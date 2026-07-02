// =============================================================================
// commander-inflight-fallback.test.js — #3886
//
// Test de REGRESIÓN a nivel escenario del fallback in-flight del Telegram
// Commander. Complementa a `inflight-executor.test.js` (unit del ejecutor) y a
// los tests del core `inflight-fallback.js`, verificando los criterios de
// aceptación del PO (#issuecomment-4866942720) sobre los MÓDULOS REALES
// (decisión + ejecución + lock), sin fakear `decide`:
//
//   CA-1 — Nunca silencio: para CUALQUIER desenlace del fallback in-flight,
//          exactamente uno de {runSecondary, onCanned} se dispara. El operador
//          siempre recibe respuesta (secundario) o canned informativo.
//   CA-2 — Rotación in-flight Anthropic→secundario: primario Anthropic cae
//          mid-request, hay secundario con cuota → se adquiere el lock real
//          (namespaced por chatId) y se spawnea el secundario. La respuesta
//          tardía del primario muerto se reconoce como duplicada.
//   CA-3 — Cadena agotada → canned humano: todos los secundarios gateados →
//          onCanned con mensaje natural (sin jerga técnica), executed:false.
//   CA-4 — Límite de diseño MAX_INFLIGHT_FALLBACKS=1 (reconciliación del Gherkin
//          original de 2 hops): un segundo fallback in-flight (attemptIndex>=1)
//          NO spawnea; responde canned. La cascada entre providers non-Anthropic
//          la maneja `advanceOrGiveUp` a nivel resolución, no este ejecutor.
//   CA-7 — Sin deadlock Commander↔Sherlock: locks con el mismo requestId pero
//          distinto namespace (chatId del Commander vs `issue-<n>` de Sherlock)
//          NO colisionan; el release de uno no afecta al otro.
//
// Framework: node:test (infra Node.js pura del pipeline V2, NO gradle).
// Seguridad (SR-S2/SR-7): se verifica que el parcial del primario NUNCA se
// vuelca literal al audit (solo hash) y que el canned no arrastra jerga interna.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const executor = require('../lib/inflight-executor');
const inflight = require('../lib/commander/inflight-fallback');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Dir temporal con `logs/` para que el core escriba el audit del turno.
function withTempPipeline(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd3886-'));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    try {
        return fn(dir);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
        inflight._resetInflightLocks();
    }
}

// Monkey-patch del cache de multi-provider para controlar el resolver del
// secundario sin depender de credenciales/config real (mismo patrón que el
// test de integración de inflight-executor.test.js). `resolution` es lo que
// devuelve `resolveCommanderProviderExcluding`.
function withFakeResolver(resolution, fn) {
    const mpPath = require.resolve('../lib/commander/multi-provider');
    const original = require.cache[mpPath];
    const fakeMP = {
        resolveCommanderProviderExcluding(excluded) {
            return typeof resolution === 'function' ? resolution(excluded) : resolution;
        },
    };
    require.cache[mpPath] = { exports: { ...((original && original.exports) || {}), ...fakeMP } };
    try {
        return fn();
    } finally {
        if (original) require.cache[mpPath] = original;
        else delete require.cache[mpPath];
    }
}

// Lee las entries del audit del día en el dir temporal.
function readAudit(dir) {
    const d = new Date();
    const f = path.join(dir, 'logs',
        `commander-dispatch-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}.jsonl`);
    if (!fs.existsSync(f)) return { entries: [], raw: '' };
    const raw = fs.readFileSync(f, 'utf8');
    return { entries: raw.split('\n').filter(Boolean).map(JSON.parse), raw };
}

// Corre un turno de fallback in-flight capturando qué callback se disparó.
function runTurn(opts) {
    const events = { runSecondary: null, canned: null, notice: null };
    const res = executor.runInflightFallback({
        skill: 'telegram-commander',
        primaryProvider: 'anthropic',
        primaryErrorClass: opts.errorClass || 'transient_5xx',
        primaryDurationMs: opts.primaryDurationMs != null ? opts.primaryDurationMs : 8_000,
        primaryPartialOutput: opts.partial != null ? opts.partial : 'PARCIAL-SECRETO-DEL-PRIMARIO',
        attemptIndex: opts.attemptIndex != null ? opts.attemptIndex : 0,
        budgetMs: opts.budgetMs,
        pipelineDir: opts.dir,
        lockNamespace: opts.lockNamespace || 'chat-1',
        requestId: opts.requestId || 'req-1',
        onNotice: (txt) => { events.notice = txt; },
        onCanned: (canned, reason) => { events.canned = { canned, reason }; },
        runSecondary: (dec) => { events.runSecondary = dec.secondaryProvider; },
        log: () => {},
    });
    return { res, events };
}

