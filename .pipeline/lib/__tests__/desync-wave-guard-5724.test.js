// =============================================================================
// desync-wave-guard-5724.test.js — Issue #5724
//
// El incidente: el dispatch estuvo ~10 h suspendido con cuota disponible en 4
// providers. Dos defectos encadenados:
//
//   1. La poda por TTL sacó de la allowlist a #5689-#5691 — issues ABIERTOS,
//      `Ready`, de la ola activa — porque el filtro era puramente temporal.
//   2. La divergencia resultante (`added=[]`, `removed=[5689,5690,5691]`) se
//      clasificó `resoluble_reductivo` pero el resolvedor exigía que TODO issue
//      divergente estuviera CERRADO → human-block indefinido y sin alerta.
//
// Cubre:
//   CA-1  guard de ola activa en `expireRecursiveAuthorizations` (+ fail-safe
//         de estado indeterminado y de ola ilegible).
//   CA-2  convergencia ADITIVA allowlist ← ola para issues abiertos de la ola,
//         con la frontera fail-closed intacta (indeterminado / extras / ajenos).
//   CA-3  recordatorios con backoff mientras el dispatch siga suspendido y
//         cierre del ciclo al resolverse.
//   CA-4  `detected_at` expuesto por el slice del dashboard.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/desync-wave-guard-5724.test.js
// =============================================================================

'use strict';

process.env.PULPO_NO_AUTOSTART = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const desyncDetector = require('../desync-detector');
const recursivePromote = require('../allowlist-recursive-promote');
const blockNotifier = require('../desync-block-notifier');
const partialPause = require('../partial-pause');
const waves = require('../waves');
const slices = require('../dashboard-slices');
const pulpo = require('../../pulpo.js');

// -----------------------------------------------------------------------------
// Helpers de fixture (mismo patrón que desync-reductive-autoresolve-4753)
// -----------------------------------------------------------------------------
function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'desync-5724-')); }
function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }

function setup() {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    try { waves.invalidateCache(); } catch (_) {}
    try { desyncDetector.clearDesyncFlag(); } catch (_) {}
    try { blockNotifier._internal.clearState(); } catch (_) {}
    return dir;
}

function teardown(dir) {
    try { desyncDetector.clearDesyncFlag(); } catch (_) {}
    try { blockNotifier._internal.clearState(); } catch (_) {}
    delete process.env.PIPELINE_DIR_OVERRIDE;
    try { waves.invalidateCache(); } catch (_) {}
    rmrf(dir);
}

function writeWaves(dir, activeIssues) {
    const state = {
        version: '1.0',
        meta: {
            created_at: '2026-08-09T00:00:00Z', updated_at: '2026-08-09T00:00:00Z',
            updated_by: 'fixture', source: 'manual', note: 'test #5724', next_wave_number: 99,
        },
        active_wave: {
            number: 10,
            name: 'Ola 10 — Test 5724',
            goal: 'converger allowlist ← ola',
            started_at: '2026-08-09T00:00:00.000Z',
            issues: activeIssues.map((i) => ({ number: i.number, status: i.status || 'in_progress' })),
        },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(state, null, 2));
    try { waves.invalidateCache(); } catch (_) {}
}

function writeAllowlist(dir, allowedIssues, authorizationTtls) {
    const data = {
        allowed_issues: allowedIssues,
        created_at: '2026-08-09T00:00:00.000Z',
        source: 'fixture',
    };
    if (authorizationTtls) data.authorization_ttls = authorizationTtls;
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify(data, null, 2));
}

function readAllowlist(dir) {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, '.partial-pause.json'), 'utf8'));
    return (parsed.allowed_issues || []).map(Number).sort((a, b) => a - b);
}

function isClosedFrom(set) {
    const s = new Set(set);
    return (n) => s.has(Number(n));
}

// TTL vencido / vigente respecto de un `now` fijo del test.
const AHORA = Date.parse('2026-08-09T12:10:00.000Z');
const VENCIDO = '2026-08-08T00:00:00.000Z';
const VIGENTE = '2026-08-31T00:00:00.000Z';

