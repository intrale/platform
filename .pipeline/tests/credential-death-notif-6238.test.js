// =============================================================================
// credential-death-notif-6238.test.js — Issue #6238.
//
// Cobertura del aviso al operador cuando la sesión de un provider vence:
//   CA-5      · un solo Telegram por provider por ventana de 30 min; el dedupe
//               NO puede suprimir evidencia (log/JSONL los emite el caller).
//   CA-UX-1   · abre con 🚨; prohibidos 🔌 / ⚠️ / ⛔ / ⏸️.
//   CA-UX-2   · label humano del proveedor, nunca la provider-key cruda.
//   CA-UX-3   · dice qué acción concreta destraba (reautenticar).
//   CA-UX-4   · dice explícitamente que el issue NO fue penalizado.
//   CA-UX-5   · explica su propia repetición en el cierre.
//   CA-UX-6   · la repetición NO es el mismo texto (tiempo + "sigue igual").
//   CA-UX-7   · la lista de issues se acota a 10 + "… y N más".
//   CA-UX-8   · sin jerga interna del pipeline en el texto del operador.
//   SEC-CA-5  · sin excerpt del log ni fragmento de credencial.
//
// Ejecución: `node --test .pipeline/tests/credential-death-notif-6238.test.js`
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.PULPO_NO_AUTOSTART = '1';
const pulpo = require(path.join(__dirname, '..', 'pulpo.js'));

const {
    buildCredentialDeathMessage,
    sendCredentialDeathNotif,
    formatElapsedHuman,
    formatPendingIssues,
    CREDENTIAL_NOTIF_COOLDOWN_MS,
    CREDENTIAL_NOTIF_MAX_ISSUES,
    _resetCredentialNotifStateForTest,
} = pulpo;

const MIN = 60 * 1000;

function collector() {
    const sent = [];
    return { sent, send: (m) => sent.push(m) };
}

// -----------------------------------------------------------------------------
// CA-UX-1/2/3/4/5 — el copy del primer aviso
// -----------------------------------------------------------------------------

test('CA-UX-1 el aviso abre con 🚨 y no usa 🔌 / ⚠️ / ⛔ / ⏸️', () => {
    for (const isRepeat of [false, true]) {
        const msg = buildCredentialDeathMessage({
            providerKey: 'anthropic', isRepeat, elapsedMs: 75 * MIN, pending: '#6226, #6146',
        });
        assert.ok(msg.startsWith('🚨'), 'debe abrir con 🚨');
        for (const prohibido of ['🔌', '⚠️', '⛔', '⏸️']) {
            assert.ok(!msg.includes(prohibido), `emoji prohibido presente: ${prohibido}`);
        }
    }
});

test('CA-UX-2 usa el label humano del proveedor, nunca la clave interna', () => {
    const casos = [
        ['anthropic', 'Anthropic'],
        ['openai-codex', 'OpenAI Codex'],
        ['gemini-google', 'Gemini'],
    ];
    for (const [key, label] of casos) {
        for (const isRepeat of [false, true]) {
            const msg = buildCredentialDeathMessage({
                providerKey: key, isRepeat, elapsedMs: 0, pending: '#6226',
            });
            assert.ok(msg.includes(label), `falta el label "${label}"`);
            assert.ok(!msg.includes(key), `la clave cruda "${key}" no puede aparecer`);
        }
    }
});

test('CA-UX-3 dice qué acción concreta destraba (reautenticar en la máquina del pipeline)', () => {
    const msg = buildCredentialDeathMessage({ providerKey: 'anthropic', isRepeat: false, elapsedMs: 0, pending: '#6226' });
    assert.ok(/reautentiques/i.test(msg));
    assert.ok(/m[aá]quina del pipeline/i.test(msg));
});

test('CA-UX-4 dice explícitamente que el issue NO fue penalizado', () => {
    const msg = buildCredentialDeathMessage({ providerKey: 'anthropic', isRepeat: false, elapsedMs: 0, pending: '#6226' });
    assert.ok(/Ning[uú]n issue pag[oó] el costo/i.test(msg));
    assert.ok(/no gastaron intento ni suman rebote/i.test(msg));
});

test('CA-UX-5 el primer aviso explica su propia repetición en el cierre', () => {
    const msg = buildCredentialDeathMessage({ providerKey: 'anthropic', isRepeat: false, elapsedMs: 0, pending: '#6226' });
    assert.ok(/cada 30 minutos/i.test(msg));
    assert.ok(/sigue igual/i.test(msg));
});

test('CA-UX-6 la repetición NO es el mismo texto: lleva tiempo y "sigue igual"', () => {
    const primero = buildCredentialDeathMessage({ providerKey: 'anthropic', isRepeat: false, elapsedMs: 0, pending: '#6226' });
    const repe = buildCredentialDeathMessage({ providerKey: 'anthropic', isRepeat: true, elapsedMs: 75 * MIN, pending: '#6226' });
    assert.notEqual(primero, repe);
    assert.ok(/sigue vencida/i.test(repe));
    assert.ok(repe.includes('1 h 15 min'), 'debe llevar el tiempo transcurrido');
    assert.ok(/Nada cambi[oó]/i.test(repe));
});

test('CA-UX-8 el texto del operador no usa jerga interna del pipeline', () => {
    const PROHIBIDAS = ['credential-death', 'TTL', 'fast-fail', 'cooldown',
        'provider-disabled', 'logTail', 'signature', 'spawn'];
    for (const isRepeat of [false, true]) {
        const msg = buildCredentialDeathMessage({
            providerKey: 'anthropic', isRepeat, elapsedMs: 40 * MIN, pending: '#6226, #6146',
        });
        const lower = msg.toLowerCase();
        for (const jerga of PROHIBIDAS) {
            assert.ok(!lower.includes(jerga.toLowerCase()), `jerga prohibida en el mensaje: "${jerga}"`);
        }
    }
});

