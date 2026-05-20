// =============================================================================
// pipeline-states.test.js — Tests para los puntos de no retorno (#3417).
//
// Cobertura:
//   - CA-1: NO_RETURN_STATES + BLOCKED_REASON_TO_USER_MSG completos y alineados.
//   - CA-2: isNoReturnState clasifica correctamente cada estado.
//   - CA-3: fail-closed ante GH API caída, timeout, JSON malformado.
//   - CA-4: filesystem solo autoritativo para `archivado/`, no para deliveries.
//   - CA-6: validación estricta del parámetro `issue` (path traversal,
//           inputs malformados).
//   - CA-7 (SEC-NR-7): coverage del state machine contra config.yaml.
//   - CA-8 (SEC-NR-5): audit log con hash chain.
//   - CA-9: mensajes user-facing sin paths absolutos, sin leaks.
//   - CA-11 (SEC-NR-8): raw_command_preview pasa por redact.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const pipelineStates = require('../pipeline-states');
const auditLog = require('../audit-log');

const {
    NO_RETURN_STATES,
    BLOCKED_REASON_TO_USER_MSG,
    TERMINAL_LABELS,
    ARCHIVADO_PHASES,
    isNoReturnState,
    formatBlockedMessage,
    appendBlockedRejection,
    __internal,
} = pipelineStates;

const { validateIssueNumber, formatDateArgentine, findInArchivado } = __internal;

// -----------------------------------------------------------------------------
// Fakes / helpers
// -----------------------------------------------------------------------------

function makeTmpRoot(prefix = 'pipeline-states') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

function mkArchivado(root, pipeline, fase, fileName) {
    const dir = path.join(root, pipeline, fase, 'archivado');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), '');
    return dir;
}

/**
 * fakeGhRunner — devuelve respuestas scripted por args[1] (subcomando).
 * Para `gh issue view N --repo ... --json ...` mira args[2] como número.
 */
function scriptGhRunner(byIssue) {
    return function fakeGhRunner(args) {
        if (args[0] === 'issue' && args[1] === 'view') {
            const issueArg = args[2];
            const script = byIssue[issueArg];
            if (!script) {
                return { status: 1, stdout: '', stderr: 'not found' };
            }
            if (script.error) {
                return { status: 1, stdout: '', stderr: script.stderr || 'fail' };
            }
            if (script.timeout) {
                return { status: null, stdout: '', stderr: '', signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } };
            }
            if (script.malformed) {
                return { status: 0, stdout: 'not json at all', stderr: '' };
            }
            return {
                status: 0,
                stdout: JSON.stringify(script.payload),
                stderr: '',
            };
        }
        return { status: 1, stdout: '', stderr: 'unsupported' };
    };
}

/**
 * fakePrFetcher — emula `fetchPrInfoForIssue`. Retorna lo declarado o null.
 */
function scriptPrFetcher(byIssue) {
    return function (issue) {
        const k = String(issue);
        if (Object.prototype.hasOwnProperty.call(byIssue, k)) return byIssue[k];
        return null;
    };
}

// -----------------------------------------------------------------------------
// CA-1 — Constantes exportadas
// -----------------------------------------------------------------------------

test('CA-1: NO_RETURN_STATES incluye exactamente los 7 reasons cerrados', () => {
    assert.deepEqual([...NO_RETURN_STATES].sort(), [
        'archived',
        'github_api_unavailable',
        'issue_closed',
        'label_duplicate',
        'label_invalid',
        'label_wontfix',
        'pr_merged',
    ]);
});

test('CA-1: NO_RETURN_STATES está congelado (no se puede mutar accidentalmente)', () => {
    assert.throws(() => { NO_RETURN_STATES.push('hacked'); }, TypeError);
});

test('CA-1: BLOCKED_REASON_TO_USER_MSG cubre todos los reasons de NO_RETURN_STATES', () => {
    // SEC-NR-7 / CA-10 — completeness del dictionary.
    for (const reason of NO_RETURN_STATES) {
        assert.ok(
            typeof BLOCKED_REASON_TO_USER_MSG[reason] === 'string'
            && BLOCKED_REASON_TO_USER_MSG[reason].length > 0,
            `falta template para reason '${reason}'`
        );
    }
});