function ttlsPara(numeros, expiresAt) {
    const out = {};
    for (const n of numeros) {
        out[String(n)] = {
            parent: 5678,
            authorized_by: 'recursive-deps:from-5678',
            expires_at: expiresAt,
            created_at: '2026-08-06T00:00:00.000Z',
        };
    }
    return out;
}

// =============================================================================
// CA-1 — La poda por TTL no puede llevarse trabajo vivo de la ola activa
// =============================================================================
test('CA-1: issues ABIERTOS de la ola activa con TTL vencido NO se podan de la allowlist', () => {
    const dir = setup();
    try {
        // Reproducción literal del incidente: hijos del split de #5678, abiertos,
        // en la ola 10, con la autorización heredada ya vencida.
        writeWaves(dir, [
            { number: 5688, status: 'in_progress' },
            { number: 5689, status: 'in_progress' },
            { number: 5690, status: 'in_progress' },
            { number: 5691, status: 'in_progress' },
        ]);
        writeAllowlist(dir, [5688, 5689, 5690, 5691], ttlsPara([5689, 5690, 5691], VENCIDO));

        const r = recursivePromote.expireRecursiveAuthorizations({
            nowMs: AHORA,
            isClosed: isClosedFrom([]), // los tres siguen abiertos
        });

        assert.deepEqual(r.expired, [], 'no se poda nada: son trabajo pendiente de la ola activa');
        assert.deepEqual(r.protected.sort((a, b) => a - b), [5689, 5690, 5691]);
        assert.deepEqual(readAllowlist(dir), [5688, 5689, 5690, 5691], 'la allowlist queda intacta');
    } finally { teardown(dir); }
});

test('CA-1: issues CERRADOS de la ola activa con TTL vencido SÍ se podan (son residuo)', () => {
    const dir = setup();
    try {
        writeWaves(dir, [
            { number: 5688, status: 'in_progress' },
            { number: 5689, status: 'in_progress' },
        ]);
        writeAllowlist(dir, [5688, 5689], ttlsPara([5689], VENCIDO));

        const r = recursivePromote.expireRecursiveAuthorizations({
            nowMs: AHORA,
            isClosed: isClosedFrom([5689]), // cerrado confirmado
        });

        assert.deepEqual(r.expired, [5689]);
        assert.deepEqual(r.protected, []);
        assert.deepEqual(readAllowlist(dir), [5688]);
    } finally { teardown(dir); }
});

test('CA-1: issues vencidos AJENOS a la ola activa se siguen podando (comportamiento #3625 intacto)', () => {
    const dir = setup();
    try {
        writeWaves(dir, [{ number: 5688, status: 'in_progress' }]);
        writeAllowlist(dir, [5688, 4444], ttlsPara([4444], VENCIDO));

        const r = recursivePromote.expireRecursiveAuthorizations({
            nowMs: AHORA,
            isClosed: isClosedFrom([]), // #4444 abierto, pero fuera de la ola
        });

        assert.deepEqual(r.expired, [4444], 'fuera de la ola activa = residuo, se poda igual que antes');
        assert.deepEqual(readAllowlist(dir), [5688]);
    } finally { teardown(dir); }
});

test('CA-1 fail-safe: estado INDETERMINADO de un issue de la ola NO habilita la poda', () => {
    const dir = setup();
    try {
        writeWaves(dir, [
            { number: 5688, status: 'in_progress' },
            { number: 5689, status: 'in_progress' },
        ]);
        writeAllowlist(dir, [5688, 5689], ttlsPara([5689], VENCIDO));

        // title-cache stale (#4566/#4882): no sabemos si está cerrado.
        const r = recursivePromote.expireRecursiveAuthorizations({
            nowMs: AHORA,
            isClosed: () => undefined,
        });

        assert.deepEqual(r.expired, []);
        assert.deepEqual(r.protected, [5689]);
        assert.deepEqual(readAllowlist(dir), [5688, 5689]);
    } finally { teardown(dir); }
});

