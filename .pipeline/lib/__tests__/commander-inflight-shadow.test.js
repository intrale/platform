// =============================================================================
// commander-inflight-shadow.test.js — Tests para los detectores shadow del
// Commander (#3577, parte 1/2 del split de #3472).
//
// Cubre los CA del PO:
//   - CA-F1 — 4 detectores con su audit event correcto.
//   - CA-F2 — no-interferencia (no `proc.kill`, no `_inflightLocks`).
//   - CA-S2 / CA-S8 — allowlist de campos del payload (defense in depth).
//   - Tests negativos: R-1 (Skill in-flight), R-3 (finalResult), R-7 (cli_glitch).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const detectors = require('../commander/inflight-shadow-detectors');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function tmpPipelineDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inflight-shadow-'));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    return dir;
}

function readAuditLines(pipelineDir, now) {
    const file = detectors.auditFile(pipelineDir, now);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter(l => l.trim().length > 0)
        .map(l => JSON.parse(l));
}

// =============================================================================
// CA-F1 — Tests por detector (4 errorClasses)
// =============================================================================

test('CA-F1 · timeout_first_byte emite evento con shape correcto', () => {
    const pipelineDir = tmpPipelineDir();
    const now = 1_700_000_000_000;
    const entry = detectors.buildInflightSignalEntry({
        errorClass: 'timeout_first_byte',
        chatId: '12345',
        requestId: 'tg-aaa-1700000000000-bbcc',
        primaryProvider: 'anthropic',
        providerEffective: 'anthropic',
        startTime: now - 15000,
        now,
    });
    const ok = detectors.emitInflightSignal({ pipelineDir, entry, now });
    assert.equal(ok, true);

    const lines = readAuditLines(pipelineDir, now);
    assert.equal(lines.length, 1);
    const ev = lines[0];
    assert.equal(ev.event, 'inflight_signal_observed');
    assert.equal(ev.error_class, 'timeout_first_byte');
    assert.equal(ev.mode, 'shadow');
    assert.equal(ev.request_id, 'tg-aaa-1700000000000-bbcc');
    assert.equal(ev.primary_provider, 'anthropic');
    assert.equal(ev.provider_effective, 'anthropic');
    assert.equal(ev.primary_duration_ms, 15000);
    assert.equal(typeof ev.chat_id_hash, 'string');
    assert.notEqual(ev.chat_id_hash, '12345', 'chat_id_hash NUNCA plaintext');
    // hash-chain SHA-256 agrega `hash_prev` y `hash_self` — verificamos integridad.
    assert.equal(typeof ev.hash_self, 'string');
    assert.equal(typeof ev.hash_prev, 'string');
});

test('CA-F1 · timeout_no_new_bytes_30s emite evento con shape correcto', () => {
    const pipelineDir = tmpPipelineDir();
    const now = 1_700_000_030_000;
    const entry = detectors.buildInflightSignalEntry({
        errorClass: 'timeout_no_new_bytes_30s',
        chatId: '54321',
        requestId: 'tg-bbb-1700000000000-ddee',
        primaryProvider: 'anthropic',
        providerEffective: 'openai-codex',
        startTime: 1_700_000_000_000,
        now,
        partialOutput: 'parcial del LLM antes del gap',
    });
    const ok = detectors.emitInflightSignal({ pipelineDir, entry, now });
    assert.equal(ok, true);

    const [ev] = readAuditLines(pipelineDir, now);
    assert.equal(ev.error_class, 'timeout_no_new_bytes_30s');
    assert.equal(ev.provider_effective, 'openai-codex', 'soporta provider distinto al primary (R-4)');
    assert.equal(ev.primary_duration_ms, 30000);
    assert.equal(typeof ev.partial_output_hash, 'string');
    assert.equal(ev.partial_output_hash.length, 12, 'hash truncado a 12 hex');
});