test('CA-1: TERMINAL_LABELS está sincronizado con los reasons label_*', () => {
    const labelReasons = NO_RETURN_STATES
        .filter(r => r.startsWith('label_'))
        .map(r => r.slice('label_'.length));
    assert.deepEqual([...TERMINAL_LABELS].sort(), labelReasons.sort());
});

// -----------------------------------------------------------------------------
// CA-6 — Validación estricta del parámetro `issue`
// -----------------------------------------------------------------------------

test('CA-6: validateIssueNumber acepta enteros positivos en rango', () => {
    assert.equal(validateIssueNumber(1), 1);
    assert.equal(validateIssueNumber(3417), 3417);
    assert.equal(validateIssueNumber(9999999), 9999999);
});

test('CA-6: validateIssueNumber rechaza inputs malformados', () => {
    const bad = [NaN, -1, 0, 0.5, 1.7, '3417', 3417.0001, null, undefined, {}, [], true, false, Infinity, -Infinity, 10_000_000, 100_000_000];
    for (const v of bad) {
        assert.throws(() => validateIssueNumber(v), TypeError, `debe rechazar ${String(v)}`);
    }
});

test('CA-6: isNoReturnState lanza TypeError ante input inválido (no se invoca gh)', async () => {
    let ghCalled = false;
    const fakeGh = () => { ghCalled = true; return { status: 1, stdout: '', stderr: '' }; };
    await assert.rejects(
        () => isNoReturnState('3417', { ghRunner: fakeGh }),
        TypeError
    );
    await assert.rejects(
        () => isNoReturnState(-1, { ghRunner: fakeGh }),
        TypeError
    );
    assert.equal(ghCalled, false, 'no debe invocar gh ante input inválido');
});

// -----------------------------------------------------------------------------
// CA-2 — Clasificación correcta de cada estado
// -----------------------------------------------------------------------------

test('CA-2: issue open sin labels terminales → blocked: false', async () => {
    const root = makeTmpRoot();
    const ghRunner = scriptGhRunner({
        '3417': { payload: { number: 3417, state: 'open', closedAt: null, stateReason: null, labels: [{ name: 'enhancement' }] } },
    });
    const r = await isNoReturnState(3417, { root, ghRunner, prFetcher: () => null });
    assert.equal(r.blocked, false);
});

test('CA-2: issue closed con PR mergeado → reason pr_merged', async () => {
    const root = makeTmpRoot();
    const ghRunner = scriptGhRunner({
        '3381': { payload: { number: 3381, state: 'closed', closedAt: '2026-05-19T15:30:00Z', stateReason: 'completed', labels: [] } },
    });
    const prFetcher = scriptPrFetcher({
        '3381': { number: 3402, state: 'MERGED', mergedAt: '2026-05-19T15:30:00Z' },
    });
    const r = await isNoReturnState(3381, { root, ghRunner, prFetcher });
    assert.equal(r.blocked, true);
    assert.equal(r.reason, 'pr_merged');
    assert.equal(r.reason_details.prNumber, 3402);
    assert.equal(r.reason_details.mergedAt, '2026-05-19T15:30:00Z');
});

test('CA-2: issue closed sin PR mergeado → reason issue_closed', async () => {
    const root = makeTmpRoot();
    const ghRunner = scriptGhRunner({
        '3300': { payload: { number: 3300, state: 'closed', closedAt: '2026-05-10T12:00:00Z', stateReason: 'not_planned', labels: [] } },
    });
    const prFetcher = scriptPrFetcher({ '3300': null });
    const r = await isNoReturnState(3300, { root, ghRunner, prFetcher });
    assert.equal(r.blocked, true);
    assert.equal(r.reason, 'issue_closed');
    assert.equal(r.reason_details.closedAt, '2026-05-10T12:00:00Z');
});

test('CA-2: PR existente pero state != MERGED → cae a issue_closed', async () => {
    const root = makeTmpRoot();
    const ghRunner = scriptGhRunner({
        '3301': { payload: { number: 3301, state: 'closed', closedAt: '2026-05-10T12:00:00Z', stateReason: 'completed', labels: [] } },
    });
    const prFetcher = scriptPrFetcher({
        '3301': { number: 99, state: 'CLOSED', mergedAt: null },
    });
    const r = await isNoReturnState(3301, { root, ghRunner, prFetcher });
    assert.equal(r.blocked, true);
    assert.equal(r.reason, 'issue_closed');
});

