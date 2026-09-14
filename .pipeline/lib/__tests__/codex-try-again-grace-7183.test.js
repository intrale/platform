// =============================================================================
// codex-try-again-grace-7183.test.js — Un "try again at" que cayó en el mismo
// minuto del spawn no manda a codex a mañana (#7183).
//
// INCIDENTE QUE FIJA ESTA SUITE
// -----------------------------
// El 2026-09-10 a las 21:18:21 local el pipeline apagó `openai-codex` 24h con
// el tipo CORRECTO (`usage_limit_reached`, #7161) y con el reconciliador de
// #7181 corriendo. El frame crudo (`.pipeline/logs/5113-ux.attempt-2.log`):
//
//   {"type":"turn.failed","error":{"message":"You've hit your usage limit ...
//    try again at 9:18 PM."}}
//
// El CLI redondea el reset al minuto: "9:18 PM" era ESE minuto. La forma "sólo
// hora" del parser hizo `setHours(21,18)` → `21:18:00 <= now` → "ya pasó hoy,
// corresponde mañana" → +24h, que quedó 21 segundos por debajo del techo de
// sanidad de 24h. El reconciliador no pudo acortarlo: el rollout de ese spawn
// sólo traía el frame `premium` (ventanas en null) y los anteriores eran de
// hacía 9h (`measurement_predates_flag`).
//
// INVARIANTES QUE NO SE RELAJAN
// -----------------------------
// - Techo de sanidad de 24h y descarte de fechas pasadas MÁS ALLÁ de la gracia.
// - La forma "sólo hora" que pasó hace horas sigue yendo al cruce de mañana.
// - `setFlag` sigue sin degradar nunca al cap de 24h para este tipo.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedPipelineConfig } = require('./_test-helpers');
const { withEnv } = require('../test-helpers/with-env');

const dispatcher = require('../agent-launcher/dispatch-with-fallback');

// Frame REAL del incidente.
const FRAME_INCIDENTE = JSON.stringify({
    type: 'turn.failed',
    error: {
        message: "You've hit your usage limit. Upgrade to Pro "
            + '(https://openai.com/chatgpt/pricing) or try again at 9:18 PM.',
    },
});

// Anclajes en hora LOCAL (el mensaje no trae zona horaria).
const RESET_ANUNCIADO_LOCAL = new Date(2026, 8, 10, 21, 18, 0, 0);          // 9:18 PM de hoy
const NOW_INCIDENTE = new Date(2026, 8, 10, 21, 18, 21, 0).getTime();       // 21 s después

function conPipelineAislado(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-codex-7183-'));
    seedPipelineConfig(tmp);
    const sesiones = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-7183-sessions-'));
    const quotaPath = require.resolve('../quota-exhausted');
    try {
        return withEnv({ PIPELINE_DIR_OVERRIDE: tmp, CODEX_SESSIONS_DIR: sesiones }, () => {
            delete require.cache[quotaPath];
            const q = require('../quota-exhausted');
            return fn(q, tmp);
        });
    } finally {
        delete require.cache[quotaPath];
        fs.rmSync(sesiones, { recursive: true, force: true });
    }
}

function leerSlotCodex(tmp) {
    const flag = JSON.parse(fs.readFileSync(path.join(tmp, 'quota-exhausted.json'), 'utf8'));
    return (flag.providers && flag.providers['openai-codex']) || flag;
}

function spawnCapado(q, tmp, now) {
    return dispatcher.onSpawnExit({
        skill: 'ux',
        issue: 5113,
        provider: 'openai-codex',
        transport: 'cli',
        rawOutput: FRAME_INCIDENTE,
        exitCode: 1,
        durationMs: 3000,
        pipelineDir: tmp,
        quotaModule: q,
        now,
    });
}

const quota = require('../quota-exhausted');

// -----------------------------------------------------------------------------
// CA-1 · El parser no manda a mañana un reset que venció hace segundos
// -----------------------------------------------------------------------------

test('CA-1 · "9:18 PM" leído a las 21:18:21 es el reset de HOY, no el de mañana', () => {
    const iso = quota._parseCodexUsageLimitResetAt(
        JSON.parse(FRAME_INCIDENTE).error.message, { now: NOW_INCIDENTE });
    assert.equal(iso, RESET_ANUNCIADO_LOCAL.toISOString(),
        'el cap se liberó en ese minuto: sumar 24h es el apagón del incidente');
});