test('CA-1 fail-safe: ola INDETERMINADA (waves.json corrupto) protege todo lo vencido', () => {
    const dir = setup();
    try {
        // `getActiveWave()` lanza con JSON inválido → estado indeterminado.
        fs.writeFileSync(path.join(dir, 'waves.json'), '{ esto no es json');
        try { waves.invalidateCache(); } catch (_) {}
        writeAllowlist(dir, [5688, 5689], ttlsPara([5689], VENCIDO));

        const r = recursivePromote.expireRecursiveAuthorizations({
            nowMs: AHORA,
            isClosed: isClosedFrom([]),
        });

        assert.deepEqual(r.expired, [], 'sin poder leer la ola no podemos afirmar que sea residuo');
        assert.deepEqual(r.protected, [5689]);
        assert.deepEqual(readAllowlist(dir), [5688, 5689]);
    } finally { teardown(dir); }
});

test('CA-1: SIN ola activa (modo legacy sin waves.json) la poda por TTL sigue funcionando (#3625 intacto)', () => {
    const dir = setup();
    try {
        // No hay ola → no hay trabajo vivo que proteger: el TTL debe poder
        // limpiar autorizaciones heredadas obsoletas como siempre.
        writeAllowlist(dir, [5688, 9001], ttlsPara([9001], VENCIDO));

        const r = recursivePromote.expireRecursiveAuthorizations({ nowMs: AHORA });

        assert.deepEqual(r.expired, [9001]);
        assert.deepEqual(r.protected, []);
        assert.deepEqual(readAllowlist(dir), [5688]);
    } finally { teardown(dir); }
});

test('CA-1: un TTL VIGENTE no se toca (regresión del cron #3625)', () => {
    const dir = setup();
    try {
        writeWaves(dir, [{ number: 5688, status: 'in_progress' }]);
        writeAllowlist(dir, [5688, 4444], ttlsPara([4444], VIGENTE));

        const r = recursivePromote.expireRecursiveAuthorizations({ nowMs: AHORA });

        assert.deepEqual(r.expired, []);
        assert.deepEqual(r.protected, []);
        assert.deepEqual(readAllowlist(dir), [4444, 5688]);
    } finally { teardown(dir); }
});

// =============================================================================
// CA-2 — Convergencia aditiva allowlist ← ola (el bloqueo de 10 h)
// =============================================================================
test('CA-2: issues ABIERTOS de la ola ausentes de la allowlist convergen solos (sin human-block)', () => {
    const dir = setup();
    try {
        writeWaves(dir, [
            { number: 5688, status: 'in_progress' },
            { number: 5689, status: 'in_progress' },
            { number: 5690, status: 'in_progress' },
            { number: 5691, status: 'in_progress' },
        ]);
        writeAllowlist(dir, [5688]);
        const isClosed = isClosedFrom([]); // los tres faltantes están abiertos

        const before = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true, isClosed });
        assert.equal(before.desync, true);
        assert.deepEqual(before.added, []);
        assert.deepEqual(before.removed.slice().sort((a, b) => a - b), [5689, 5690, 5691]);
        assert.equal(before.classification, 'resoluble_reductivo');

        pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed });

        assert.deepEqual(readAllowlist(dir), [5688, 5689, 5690, 5691],
            'la ola es la fuente de verdad: los issues vuelven a la allowlist');
        assert.equal(desyncDetector.isDesyncFlagSet(), false, 'el dispatch NO queda suspendido');
        const after = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true, isClosed });
        assert.equal(after.desync, false, 'la divergencia converge de verdad');
    } finally { teardown(dir); }
});

test('CA-2: divergencia MIXTA (un cerrado + un abierto, ambos de la ola) converge en una pasada', () => {
    const dir = setup();
    try {
        writeWaves(dir, [
            { number: 5688, status: 'in_progress' },
            { number: 4716, status: 'in_progress' }, // cerrado residual
            { number: 5689, status: 'in_progress' }, // abierto faltante
        ]);
        writeAllowlist(dir, [5688]);
        const isClosed = isClosedFrom([4716]);

        pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed });

        assert.deepEqual(readAllowlist(dir), [5688, 5689], 'el cerrado no vuelve, el abierto sí');
        assert.equal(desyncDetector.isDesyncFlagSet(), false);
        const after = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true, isClosed });
        assert.equal(after.desync, false);
    } finally { teardown(dir); }
});