test('CA-2: issue open con label wontfix → reason label_wontfix', async () => {
    const root = makeTmpRoot();
    const ghRunner = scriptGhRunner({
        '1234': { payload: { number: 1234, state: 'open', closedAt: null, stateReason: null, labels: [{ name: 'wontfix' }, { name: 'enhancement' }] } },
    });
    const r = await isNoReturnState(1234, { root, ghRunner, prFetcher: () => null });
    assert.equal(r.blocked, true);
    assert.equal(r.reason, 'label_wontfix');
});

test('CA-2: labels duplicate / invalid también bloquean', async () => {
    const root = makeTmpRoot();
    const ghRunnerDup = scriptGhRunner({
        '111': { payload: { number: 111, state: 'open', closedAt: null, stateReason: null, labels: [{ name: 'Duplicate' }] } },
    });
    const r1 = await isNoReturnState(111, { root, ghRunner: ghRunnerDup, prFetcher: () => null });
    assert.equal(r1.reason, 'label_duplicate');

    const ghRunnerInv = scriptGhRunner({
        '222': { payload: { number: 222, state: 'open', closedAt: null, stateReason: null, labels: [{ name: 'invalid' }] } },
    });
    const r2 = await isNoReturnState(222, { root, ghRunner: ghRunnerInv, prFetcher: () => null });
    assert.equal(r2.reason, 'label_invalid');
});

// -----------------------------------------------------------------------------
// CA-3 / CA-4 — Fail-closed + archivado autoritativo
// -----------------------------------------------------------------------------

test('CA-3: GH API timeout → blocked github_api_unavailable', async () => {
    const root = makeTmpRoot();
    const ghRunner = scriptGhRunner({ '999': { timeout: true } });
    const r = await isNoReturnState(999, { root, ghRunner, prFetcher: () => null });
    assert.equal(r.blocked, true);
    assert.equal(r.reason, 'github_api_unavailable');
    assert.equal(r.reason_details.code, 'timeout');
});

test('CA-3: GH API stderr error → blocked github_api_unavailable', async () => {
    const root = makeTmpRoot();
    const ghRunner = scriptGhRunner({ '888': { error: true, stderr: 'rate limit' } });
    const r = await isNoReturnState(888, { root, ghRunner, prFetcher: () => null });
    assert.equal(r.blocked, true);
    assert.equal(r.reason, 'github_api_unavailable');
});

test('CA-3: GH API responde JSON malformado → blocked github_api_unavailable', async () => {
    const root = makeTmpRoot();
    const ghRunner = scriptGhRunner({ '777': { malformed: true } });
    const r = await isNoReturnState(777, { root, ghRunner, prFetcher: () => null });
    assert.equal(r.blocked, true);
    assert.equal(r.reason, 'github_api_unavailable');
});

test('CA-3: details.code es genérico, no expone stack ni paths', async () => {
    const root = makeTmpRoot();
    const ghRunner = scriptGhRunner({ '666': { error: true, stderr: 'C:\\secret\\path leaked' } });
    const r = await isNoReturnState(666, { root, ghRunner, prFetcher: () => null });
    assert.equal(r.blocked, true);
    // El code es 'non_zero_exit' o 'timeout' o similar — NO el stderr completo.
    assert.ok(!/secret|C:\\\\/.test(JSON.stringify(r.reason_details)),
        'reason_details no debe filtrar el stderr');
});

test('CA-4: issue archivado en disco → blocked archived (autoritativo)', async () => {
    const root = makeTmpRoot();
    mkArchivado(root, 'desarrollo', 'dev', '4242.android-dev');
    // GH dice open + sin labels — el filesystem manda.
    const ghRunner = scriptGhRunner({
        '4242': { payload: { number: 4242, state: 'open', closedAt: null, stateReason: null, labels: [] } },
    });
    const r = await isNoReturnState(4242, { root, ghRunner, prFetcher: () => null });
    assert.equal(r.blocked, true);
    assert.equal(r.reason, 'archived');
    assert.equal(r.reason_details.pipeline, 'desarrollo');
    assert.equal(r.reason_details.fase, 'dev');
});

test('CA-4: archivado tiene prioridad sobre GH state (chequea antes de invocar gh)', async () => {
    const root = makeTmpRoot();
    mkArchivado(root, 'definicion', 'analisis', '5555.po');
    let ghCalled = false;
    const ghRunner = () => { ghCalled = true; return { status: 0, stdout: '{"state":"open","labels":[]}', stderr: '' }; };
    const r = await isNoReturnState(5555, { root, ghRunner, prFetcher: () => null });
    assert.equal(r.blocked, true);
    assert.equal(r.reason, 'archived');
    assert.equal(ghCalled, false, 'archivado debe cortar antes de tocar gh');
});

