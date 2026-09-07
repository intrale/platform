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

// =============================================================================
// #6117 — La convergencia aditiva EXITOSA no le escribe al operador
//
// Antes de #6117 esta rama emitía "Volví a habilitar el dispatch (#5724)". El
// aviso no pedía ninguna decisión: la reparación ya se había ejecutado y el
// pipeline seguía andando. Ahora el dato va a log, audit, métrica y dashboard.
//
// RIESGO DE FALSO VERDE (H6) — `sendTelegramPlain` NO hace HTTP: encola un
// dropfile en `<pipeline>/servicios/telegram/pendiente`. Si faltan las
// credenciales corta ANTES de escribir, y si el directorio no existe el
// `writeFileSync` tira y se lo come un `catch` best-effort. En cualquiera de
// esos dos casos un `assert(dropfiles === 0)` pasaría sin haber probado nada.
//
// Por eso cada test de silencio de acá abajo:
//   1. corre sobre un arnés que SIEMBRA credenciales válidas y CREA el
//      directorio de la cola (`setupTelegram`), y
//   2. va acompañado de un CONTROL POSITIVO en el mismo arnés, que demuestra
//      que el harness detecta un dropfile cuando efectivamente lo hay.
// Sin el control positivo, estos tests no valen nada.
// =============================================================================

const autoRepairMetrics = require('../metrics/auto-repair');

// Formato exigido por `lib/telegram-secrets.js::isLikelyToken`. Valor SINTÉTICO
// con la forma correcta, no una credencial real.
const TG_TOKEN_FAKE = '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
let _tgEnvPrevio = null;

/** setup() + cola de Telegram operativa (credenciales + directorio). */
function setupTelegram() {
    const dir = setup();
    fs.mkdirSync(path.join(dir, 'servicios', 'telegram', 'pendiente'), { recursive: true });
    _tgEnvPrevio = {
        token: process.env.TELEGRAM_BOT_TOKEN,
        chat: process.env.TELEGRAM_CHAT_ID,
    };
    process.env.TELEGRAM_BOT_TOKEN = TG_TOKEN_FAKE;
    process.env.TELEGRAM_CHAT_ID = '999999';
    // El dedupe del aviso de fallo es estado de PROCESO, no del tmpdir: sin
    // limpiarlo, un test que ya emitió una firma silencia al siguiente que use
    // la misma, y el fallo se lee como un bug del código bajo prueba.
    try { pulpo._resetAutoRepairFailureDedupe(); } catch (_) {}
    return dir;
}

function teardownTelegram(dir) {
    if (_tgEnvPrevio) {
        if (_tgEnvPrevio.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
        else process.env.TELEGRAM_BOT_TOKEN = _tgEnvPrevio.token;
        if (_tgEnvPrevio.chat === undefined) delete process.env.TELEGRAM_CHAT_ID;
        else process.env.TELEGRAM_CHAT_ID = _tgEnvPrevio.chat;
        _tgEnvPrevio = null;
    }
    teardown(dir);
}

/** Dropfiles encolados para Telegram en el tmpdir del test. */
function dropfiles(dir) {
    const d = path.join(dir, 'servicios', 'telegram', 'pendiente');
    try { return fs.readdirSync(d); } catch { return []; }
}

/** Texto de cada dropfile (para asertar sobre el copy emitido). */
function dropfileTexts(dir) {
    const d = path.join(dir, 'servicios', 'telegram', 'pendiente');
    return dropfiles(dir).map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')).text || ''; }
        catch { return ''; }
    });
}

test('#6117 CONTROL POSITIVO: el arnés SÍ detecta un dropfile cuando se emite uno', () => {
    // Este test es el que le da sentido a los de silencio. Si esto falla, los
    // `assert(dropfiles === 0)` de abajo son falsos verdes.
    const dir = setupTelegram();
    try {
        assert.deepEqual(dropfiles(dir), [], 'arranca sin dropfiles');
        pulpo.notifyAutoRepairFailure('convergencia_aditiva', 'motivo de prueba');
        assert.equal(dropfiles(dir).length, 1,
            'el arnés tiene credenciales y directorio: un envío real deja dropfile');
    } finally { teardownTelegram(dir); }
});