test('CA-2 fail-closed: estado INDETERMINADO de un faltante NO converge → dispatch suspendido', () => {
    const dir = setup();
    try {
        writeWaves(dir, [
            { number: 5688, status: 'in_progress' },
            { number: 5689, status: 'in_progress' },
        ]);
        writeAllowlist(dir, [5688]);
        // SEC-4: cache miss del title-cache no se trata como "abierto".
        const isClosed = (n) => (Number(n) === 5688 ? false : undefined);

        pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed });

        assert.deepEqual(readAllowlist(dir), [5688], 'no se muta la allowlist con estado no confiable');
        assert.equal(desyncDetector.isDesyncFlagSet(), true, 'human-block preservado');
    } finally { teardown(dir); }
});

test('CA-2 fail-closed: con EXTRAS abiertos en la allowlist sigue siendo ambiguo (no se revoca nada en silencio)', () => {
    const dir = setup();
    try {
        writeWaves(dir, [
            { number: 5688, status: 'in_progress' },
            { number: 5689, status: 'in_progress' },
        ]);
        writeAllowlist(dir, [5688, 7777]); // #7777 abierto y ajeno a la ola
        const isClosed = isClosedFrom([]);

        const before = desyncDetector.detectDesync({ skipFlag: true, skipAlert: true, isClosed });
        assert.deepEqual(before.added, [7777]);
        assert.equal(before.classification, 'ambiguo');

        pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed });

        assert.deepEqual(readAllowlist(dir), [5688, 7777], 'la autorización deliberada no se revoca');
        assert.equal(desyncDetector.isDesyncFlagSet(), true);
    } finally { teardown(dir); }
});

// =============================================================================
// CA-1 + CA-2 juntos — no puede haber bucle poda ↔ convergencia
// =============================================================================
test('CA-1+CA-2: tras converger, el cron de TTL no vuelve a sacar los issues (sin churn)', () => {
    const dir = setup();
    try {
        writeWaves(dir, [
            { number: 5688, status: 'in_progress' },
            { number: 5689, status: 'in_progress' },
        ]);
        writeAllowlist(dir, [5688], ttlsPara([5689], VENCIDO));
        const isClosed = isClosedFrom([]);

        pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed });
        assert.deepEqual(readAllowlist(dir), [5688, 5689], 'convergió');

        // El TTL heredado de #5689 sigue vencido: sin el guard de CA-1 esto lo
        // sacaría otra vez y el ciclo se repetiría cada hora.
        const r = recursivePromote.expireRecursiveAuthorizations({ nowMs: AHORA, isClosed });
        assert.deepEqual(r.expired, []);
        assert.deepEqual(readAllowlist(dir), [5688, 5689], 'la poda ya no deshace la convergencia');
    } finally { teardown(dir); }
});

// =============================================================================
// CA-3 — Recordatorios con backoff mientras el dispatch siga suspendido
// =============================================================================
test('CA-3: la primera llamada abre el ciclo sin duplicar la alerta inicial del detector', () => {
    const dir = setup();
    try {
        const enviados = [];
        const r = blockNotifier.onBlocked({
            detectedAt: '2026-08-09T12:12:00.000Z',
            added: [], removed: [5689, 5690, 5691],
            nowMs: Date.parse('2026-08-09T12:12:30.000Z'),
            send: (p) => enviados.push(p),
        });
        assert.equal(r.notificado, false);
        assert.equal(r.motivo, 'ciclo_iniciado');
        assert.equal(enviados.length, 0, 'la alerta inicial la emite el detector, no el notifier');
    } finally { teardown(dir); }
});

test('CA-3: a los 15 min sale el primer recordatorio y no se repite hasta el escalón siguiente', () => {
    const dir = setup();
    try {
        const enviados = [];
        const send = (p) => enviados.push(p);
        const detectedAt = '2026-08-09T12:12:00.000Z';
        const t0 = Date.parse(detectedAt);
        const base = { detectedAt, added: [], removed: [5689, 5690, 5691], send };

        blockNotifier.onBlocked({ ...base, nowMs: t0 + 60 * 1000 });         // 1 min
        assert.equal(enviados.length, 0);

        blockNotifier.onBlocked({ ...base, nowMs: t0 + 10 * 60 * 1000 });    // 10 min
        assert.equal(enviados.length, 0, 'antes del primer escalón no molesta');

        const r1 = blockNotifier.onBlocked({ ...base, nowMs: t0 + 16 * 60 * 1000 });
        assert.equal(r1.notificado, true);
        assert.equal(enviados.length, 1);

        // El pulpo evalúa cada ~5 min: sin backoff esto sería un mensaje por tick.
        for (const min of [21, 26, 31, 36, 41, 46, 51, 56]) {
            blockNotifier.onBlocked({ ...base, nowMs: t0 + min * 60 * 1000 });
        }
        assert.equal(enviados.length, 1, 'un solo mensaje en la primera hora');

        blockNotifier.onBlocked({ ...base, nowMs: t0 + 61 * 60 * 1000 });    // escalón 1 h
        assert.equal(enviados.length, 2);
    } finally { teardown(dir); }
});

