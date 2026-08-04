// =============================================================================
// Tests provider-pause-cause.js — Issue #5467
//
// Cobertura de los CA consolidados por el PO (CA-1..CA-13):
//   CA-1  · Desglose por proveedor con mapeo CERRADO reason_code → castellano.
//   CA-4  · Merge de períodos contiguos: la hora de reanudación es la REAL.
//   CA-6  · Frescura derivada de readTickIntervalMs, no hardcodeada.
//   CA-7  · Degradación sin excepción (ausente / corrupto / forma inesperada).
//   CA-8  · key_status / auth_mode nunca salen al texto.
//   CA-11 · Sólo lee archivos: ningún test requiere red.
//   CA-12 · TODO con fixtures inyectados por `opts`, NUNCA el snapshot vivo —
//           el estado rota en minutos (openai pasó de red/quota_exhausted_real
//           a green en dos horas el 03/08), atarse al archivo real produce
//           tests flaky por diseño.
//   CA-13 · Cuarta categoría `transitoria` (timeout / network_error / default).
//   SEC-4 · Prototype pollution + ids fuera del patrón seguro.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../provider-pause-cause');
const {
    classifyPauseCause,
    readHealthSnapshot,
    mergeContiguousPeriods,
    canonicalProviderId,
    formatPct,
    pickDominantCause,
    REASON_TABLE,
    CAUSE_REPOSO,
    CAUSE_CUOTA,
    CAUSE_AUTH,
    CAUSE_TRANSITORIA,
    CAUSE_DISPONIBLE,
} = mod;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TZ = 'America/Argentina/Buenos_Aires';

/** Lunes 21:00 ART. El caso exacto que CA-4 exige verificar. */
const MONDAY_2100_ART = Date.parse('2026-08-04T00:00:00Z');

/**
 * Schedule REAL de `anthropic` en disco, como fixture LITERAL (CA-12).
 * Lunes a jueves: dos períodos contiguos vía medianoche.
 * Viernes a domingo: sólo el bloque de madrugada, SIN bloque nocturno — el
 * merge tiene que tolerarlo sin inventar uno (advertencia de `guru`).
 */
function anthropicScheduleFixture() {
    const night = [{ start: '00:00', end: '07:00' }, { start: '20:00', end: '00:00' }];
    const dawn = [{ start: '00:00', end: '07:00' }];
    return {
        monday: night.map(p => ({ ...p })),
        tuesday: night.map(p => ({ ...p })),
        wednesday: night.map(p => ({ ...p })),
        thursday: night.map(p => ({ ...p })),
        friday: dawn.map(p => ({ ...p })),
        saturday: dawn.map(p => ({ ...p })),
        sunday: dawn.map(p => ({ ...p })),
    };
}

/** Módulo de schedule falso: `resting` es la lista de providers con ventana activa. */
function fakeScheduleModule(resting = [], schedule = anthropicScheduleFixture()) {
    return {
        isValidProvider: () => true,
        getProviderSchedule: (provider) => ({
            provider,
            active: resting.indexOf(provider) >= 0,
            schedule,
            timezone: TZ,
            updated_at: null,
        }),
    };
}

/** Crea un stateDir temporal con el contenido dado (string crudo o null). */
function withStateDir(rawContent) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-cause-'));
    if (rawContent !== null) {
        fs.writeFileSync(path.join(dir, 'multi-provider-health.json'), rawContent, 'utf8');
    }
    return dir;
}

function snapshotJson(providers, tsMs = MONDAY_2100_ART - 60_000) {
    return JSON.stringify({ ts: new Date(tsMs).toISOString(), providers });
}

function row(provider, reasonCode, extra = {}) {
    return {
        provider,
        label: extra.label || provider,
        state: extra.state || 'red',
        reason_code: reasonCode,
        quota: { pct: Object.prototype.hasOwnProperty.call(extra, 'pct') ? extra.pct : null },
        key_status: 'not_applicable',
        auth_mode: 'oauth',
    };
}

// ─── CA-4 · Merge de períodos contiguos ──────────────────────────────────────