test('#6117 CA-1: una convergencia aditiva EXITOSA no deja ningún dropfile de Telegram', () => {
    const dir = setupTelegram();
    try {
        writeWaves(dir, [
            { number: 5688, status: 'in_progress' },
            { number: 5689, status: 'in_progress' },
            { number: 5690, status: 'in_progress' },
        ]);
        writeAllowlist(dir, [5688]);
        const isClosed = isClosedFrom([]);

        pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed });

        // La reparación efectivamente ocurrió (si no, el silencio no prueba nada).
        assert.deepEqual(readAllowlist(dir), [5688, 5689, 5690], 'la reparación se aplicó');
        assert.equal(desyncDetector.isDesyncFlagSet(), false);
        assert.deepEqual(dropfiles(dir), [],
            'una reparación exitosa no pide ninguna decisión: no se le escribe al operador');
    } finally { teardownTelegram(dir); }
});

test('#6117 CA-3: la reparación exitosa SÍ deja traza completa en el log del Pulpo', () => {
    // `log()` escribe por stdout (el servicio lo redirige a pulpo.log), así que
    // la traza se captura interceptando console.log, no leyendo un archivo.
    const dir = setupTelegram();
    const capturado = [];
    const originalLog = console.log;
    console.log = (...args) => { capturado.push(args.join(' ')); };
    try {
        writeWaves(dir, [
            { number: 5688, status: 'in_progress' },
            { number: 5689, status: 'in_progress' },
        ]);
        writeAllowlist(dir, [5688]);

        pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed: isClosedFrom([]) });
    } finally {
        console.log = originalLog;
        teardownTelegram(dir);
    }

    const contenido = capturado.join('\n');
    assert.ok(/convergencia ADITIVA/.test(contenido), 'la convergencia queda en el log');
    assert.ok(/5689/.test(contenido), 'el log nombra los issues repuestos');
    assert.ok(/faltantes_repuestos/.test(contenido), 'el log conserva el detalle de qué se repuso');
    // El silencio de Telegram queda explicado en la propia traza: quien lea el
    // log dentro de seis meses no tiene que adivinar por qué no hubo aviso.
    assert.ok(/#6117/.test(contenido), 'el log dice por qué no se notificó');
});

test('#6117 CA-3: onResolved sigue invocándose (no es regresión de #5724 CA-4)', () => {
    // El cierre de ciclo de `desyncBlockNotifier` NO se borró: sigue avisando
    // "volvió el trabajo" cuando el operador ya había recibido el aviso de
    // bloqueo. Silenciar la auto-reparación no puede llevarse eso puesto.
    const dir = setupTelegram();
    try {
        const llamadas = [];
        const original = blockNotifier.onResolved;
        blockNotifier.onResolved = (arg) => { llamadas.push(arg); return { notificado: false }; };
        try {
            writeWaves(dir, [
                { number: 5688, status: 'in_progress' },
                { number: 5689, status: 'in_progress' },
            ]);
            writeAllowlist(dir, [5688]);
            pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed: isClosedFrom([]) });
        } finally { blockNotifier.onResolved = original; }

        assert.equal(llamadas.length, 1, 'onResolved se invocó exactamente una vez');
        assert.equal(llamadas[0].resolucion, 'convergencia_aditiva');
        assert.deepEqual(llamadas[0].issues, [5689]);
    } finally { teardownTelegram(dir); }
});

test('#6117 CA-6: la reparación exitosa incrementa el contador de auto-reparaciones', () => {
    const dir = setupTelegram();
    try {
        writeWaves(dir, [
            { number: 5688, status: 'in_progress' },
            { number: 5689, status: 'in_progress' },
        ]);
        writeAllowlist(dir, [5688]);

        assert.equal(autoRepairMetrics.readLastAutoRepair(), null, 'arranca sin métrica');
        pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed: isClosedFrom([]) });

        const last = autoRepairMetrics.readLastAutoRepair();
        assert.notEqual(last, null, 'quedó registrada la auto-reparación');
        assert.equal(last.tipo, 'convergencia_aditiva');
        assert.deepEqual(last.issues, [5689]);
    } finally { teardownTelegram(dir); }
});