const CODEX_OK = {
    gated: false,
    provider: 'openai-codex',
    model: 'gpt-5-codex',
    handler: { providerDef: { supports_tool_use: true } },
    chainTried: ['anthropic', 'openai-codex'],
};

const ALL_GATED = {
    gated: true,
    provider: null,
    model: null,
    handler: null,
    chainTried: ['anthropic', 'openai-codex', 'gemini', 'cerebras', 'nvidia'],
    source: 'all-gated',
};

// -----------------------------------------------------------------------------
// CA-1 — Nunca silencio (invariante bloqueante).
// -----------------------------------------------------------------------------
test('CA-1 — con secundario disponible, el turno se resuelve por runSecondary (nunca silencio)', () => {
    withTempPipeline((dir) => {
        withFakeResolver(CODEX_OK, () => {
            const { res, events } = runTurn({ dir });
            // Exactamente uno de {runSecondary, canned} — nunca ninguno (silencio).
            assert.ok(events.runSecondary !== null || events.canned !== null, 'silencio: no respondió ni secundario ni canned');
            assert.equal(events.runSecondary, 'openai-codex');
            assert.equal(events.canned, null);
            assert.equal(res.executed, true);
        });
    });
});

test('CA-1 — sin secundario disponible, el turno se resuelve por canned (nunca silencio)', () => {
    withTempPipeline((dir) => {
        withFakeResolver(ALL_GATED, () => {
            const { res, events } = runTurn({ dir });
            assert.ok(events.runSecondary !== null || events.canned !== null, 'silencio: no respondió ni secundario ni canned');
            assert.equal(events.runSecondary, null);
            assert.ok(events.canned && typeof events.canned.canned === 'string' && events.canned.canned.length > 0);
            assert.equal(res.executed, false);
        });
    });
});

// -----------------------------------------------------------------------------
// CA-2 — Rotación in-flight Anthropic→secundario + lock late-response.
// -----------------------------------------------------------------------------
test('CA-2 — Anthropic cae mid-request → spawn del secundario y lock real adquirido', () => {
    withTempPipeline((dir) => {
        withFakeResolver(CODEX_OK, () => {
            const { res, events } = runTurn({ dir, requestId: 'req-ca2', lockNamespace: 'chat-ca2', errorClass: 'eof_premature' });
            assert.equal(res.executed, true);
            assert.equal(events.runSecondary, 'openai-codex');

            // El lock se adquirió ANTES del spawn: cualquier respuesta tardía del
            // primario muerto (mismo chatId+requestId) se reconoce como duplicada.
            assert.equal(
                inflight.isLateResponseDuplicate({ chatId: 'chat-ca2', requestId: 'req-ca2' }),
                true,
                'el lock in-flight no quedó adquirido tras el spawn del secundario',
            );

            // El core emitió la señal de DECISIÓN.
            const { entries, raw } = readAudit(dir);
            assert.ok(entries.some(e => e.event === 'inflight_fallback_initiated'), 'falta inflight_fallback_initiated en el audit');
            // SR-S2: el parcial del primario NUNCA se vuelca literal (solo hash).
            assert.ok(!raw.includes('PARCIAL-SECRETO-DEL-PRIMARIO'), 'el parcial del primario se filtró al audit');
        });
    });
});