test('CA-4 — merge cruza medianoche: lunes 21:00 informa 07:00, nunca 00:00', () => {
    const rmw = require('../rest-mode-window');
    const raw = anthropicScheduleFixture();
    const merged = mergeContiguousPeriods(raw);

    const sinMerge = rmw.nextWindowTransition(
        { active: true, schedule: raw, timezone: TZ }, MONDAY_2100_ART);
    const conMerge = rmw.nextWindowTransition(
        { active: true, schedule: merged, timezone: TZ }, MONDAY_2100_ART);

    // El comportamiento SIN merge es el defecto que CA-4 elimina: prometería
    // reanudación a medianoche cuando el pipeline sigue dormido hasta las 07:00.
    assert.equal(sinMerge.atHHMM, '00:00', 'sin merge el bug está presente (baseline)');
    assert.equal(conMerge.atHHMM, '07:00', 'con merge la hora es la real');
    assert.equal(conMerge.minutesFromNow, 600, '10 horas hasta las 07:00, no 3');
});

test('CA-4 — merge intra-día: 08:00-12:00 + 12:00-15:00 → termina 15:00', () => {
    const merged = mergeContiguousPeriods({
        monday: [{ start: '08:00', end: '12:00' }, { start: '12:00', end: '15:00' }],
    });
    assert.deepEqual(merged.monday, [{ start: '08:00', end: '15:00' }]);
});

test('CA-4 — merge tolera días sin bloque nocturno contiguo sin inventar uno', () => {
    const merged = mergeContiguousPeriods(anthropicScheduleFixture());
    // Sábado no tiene un período previo que termine en 00:00 (viernes sólo
    // tiene el bloque de madrugada), así que su 00:00-07:00 queda intacto.
    assert.deepEqual(merged.saturday, [{ start: '00:00', end: '07:00' }]);
    // Lunes conserva su bloque de madrugada porque el domingo no tiene nocturno.
    assert.ok(merged.monday.some(p => p.start === '00:00' && p.end === '07:00'));
});

test('CA-4 — el merge NO altera la detección de "está en reposo" en toda la semana', () => {
    // Anti-regresión: el merge sólo puede corregir la HORA de reanudación.
    // Si además cambiara qué momentos cuentan como reposo, estaríamos tocando
    // la semántica del gate de rest-mode que consume pulpo.js.
    const rmw = require('../rest-mode-window');
    const raw = anthropicScheduleFixture();
    const merged = mergeContiguousPeriods(raw);
    const winRaw = { active: true, schedule: raw, timezone: TZ };
    const winMerged = { active: true, schedule: merged, timezone: TZ };

    const base = Date.parse('2026-08-02T03:00:00Z'); // domingo 00:00 ART
    let divergencias = 0;
    for (let i = 0; i < 7 * 48; i++) {
        const t = base + i * 30 * 60_000;
        if (rmw.describeRestModeNow(winRaw, t).isWithinNow
            !== rmw.describeRestModeNow(winMerged, t).isWithinNow) divergencias++;
    }
    assert.equal(divergencias, 0, 'paridad total en 336 muestras de media hora');
});

test('CA-4 — el merge no muta el schedule original', () => {
    const raw = anthropicScheduleFixture();
    const antes = JSON.stringify(raw);
    mergeContiguousPeriods(raw);
    assert.equal(JSON.stringify(raw), antes);
});

test('merge descarta períodos con HH:MM inválido o degenerado', () => {
    const merged = mergeContiguousPeriods({
        monday: [
            { start: '25:00', end: '07:00' },   // hora imposible
            { start: '08:00', end: 'no-hora' }, // no matchea HH:MM
            { start: '09:00', end: '09:00' },   // degenerado
            { start: '10:00', end: '11:00' },   // válido
        ],
    });
    assert.deepEqual(merged.monday, [{ start: '10:00', end: '11:00' }]);
});

// ─── CA-7 / SEC-4 · Degradación y robustez del snapshot ──────────────────────

