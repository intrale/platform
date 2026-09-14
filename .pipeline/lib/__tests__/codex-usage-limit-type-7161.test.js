// =============================================================================
// codex-usage-limit-type-7161.test.js — El cap rolling de codex deja de
// apagarse 24h por un error_type adivinado (#7161).
//
// INCIDENTE QUE FIJA ESTA SUITE
// -----------------------------
// El 2026-09-09 a las 23:17Z el pipeline marcó `openai-codex` como cuota
// agotada por 24 HORAS mientras el CLI seguía mostrando cuota disponible. Las
// dos lecturas eran correctas: se agotó el cap ROLLING de sesión (96%), no la
// cuota semanal (31%). El frame crudo del spawn era:
//
//   {"type":"turn.failed","error":{"message":"You've hit your usage limit.
//    Upgrade to Pro ... or try again at Sep 10th, 2026 1:00 AM."}}
//
// Codex anunciaba que se liberaba a la 1:00 AM. El pipeline lo apagó hasta el
// día siguiente. La causa eran dos defectos encadenados:
//
//   1. `_detectOpenAI` resolvía bien el tipo (`usage_limit_reached`) y el
//      parser TIRABA ese valor: sólo devolvía `{errorClass, evidence}`.
//   2. El escritor del flag lo re-adivinaba reparseando el evidence. El frame
//      de codex sólo trae `error.message`, así que no encontraba candidato y
//      caía al "default safe" = `allowlist[0]` = `insufficient_quota` — que
//      semánticamente es "sin crédito/billing" y dispara el cap de 24h.
//
// Y de yapa, el `try again at <fecha>` del propio mensaje se ignoraba.
//
// INVARIANTES QUE NO SE RELAJAN
// -----------------------------
// SR-7 sigue vigente: el tipo propagado se REVALIDA contra la allowlist del
// provider antes de persistirse. La detección estructural de `insufficient_quota`
// (caso Cerebras 402 de #5978) no se toca.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedPipelineConfig } = require('./_test-helpers');
const { withEnv } = require('../test-helpers/with-env');

const parser = require('../agent-launcher/provider-error-parser');
const dispatcher = require('../agent-launcher/dispatch-with-fallback');

// Frame REAL del incidente (`.pipeline/logs/5113-pipeline-dev.attempt-2.log`).
const FRAME_INCIDENTE = JSON.stringify({
    type: 'turn.failed',
    error: {
        message: "You've hit your usage limit. Upgrade to Pro "
            + '(https://openai.com/chatgpt/pricing) or try again at Sep 10th, 2026 1:00 AM.',
    },
});

// El mensaje NO trae zona horaria: se interpreta en hora LOCAL del host. Por eso
// los anclajes del test se construyen con el constructor local, no con ISO — así
// la suite pasa en cualquier TZ.
const RESET_ANUNCIADO_LOCAL = new Date(2026, 8, 10, 1, 0, 0, 0); // Sep 10 2026, 1:00 AM local
const NOW_INCIDENTE = new Date(2026, 8, 9, 23, 17, 26, 0).getTime(); // ~2h antes

function newTmpPipelineDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-codex-7161-'));
    seedPipelineConfig(dir);
    return dir;
}

// Aislamiento de los tests que PERSISTEN flag: `.pipeline/` propio, fuente de
// sesiones Codex propia (para que el reconcile jamás lea las sesiones reales de
// la máquina) y módulo de cuota fresco atado a ese directorio. El entorno se
// restaura pase lo que pase vía `withEnv`.
function conPipelineAislado(fn) {
    const tmp = newTmpPipelineDir();
    const sesiones = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-7161-sessions-'));
    const quotaPath = require.resolve('../quota-exhausted');
    try {
        return withEnv({ PIPELINE_DIR_OVERRIDE: tmp, CODEX_SESSIONS_DIR: sesiones }, () => {
            delete require.cache[quotaPath];
            const q = require('../quota-exhausted');
            return fn(q, tmp);
        });
    } finally {
        // El módulo queda atado al tmp que estamos por borrar: lo sacamos del
        // cache para que el próximo `require` se reconstruya con el entorno real.
        delete require.cache[quotaPath];
        fs.rmSync(sesiones, { recursive: true, force: true });
    }
}

// Para los tests puros (detector, parser, selector) alcanza el módulo tal cual:
// ninguno escribe en disco.
const quota = require('../quota-exhausted');

// -----------------------------------------------------------------------------
// CA-4 · El "try again at <fecha>" del mensaje de control se parsea
// -----------------------------------------------------------------------------

test('CA-4 · parsea la fecha completa anunciada por codex ("Sep 10th, 2026 1:00 AM")', () => {
    const msg = JSON.parse(FRAME_INCIDENTE).error.message;
    const iso = quota._parseCodexUsageLimitResetAt(msg, { now: NOW_INCIDENTE });
    assert.equal(iso, RESET_ANUNCIADO_LOCAL.toISOString());
});