test('#6117 CA-7: el slice del dashboard expone la última auto-reparación', () => {
    const dir = setupTelegram();
    try {
        writeWaves(dir, [
            { number: 5688, status: 'in_progress' },
            { number: 5689, status: 'in_progress' },
        ]);
        writeAllowlist(dir, [5688]);

        // Sin reparaciones todavía: el campo existe y vale null (contrato).
        const antes = slices.desyncStatusSlice({}, {});
        assert.ok('ultima_auto_reparacion' in antes, 'el campo es parte del contrato');
        assert.equal(antes.ultima_auto_reparacion, null);

        pulpo.evaluateDesyncAndMaybeRealign('periodic', { isClosed: isClosedFrom([]) });

        const s = slices.desyncStatusSlice({}, {});
        const u = s.ultima_auto_reparacion;
        assert.notEqual(u, null, 'el operador puede consultarla sin depender de Telegram');
        assert.equal(u.tipo, 'convergencia_aditiva');
        assert.deepEqual(u.issues, [5689]);
        assert.ok(Number.isFinite(Date.parse(u.timestamp)));
        // SEC-6: shape acotado — el dashboard no expone nada más.
        assert.deepEqual(Object.keys(u).sort(), ['issues', 'timestamp', 'tipo']);
    } finally { teardownTelegram(dir); }
});

test('#6117 CA-4: una reparación que FALLA sí notifica, con causa y cómo destrabar', () => {
    const dir = setupTelegram();
    try {
        pulpo.notifyAutoRepairFailure('convergencia_aditiva', 'no_active_wave');

        const textos = dropfileTexts(dir);
        assert.equal(textos.length, 1, 'el fallo sí llega al operador');
        const t = textos[0];
        assert.ok(/no pude/i.test(t), 'dice que no pudo');
        assert.ok(/no_active_wave/.test(t), 'incluye la causa');
        assert.ok(/wave add/.test(t), 'dice qué hacer para destrabar (#5134)');
    } finally { teardownTelegram(dir); }
});

test('#6117 SEC-5: el aviso de fallo no filtra stack, paths absolutos ni tokens', () => {
    const dir = setupTelegram();
    try {
        const sucio = 'ENOENT: no such file C:\\Workspaces\\Intrale\\secreto\\config.yaml '
            + 'token=1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n'
            + '    at Object.<anonymous> (/c/Workspaces/Intrale/platform/.pipeline/pulpo.js:19080:15)\n'
            + '    at Module._compile (node:internal/modules/cjs/loader:1234:14)';
        pulpo.notifyAutoRepairFailure('reparacion_aditiva_wave_add', sucio);

        const [t] = dropfileTexts(dir);
        assert.ok(t, 'se emitió el aviso');
        assert.ok(!/C:\\Workspaces/.test(t), 'sin paths absolutos de Windows');
        assert.ok(!/\/c\/Workspaces/.test(t), 'sin paths absolutos POSIX');
        assert.ok(!/at Object\.<anonymous>/.test(t), 'sin stack trace');
        assert.ok(!/at Module\._compile/.test(t), 'sin stack trace');
        assert.ok(!/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/.test(t), 'sin el token');
    } finally { teardownTelegram(dir); }
});

test('#6117: el aviso de fallo se dedupea por firma (no floodea el tick de 5 min)', () => {
    // `evaluateDesyncAndMaybeRealign('periodic')` corre cada ~5 min. Una causa
    // que persiste ejecutaría la rama de fallo en CADA tick: sin dedupe serían
    // ~288 mensajes por día, un flood peor que los avisos que #6117 vino a
    // sacar. Se avisa una vez por ventana, y de nuevo si la causa CAMBIA.
    const dir = setupTelegram();
    try {
        const r1 = pulpo.notifyAutoRepairFailure('convergencia_aditiva', 'no_partial_pause');
        const r2 = pulpo.notifyAutoRepairFailure('convergencia_aditiva', 'no_partial_pause');
        const r3 = pulpo.notifyAutoRepairFailure('convergencia_aditiva', 'no_partial_pause');
        assert.equal(r1.notificado, true, 'el primero avisa');
        assert.equal(r2.notificado, false, 'el repetido no');
        assert.equal(r3.motivo, 'dedupe_ventana');
        assert.equal(dropfiles(dir).length, 1, 'un solo mensaje pese a tres ticks');

        // Causa distinta = información nueva sobre por qué sigue frenado.
        const r4 = pulpo.notifyAutoRepairFailure('convergencia_aditiva', 'no_active_wave');
        assert.equal(r4.notificado, true, 'una causa nueva sí se comunica');
        assert.equal(dropfiles(dir).length, 2);
    } finally { teardownTelegram(dir); }
});