test('CA-7 — snapshot ausente degrada sin excepción', () => {
    const dir = path.join(os.tmpdir(), 'pause-cause-inexistente-5467');
    const snap = readHealthSnapshot({ stateDir: dir, now: MONDAY_2100_ART });
    assert.equal(snap.degraded, true);
    assert.deepEqual(Object.keys(snap.byProvider), []);

    const cause = classifyPauseCause(['anthropic'], { stateDir: dir, now: MONDAY_2100_ART });
    assert.equal(cause.degraded, true);
    assert.equal(cause.dominantCause, null);
    assert.equal(cause.verdict, null, 'sin datos no se afirma ninguna causa (UX-V2)');
});

test('CA-7 — JSON corrupto degrada sin excepción', () => {
    const dir = withStateDir('{ esto no es json valido ');
    const cause = classifyPauseCause(['anthropic'], { stateDir: dir, now: MONDAY_2100_ART });
    assert.equal(cause.degraded, true);
    assert.equal(cause.verdict, null);
});

test('CA-7 — JSON válido con forma inesperada (providers no-array) degrada', () => {
    for (const bad of ['{"ts":"2026-08-04T00:00:00Z","providers":{"anthropic":{}}}',
        '{"ts":"2026-08-04T00:00:00Z"}', '[]', '"texto"', 'null']) {
        const dir = withStateDir(bad);
        const snap = readHealthSnapshot({ stateDir: dir, now: MONDAY_2100_ART });
        assert.equal(snap.degraded, true, `debe degradar con: ${bad}`);
    }
});

test('SEC-4 — claves hostiles en el snapshot no contaminan el prototipo', () => {
    // JSON crudo a propósito: `JSON.stringify` de un objeto JS no puede emitir
    // una clave `__proto__` propia, que es justo el vector a probar. El archivo
    // lo escribe otro proceso, así que hay que asumir que puede traerla.
    const raw = [
        '{',
        `  "ts": "${new Date(MONDAY_2100_ART).toISOString()}",`,
        '  "providers": [',
        '    { "provider": "__proto__", "label": "x", "reason_code": "timeout" },',
        '    { "provider": "constructor", "label": "x", "reason_code": "timeout" },',
        '    { "provider": "anthropic", "label": "Anthropic", "reason_code": "timeout",',
        '      "__proto__": { "polluted": true },',
        '      "constructor": { "prototype": { "polluted": true } } }',
        '  ]',
        '}',
    ].join('\n');
    const dir = withStateDir(raw);

    const snap = readHealthSnapshot({ stateDir: dir, now: MONDAY_2100_ART });

    assert.equal({}.polluted, undefined, 'Object.prototype intacto');
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(({}).constructor, Object, 'constructor intacto');
    // `__proto__` no matchea /^[a-z][a-z0-9-]{0,32}$/ y se descarta. `constructor`
    // SÍ matchea (son todas minúsculas) y entra como id — y es inofensivo
    // justamente porque el índice se arma sobre un objeto SIN prototipo: no
    // pisa nada heredado y no se confunde con `Object.prototype.constructor`.
    assert.deepEqual(Object.keys(snap.byProvider), ['constructor', 'anthropic']);
    assert.equal(Object.getPrototypeOf(snap.byProvider), null);
    // Un provider no presente sigue dando `undefined`, no una función heredada.
    assert.equal(snap.byProvider.toString, undefined);
    assert.equal(snap.byProvider.hasOwnProperty, undefined);
    // Y la fila sólo tiene los campos que leímos por nombre.
    assert.deepEqual(
        Object.keys(snap.byProvider.anthropic).sort(),
        ['id', 'label', 'quotaPct', 'rawId', 'reasonCode', 'state'],
    );
});

test('SEC-4 — ids fuera del patrón seguro se descartan', () => {
    const dir = withStateDir(snapshotJson([
        row('Anthropic', 'timeout'),          // mayúsculas
        row('9provider', 'timeout'),          // arranca con dígito
        row('con espacio', 'timeout'),        // espacio
        row('a'.repeat(40), 'timeout'),       // supera 33 chars
        row('cerebras', 'timeout'),           // válido
    ]));
    const snap = readHealthSnapshot({ stateDir: dir, now: MONDAY_2100_ART });
    assert.deepEqual(Object.keys(snap.byProvider), ['cerebras']);
});