test('CA-F1 · eof_premature emite evento con shape correcto', () => {
    const pipelineDir = tmpPipelineDir();
    const now = 1_700_000_005_000;
    const entry = detectors.buildInflightSignalEntry({
        errorClass: 'eof_premature',
        chatId: 'abc',
        requestId: 'req-eof-1',
        primaryProvider: 'anthropic',
        startTime: 1_700_000_000_000,
        now,
    });
    detectors.emitInflightSignal({ pipelineDir, entry, now });
    const [ev] = readAuditLines(pipelineDir, now);
    assert.equal(ev.error_class, 'eof_premature');
    assert.equal(ev.primary_duration_ms, 5000);
    assert.equal(ev.partial_output_hash, undefined, 'sin partial → sin hash');
});

test('CA-F1 · transient_5xx emite evento con shape correcto', () => {
    const pipelineDir = tmpPipelineDir();
    const now = 1_700_000_002_500;
    const entry = detectors.buildInflightSignalEntry({
        errorClass: 'transient_5xx',
        chatId: 'xyz',
        requestId: 'req-5xx-1',
        primaryProvider: 'anthropic',
        providerEffective: 'anthropic',
        startTime: 1_700_000_000_000,
        now,
    });
    detectors.emitInflightSignal({ pipelineDir, entry, now });
    const [ev] = readAuditLines(pipelineDir, now);
    assert.equal(ev.error_class, 'transient_5xx');
    assert.equal(ev.primary_duration_ms, 2500);
});

// =============================================================================
// CA-S8 / SR-S8 — Allowlist de campos del payload
// =============================================================================

test('CA-S8 · payload solo contiene campos del allowlist', () => {
    // Para los 4 errorClasses verificamos que el entry construido SOLO tiene
    // los campos permitidos. Defense in depth: si alguien en el futuro agrega
    // un campo de debug por accidente, el test rompe.
    const allowedSet = new Set(detectors.ALLOWED_FIELDS);
    for (const errorClass of detectors.ERROR_CLASSES) {
        const entry = detectors.buildInflightSignalEntry({
            errorClass,
            chatId: 'chat-1',
            requestId: 'req-1',
            primaryProvider: 'anthropic',
            providerEffective: 'anthropic',
            startTime: 1_700_000_000_000,
            now: 1_700_000_010_000,
            partialOutput: 'algo de output',
        });
        const keys = Object.keys(entry);
        for (const k of keys) {
            assert.ok(
                allowedSet.has(k),
                `errorClass=${errorClass}: campo "${k}" NO está en allowlist (${detectors.ALLOWED_FIELDS.join(',')})`
            );
        }
        // Campos PROHIBIDOS no deben aparecer.
        const PROHIBITED = ['prompt', 'partial_output', 'lastText', 'stderr_dump', 'text', 'content', 'headers', 'stack_trace'];
        for (const p of PROHIBITED) {
            assert.ok(!(p in entry), `errorClass=${errorClass}: campo prohibido "${p}" presente`);
        }
    }
});

test('CA-S8 · chat_id NUNCA aparece plaintext (solo hash truncado)', () => {
    const chatId = 'leakable-chat-id-12345';
    const entry = detectors.buildInflightSignalEntry({
        errorClass: 'timeout_first_byte',
        chatId,
        requestId: 'req-leak-1',
        primaryProvider: 'anthropic',
        startTime: 1_700_000_000_000,
        now: 1_700_000_015_000,
    });
    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes(chatId), `chatId plaintext leakeado: ${serialized}`);
    assert.equal(typeof entry.chat_id_hash, 'string');
    assert.equal(entry.chat_id_hash.length, 12);
});

test('CA-S8 · partial_output NUNCA aparece plaintext (solo hash)', () => {
    const sensitive = 'datos personales del usuario que NO deben loggearse';
    const entry = detectors.buildInflightSignalEntry({
        errorClass: 'timeout_no_new_bytes_30s',
        chatId: 'c',
        requestId: 'req-leak-2',
        primaryProvider: 'anthropic',
        startTime: 1_700_000_000_000,
        now: 1_700_000_030_000,
        partialOutput: sensitive,
    });
    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes(sensitive), `partial leakeado: ${serialized}`);
    assert.equal(typeof entry.partial_output_hash, 'string');
});