test('#6117 SEC-2: si el audit no se pudo escribir, la reparación exitosa SÍ avisa', () => {
    // Se mutó quién puede despachar y no quedó registro de la operación. No
    // frena nada, pero el operador tiene que enterarse antes de seguir tocando.
    const dir = setupTelegram();
    try {
        pulpo.afterSuccessfulAutoRepair('convergencia_aditiva', [5689], { ok: true, audit_failed: true });
        const [t] = dropfileTexts(dir);
        assert.ok(t, 'el fallo de audit no puede ser silencioso');
        assert.ok(/registro/i.test(t), 'explica que no quedó registro');

        // Contraprueba: con el audit OK, la misma reparación es silenciosa.
        const antes = dropfiles(dir).length;
        pulpo.afterSuccessfulAutoRepair('convergencia_aditiva', [5690], { ok: true, audit_failed: false });
        assert.equal(dropfiles(dir).length, antes,
            'audit OK => sigue sin escribirle al operador');
    } finally { teardownTelegram(dir); }
});

test('#6117 CA-5: la N-ésima repetición de la misma reparación SÍ notifica como anomalía', () => {
    const dir = setupTelegram();
    try {
        // Umbral default 3. Las dos primeras son sanas y silenciosas.
        pulpo.afterSuccessfulAutoRepair('convergencia_aditiva', [1], { ok: true });
        assert.deepEqual(dropfiles(dir), [], '1a reparación: silenciosa');
        pulpo.afterSuccessfulAutoRepair('convergencia_aditiva', [2], { ok: true });
        assert.deepEqual(dropfiles(dir), [], '2a reparación: silenciosa');

        // La 3ª ya no es una auto-reparación sana: es un síntoma.
        pulpo.afterSuccessfulAutoRepair('convergencia_aditiva', [3], { ok: true });
        const textos = dropfileTexts(dir);
        assert.equal(textos.length, 1, '3a reparación: se avisa la anomalía recurrente');
        // Copy normativo M4 (CA-UX-3): conteo + ventana + etiqueta humana + R3.
        assert.ok(/Van 3 reparaciones/.test(textos[0]), 'dice cuántas veces se repitió');
        assert.ok(/en la última hora/.test(textos[0]), 'dice en qué ventana');
        assert.ok(/convergencia con la ola activa/.test(textos[0]), 'R4: etiqueta humana del tipo');
        assert.ok(!/convergencia_aditiva/.test(textos[0]), 'CA-UX-2: nunca la clave interna');
        assert.ok(/Qué hacer:/.test(textos[0]), 'R3: cierra con instrucción de reanudación');
    } finally { teardownTelegram(dir); }
});

// =============================================================================
// #6117 — Criterios UX (CA-UX-1..5) verificados como código
//
// El copy de este issue lo entregó UX como normativo (comentario de criterios).
// Estas aserciones evitan que una edición futura lo erosione sin que nadie lo
// note: son las reglas R1–R6 y P1–P6 expresadas como test.
// =============================================================================

const desyncCopy = require('../desync-copy');

// Los 4 mensajes que SÍ se emiten (M1–M4), en su forma canónica.
function todosLosMensajes() {
    return [
        desyncCopy.autoRepairFailureText({ issues: [4821, 4830], causa: 'no_active_wave' }),
        desyncCopy.autoRepairFailureText({ issues: [4821], gateRejected: true }),
        desyncCopy.autoRepairExceptionText(),
        desyncCopy.autoRepairAuditFailedText({ issues: [4821] }),
        desyncCopy.autoRepairRepetitionText({
            tipo: 'convergencia_aditiva', count: 3, windowMs: 3600000,
        }),
        desyncCopy.autoRepairRepetitionText({
            tipo: 'reparacion_aditiva_wave_add', count: 5, windowMs: 3600000,
        }),
    ];
}