// ─── CA-6 · Frescura ─────────────────────────────────────────────────────────

test('CA-6 — ts más viejo que el umbral derivado marca stale', () => {
    const dir = withStateDir(snapshotJson([row('anthropic', 'timeout')], MONDAY_2100_ART - 47 * 60_000));
    const snap = readHealthSnapshot({ stateDir: dir, now: MONDAY_2100_ART, staleMs: 15 * 60_000 });
    assert.equal(snap.stale, true);
    assert.equal(snap.ageMinutes, 47);
});

test('CA-6 — ts fresco no marca stale', () => {
    const dir = withStateDir(snapshotJson([row('anthropic', 'timeout')], MONDAY_2100_ART - 60_000));
    const snap = readHealthSnapshot({ stateDir: dir, now: MONDAY_2100_ART, staleMs: 15 * 60_000 });
    assert.equal(snap.stale, false);
    assert.equal(snap.ageMinutes, 1);
});

test('CA-6 — ts ausente o no parseable se trata como stale (no se afirma frescura)', () => {
    for (const ts of [undefined, 'no-es-fecha', 12345678901234567890]) {
        const payload = { providers: [row('anthropic', 'timeout')] };
        if (ts !== undefined) payload.ts = ts;
        const dir = withStateDir(JSON.stringify(payload));
        const snap = readHealthSnapshot({ stateDir: dir, now: MONDAY_2100_ART });
        assert.equal(snap.stale, true, `ts=${ts} debe ser stale`);
    }
});

test('CA-6 — el umbral se DERIVA de la cadencia del cron, no está hardcodeado', () => {
    // 3 ticks de margen sobre la cadencia real (`readTickIntervalMs`).
    assert.equal(mod.staleThresholdMs({ staleMs: 999 }), 999, 'override explícito gana');
    const derivado = mod.staleThresholdMs({});
    assert.ok(Number.isFinite(derivado) && derivado > 0);
    assert.equal(derivado % mod.STALE_TICKS, 0, 'es un múltiplo entero de los ticks');
});

// ─── CA-1 / SEC-1 · Tabla de copy cerrada ────────────────────────────────────

test('CA-1 — cada reason_code de la tabla mapea a su copy y categoría', () => {
    const esperado = {
        authenticated: ['disponible', CAUSE_DISPONIBLE],
        cli_oauth_ok: ['disponible', CAUSE_DISPONIBLE],
        quota_exhausted: ['el proveedor la reporta agotada (sin medición)', CAUSE_CUOTA],
        rate_limited: ['frenado por límite de frecuencia', CAUSE_CUOTA],
        invalid_credentials: ['credenciales inválidas', CAUSE_AUTH],
        no_key_configured: ['sin credenciales configuradas', CAUSE_AUTH],
        forbidden: ['acceso denegado por el proveedor', CAUSE_AUTH],
        cli_license_unavailable: ['sin licencia CLI habilitada', CAUSE_AUTH],
        cli_unavailable: ['CLI no disponible', CAUSE_AUTH],
        cli_binary_undeclared: ['CLI sin declarar en la configuración', CAUSE_AUTH],
        unknown_provider: ['proveedor desconocido en la configuración', CAUSE_AUTH],
        timeout: ['sin respuesta a tiempo', CAUSE_TRANSITORIA],
        network_error: ['error de red', CAUSE_TRANSITORIA],
        unknown: ['motivo desconocido', CAUSE_TRANSITORIA],
    };
    for (const [code, [text, cause]] of Object.entries(esperado)) {
        const dir = withStateDir(snapshotJson([row('cerebras', code)]));
        const res = classifyPauseCause(['cerebras'], {
            stateDir: dir, now: MONDAY_2100_ART, scheduleModule: fakeScheduleModule([]),
        });
        assert.equal(res.providers[0].text, text, `copy de ${code}`);
        assert.equal(res.providers[0].cause, cause, `categoría de ${code}`);
    }
});