// =============================================================================
// CA-S6 / SR-S6 — request_id obligatorio
// =============================================================================

test('CA-S6 · buildInflightSignalEntry sin requestId tira error', () => {
    assert.throws(
        () => detectors.buildInflightSignalEntry({
            errorClass: 'timeout_first_byte',
            chatId: 'c',
            primaryProvider: 'anthropic',
            startTime: 1_700_000_000_000,
            now: 1_700_000_015_000,
        }),
        /request_id requerido/
    );
});

test('error_class inválido tira error', () => {
    assert.throws(
        () => detectors.buildInflightSignalEntry({
            errorClass: 'inventado',
            requestId: 'r',
            primaryProvider: 'anthropic',
            startTime: 1_700_000_000_000,
            now: 1_700_000_015_000,
        }),
        /invalid error_class/
    );
});

// =============================================================================
// CA-A1 — shouldFireFirstByte
// =============================================================================

test('CA-A1 · first-byte dispara cuando pasan 15s sin line', () => {
    assert.equal(
        detectors.shouldFireFirstByte({
            startTime: 1_700_000_000_000,
            now: 1_700_000_015_000,
            lastLineAt: 0,
            alreadyFired: false,
        }),
        true
    );
});

test('CA-A1 · first-byte NO dispara si ya hubo line', () => {
    assert.equal(
        detectors.shouldFireFirstByte({
            startTime: 1_700_000_000_000,
            now: 1_700_000_020_000,
            lastLineAt: 1_700_000_010_000,
            alreadyFired: false,
        }),
        false
    );
});

test('CA-A1 · first-byte NO se re-dispara (alreadyFired)', () => {
    assert.equal(
        detectors.shouldFireFirstByte({
            startTime: 1_700_000_000_000,
            now: 1_700_000_030_000,
            lastLineAt: 0,
            alreadyFired: true,
        }),
        false
    );
});

// =============================================================================
// CA-A2 / R-1 — shouldFireStreamGap
// =============================================================================

test('CA-A2 · stream-gap dispara con 30s+ sin nuevos lines', () => {
    assert.equal(
        detectors.shouldFireStreamGap({
            lastLineAt: 1_700_000_000_000,
            now: 1_700_000_030_001,
            pendingSkillCallsSize: 0,
            alreadyFired: false,
        }),
        true
    );
});

test('CA-A2.b / R-1 / SR-S5 · stream-gap NO dispara si hay Skill in-flight', () => {
    assert.equal(
        detectors.shouldFireStreamGap({
            lastLineAt: 1_700_000_000_000,
            now: 1_700_000_060_000, // 60s gap, debería disparar
            pendingSkillCallsSize: 1, // pero hay Skill in-flight
            alreadyFired: false,
        }),
        false,
        'R-1: el SKILL_WATCHDOG_MS cubre Skills, stream-gap no debe duplicar señal'
    );
});

test('CA-A2 · stream-gap NO dispara si todavía no llegó primer line', () => {
    assert.equal(
        detectors.shouldFireStreamGap({
            lastLineAt: 0,
            now: 1_700_000_030_000,
            pendingSkillCallsSize: 0,
            alreadyFired: false,
        }),
        false
    );
});

test('CA-A2 · stream-gap NO se re-dispara (alreadyFired)', () => {
    assert.equal(
        detectors.shouldFireStreamGap({
            lastLineAt: 1_700_000_000_000,
            now: 1_700_000_120_000,
            pendingSkillCallsSize: 0,
            alreadyFired: true,
        }),
        false
    );
});

// =============================================================================
// CA-A3 / R-3 — shouldFireEofPremature
// =============================================================================