test('SEC-CA-5 el mensaje no lleva excerpt del log ni fragmento de credencial', () => {
    const msg = buildCredentialDeathMessage({ providerKey: 'anthropic', isRepeat: false, elapsedMs: 0, pending: '#6226' });
    assert.ok(!msg.includes('OAuth session expired'));
    assert.ok(!msg.includes('Failed to authenticate'));
    assert.ok(!msg.includes('authentication_failed'));
    assert.ok(!/sk-|AKIA|Bearer |eyJ/.test(msg));
    assert.ok(!msg.includes('.credentials.json'));
});

// -----------------------------------------------------------------------------
// CA-UX-7 — lista de issues acotada
// -----------------------------------------------------------------------------

test('CA-UX-7 la lista de issues se acota a 10 y cierra con "… y N más"', () => {
    assert.equal(CREDENTIAL_NOTIF_MAX_ISSUES, 10);
    const pocos = formatPendingIssues(new Set(['6226', '6146']));
    assert.equal(pocos, '#6226, #6146');
    assert.ok(!pocos.includes('más'));

    const muchos = formatPendingIssues(new Set(Array.from({ length: 14 }, (_, i) => String(6000 + i))));
    assert.equal((muchos.match(/#/g) || []).length, 10, 'sólo 10 issues enumerados');
    assert.ok(muchos.endsWith('… y 4 más'), muchos);
});

test('formatElapsedHuman rinde minutos, horas y horas+minutos', () => {
    assert.equal(formatElapsedHuman(0), '0 min');
    assert.equal(formatElapsedHuman(45 * MIN), '45 min');
    assert.equal(formatElapsedHuman(60 * MIN), '1 h');
    assert.equal(formatElapsedHuman(75 * MIN), '1 h 15 min');
    assert.equal(formatElapsedHuman(-5 * MIN), '0 min', 'nunca negativo');
});

// -----------------------------------------------------------------------------
// CA-5 — dedupe por provider, ventana de 30 min
// -----------------------------------------------------------------------------

test('CA-5 cuatro muertes en 10 minutos → un solo Telegram, con los cuatro issues', () => {
    _resetCredentialNotifStateForTest();
    const { sent, send } = collector();
    const t0 = 1_000_000_000;

    const r1 = sendCredentialDeathNotif('anthropic', 6226, { now: t0, send });
    const r2 = sendCredentialDeathNotif('anthropic', 6146, { now: t0 + 1 * MIN, send });
    const r3 = sendCredentialDeathNotif('anthropic', 6226, { now: t0 + 6 * MIN, send });
    const r4 = sendCredentialDeathNotif('anthropic', 6301, { now: t0 + 9 * MIN, send });

    assert.equal(sent.length, 1, 'un único mensaje por ventana');
    assert.equal(r1.sent, true);
    assert.deepEqual([r2.sent, r3.sent, r4.sent], [false, false, false]);

    // El caller igual tiene la info para su línea de log (SEC-CA-4 / CA-UX-9).
    assert.ok(r4.remainingMin > 0 && r4.remainingMin <= 30);
    assert.ok(r4.pending.includes('#6226'));
    assert.ok(r4.pending.includes('#6146'));
    assert.ok(r4.pending.includes('#6301'));
});

test('CA-5 pasada la ventana de 30 min sale la repetición, distinta del primer aviso', () => {
    _resetCredentialNotifStateForTest();
    const { sent, send } = collector();
    const t0 = 1_000_000_000;

    sendCredentialDeathNotif('anthropic', 6226, { now: t0, send });
    sendCredentialDeathNotif('anthropic', 6146, { now: t0 + 10 * MIN, send });
    assert.equal(sent.length, 1);

    // Justo antes del borde: sigue suprimido.
    sendCredentialDeathNotif('anthropic', 6146, { now: t0 + CREDENTIAL_NOTIF_COOLDOWN_MS - 1, send });
    assert.equal(sent.length, 1);

    // Cruzando el borde: sale la repetición.
    const r = sendCredentialDeathNotif('anthropic', 6301, { now: t0 + 75 * MIN, send });
    assert.equal(sent.length, 2);
    assert.equal(r.sent, true);
    assert.notEqual(sent[0], sent[1], 'la repetición no puede ser el mismo texto');
    assert.ok(sent[1].includes('1 h 15 min'));
    assert.ok(sent[1].includes('#6301'));
});

test('CA-5 la clave de dedupe es el PROVIDER: dos providers no se suprimen entre sí', () => {
    _resetCredentialNotifStateForTest();
    const { sent, send } = collector();
    const t0 = 1_000_000_000;

    sendCredentialDeathNotif('anthropic', 6226, { now: t0, send });
    sendCredentialDeathNotif('openai-codex', 6146, { now: t0 + 1 * MIN, send });
    sendCredentialDeathNotif('anthropic', 6301, { now: t0 + 2 * MIN, send });

    assert.equal(sent.length, 2, 'un aviso por provider');
    assert.ok(sent[0].includes('Anthropic'));
    assert.ok(sent[1].includes('OpenAI Codex'));
});

test('CA-5 la ventana es de 30 minutos', () => {
    assert.equal(CREDENTIAL_NOTIF_COOLDOWN_MS, 30 * MIN);
});

test('provider desconocido o vacío no rompe el aviso', () => {
    _resetCredentialNotifStateForTest();
    const { sent, send } = collector();
    assert.doesNotThrow(() => {
        sendCredentialDeathNotif(null, 6226, { now: 1_000_000_000, send });
    });
    assert.equal(sent.length, 1);
    assert.ok(sent[0].startsWith('🚨'));
});