test('CA-1 — la tabla cubre TODOS los ALLOWED_REASON_CODES del cron', () => {
    // Un código sin fila es un bug de copy, no un caso de default silencioso
    // (UX-3). Si el cron agrega un código nuevo, este test lo caza.
    const { ALLOWED_REASON_CODES } = require('../multi-provider/health-alerts');
    const faltantes = Array.from(ALLOWED_REASON_CODES)
        .filter(c => !Object.prototype.hasOwnProperty.call(REASON_TABLE, c));
    assert.deepEqual(faltantes, [], `códigos sin copy en REASON_TABLE: ${faltantes.join(', ')}`);
});

test('SEC-1 — reason_code fuera de la tabla cae al default, sin interpolar el crudo', () => {
    const dir = withStateDir(snapshotJson([row('cerebras', 'codigo_inventado_maligno_*_')]));
    const res = classifyPauseCause(['cerebras'], {
        stateDir: dir, now: MONDAY_2100_ART, scheduleModule: fakeScheduleModule([]),
    });
    assert.equal(res.providers[0].text, 'motivo desconocido');
    assert.equal(res.providers[0].cause, CAUSE_TRANSITORIA);
    assert.ok(!res.providers[0].text.includes('maligno'), 'el código crudo NUNCA se interpola');
});

test('UX-2 — quota_exhausted_real dice el porcentaje; sin medición no lo inventa', () => {
    const conPct = withStateDir(snapshotJson([row('openai', 'quota_exhausted_real', { pct: 94 })]));
    const sinPct = withStateDir(snapshotJson([row('openai', 'quota_exhausted_real', { pct: null })]));
    const opts = { now: MONDAY_2100_ART, scheduleModule: fakeScheduleModule([]) };

    assert.equal(
        classifyPauseCause(['openai-codex'], { ...opts, stateDir: conPct }).providers[0].text,
        'cuota agotada (94 %)');
    assert.equal(
        classifyPauseCause(['openai-codex'], { ...opts, stateDir: sinPct }).providers[0].text,
        'cuota agotada', 'sin medición no se escribe "(— %)"');
});

test('formatPct clampea y redondea; sin número devuelve vacío', () => {
    assert.equal(formatPct(94), '94 %');
    assert.equal(formatPct(93.6), '94 %');
    assert.equal(formatPct(150), '100 %');
    assert.equal(formatPct(-5), '0 %');
    assert.equal(formatPct(null), '');
    assert.equal(formatPct('mucha'), '');
});

// ─── CA-8 / SEC-3 · Postura de seguridad ─────────────────────────────────────

test('CA-8 — key_status y auth_mode nunca llegan a la clasificación', () => {
    const dir = withStateDir(snapshotJson([
        row('cerebras', 'invalid_credentials', { label: 'Cerebras' }),
    ]));
    const res = classifyPauseCause(['cerebras'], {
        stateDir: dir, now: MONDAY_2100_ART, scheduleModule: fakeScheduleModule([]),
    });
    const serializado = JSON.stringify(res);
    assert.ok(!serializado.includes('auth_mode'), 'auth_mode fuera');
    assert.ok(!serializado.includes('key_status'), 'key_status fuera');
    assert.ok(!serializado.includes('oauth'), 'el modo de auth no se propaga');
    assert.ok(!serializado.includes('not_applicable'));
});

// ─── CA-13 · Categorías y precedencia ────────────────────────────────────────

test('CA-13 — precedencia auth > cuota > transitoria > reposo', () => {
    const p = (cause) => ({ cause });
    assert.equal(pickDominantCause([p(CAUSE_REPOSO), p(CAUSE_TRANSITORIA)]), CAUSE_TRANSITORIA);
    assert.equal(pickDominantCause([p(CAUSE_TRANSITORIA), p(CAUSE_CUOTA)]), CAUSE_CUOTA);
    assert.equal(pickDominantCause([p(CAUSE_CUOTA), p(CAUSE_AUTH)]), CAUSE_AUTH);
    assert.equal(pickDominantCause([p(CAUSE_REPOSO), p(CAUSE_AUTH), p(CAUSE_CUOTA)]), CAUSE_AUTH);
    assert.equal(pickDominantCause([p(CAUSE_DISPONIBLE)]), null, 'disponible nunca domina');
    assert.equal(pickDominantCause([]), null);
});