test('CA-A3 · eof_premature dispara con code!=0 sin result ni text', () => {
    assert.equal(
        detectors.shouldFireEofPremature({
            code: 1,
            finalResult: null,
            lastText: '',
            alreadyFired: false,
        }),
        true
    );
});

test('CA-A3 · eof_premature dispara con code=null (signal kill) sin result', () => {
    assert.equal(
        detectors.shouldFireEofPremature({
            code: null,
            finalResult: null,
            lastText: '',
            alreadyFired: false,
        }),
        true
    );
});

test('CA-A3 / R-3 · eof_premature NO dispara si finalResult está seteado', () => {
    // Race con workaround claude-code#25629: result event llegó OK, después
    // `setTimeout(3s) → killProc → finish('result+kill')` produce code!=0
    // legítimo. NO debe contar como eof prematuro.
    assert.equal(
        detectors.shouldFireEofPremature({
            code: null,
            finalResult: { type: 'result', result: 'respuesta del LLM' },
            lastText: '',
            alreadyFired: false,
        }),
        false,
        'R-3: finalResult seteado bloquea eof_premature'
    );
});

test('CA-A3 · eof_premature NO dispara si hay lastText', () => {
    assert.equal(
        detectors.shouldFireEofPremature({
            code: 1,
            finalResult: null,
            lastText: 'texto parcial del asistente',
            alreadyFired: false,
        }),
        false
    );
});

test('CA-A3 · eof_premature NO dispara con code=0', () => {
    assert.equal(
        detectors.shouldFireEofPremature({
            code: 0,
            finalResult: null,
            lastText: '',
            alreadyFired: false,
        }),
        false
    );
});

// =============================================================================
// CA-A4 / R-7 / SR-S4 — detectTransient5xx
// =============================================================================

test('CA-A4 · transient_5xx detecta overloaded_error shape', () => {
    const evt = {
        is_error: true,
        error: { type: 'overloaded_error', message: 'Anthropic overloaded' },
    };
    assert.equal(detectors.detectTransient5xx(evt), true);
});

test('CA-A4 · transient_5xx detecta internal_server_error shape', () => {
    const evt = {
        is_error: true,
        error: { type: 'internal_server_error', message: '500' },
    };
    assert.equal(detectors.detectTransient5xx(evt), true);
});

test('CA-A4 · transient_5xx detecta service_unavailable_error shape', () => {
    const evt = {
        is_error: true,
        error: { type: 'service_unavailable_error', message: '503' },
    };
    assert.equal(detectors.detectTransient5xx(evt), true);
});

test('CA-A4 · transient_5xx detecta message.error.type wrappeado', () => {
    const evt = {
        is_error: true,
        message: { error: { type: 'gateway_timeout' } },
    };
    assert.equal(detectors.detectTransient5xx(evt), true);
});

test('CA-A4 / SR-S4 · transient_5xx NO match por substring sobre texto libre', () => {
    // Anti prompt-injection: el LLM responde "Error 503 internal" como texto
    // plano del asistente. Eso NO debe disparar la señal.
    const evt = {
        is_error: false,
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Error 503 internal server error overloaded_error' }] },
    };
    assert.equal(detectors.detectTransient5xx(evt), false);
});

test('CA-A4 / R-7 · transient_5xx EXCLUYE cli_1m_context_glitch', () => {
    // Shape de cli_1m_context_glitch: is_error:true + error.type que parece 5xx
    // pero el cliGlitchDetector devuelve true. NO debe disparar transient_5xx
    // (ya tiene canal dedicado oneMWorkaround.recordHit).
    const evt = {
        is_error: true,
        error: { type: 'overloaded_error', message: 'Usage credits required for 1M context' },
    };
    const cliGlitchDetector = (e) => true; // simula que el detector matcheó
    assert.equal(
        detectors.detectTransient5xx(evt, { cliGlitchDetector }),
        false,
        'R-7: cli_1m_context_glitch tiene canal dedicado, no es transient_5xx'
    );
});