test('CA-1 · un reset anunciado dentro de la gracia se devuelve aunque sea anterior a now', () => {
    const now = RESET_ANUNCIADO_LOCAL.getTime() + quota.CODEX_ANNOUNCED_RESET_GRACE_MS - 1000;
    const iso = quota._parseCodexUsageLimitResetAt(
        "You've hit your usage limit, try again at 9:18 PM.", { now });
    assert.equal(iso, RESET_ANUNCIADO_LOCAL.toISOString());
});

test('CA-1 · la fecha completa también goza de la gracia', () => {
    const iso = quota._parseCodexUsageLimitResetAt(
        "You've hit your usage limit, try again at Sep 10th, 2026 9:18 PM.", { now: NOW_INCIDENTE });
    assert.equal(iso, RESET_ANUNCIADO_LOCAL.toISOString());
});

// -----------------------------------------------------------------------------
// CA-3 / CA-4 · Lo que ya funcionaba sigue igual fuera de la gracia
// -----------------------------------------------------------------------------

test('CA-3 · una fecha completa horas en el pasado sigue descartándose', () => {
    const now = new Date(2026, 8, 10, 12, 0, 0, 0).getTime();
    const iso = quota._parseCodexUsageLimitResetAt(
        "You've hit your usage limit, try again at Sep 10th, 2026 1:00 AM.", { now });
    assert.equal(iso, null);
});

test('CA-4 · la forma "sólo hora" que pasó hace horas sigue yendo al cruce de mañana', () => {
    const now = new Date(2026, 8, 9, 23, 17, 0, 0).getTime();
    const iso = quota._parseCodexUsageLimitResetAt(
        "You've hit your usage limit. Try again at 6:02 AM.", { now });
    assert.equal(iso, new Date(2026, 8, 10, 6, 2, 0, 0).toISOString());
});

test('CA-4 · justo fuera de la gracia la forma "sólo hora" vuelve a ser mañana', () => {
    const now = RESET_ANUNCIADO_LOCAL.getTime() + quota.CODEX_ANNOUNCED_RESET_GRACE_MS + 1000;
    const iso = quota._parseCodexUsageLimitResetAt(
        "You've hit your usage limit, try again at 9:18 PM.", { now });
    assert.equal(iso, new Date(2026, 8, 11, 21, 18, 0, 0).toISOString());
});

// -----------------------------------------------------------------------------
// CA-2 · El flag persistido gatea el mínimo, no 1h ni 24h
// -----------------------------------------------------------------------------

test('CA-2 · con el frame del incidente el gate dura el mínimo (5 min), no 24h', () => {
    conPipelineAislado((q, tmp) => {
        const r = spawnCapado(q, tmp, NOW_INCIDENTE);
        assert.equal(r.errorClass, 'quota_exhausted');
        assert.equal(r.flagSet, true);

        const slot = leerSlotCodex(tmp);
        assert.equal(slot.pattern_matched, 'usage_limit_reached');
        const gateMs = Date.parse(slot.resets_at) - NOW_INCIDENTE;
        assert.equal(gateMs, q.MIN_RESETS_AT_MS,
            `el cap ya venció: el gate es el mínimo auto-corrector (duró ${gateMs}ms)`);
    });
});

test('CA-2 · un reset anunciado a 2 min tampoco cae a la ventana fija de 1h', () => {
    conPipelineAislado((q, tmp) => {
        const now = new Date(2026, 8, 10, 21, 16, 0, 0).getTime(); // 2 min antes del 9:18 PM
        spawnCapado(q, tmp, now);
        const gateMs = Date.parse(leerSlotCodex(tmp).resets_at) - now;
        assert.equal(gateMs, q.MIN_RESETS_AT_MS);
        assert.ok(gateMs < q.CODEX_USAGE_LIMIT_RESET_MS);
    });
});

test('CA-2 · un reset anunciado a 3h se respeta tal cual (no se toca lo de #7161)', () => {
    conPipelineAislado((q, tmp) => {
        const now = new Date(2026, 8, 10, 18, 18, 0, 0).getTime(); // 3h antes del 9:18 PM
        spawnCapado(q, tmp, now);
        assert.equal(leerSlotCodex(tmp).resets_at, RESET_ANUNCIADO_LOCAL.toISOString());
    });
});