test('CA-3 — reposo domina sólo si TODAS las no disponibles están en reposo', () => {
    const dir = withStateDir(snapshotJson([
        row('anthropic', 'cli_oauth_ok', { label: 'Anthropic', state: 'green' }),
        row('openai', 'cli_oauth_ok', { label: 'OpenAI / Codex', state: 'green' }),
    ]));
    const res = classifyPauseCause(['anthropic', 'openai-codex'], {
        stateDir: dir,
        now: MONDAY_2100_ART,
        scheduleModule: fakeScheduleModule(['anthropic', 'openai-codex']),
    });
    assert.equal(res.dominantCause, CAUSE_REPOSO);
    assert.equal(res.verdict.requiresAction, false);
    assert.match(res.verdict.text, /reanuda mañana 07:00/,
        'la hora es la del bloque FUSIONADO, no la medianoche');
});

test('CA-13 — timeout como causa dominante no manda al operador a reautenticar', () => {
    const dir = withStateDir(snapshotJson([
        row('nvidia-nim', 'timeout', { label: 'NVIDIA NIM' }),
        row('cerebras', 'network_error', { label: 'Cerebras' }),
    ]));
    const res = classifyPauseCause(['nvidia-nim', 'cerebras'], {
        stateDir: dir, now: MONDAY_2100_ART, scheduleModule: fakeScheduleModule([]),
    });
    assert.equal(res.dominantCause, CAUSE_TRANSITORIA);
    assert.equal(res.verdict.requiresAction, false, 'no hay acción que el operador pueda tomar');
    assert.match(res.verdict.text, /Se recupera solo/);
    assert.ok(!/\d{2}:\d{2}/.test(res.verdict.text), 'sin hora: no la conocemos, no la inventamos');
});

test('un provider en reposo Y con la cuota agotada muestra la cuota, no el reposo', () => {
    // El reposo se resuelve solo; la cuota SOBREVIVE al despertar. Mostrar
    // "en reposo hasta 07:00" prometería una recuperación que no va a ocurrir.
    const dir = withStateDir(snapshotJson([
        row('openai', 'quota_exhausted_real', { label: 'OpenAI / Codex', pct: 94 }),
    ]));
    const res = classifyPauseCause(['openai-codex'], {
        stateDir: dir, now: MONDAY_2100_ART, scheduleModule: fakeScheduleModule(['openai-codex']),
    });
    assert.equal(res.dominantCause, CAUSE_CUOTA);
    assert.equal(res.providers[0].text, 'cuota agotada (94 %)');
});

test('un provider en reposo con motivo transitorio NO se titula pausa programada', () => {
    // `transitoria` gana al reposo por la tabla de precedencia. Es deliberado y
    // conservador: un provider que además no responde puede seguir sin
    // responder al despertar, así que no corresponde prometer `🌙 programada`
    // con hora exacta.
    const dir = withStateDir(snapshotJson([row('anthropic', 'timeout', { label: 'Anthropic' })]));
    const res = classifyPauseCause(['anthropic'], {
        stateDir: dir, now: MONDAY_2100_ART, scheduleModule: fakeScheduleModule(['anthropic']),
    });
    assert.equal(res.dominantCause, CAUSE_TRANSITORIA);
    assert.equal(res.providers[0].text, 'sin respuesta a tiempo');
    assert.equal(res.verdict.requiresAction, false);
});

test('un provider en reposo y verde muestra el reposo, no "disponible"', () => {
    // Único caso donde el reposo gana: está sano pero la ventana lo tiene
    // dormido. Decir "disponible" sería mentirle al operador.
    const dir = withStateDir(snapshotJson([
        row('anthropic', 'cli_oauth_ok', { label: 'Anthropic', state: 'green' }),
    ]));
    const res = classifyPauseCause(['anthropic'], {
        stateDir: dir, now: MONDAY_2100_ART, scheduleModule: fakeScheduleModule(['anthropic']),
    });
    assert.equal(res.dominantCause, CAUSE_REPOSO);
    assert.match(res.providers[0].text, /^en reposo hasta /);
});