test('#6117 CA-UX-1: el copy vive en desync-copy.js, no inline en pulpo.js', () => {
    // R6 — inline en pulpo.js es como nacieron los dos avisos que este issue
    // borró. Se afirma que el módulo expone los constructores de los 4 mensajes.
    for (const fn of ['autoRepairFailureText', 'autoRepairExceptionText',
        'autoRepairAuditFailedText', 'autoRepairRepetitionText', 'autoRepairLineaDashboard']) {
        assert.equal(typeof desyncCopy[fn], 'function', `desync-copy debe exponer ${fn}`);
    }
    // Y que pulpo.js NO reintrodujo literales de copy propios en estas ramas.
    const fuentePulpo = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    for (const literal of ['Volví a habilitar el dispatch', 'Intenté reponer', 'Tuve que repon']) {
        assert.ok(!fuentePulpo.includes(literal),
            `pulpo.js no debe traer copy inline de auto-reparación: "${literal}"`);
    }
});

test('#6117 CA-UX-2 / R4: ninguna superficie visible muestra las claves internas', () => {
    const superficies = todosLosMensajes();
    // La línea del dashboard también es superficie visible.
    superficies.push(desyncCopy.autoRepairLineaDashboard(
        { tipo: 'convergencia_aditiva', issues: [1], timestamp: new Date().toISOString() }, {}).texto);
    superficies.push(desyncCopy.autoRepairLineaDashboard(
        { tipo: 'reparacion_aditiva_wave_add', issues: [2], timestamp: new Date().toISOString() }, {}).texto);

    for (const s of superficies) {
        assert.ok(!/convergencia_aditiva/.test(s), `clave interna filtrada: ${s}`);
        assert.ok(!/reparacion_aditiva_wave_add/.test(s), `clave interna filtrada: ${s}`);
    }
    // Y el mapa de etiquetas humanas es un set CERRADO.
    assert.deepEqual(Object.keys(desyncCopy.AUTO_REPAIR_LABELS).sort(),
        ['convergencia_aditiva', 'reparacion_aditiva_wave_add']);
    assert.equal(desyncCopy.autoRepairLabel('convergencia_aditiva'), 'convergencia con la ola activa');
    assert.equal(desyncCopy.autoRepairLabel('reparacion_aditiva_wave_add'), 'reposición de una promoción tuya');
    // Un tipo desconocido degrada sin filtrar la clave cruda.
    assert.ok(!/tipo_raro/.test(desyncCopy.autoRepairLabel('tipo_raro')));
});