test('CA-4 · parsea la forma con sólo hora y la lleva al próximo cruce local', () => {
    const now = new Date(2026, 8, 9, 23, 17, 0, 0).getTime();
    const iso = quota._parseCodexUsageLimitResetAt(
        "You've hit your usage limit. Try again at 6:02 AM.", { now });
    assert.equal(iso, new Date(2026, 8, 10, 6, 2, 0, 0).toISOString(),
        'las 6:02 AM ya pasaron hoy → corresponde el cruce de mañana');
});

test('CA-4 · sin "try again at" no inventa fecha (cae a la ventana corta del caller)', () => {
    const iso = quota._parseCodexUsageLimitResetAt(
        "You've hit your usage limit. Upgrade to Pro.", { now: NOW_INCIDENTE });
    assert.equal(iso, null);
});

test('CA-4 · descarta una fecha anunciada en el pasado', () => {
    const now = new Date(2026, 8, 10, 12, 0, 0, 0).getTime();
    const iso = quota._parseCodexUsageLimitResetAt(
        "You've hit your usage limit, try again at Sep 10th, 2026 1:00 AM.", { now });
    assert.equal(iso, null);
});

test('CA-4 · descarta una fecha más lejana que el techo de sanidad de 24h', () => {
    const iso = quota._parseCodexUsageLimitResetAt(
        "You've hit your usage limit, try again at Sep 20th, 2026 1:00 AM.", { now: NOW_INCIDENTE });
    assert.equal(iso, null, 'un cap rolling no se libera en 10 días: es basura, no un reset');
});

// -----------------------------------------------------------------------------
// CA-1 · El errorType resuelto por el detector se propaga (no se tira)
// -----------------------------------------------------------------------------

test('CA-1 · _detectOpenAI devuelve el tipo Y el reset anunciado del frame real', () => {
    const evt = JSON.parse(FRAME_INCIDENTE);
    const allowlist = quota.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER['openai-codex'];
    const r = quota._detectOpenAI(evt, allowlist, { now: NOW_INCIDENTE });
    assert.equal(r.matched, true);
    assert.equal(r.errorType, 'usage_limit_reached');
    assert.equal(r.resetsAt, RESET_ANUNCIADO_LOCAL.toISOString());
});

test('CA-1 · parseProviderError propaga errorType y resetsAt hasta el veredicto', () => {
    const verdict = parser.parseProviderError(FRAME_INCIDENTE, {
        provider: 'openai-codex',
        transport: 'cli',
        exitCode: 1,
        durationMs: 4000,
        now: NOW_INCIDENTE,
    });
    assert.equal(verdict.errorClass, 'quota_exhausted');
    assert.equal(verdict.errorType, 'usage_limit_reached',
        'el tipo lo resolvió el detector: el parser NO puede descartarlo');
    assert.equal(verdict.resetsAt, RESET_ANUNCIADO_LOCAL.toISOString());
});

// -----------------------------------------------------------------------------
// CA-2 / CA-3 · El selector usa el tipo propagado; el degradado deja traza
// -----------------------------------------------------------------------------

test('CA-2 · _selectErrorTypeForFlag prefiere el tipo propagado sobre la adivinanza', () => {
    const verdict = {
        errorClass: 'quota_exhausted',
        evidence: FRAME_INCIDENTE,
        errorType: 'usage_limit_reached',
    };
    const elegido = dispatcher._selectErrorTypeForFlag('openai-codex', verdict, quota);
    assert.equal(elegido, 'usage_limit_reached');
    assert.notEqual(elegido, 'insufficient_quota',
        'insufficient_quota es el allowlist[0]: era el valor inventado del incidente');
});

test('CA-2 · SR-7 no se relaja: un tipo propagado fuera de la allowlist no se persiste', () => {
    const verdict = {
        errorClass: 'quota_exhausted',
        evidence: '{"type":"turn.failed"}',
        errorType: 'tipo_inventado_por_el_provider',
    };
    const degradados = [];
    const elegido = dispatcher._selectErrorTypeForFlag('openai-codex', verdict, quota, {
        onDegraded: (info) => degradados.push(info),
    });
    assert.equal(elegido, 'insufficient_quota', 'cae al default safe de la allowlist');
    assert.equal(degradados.length, 1);
    assert.equal(degradados[0].reason, 'propagated_type_out_of_allowlist');
});

test('CA-3 · el degradado a allowlist[0] deja traza explícita, no ocurre en silencio', () => {
    const verdict = { errorClass: 'quota_exhausted', evidence: 'texto libre sin shape' };
    const degradados = [];
    const elegido = dispatcher._selectErrorTypeForFlag('openai-codex', verdict, quota, {
        onDegraded: (info) => degradados.push(info),
    });
    assert.equal(elegido, 'insufficient_quota');
    assert.deepEqual(degradados, [{
        provider: 'openai-codex',
        chosen: 'insufficient_quota',
        reason: 'no_error_type_in_evidence',
        propagated: null,
    }]);
});