// ─── R3 · Fail-open del schedule ─────────────────────────────────────────────

test('R3 — sin schedule activo un provider NUNCA se clasifica en reposo', () => {
    const dir = withStateDir(snapshotJson([row('anthropic', 'cli_oauth_ok', { state: 'green' })]));
    const res = classifyPauseCause(['anthropic'], {
        stateDir: dir,
        now: MONDAY_2100_ART,
        scheduleModule: {
            isValidProvider: () => true,
            getProviderSchedule: () => ({ provider: 'anthropic', active: false, schedule: {}, timezone: TZ }),
        },
    });
    assert.notEqual(res.providers[0].cause, CAUSE_REPOSO);
});

test('R3 — si getProviderSchedule tira, degradamos a "no está en reposo"', () => {
    const dir = withStateDir(snapshotJson([row('anthropic', 'cli_oauth_ok', { state: 'green' })]));
    const res = classifyPauseCause(['anthropic'], {
        stateDir: dir,
        now: MONDAY_2100_ART,
        scheduleModule: {
            isValidProvider: () => true,
            getProviderSchedule: () => { throw new Error('disco roto'); },
        },
    });
    assert.notEqual(res.providers[0].cause, CAUSE_REPOSO);
});

test('R5 — provider fuera de VALID_PROVIDERS no rompe: cae a transitoria', () => {
    const dir = withStateDir(snapshotJson([]));
    const res = classifyPauseCause(['provider-inexistente'], {
        stateDir: dir,
        now: MONDAY_2100_ART,
        scheduleModule: { isValidProvider: () => false, getProviderSchedule: () => null },
    });
    assert.equal(res.providers[0].cause, CAUSE_TRANSITORIA);
    assert.equal(res.providers[0].text, 'motivo desconocido');
});

// ─── Alias de ids ────────────────────────────────────────────────────────────

test('el alias openai → openai-codex cruza la fila de salud con la cadena', () => {
    // El cron persiste `openai`; las cadenas usan `openai-codex`. Sin el alias
    // el desglose no encontraría la fila y diría "motivo desconocido".
    assert.equal(canonicalProviderId('openai'), 'openai-codex');
    assert.equal(canonicalProviderId('anthropic'), 'anthropic');
    assert.equal(canonicalProviderId('MAYUSCULA'), null);
    assert.equal(canonicalProviderId(null), null);

    const dir = withStateDir(snapshotJson([
        row('openai', 'quota_exhausted_real', { label: 'OpenAI / Codex', pct: 94 }),
    ]));
    const res = classifyPauseCause(['openai-codex'], {
        stateDir: dir, now: MONDAY_2100_ART, scheduleModule: fakeScheduleModule([]),
    });
    assert.equal(res.providers[0].text, 'cuota agotada (94 %)');
});

test('la cadena deduplica providers repetidos preservando el orden', () => {
    const dir = withStateDir(snapshotJson([row('anthropic', 'timeout')]));
    const res = classifyPauseCause(['anthropic', 'openai', 'openai-codex', 'anthropic'], {
        stateDir: dir, now: MONDAY_2100_ART, scheduleModule: fakeScheduleModule([]),
    });
    assert.deepEqual(res.providers.map(p => p.id), ['anthropic', 'openai-codex']);
});

// ─── CA-11 · Sin chequeos en línea ───────────────────────────────────────────

test('CA-11 — el clasificador no expone ninguna vía de chequeo en línea', () => {
    // El módulo sólo debe leer archivos. Si alguien agrega un ping, este test
    // no lo caza — pero sí caza que se importe el cliente de completions o el
    // live-ping, que es la forma en que entraría.
    const src = fs.readFileSync(require.resolve('../provider-pause-cause'), 'utf8');
    assert.ok(!src.includes("require('./multi-provider/live-ping')"));
    assert.ok(!src.includes("require('./multi-provider/completion-client')"));
    assert.ok(!/\bfetch\s*\(/.test(src), 'sin fetch');
    assert.ok(!src.includes("require('node:https')") && !src.includes("require('https')"));
});