// -----------------------------------------------------------------------------
// CA-6 — Path traversal defensa en findInArchivado
// -----------------------------------------------------------------------------

test('CA-6: findInArchivado ignora directorios fuera del prefijo permitido', () => {
    const root = makeTmpRoot();
    // Creamos un archivado válido y otro afuera (no debería listarse).
    mkArchivado(root, 'desarrollo', 'dev', '100.skill');
    const outside = path.join(root, 'fuera-del-pipeline');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, '100.skill'), '');
    const r = findInArchivado(100, { root });
    assert.equal(r.found, true);
    assert.equal(r.fase, 'dev');
    assert.equal(r.pipeline, 'desarrollo');
});

test('CA-6: findInArchivado retorna found:false cuando no existe el directorio', () => {
    const root = makeTmpRoot();
    const r = findInArchivado(9999, { root });
    assert.equal(r.found, false);
});

// -----------------------------------------------------------------------------
// CA-9 — Mensajes user-facing
// -----------------------------------------------------------------------------

test('CA-9: formatBlockedMessage retorna null si no está bloqueado', () => {
    assert.equal(formatBlockedMessage({ blocked: false }, 1234), null);
    assert.equal(formatBlockedMessage(null, 1234), null);
});

test('CA-9: formatBlockedMessage pr_merged incluye issue, prNumber y mergedAt formateado', () => {
    const msg = formatBlockedMessage({
        blocked: true,
        reason: 'pr_merged',
        reason_details: { prNumber: 3402, mergedAt: '2026-05-19T15:30:00Z' },
    }, 3381);
    assert.match(msg, /#3381/);
    assert.match(msg, /#3402/);
    assert.match(msg, /19\/05\/2026 15:30/); // formato argentino
    assert.match(msg, /delivery finalizado/);
    assert.match(msg, /^❌/);
});

test('CA-9: formatBlockedMessage issue_closed incluye closedAt formateado', () => {
    const msg = formatBlockedMessage({
        blocked: true,
        reason: 'issue_closed',
        reason_details: { closedAt: '2026-04-15T08:00:00Z' },
    }, 1000);
    assert.match(msg, /#1000/);
    assert.match(msg, /cerrado manualmente/);
    assert.match(msg, /15\/04\/2026 08:00/);
});

test('CA-9: formatBlockedMessage label_* incluye el label correcto en el texto', () => {
    const m1 = formatBlockedMessage({ blocked: true, reason: 'label_wontfix', reason_details: { label: 'wontfix' } }, 1);
    assert.match(m1, /\*\*wontfix\*\*/);
    const m2 = formatBlockedMessage({ blocked: true, reason: 'label_duplicate', reason_details: { label: 'duplicate' } }, 2);
    assert.match(m2, /\*\*duplicate\*\*/);
    const m3 = formatBlockedMessage({ blocked: true, reason: 'label_invalid', reason_details: { label: 'invalid' } }, 3);
    assert.match(m3, /\*\*invalid\*\*/);
});

test('CA-9: formatBlockedMessage github_api_unavailable usa ⏳ (no ❌)', () => {
    const msg = formatBlockedMessage({
        blocked: true,
        reason: 'github_api_unavailable',
        reason_details: { code: 'timeout' },
    }, 3417);
    assert.match(msg, /^⏳/);
    assert.match(msg, /#3417/);
    assert.match(msg, /unos segundos/);
    // G-UX-4: no debe nombrar GitHub explícitamente (no es leakeage de impl).
    assert.doesNotMatch(msg, /GitHub|gh api|http/i);
});

test('CA-9: ningún template del dictionary contiene paths absolutos (G-UX-1)', () => {
    // Regex que detecta paths Windows (`C:\...`) o POSIX (`/foo/bar`) y refs internas.
    const pathLike = /([A-Za-z]:\\)|(\/[a-z][a-z0-9_-]+\/[a-z][a-z0-9_-]+)|(\.pipeline\/)/i;
    for (const [reason, template] of Object.entries(BLOCKED_REASON_TO_USER_MSG)) {
        assert.doesNotMatch(template, pathLike, `template '${reason}' contiene path absoluto`);
        // Tampoco debe contener nombres de modulo internos.
        assert.doesNotMatch(template, /Kodein|tag=|stderr/i, `template '${reason}' contiene leakage técnica`);
    }
});

test('CA-9: formatBlockedMessage no falla si reason_details es vacío (placeholders → ?)', () => {
    const msg = formatBlockedMessage({ blocked: true, reason: 'pr_merged', reason_details: {} }, 100);
    assert.match(msg, /#100/);
    assert.match(msg, /\?/); // placeholders sin data quedan en '?'
});

// -----------------------------------------------------------------------------
// formatDateArgentine
// -----------------------------------------------------------------------------

test('formatDateArgentine convierte ISO8601 a DD/MM/YYYY HH:mm', () => {
    assert.equal(formatDateArgentine('2026-05-19T15:30:00Z'), '19/05/2026 15:30');
    assert.equal(formatDateArgentine('2026-01-01T00:00:00Z'), '01/01/2026 00:00');
});

test('formatDateArgentine devuelve string original si no parsea', () => {
    assert.equal(formatDateArgentine('not-a-date'), 'not-a-date');
    assert.equal(formatDateArgentine(''), '');
});

// -----------------------------------------------------------------------------
// CA-8 / SEC-NR-5 / SEC-NR-8 — Audit log
// -----------------------------------------------------------------------------

test('CA-8: appendBlockedRejection escribe entry con hash chain en archivo temporal', () => {
    const tmpFile = path.join(makeTmpRoot(), 'rejections.jsonl');
    const r = appendBlockedRejection({
        issue: 3417,
        blockedResult: {
            blocked: true,
            reason: 'pr_merged',
            reason_details: { prNumber: 3402, mergedAt: '2026-05-19T15:30:00Z' },
        },
        operatorChatId: '123456789',
        rawCommand: '/rechazar 3417 motivo de prueba',
        lockHeldMs: 45,
        file: tmpFile,
    });
    assert.equal(r.hash_prev, 'GENESIS');
    assert.match(r.hash_self, /^[a-f0-9]{64}$/);

    const verify = auditLog.verifyChain(tmpFile);
    assert.equal(verify.ok, true);
    assert.equal(verify.entriesChecked, 1);

    const entries = auditLog.readAll(tmpFile);
    const e = entries[0];
    assert.equal(e.issue, 3417);
    assert.equal(e.blocked_reason, 'pr_merged');
    assert.equal(e.reason_details.prNumber, 3402);
    assert.equal(e.reason_details.mergedAt, '2026-05-19T15:30:00Z');
    assert.match(e.operator_chat_id_hash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(e.lock_held_ms, 45);
});

test('SEC-NR-8 / CA-11: raw_command_preview pasa por redact (no filtra tokens)', () => {
    const tmpFile = path.join(makeTmpRoot(), 'rejections.jsonl');
    // Comando con un secreto simulado.
    appendBlockedRejection({
        issue: 1,
        blockedResult: { blocked: true, reason: 'archived', reason_details: { pipeline: 'desarrollo', fase: 'dev' } },
        operatorChatId: 'op',
        rawCommand: '/rechazar 1 con password=supersecret123 y token=abc.def.ghi',
        lockHeldMs: 10,
        file: tmpFile,
    });
    const entries = auditLog.readAll(tmpFile);
    const raw = entries[0].raw_command_preview;
    assert.doesNotMatch(raw, /supersecret123/, 'password no debe aparecer en plano');
});

test('SEC-NR-5: operator_chat_id se hashea, nunca persiste en plano', () => {
    const tmpFile = path.join(makeTmpRoot(), 'rejections.jsonl');
    appendBlockedRejection({
        issue: 1,
        blockedResult: { blocked: true, reason: 'archived', reason_details: {} },
        operatorChatId: '12345-LEO-CHATID',
        rawCommand: '/rechazar',
        lockHeldMs: 1,
        file: tmpFile,
    });
    const entries = auditLog.readAll(tmpFile);
    const e = entries[0];
    assert.doesNotMatch(JSON.stringify(e), /LEO-CHATID/, 'chat_id no debe aparecer en plano');
    assert.match(e.operator_chat_id_hash, /^sha256:[a-f0-9]{64}$/);
});

test('CA-8: reason_details normaliza backslashes a forward-slash para reproducibilidad cross-OS', () => {
    const tmpFile = path.join(makeTmpRoot(), 'rejections.jsonl');
    appendBlockedRejection({
        issue: 1,
        blockedResult: {
            blocked: true,
            reason: 'archived',
            reason_details: { pipeline: 'desarrollo\\dev' }, // string con backslash
        },
        operatorChatId: 'op',
        rawCommand: '/rechazar',
        lockHeldMs: 1,
        file: tmpFile,
    });
    const entries = auditLog.readAll(tmpFile);
    assert.equal(entries[0].reason_details.pipeline, 'desarrollo/dev');
});

test('CA-8: appendBlockedRejection rechaza blockedResult con reason fuera de NO_RETURN_STATES', () => {
    const tmpFile = path.join(makeTmpRoot(), 'rejections.jsonl');
    assert.throws(() => appendBlockedRejection({
        issue: 1,
        blockedResult: { blocked: true, reason: 'invented_reason' },
        operatorChatId: 'op',
        rawCommand: '/rechazar',
        file: tmpFile,
    }), /no está en NO_RETURN_STATES/);
});

test('CA-8: appendBlockedRejection rechaza issue inválido (defensa CA-6)', () => {
    assert.throws(() => appendBlockedRejection({
        issue: 'bad',
        blockedResult: { blocked: true, reason: 'archived', reason_details: {} },
        operatorChatId: 'op',
        rawCommand: '/rechazar',
        file: '/tmp/whatever.jsonl',
    }), TypeError);
});

test('CA-8: hash chain encadena entries consecutivas', () => {
    const tmpFile = path.join(makeTmpRoot(), 'rejections.jsonl');
    const r1 = appendBlockedRejection({
        issue: 1,
        blockedResult: { blocked: true, reason: 'archived', reason_details: {} },
        operatorChatId: 'op',
        rawCommand: '/rechazar 1',
        lockHeldMs: 1,
        file: tmpFile,
    });
    const r2 = appendBlockedRejection({
        issue: 2,
        blockedResult: { blocked: true, reason: 'issue_closed', reason_details: { closedAt: '2026-01-01T00:00:00Z' } },
        operatorChatId: 'op',
        rawCommand: '/rechazar 2',
        lockHeldMs: 2,
        file: tmpFile,
    });
    assert.equal(r2.hash_prev, r1.hash_self);
    const verify = auditLog.verifyChain(tmpFile);
    assert.equal(verify.ok, true);
    assert.equal(verify.entriesChecked, 2);
});

// -----------------------------------------------------------------------------
// SEC-NR-7 / CA-10 — Coverage del state machine contra config.yaml
// -----------------------------------------------------------------------------

test('SEC-NR-7: ARCHIVADO_PHASES cubre todas las fases declaradas en config.yaml', () => {
    // Carga directa de config.yaml — si alguien agrega una fase nueva en config
    // sin actualizar ARCHIVADO_PHASES, este test debe fallar.
    let yaml;
    try {
        yaml = require('js-yaml');
    } catch {
        // js-yaml debería estar instalado (lo usa rebote-classifier).
        assert.fail('js-yaml no disponible — instalalo en node_modules para SEC-NR-7');
        return;
    }
    const configPath = path.resolve(__dirname, '..', '..', 'config.yaml');
    const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
    const declaredPhases = [];
    for (const [pipelineName, def] of Object.entries(config.pipelines || {})) {
        for (const fase of def.fases || []) {
            declaredPhases.push(`${pipelineName}/${fase}`);
        }
    }
    const coveredPhases = ARCHIVADO_PHASES.map(p => `${p.pipeline}/${p.fase}`);

    // Cada fase declarada en config debe estar cubierta. Si se agrega una
    // nueva (ej. 'politica') sin actualizar ARCHIVADO_PHASES, este test
    // dispara el "silent bypass" de la guard que SEC-NR-7 quiere prevenir.
    for (const phase of declaredPhases) {
        assert.ok(
            coveredPhases.includes(phase),
            `Fase '${phase}' declarada en config.yaml pero falta en ARCHIVADO_PHASES`
        );
    }
});

test('SEC-NR-7: cada reason en NO_RETURN_STATES tiene template (y viceversa)', () => {
    const templateKeys = Object.keys(BLOCKED_REASON_TO_USER_MSG).sort();
    const reasonKeys = [...NO_RETURN_STATES].sort();
    assert.deepEqual(templateKeys, reasonKeys);
});