// -----------------------------------------------------------------------------
// CA-5 · End-to-end del incidente: qué queda persistido en el flag
// -----------------------------------------------------------------------------

function leerSlotCodex(tmp) {
    const flag = JSON.parse(fs.readFileSync(path.join(tmp, 'quota-exhausted.json'), 'utf8'));
    return (flag.providers && flag.providers['openai-codex']) || flag;
}

test('CA-5 · el flag persistido dice usage_limit_reached y respeta la hora anunciada', () => {
    conPipelineAislado((q, tmp) => {
        const r = dispatcher.onSpawnExit({
            skill: 'pipeline-dev',
            issue: 7161,
            provider: 'openai-codex',
            transport: 'cli',
            rawOutput: FRAME_INCIDENTE,
            exitCode: 1,
            durationMs: 4200,
            pipelineDir: tmp,
            quotaModule: q,
            now: NOW_INCIDENTE,
        });

        assert.equal(r.errorClass, 'quota_exhausted');
        assert.equal(r.flagSet, true);

        const slot = leerSlotCodex(tmp);
        assert.equal(slot.pattern_matched, 'usage_limit_reached',
            'el tipo que persiste es el que reportó el provider, no el default de la allowlist');
        assert.equal(slot.resets_at, RESET_ANUNCIADO_LOCAL.toISOString(),
            'el gate dura hasta la hora que anunció codex, no 24h clavadas');

        const gateMs = Date.parse(slot.resets_at) - NOW_INCIDENTE;
        assert.ok(gateMs < 3 * 60 * 60 * 1000, `el gate no puede durar 24h (duró ${gateMs}ms)`);
    });
});

test('CA-5 · sin fecha anunciada el gate cae a la ventana corta de 1h, nunca al cap de 24h', () => {
    conPipelineAislado((q, tmp) => {
        const frameSinFecha = JSON.stringify({
            type: 'error',
            message: "You've hit your usage limit. Upgrade to Pro.",
        });
        const r = dispatcher.onSpawnExit({
            skill: 'pipeline-dev',
            issue: 7161,
            provider: 'openai-codex',
            transport: 'cli',
            rawOutput: frameSinFecha,
            exitCode: 1,
            durationMs: 4200,
            pipelineDir: tmp,
            quotaModule: q,
            now: NOW_INCIDENTE,
        });
        assert.equal(r.flagSet, true);

        const slot = leerSlotCodex(tmp);
        assert.equal(slot.pattern_matched, 'usage_limit_reached');
        assert.equal(Date.parse(slot.resets_at), NOW_INCIDENTE + q.CODEX_USAGE_LIMIT_RESET_MS);
    });
});

test('CA-5 · un resets_at basura tampoco degrada al cap de 24h', () => {
    conPipelineAislado((q, tmp) => {
        q.setFlag({
            provider: 'openai-codex',
            errorType: 'usage_limit_reached',
            resetsAt: 'no soy una fecha',
            now: NOW_INCIDENTE,
        });
        const slot = leerSlotCodex(tmp);
        assert.equal(Date.parse(slot.resets_at), NOW_INCIDENTE + q.CODEX_USAGE_LIMIT_RESET_MS);
    });
});

// -----------------------------------------------------------------------------
// CA-6 · La detección estructural de insufficient_quota NO se relaja
// -----------------------------------------------------------------------------

test('CA-6 · el 402 de billing de Cerebras (#5978) sigue matcheando insufficient_quota', () => {
    const frame402 = JSON.stringify({
        error: {
            status: 402,
            message: 'Payment required to access this resource. Visit your billing tab.',
            code: 'insufficient_quota',
        },
    });
    const verdict = parser.parseProviderError(frame402, {
        provider: 'cerebras',
        transport: 'api',
        exitCode: 1,
        durationMs: 800,
    });
    assert.equal(verdict.errorClass, 'quota_exhausted');
    assert.equal(verdict.errorType, 'insufficient_quota');

    // Y ahora el tipo se persiste porque el provider LO REPORTÓ, no porque sea
    // el primer valor de la allowlist.
    const degradados = [];
    const elegido = dispatcher._selectErrorTypeForFlag('cerebras', verdict, quota, {
        onDegraded: (info) => degradados.push(info),
    });
    assert.equal(elegido, 'insufficient_quota');
    assert.equal(degradados.length, 0, 'no hubo adivinanza: el código vino en el frame');
});

test('CA-6 · un frame de texto libre de codex sin el patrón de límite no setea flag', () => {
    const verdict = parser.parseProviderError(
        JSON.stringify({ type: 'turn.failed', error: { message: 'network unreachable' } }),
        { provider: 'openai-codex', transport: 'cli', exitCode: 1, durationMs: 500, now: NOW_INCIDENTE },
    );
    assert.notEqual(verdict.errorClass, 'quota_exhausted');
    assert.equal(verdict.errorType, undefined);
});