test('CA-A4 · transient_5xx NO dispara si is_error=false', () => {
    const evt = { is_error: false, error: { type: 'overloaded_error' } };
    assert.equal(detectors.detectTransient5xx(evt), false);
});

test('CA-A4 · transient_5xx NO dispara con error type fuera del set', () => {
    const evt = { is_error: true, error: { type: 'invalid_request_error' } };
    assert.equal(detectors.detectTransient5xx(evt), false, 'invalid_request_error es 4xx, no transient');
});

test('CA-A4 · transient_5xx NO dispara si evt nulo o malformado', () => {
    assert.equal(detectors.detectTransient5xx(null), false);
    assert.equal(detectors.detectTransient5xx(undefined), false);
    assert.equal(detectors.detectTransient5xx({}), false);
    assert.equal(detectors.detectTransient5xx({ is_error: true }), false, 'sin error.type → no match');
});

// =============================================================================
// CA-F2 — no-interferencia con primitivas del wire-up real (CA-S7)
// =============================================================================

test('CA-F2 / CA-S7 · módulo shadow NO invoca decideInflightFallback ni locks', () => {
    // Defense in depth: el módulo shadow no debe siquiera tener llamadas
    // a las primitivas de wire-up real. Si en el futuro alguien las invoca
    // por error, este test rompe.
    //
    // Quitamos comentarios antes de chequear: las menciones en docstring
    // describen QUÉ no se hace; lo que importa es que no haya call sites.
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'commander', 'inflight-shadow-detectors.js'),
        'utf8'
    );
    // Strip block comments y line comments
    const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map(l => l.replace(/\/\/.*$/, ''))
        .join('\n');

    assert.ok(!/\bdecideInflightFallback\s*\(/.test(code), 'shadow NO debe invocar decideInflightFallback()');
    assert.ok(!/\bacquireInflightLock\s*\(/.test(code), 'shadow NO debe invocar acquireInflightLock()');
    assert.ok(!/\breleaseInflightLock\s*\(/.test(code), 'shadow NO debe invocar releaseInflightLock()');
    assert.ok(!/\bisLateResponseDuplicate\s*\(/.test(code), 'shadow NO debe invocar isLateResponseDuplicate()');
    assert.ok(!/\bproc\.kill\s*\(/.test(code), 'shadow NO debe matar procesos');
    // También verificamos que NO importa el módulo inflight-fallback (sería un
    // smell aunque no llame las funciones).
    assert.ok(!/require\(['"]\.\/inflight-fallback['"]\)/.test(code),
        'shadow NO debe requerir inflight-fallback.js');
});

// =============================================================================
// CA-S1 — hash-chain del audit log preservado tras emit
// =============================================================================

test('CA-S1 · emitInflightSignal preserva hash-chain del audit log', () => {
    const pipelineDir = tmpPipelineDir();
    const now1 = 1_700_000_010_000;
    const now2 = 1_700_000_015_000;
    const now3 = 1_700_000_020_000;

    // 3 eventos en secuencia → verificar que verifyChain pasa.
    for (const [ts, ec] of [[now1, 'timeout_first_byte'], [now2, 'eof_premature'], [now3, 'transient_5xx']]) {
        const entry = detectors.buildInflightSignalEntry({
            errorClass: ec,
            chatId: 'c',
            requestId: `req-${ts}`,
            primaryProvider: 'anthropic',
            startTime: 1_700_000_000_000,
            now: ts,
        });
        const ok = detectors.emitInflightSignal({ pipelineDir, entry, now: ts });
        assert.equal(ok, true);
    }

    const auditLog = require('../audit-log');
    const file = detectors.auditFile(pipelineDir, now1);
    const result = auditLog.verifyChain(file);
    assert.equal(result.ok, true, `verifyChain falló: ${JSON.stringify(result)}`);
});