// -----------------------------------------------------------------------------
// CA-3 — Cadena agotada → canned humano (sin jerga técnica).
// -----------------------------------------------------------------------------
test('CA-3 — todos los secundarios gateados → canned informativo, humano, sin jerga', () => {
    withTempPipeline((dir) => {
        withFakeResolver(ALL_GATED, () => {
            const { res, events } = runTurn({ dir, requestId: 'req-ca3' });
            assert.equal(res.executed, false);
            assert.equal(events.runSecondary, null, 'no debe spawnear secundario cuando todo está gateado');
            assert.ok(events.canned, 'debe responder canned');
            const msg = events.canned.canned;
            assert.ok(typeof msg === 'string' && msg.trim().length > 0, 'canned vacío');
            // G-1 (UX): sin jerga técnica interna en el mensaje al operador.
            for (const jerga of ['quota_exhausted', 'HARD_TIMEOUT', 'all_gated', 'error_code', 'stack']) {
                assert.ok(!msg.toLowerCase().includes(jerga.toLowerCase()), `el canned filtró jerga técnica: ${jerga}`);
            }
        });
    });
});

// -----------------------------------------------------------------------------
// CA-4 — MAX_INFLIGHT_FALLBACKS=1 (reconciliación del Gherkin de 2 hops).
// -----------------------------------------------------------------------------
test('CA-4 — segundo fallback in-flight (attemptIndex>=1) no spawnea: cap=1 respetado', () => {
    assert.equal(inflight.MAX_INFLIGHT_FALLBACKS, 1, 'el cap de diseño cambió — revisar re-análisis de seguridad/costo');
    withTempPipeline((dir) => {
        // Aunque el resolver tuviese un candidato, el cap corta ANTES (attemptIndex=1).
        withFakeResolver(CODEX_OK, () => {
            const { res, events } = runTurn({ dir, requestId: 'req-ca4', attemptIndex: 1 });
            assert.equal(res.executed, false, 'con attemptIndex=1 no debe ejecutar un segundo fallback in-flight');
            assert.equal(events.runSecondary, null);
            assert.ok(events.canned, 'debe responder canned al agotar el cap (nunca silencio)');
            const { entries } = readAudit(dir);
            assert.ok(entries.some(e => e.event === 'inflight_fallback_exhausted'), 'falta inflight_fallback_exhausted (cap)');
        });
    });
});

// -----------------------------------------------------------------------------
// CA-7 — Sin deadlock Commander↔Sherlock: namespaces aislados.
// -----------------------------------------------------------------------------
test('CA-7 — locks con mismo requestId y distinto namespace no colisionan', () => {
    withTempPipeline(() => {
        const requestId = 'req-shared';
        // Commander (namespace = chatId) y Sherlock (namespace = issue-N) con el
        // MISMO requestId: deben ser locks independientes.
        assert.equal(inflight.acquireInflightLock({ chatId: 'chat-99', requestId, secondaryProvider: 'openai-codex' }), true);
        assert.equal(inflight.acquireInflightLock({ chatId: 'issue-42', requestId, secondaryProvider: 'gemini' }), true);

        assert.equal(inflight.isLateResponseDuplicate({ chatId: 'chat-99', requestId }), true);
        assert.equal(inflight.isLateResponseDuplicate({ chatId: 'issue-42', requestId }), true);

        // Liberar el del Commander no debe afectar el de Sherlock (sin deadlock
        // ni release cruzado).
        assert.equal(inflight.releaseInflightLock({ chatId: 'chat-99', requestId }), true);
        assert.equal(inflight.isLateResponseDuplicate({ chatId: 'chat-99', requestId }), false);
        assert.equal(inflight.isLateResponseDuplicate({ chatId: 'issue-42', requestId }), true, 'el release del Commander liberó el lock de Sherlock (namespaces no aislados)');
    });
});

test('CA-7 — release de un requestId no afecta otro turno del mismo chat', () => {
    withTempPipeline(() => {
        inflight.acquireInflightLock({ chatId: 'chat-1', requestId: 'turn-A' });
        inflight.acquireInflightLock({ chatId: 'chat-1', requestId: 'turn-B' });
        inflight.releaseInflightLock({ chatId: 'chat-1', requestId: 'turn-A' });
        assert.equal(inflight.isLateResponseDuplicate({ chatId: 'chat-1', requestId: 'turn-A' }), false);
        assert.equal(inflight.isLateResponseDuplicate({ chatId: 'chat-1', requestId: 'turn-B' }), true);
    });
});