test('CA-3: el recordatorio nombra la consecuencia, el tiempo y los issues concretos', () => {
    const dir = setup();
    try {
        const enviados = [];
        const send = (p) => enviados.push(p);
        const detectedAt = '2026-08-09T12:12:00.000Z';
        const t0 = Date.parse(detectedAt);
        const base = { detectedAt, added: [], removed: [5689, 5690, 5691], send };

        blockNotifier.onBlocked({ ...base, nowMs: t0 + 1000 });
        blockNotifier.onBlocked({ ...base, nowMs: t0 + 2 * 60 * 60 * 1000 }); // 2 h

        assert.equal(enviados.length, 1);
        const msg = enviados[0];
        assert.equal(msg.level, 'error');
        assert.match(msg.message, /dispatch sigue suspendido/i);
        assert.match(msg.message, /hace 2 h/);
        assert.match(msg.action, /#5689, #5690, #5691/);
        assert.equal(msg.context.antiguedad_minutos, 120);
    } finally { teardown(dir); }
});

test('CA-3: si la divergencia cambia, el ciclo se reinicia (es otro bloqueo)', () => {
    const dir = setup();
    try {
        const enviados = [];
        const send = (p) => enviados.push(p);
        const t0 = Date.parse('2026-08-09T12:12:00.000Z');

        blockNotifier.onBlocked({ detectedAt: '2026-08-09T12:12:00.000Z', removed: [5689], nowMs: t0, send });
        blockNotifier.onBlocked({ detectedAt: '2026-08-09T12:12:00.000Z', removed: [5689], nowMs: t0 + 20 * 60 * 1000, send });
        assert.equal(enviados.length, 1);

        // Otra divergencia (otros issues) → firma distinta → escalera nueva.
        const r = blockNotifier.onBlocked({
            detectedAt: '2026-08-09T14:00:00.000Z', removed: [6001],
            nowMs: t0 + 21 * 60 * 1000, send,
        });
        assert.equal(r.motivo, 'ciclo_iniciado');
        assert.equal(enviados.length, 1);
    } finally { teardown(dir); }
});

test('CA-3: al resolverse avisa el cierre sólo si el operador llegó a ver un recordatorio', () => {
    const dir = setup();
    try {
        const enviados = [];
        const send = (p) => enviados.push(p);
        const detectedAt = '2026-08-09T12:12:00.000Z';
        const t0 = Date.parse(detectedAt);

        // Bloqueo corto: se resuelve antes del primer escalón → silencio.
        blockNotifier.onBlocked({ detectedAt, removed: [5689], nowMs: t0, send });
        const corto = blockNotifier.onResolved({ nowMs: t0 + 3 * 60 * 1000, send });
        assert.equal(corto.notificado, false);
        assert.equal(corto.motivo, 'sin_avisos_previos');
        assert.equal(enviados.length, 0);

        // Bloqueo largo: hubo recordatorio → corresponde contar que volvió.
        blockNotifier.onBlocked({ detectedAt, removed: [5689], nowMs: t0, send });
        blockNotifier.onBlocked({ detectedAt, removed: [5689], nowMs: t0 + 20 * 60 * 1000, send });
        assert.equal(enviados.length, 1);
        const largo = blockNotifier.onResolved({
            resolucion: 'convergencia_aditiva', issues: [5689],
            nowMs: t0 + 25 * 60 * 1000, send,
        });
        assert.equal(largo.notificado, true);
        assert.equal(enviados.length, 2);
        assert.match(enviados[1].message, /volvió a arrancar/i);
        assert.match(enviados[1].action, /#5689/);
    } finally { teardown(dir); }
});

test('CA-3: un fallo de envío no marca el escalón como emitido (se reintenta)', () => {
    const dir = setup();
    try {
        const detectedAt = '2026-08-09T12:12:00.000Z';
        const t0 = Date.parse(detectedAt);
        blockNotifier.onBlocked({ detectedAt, removed: [5689], nowMs: t0, send: () => {} });

        const roto = blockNotifier.onBlocked({
            detectedAt, removed: [5689], nowMs: t0 + 16 * 60 * 1000,
            send: () => { throw new Error('telegram caído'); },
        });
        assert.equal(roto.notificado, false);
        assert.equal(roto.motivo, 'envio_fallido');

        const enviados = [];
        const reintento = blockNotifier.onBlocked({
            detectedAt, removed: [5689], nowMs: t0 + 17 * 60 * 1000,
            send: (p) => enviados.push(p),
        });
        assert.equal(reintento.notificado, true, 'el escalón sigue pendiente hasta que se envía');
        assert.equal(enviados.length, 1);
    } finally { teardown(dir); }
});

test('CA-3: el pulpo emite el recordatorio aunque el flag YA estuviera puesto (el silencio de 10 h)', () => {
    const dir = setup();
    try {
        writeWaves(dir, [
            { number: 5688, status: 'in_progress' },
            { number: 5689, status: 'in_progress' },
        ]);
        writeAllowlist(dir, [5688]);
        const isClosed = (n) => (Number(n) === 5688 ? false : undefined); // indeterminado → bloquea

        // Primer ciclo: crea el flag y abre la escalera de avisos.
        pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed });
        assert.equal(desyncDetector.isDesyncFlagSet(), true);
        const estado = blockNotifier._internal.readState();
        assert.ok(estado, 'el ciclo de avisos quedó abierto');
        assert.equal(estado.escalon_emitido, 0);

        // Envejecemos el flag 3 horas: el segundo ciclo debe recordar, no callar.
        const flagPath = path.join(dir, desyncDetector.DESYNC_FLAG_BASENAME);
        const flag = JSON.parse(fs.readFileSync(flagPath, 'utf8'));
        const viejo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
        flag.detected_at = viejo;
        fs.writeFileSync(flagPath, JSON.stringify(flag, null, 2));
        const st = blockNotifier._internal.readState();
        st.firma = blockNotifier._internal.firmaDe({
            detectedAt: viejo, added: [], removed: [5689],
        });
        st.detected_at = viejo;
        blockNotifier._internal.writeState(st);

        pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed });

        const final = blockNotifier._internal.readState();
        assert.ok(final.escalon_emitido >= 1, 'con el flag ya puesto igual sale un recordatorio');
    } finally { teardown(dir); }
});