test('#6117 R1: ningún mensaje trae el número de issue del pipeline entre paréntesis', () => {
    // Es el problema #2 del issue: el (#5724) se confundía con los issues
    // reparados que aparecen dos líneas más abajo.
    for (const m of todosLosMensajes()) {
        const hits = m.match(/\(#\d{3,}\)/g) || [];
        assert.deepEqual(hits, [], `trazabilidad de código filtrada al operador: ${m}`);
    }
});

test('#6117 R3: toda alerta cierra con la instrucción de reanudación', () => {
    for (const m of todosLosMensajes()) {
        assert.ok(/Qué hacer:/.test(m), `sin instrucción de reanudación (#5134): ${m}`);
    }
});

test('#6117 R2: la consecuencia operativa va antes que el detalle en los mensajes de fallo', () => {
    // "No se lanza ningún agente" importa más que qué función falló.
    for (const m of [desyncCopy.autoRepairFailureText({ causa: 'x' }), desyncCopy.autoRepairExceptionText()]) {
        assert.ok(/no se lanza ningún agente/.test(m), `falta la consecuencia operativa: ${m}`);
        assert.ok(m.indexOf('no se lanza ningún agente') < m.indexOf('Qué hacer:'),
            'la consecuencia va antes del cierre');
    }
});

test('#6117 CA-UX-5 · P5: la línea del dashboard tiene empty-state explícito', () => {
    for (const vacio of [null, undefined, {}, { tipo: 'convergencia_aditiva' }]) {
        const l = desyncCopy.autoRepairLineaDashboard(vacio, {});
        assert.equal(l.vacio, true);
        assert.equal(l.texto, 'Sin auto-reparaciones registradas.',
            'la línea nunca se oculta ni queda en blanco');
    }
});

test('#6117 CA-UX-5 · P3: la antigüedad reusa desyncAgeText, no un formateador nuevo', () => {
    const now = Date.parse('2026-08-18T12:00:00.000Z');
    const ts = new Date(now - 135 * 60000).toISOString();   // 2 h 15 min
    const l = desyncCopy.autoRepairLineaDashboard(
        { tipo: 'convergencia_aditiva', issues: [1], timestamp: ts }, { nowMs: now });
    // Misma redacción que el resto de la vista.
    assert.equal(l.edad, desyncCopy.desyncAgeText(ts, now));
    assert.ok(/hace 2 h 15 min/.test(l.texto), `redacción divergente: ${l.texto}`);
});

test('#6117 CA-UX-5 · P4: el tope de chips reusa DSS_CHIPS_TOPE y no trunca en silencio', () => {
    const issues = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const l = desyncCopy.autoRepairLineaDashboard(
        { tipo: 'convergencia_aditiva', issues, timestamp: new Date().toISOString() }, {});
    const more = l.chips.filter((c) => c.tipo === 'more');
    assert.equal(l.chips.length, desyncCopy.DSS_CHIPS_TOPE + 1, 'tope + indicador');
    assert.equal(more.length, 1, 'el truncado se indica, no es silencioso');
    assert.equal(more[0].ocultos, issues.length - desyncCopy.DSS_CHIPS_TOPE);
    assert.ok(/\+3/.test(l.texto), `el +N tiene que verse: ${l.texto}`);
});

test('#6117 CA-UX-5 · P1/P6: es metadato salvo umbral superado, y nunca sólo color', () => {
    const base = { tipo: 'convergencia_aditiva', issues: [4821], timestamp: new Date().toISOString() };

    // P1 — caso normal: metadato, sin ascenso de jerarquía.
    const normal = desyncCopy.autoRepairLineaDashboard(base, {});
    assert.equal(normal.severidad, 'meta');
    assert.equal(normal.aviso, '');

    // P6 — umbral superado: sube a warning Y lo dice con texto explícito.
    const warn = desyncCopy.autoRepairLineaDashboard(base, {
        repeticion: { count: 3, ventana_ms: 3600000, superado: true },
    });
    assert.equal(warn.severidad, 'warn');
    assert.ok(/se repitió 3 veces en la última hora/.test(warn.texto),
        `la info no puede ir sólo en el color: ${warn.texto}`);

    // Repetición por debajo del umbral no asciende.
    const bajo = desyncCopy.autoRepairLineaDashboard(base, {
        repeticion: { count: 2, ventana_ms: 3600000, superado: false },
    });
    assert.equal(bajo.severidad, 'meta');
});

test('#6117: la ventana se dice en criollo, no en milisegundos', () => {
    assert.equal(desyncCopy.autoRepairWindowText(3600000), 'la última hora');
    assert.equal(desyncCopy.autoRepairWindowText(1800000), 'los últimos 30 min');
    assert.equal(desyncCopy.autoRepairWindowText(6 * 3600000), 'las últimas 6 h');
    // Config rota: no se rompe ni muestra NaN.
    for (const malo of [0, -1, NaN, null, undefined, 'una hora']) {
        assert.ok(desyncCopy.autoRepairWindowText(malo).length > 0);
        assert.ok(!/NaN/.test(desyncCopy.autoRepairWindowText(malo)));
    }
});

test('#6117 SEC-4: si no se pudo contar, M4 lo dice en vez de inventar un número', () => {
    const m = desyncCopy.autoRepairRepetitionText({
        tipo: 'convergencia_aditiva', windowMs: 3600000, ilegible: true,
    });
    assert.ok(/no pude contar/i.test(m), 'reconoce que no pudo contar');
    assert.ok(!/Van undefined/.test(m) && !/NaN/.test(m), 'nunca un número inventado');
    assert.ok(/Qué hacer:/.test(m), 'R3 se mantiene');
});