// =============================================================================
// CA-4 — El dashboard tiene con qué mostrar la antigüedad del bloqueo
// =============================================================================
test('CA-4: el slice expone detected_at cuando el dispatch está suspendido', () => {
    const dir = setup();
    try {
        writeWaves(dir, [
            { number: 5688, status: 'in_progress' },
            { number: 5689, status: 'in_progress' },
        ]);
        writeAllowlist(dir, [5688]);
        // Flag real, creado por el detector.
        desyncDetector.detectDesync({ skipAlert: true, isClosed: isClosedFrom([]) });

        const s = slices.desyncStatusSlice({}, {});
        assert.equal(s.bloqueado, true);
        assert.equal(s.estado, 'divergencia_bloqueada');
        assert.equal(typeof s.detected_at, 'string');
        assert.ok(Number.isFinite(Date.parse(s.detected_at)), 'detected_at parseable');
        assert.deepEqual(s.removed, [5689]);
    } finally { teardown(dir); }
});

test('CA-4: sin bloqueo, detected_at es null (no se inventa antigüedad)', () => {
    const dir = setup();
    try {
        writeWaves(dir, [{ number: 5688, status: 'in_progress' }]);
        writeAllowlist(dir, [5688]);

        const s = slices.desyncStatusSlice({}, {});
        assert.equal(s.bloqueado, false);
        assert.equal(s.detected_at, null);
    } finally { teardown(dir); }
});
