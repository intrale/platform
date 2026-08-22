// =============================================================================
// commander-issue-creation.test.js — Tests del módulo de delegación a /doc y
// /planner cuando el Telegram Commander recibe pedidos de creación de issues
// (#3250).
//
// Cubre:
//   CA-1     — detectIssueCreationIntent clasifica simple vs split.
//   SEC-1    — allowlist constante y sin mutación.
//   SEC-2    — getAllowedSenderIds parsea env + isSenderAllowed valida ID.
//   SEC-3    — sanitizeIssueCreationInput trunca, strip control/ANSI, preserva
//              quotes y backticks.
//   SEC-4    — logSkillInvocation escribe JSONL bien formado, crea logs/ si
//              no existe, idempotente bajo escrituras concurrentes.
//   SEC-5    — formatBlockedByProviderResponse menciona provider correcto.
//   UX       — formatSkillFailureResponse devuelve copy variado por causa.
//   Prompt   — buildIssueCreationPromptBlock contiene marcadores de allowlist
//              y prohibición de gh issue create directo.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/commander-issue-creation.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ic = require('../commander/issue-creation');

// -----------------------------------------------------------------------------
// detectIssueCreationIntent — CA-1
// -----------------------------------------------------------------------------

test('detectIssueCreationIntent: "creá un issue para X" → create_simple', () => {
    const r = ic.detectIssueCreationIntent('creá un issue para arreglar el bug del scroll');
    assert.equal(r.intent, ic.INTENT_CREATE_SIMPLE);
    assert.ok(r.matched);
});

test('detectIssueCreationIntent: "levantá una historia de Y" → create_simple', () => {
    const r = ic.detectIssueCreationIntent('levantá una historia de mejora del onboarding');
    assert.equal(r.intent, ic.INTENT_CREATE_SIMPLE);
});

test('detectIssueCreationIntent: "hace falta un ticket de Z" → create_simple', () => {
    const r = ic.detectIssueCreationIntent('hace falta un ticket de optimización del query');
    assert.equal(r.intent, ic.INTENT_CREATE_SIMPLE);
});

test('detectIssueCreationIntent: "armá un issue" → create_simple', () => {
    const r = ic.detectIssueCreationIntent('armá un issue para revisar permisos');
    assert.equal(r.intent, ic.INTENT_CREATE_SIMPLE);
});

test('detectIssueCreationIntent: "creá un épico" → create_split', () => {
    const r = ic.detectIssueCreationIntent('creá un épico para el rediseño del checkout');
    assert.equal(r.intent, ic.INTENT_CREATE_SPLIT);
});

test('detectIssueCreationIntent: "esto hay que dividirlo en backend y app" → create_split', () => {
    const r = ic.detectIssueCreationIntent('esto hay que dividir en backend y app');
    assert.equal(r.intent, ic.INTENT_CREATE_SPLIT);
});

test('detectIssueCreationIntent: "splitea esto" → create_split', () => {
    const r = ic.detectIssueCreationIntent('splitea esto en sub-tareas más chicas');
    assert.equal(r.intent, ic.INTENT_CREATE_SPLIT);
});

test('detectIssueCreationIntent: separá en backend y app → create_split (multi-modulo)', () => {
    const r = ic.detectIssueCreationIntent('separá en backend y app por favor');
    assert.equal(r.intent, ic.INTENT_CREATE_SPLIT);
});

test('detectIssueCreationIntent: texto neutro → none', () => {
    const r = ic.detectIssueCreationIntent('hola, decime cómo va el pipeline');
    assert.equal(r.intent, ic.INTENT_NONE);
    assert.equal(r.matched, null);
});

test('detectIssueCreationIntent: texto vacío → none', () => {
    assert.equal(ic.detectIssueCreationIntent('').intent, ic.INTENT_NONE);
    assert.equal(ic.detectIssueCreationIntent(null).intent, ic.INTENT_NONE);
    assert.equal(ic.detectIssueCreationIntent(undefined).intent, ic.INTENT_NONE);
});

test('detectIssueCreationIntent: split tiene prioridad sobre simple', () => {
    // "creá un épico" contiene el patrón de épico Y matchearía "creá un issue"
    // si lo viéramos al revés. Verificamos que split gana.
    const r = ic.detectIssueCreationIntent('creá un épico para X');
    assert.equal(r.intent, ic.INTENT_CREATE_SPLIT);
});

// -----------------------------------------------------------------------------
// sanitizeIssueCreationInput — SEC-3
// -----------------------------------------------------------------------------

test('sanitizeIssueCreationInput: texto corto pasa intacto', () => {
    const r = ic.sanitizeIssueCreationInput('creá un issue para X');
    assert.equal(r.sanitized, 'creá un issue para X');
    assert.equal(r.truncated, false);
    assert.equal(r.strippedControls, 0);
});

test('sanitizeIssueCreationInput: trunca a 4000 chars', () => {
    const long = 'a'.repeat(5000);
    const r = ic.sanitizeIssueCreationInput(long);
    assert.equal(r.sanitized.length, ic.MAX_INPUT_CHARS);
    assert.equal(r.truncated, true);
});

test('sanitizeIssueCreationInput: strip caracteres de control (NUL, BEL)', () => {
    const dirty = 'hola\x00mundo\x07';
    const r = ic.sanitizeIssueCreationInput(dirty);
    assert.equal(r.sanitized, 'holamundo');
    assert.ok(r.strippedControls >= 2);
});

test('sanitizeIssueCreationInput: strip ANSI escape CSI', () => {
    const dirty = 'texto \x1b[31mrojo\x1b[0m fin';
    const r = ic.sanitizeIssueCreationInput(dirty);
    assert.equal(r.sanitized, 'texto rojo fin');
});

test('sanitizeIssueCreationInput: preserva quotes y backticks (NO escapa)', () => {
    const legit = 'creá un issue para arreglar el bug del `backtick` en "el parser"';
    const r = ic.sanitizeIssueCreationInput(legit);
    assert.ok(r.sanitized.includes('`backtick`'));
    assert.ok(r.sanitized.includes('"el parser"'));
});

test('sanitizeIssueCreationInput: preserva newlines y tabs', () => {
    const txt = 'línea 1\nlínea 2\ttab';
    const r = ic.sanitizeIssueCreationInput(txt);
    assert.equal(r.sanitized, txt);
});

test('sanitizeIssueCreationInput: input no-string → vacío', () => {
    const r = ic.sanitizeIssueCreationInput(null);
    assert.equal(r.sanitized, '');
    assert.equal(r.truncated, false);
});

// -----------------------------------------------------------------------------
// getAllowedSenderIds / isSenderAllowed — SEC-2
// -----------------------------------------------------------------------------

test('getAllowedSenderIds: env vacía → []', () => {
    assert.deepEqual(ic.getAllowedSenderIds({}), []);
    assert.deepEqual(ic.getAllowedSenderIds({ TELEGRAM_ALLOWED_USER_IDS: '' }), []);
    assert.deepEqual(ic.getAllowedSenderIds({ TELEGRAM_ALLOWED_USER_IDS: '   ' }), []);
});

test('getAllowedSenderIds: env con un ID', () => {
    assert.deepEqual(ic.getAllowedSenderIds({ TELEGRAM_ALLOWED_USER_IDS: '12345' }), [12345]);
});

test('getAllowedSenderIds: env con varios IDs separados por coma', () => {
    assert.deepEqual(
        ic.getAllowedSenderIds({ TELEGRAM_ALLOWED_USER_IDS: '12345,67890, 11111' }),
        [12345, 67890, 11111]
    );
});

test('getAllowedSenderIds: ignora tokens no numéricos', () => {
    assert.deepEqual(
        ic.getAllowedSenderIds({ TELEGRAM_ALLOWED_USER_IDS: '12345,xxx,67890' }),
        [12345, 67890]
    );
});

test('getAllowedSenderIds: ignora negativos y flotantes', () => {
    assert.deepEqual(
        ic.getAllowedSenderIds({ TELEGRAM_ALLOWED_USER_IDS: '12345,-1,3.14,67890' }),
        [12345, 67890]
    );
});

test('isSenderAllowed: allowlist vacía → siempre permite', () => {
    assert.equal(ic.isSenderAllowed(12345, []), true);
    assert.equal(ic.isSenderAllowed(null, []), true);
    assert.equal(ic.isSenderAllowed(undefined, null), true);
});

test('isSenderAllowed: ID en allowlist → permite', () => {
    assert.equal(ic.isSenderAllowed(12345, [12345, 67890]), true);
    assert.equal(ic.isSenderAllowed('12345', [12345, 67890]), true); // coerción
});

test('isSenderAllowed: ID NO en allowlist → rechaza', () => {
    assert.equal(ic.isSenderAllowed(99999, [12345, 67890]), false);
    assert.equal(ic.isSenderAllowed(null, [12345]), false);
    assert.equal(ic.isSenderAllowed('not-a-number', [12345]), false);
});

// -----------------------------------------------------------------------------
// logSkillInvocation — SEC-4
// -----------------------------------------------------------------------------

function mkTmpPipelineDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cic-test-'));
    return dir;
}

test('logSkillInvocation: crea logs/ si no existe y escribe línea JSONL', () => {
    const dir = mkTmpPipelineDir();
    const ok = ic.logSkillInvocation({
        pipelineDir: dir,
        from: { id: 12345, username: 'leitolarreta' },
        inputText: 'creá un issue para X',
        skillInvoked: 'doc',
        skillResult: 'ok',
        issueCreated: 3299,
        durationMs: 245000,
        provider: 'anthropic',
        intent: 'create_simple',
    });
    assert.equal(ok, true);
    const auditPath = path.join(dir, 'logs', 'commander-skill-audit.jsonl');
    assert.ok(fs.existsSync(auditPath));
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.ok(parsed.timestamp);
    assert.deepEqual(parsed.from, { id: 12345, username: 'leitolarreta' });
    assert.equal(parsed.skill_invoked, 'doc');
    assert.equal(parsed.skill_result, 'ok');
    assert.equal(parsed.issue_created, 3299);
    assert.equal(parsed.duration_ms, 245000);
    assert.equal(parsed.provider, 'anthropic');
    assert.equal(parsed.intent, 'create_simple');
    assert.equal(parsed.input_text_truncated, false);
});

test('logSkillInvocation: omite campos undefined', () => {
    const dir = mkTmpPipelineDir();
    ic.logSkillInvocation({
        pipelineDir: dir,
        skillInvoked: 'planner',
        skillResult: 'blocked',
        error: 'provider_not_anthropic',
        provider: 'cerebras',
    });
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'logs', 'commander-skill-audit.jsonl'), 'utf8').trim());
    assert.equal(parsed.skill_invoked, 'planner');
    assert.equal(parsed.error, 'provider_not_anthropic');
    assert.equal(parsed.provider, 'cerebras');
    assert.ok(!('from' in parsed));
    assert.ok(!('issue_created' in parsed));
    assert.ok(!('duration_ms' in parsed));
});

test('logSkillInvocation: append idempotente (varias escrituras)', () => {
    const dir = mkTmpPipelineDir();
    for (let i = 0; i < 5; i++) {
        ic.logSkillInvocation({
            pipelineDir: dir,
            skillInvoked: 'doc',
            skillResult: 'ok',
            issueCreated: 3000 + i,
        });
    }
    const lines = fs.readFileSync(path.join(dir, 'logs', 'commander-skill-audit.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 5);
    for (let i = 0; i < 5; i++) {
        assert.equal(JSON.parse(lines[i]).issue_created, 3000 + i);
    }
});

test('logSkillInvocation: truncar input_text a 200 chars en el preview', () => {
    const dir = mkTmpPipelineDir();
    const longInput = 'x'.repeat(500);
    ic.logSkillInvocation({
        pipelineDir: dir,
        inputText: longInput,
        skillInvoked: 'doc',
        skillResult: 'ok',
    });
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'logs', 'commander-skill-audit.jsonl'), 'utf8').trim());
    assert.equal(parsed.input_text.length, 200);
});

test('logSkillInvocation: sin pipelineDir → no escribe y devuelve false', () => {
    assert.equal(ic.logSkillInvocation({ skillInvoked: 'doc' }), false);
});

// -----------------------------------------------------------------------------
// formatBlockedByProviderResponse — SEC-5
// -----------------------------------------------------------------------------

test('formatBlockedByProviderResponse: menciona provider de failover', () => {
    const out = ic.formatBlockedByProviderResponse({ provider: 'cerebras' });
    assert.ok(out.includes('failover a cerebras'));
    assert.ok(/cerebro principal/i.test(out));
    assert.ok(/\/doc nueva/.test(out));
});

test('formatBlockedByProviderResponse: provider=anthropic no muestra failover', () => {
    const out = ic.formatBlockedByProviderResponse({ provider: 'anthropic' });
    assert.ok(!/failover a/i.test(out));
});

// -----------------------------------------------------------------------------
// formatSkillFailureResponse — UX guidelines
// -----------------------------------------------------------------------------

test('formatSkillFailureResponse: kind=timeout', () => {
    // #3587 CA-4 — copy migrado a UX guidelines: símbolo ⏰ (no ⏱️), texto
    // variado por seed temporal (3 variantes). Verificamos que el mensaje
    // contiene el símbolo y al menos uno de los fragmentos esperados.
    const out = ic.formatSkillFailureResponse({ kind: 'timeout' });
    assert.ok(/⏰/.test(out), 'debe usar símbolo monocromo ⏰');
    assert.ok(/Cortó|Timeout|sin respuesta/i.test(out),
        `debe contener alguna de las variantes UX guideline, got: ${out}`);
});

test('formatSkillFailureResponse: kind=quota', () => {
    const out = ic.formatSkillFailureResponse({ kind: 'quota' });
    assert.ok(/saturado/i.test(out));
    assert.ok(/🔌/.test(out));
});

test('formatSkillFailureResponse: kind=gh_error con detalle', () => {
    const out = ic.formatSkillFailureResponse({ kind: 'gh_error', error: 'rate limit exceeded' });
    assert.ok(/GitHub rechazó/i.test(out));
    assert.ok(out.includes('rate limit exceeded'));
});

test('formatSkillFailureResponse: kind=generic (catch-all)', () => {
    const out = ic.formatSkillFailureResponse({ kind: 'generic', error: 'algo raro' });
    assert.ok(/creación falló/i.test(out));
    assert.ok(/\/doc nueva/.test(out));
});

test('formatSkillFailureResponse: kind=no_skill_invoked', () => {
    const out = ic.formatSkillFailureResponse({ kind: 'no_skill_invoked' });
    assert.ok(/no invocó/i.test(out));
});

// -----------------------------------------------------------------------------
// buildIssueCreationPromptBlock — CA-1 / CA-5 / SEC-1
// -----------------------------------------------------------------------------

test('buildIssueCreationPromptBlock: declara allowlist explícita doc/planner', () => {
    const block = ic.buildIssueCreationPromptBlock();
    assert.ok(/ALLOWLIST DE SKILLS/.test(block));
    assert.ok(block.includes('`doc` y `planner`'));
    assert.ok(/PROHIBIDO/.test(block));
});

test('buildIssueCreationPromptBlock: prohibe gh issue create directo (CA-5)', () => {
    const block = ic.buildIssueCreationPromptBlock();
    assert.ok(/NO uses gh issue create directo/.test(block) || /NO USES `gh issue create`/.test(block));
    assert.ok(/NUNCA/.test(block));
});

test('buildIssueCreationPromptBlock: incluye Skill(skill="doc") y Skill(skill="planner")', () => {
    const block = ic.buildIssueCreationPromptBlock();
    assert.ok(block.includes('Skill(skill="doc"'));
    assert.ok(block.includes('Skill(skill="planner"'));
});

test('buildIssueCreationPromptBlock: declara validación post-éxito con gh issue view (CA-3)', () => {
    const block = ic.buildIssueCreationPromptBlock();
    assert.ok(/gh issue view/.test(block));
    assert.ok(/projectItems/.test(block));
});

test('buildIssueCreationPromptBlock: incluye formato sugerido de split (CA-4)', () => {
    const block = ic.buildIssueCreationPromptBlock();
    assert.ok(/🧩/.test(block));
    assert.ok(/blocked:dependencies/.test(block));
});

// -----------------------------------------------------------------------------
// inspectResponseForOutcome — soporte audit log post-LLM
// -----------------------------------------------------------------------------

test('inspectResponseForOutcome: extrae issues "#NNN creado"', () => {
    const r = ic.inspectResponseForOutcome('✅ Issue #3299 creado: arreglar scroll');
    assert.deepEqual(r.issuesCreated, [3299]);
});

test('inspectResponseForOutcome: extrae múltiples issues del split', () => {
    const r = ic.inspectResponseForOutcome(`
🧩 Split listo para #3300 — Rediseño checkout
Hijos creados:
• #3301 — Backend del checkout creado
• #3302 — App del checkout creado
• #3303 — Web del checkout creado
    `);
    // Heurística captura padre + hijos (todos los #NNN del bloque marcado
    // como split). El audit log no necesita distinguir parent vs children —
    // el forense igual ve la cadena completa.
    assert.ok(r.issuesCreated.includes(3301));
    assert.ok(r.issuesCreated.includes(3302));
    assert.ok(r.issuesCreated.includes(3303));
    assert.ok(r.issuesCreated.length >= 3);
});

test('inspectResponseForOutcome: detecta mención de doc/planner', () => {
    const r = ic.inspectResponseForOutcome('Invocando /doc nueva ...');
    assert.ok(r.skillsMentioned.includes('doc'));
});

test('inspectResponseForOutcome: respuesta sin invocación → vacío', () => {
    const r = ic.inspectResponseForOutcome('Hola, ¿cómo va?');
    assert.deepEqual(r.issuesCreated, []);
    assert.deepEqual(r.skillsMentioned, []);
});

test('inspectResponseForOutcome: input no-string → vacío', () => {
    const r = ic.inspectResponseForOutcome(null);
    assert.deepEqual(r.issuesCreated, []);
});

// -----------------------------------------------------------------------------
// ALLOWED_SKILLS_FOR_ISSUE_CREATION — SEC-1
// -----------------------------------------------------------------------------

test('ALLOWED_SKILLS_FOR_ISSUE_CREATION: contiene exactamente doc y planner', () => {
    assert.deepEqual([...ic.ALLOWED_SKILLS_FOR_ISSUE_CREATION], ['doc', 'planner']);
});

test('ALLOWED_SKILLS_FOR_ISSUE_CREATION: es frozen (no se puede mutar)', () => {
    assert.equal(Object.isFrozen(ic.ALLOWED_SKILLS_FOR_ISSUE_CREATION), true);
});

// =============================================================================
// #3418 — Patterns continuativos con contexto reforzador (CA-1 + SEC-B)
// =============================================================================

test('#3418 CA-1: "Realos cuatro" sin contexto → NONE (no falsos positivos)', () => {
    const r = ic.detectIssueCreationIntent('Realos cuatro');
    assert.equal(r.intent, ic.INTENT_NONE);
});

test('#3418 CA-1: "Realos cuatro" con contexto de creación previo → CREATE_SIMPLE', () => {
    const r = ic.detectIssueCreationIntent('Realos cuatro', { intent: ic.INTENT_CREATE_SIMPLE });
    assert.notEqual(r.intent, ic.INTENT_NONE);
    assert.ok(r.continuation, 'debería marcar como continuation');
});

test('#3418 CA-1: "Reintentá creándolo" sin contexto → NONE', () => {
    const r = ic.detectIssueCreationIntent('Reintentá creándolo');
    assert.equal(r.intent, ic.INTENT_NONE);
});

test('#3418 CA-1: "Reintentá creándolos" con contexto → CREATE_SIMPLE', () => {
    const r = ic.detectIssueCreationIntent('Reintentá creándolos', { intent: ic.INTENT_CREATE_SIMPLE });
    assert.notEqual(r.intent, ic.INTENT_NONE);
});

test('#3418 CA-1: "Los cuatro y agregálos" con contexto previo → CREATE_SIMPLE', () => {
    const r = ic.detectIssueCreationIntent('Los cuatro y agregálos a la ola actual', { intent: ic.INTENT_CREATE_SIMPLE });
    assert.notEqual(r.intent, ic.INTENT_NONE);
});

test('#3418 CA-1: "creálos" con contexto → CREATE_SIMPLE', () => {
    const r = ic.detectIssueCreationIntent('creálos rápido', { intent: ic.INTENT_CREATE_SIMPLE });
    assert.equal(r.intent, ic.INTENT_CREATE_SIMPLE);
});

test('#3418 CA-1: "esos cuatro" con contexto de split previo → CREATE_SPLIT (herencia)', () => {
    const r = ic.detectIssueCreationIntent('esos cuatro', { intent: ic.INTENT_CREATE_SPLIT });
    assert.equal(r.intent, ic.INTENT_CREATE_SPLIT, 'herencia del tipo del previo');
});

test('#3418 CA-1: "los 4" sin contexto → NONE', () => {
    const r = ic.detectIssueCreationIntent('los 4');
    assert.equal(r.intent, ic.INTENT_NONE);
});

test('#3418 CA-1: "los 4" con contexto → CREATE_SIMPLE', () => {
    const r = ic.detectIssueCreationIntent('los 4 estaría perfecto', { intent: ic.INTENT_CREATE_SIMPLE });
    assert.notEqual(r.intent, ic.INTENT_NONE);
});

// SEC-B adversarial: frases que NO deben matchear (negativos)

test('#3418 SEC-B adversarial: "reintentá el build" con contexto → NONE', () => {
    const r = ic.detectIssueCreationIntent('reintentá el build que falló', { intent: ic.INTENT_CREATE_SIMPLE });
    assert.equal(r.intent, ic.INTENT_NONE, 'build es dominio ajeno');
});

test('#3418 SEC-B adversarial: "los 4 PRs que mergeé" con contexto → NONE', () => {
    const r = ic.detectIssueCreationIntent('los 4 PRs que mergeé', { intent: ic.INTENT_CREATE_SIMPLE });
    assert.equal(r.intent, ic.INTENT_NONE, 'PR es dominio ajeno');
});

test('#3418 SEC-B adversarial: "creálos como tasks en taskwarrior" con contexto → NONE', () => {
    const r = ic.detectIssueCreationIntent('creálos como tasks en taskwarrior', { intent: ic.INTENT_CREATE_SIMPLE });
    assert.equal(r.intent, ic.INTENT_NONE, 'taskwarrior es dominio ajeno');
});

test('#3418 SEC-B adversarial: "esos cuatro tests fallando" con contexto → NONE', () => {
    const r = ic.detectIssueCreationIntent('esos cuatro tests fallando', { intent: ic.INTENT_CREATE_SIMPLE });
    assert.equal(r.intent, ic.INTENT_NONE, 'tests es dominio ajeno');
});

test('#3418 SEC-B adversarial: "los 4 daemons gradle" con contexto → NONE', () => {
    const r = ic.detectIssueCreationIntent('los 4 daemons gradle vivos', { intent: ic.INTENT_CREATE_SIMPLE });
    assert.equal(r.intent, ic.INTENT_NONE, 'daemons gradle es dominio ajeno');
});

test('#3418 SEC-B: prevContext con intent=none → continuativos no matchean', () => {
    const r = ic.detectIssueCreationIntent('los 4 estaría perfecto', { intent: 'none' });
    assert.equal(r.intent, ic.INTENT_NONE);
});

test('#3418 SEC-B: prevContext null → continuativos no matchean', () => {
    const r = ic.detectIssueCreationIntent('los 4 estaría perfecto', null);
    assert.equal(r.intent, ic.INTENT_NONE);
});

test('#3418 SEC-B: prevContext con intent invalido → continuativos no matchean', () => {
    const r = ic.detectIssueCreationIntent('los 4 estaría perfecto', { intent: 'random_value' });
    assert.equal(r.intent, ic.INTENT_NONE);
});

// =============================================================================
// #3418 — Enum cerrado de skill_result (SEC-D)
// =============================================================================

test('#3418 SEC-D + #3587 CA-3: SKILL_RESULT_ENUM contiene los 9 valores cerrados', () => {
    // #3587 CA-3 — el enum se amplió de 6 a 9 valores agregando `success`,
    // `skill_not_invoked`, `skill_failed`. Los 6 originales se mantienen
    // como aliases legacy o estados válidos (`ok`, `error`, `blocked`,
    // `timeout`, `launching_no_complete`, `invalid_args`).
    assert.deepEqual([...ic.SKILL_RESULT_ENUM].sort(), [
        'blocked', 'error', 'invalid_args', 'launching_no_complete', 'ok',
        'skill_failed', 'skill_not_invoked', 'success', 'timeout',
    ]);
});

test('#3418 SEC-D: SKILL_RESULT_ENUM es frozen', () => {
    assert.equal(Object.isFrozen(ic.SKILL_RESULT_ENUM), true);
});

test('#3418 SEC-D: logSkillInvocation rechaza valores fuera del enum', () => {
    const dir = mkTmpPipelineDir();
    const calls = [];
    ic.logSkillInvocation({
        pipelineDir: dir,
        skillInvoked: 'doc',
        skillResult: 'invalid_value_xyz',
    }, { log: (l, m) => calls.push([l, m]) });
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'logs', 'commander-skill-audit.jsonl'), 'utf8').trim());
    assert.ok(!('skill_result' in parsed), 'skill_result inválido se omite');
    assert.ok(calls.some(c => /skill_result inválido/.test(c[1])));
});

test('#3418 SEC-D: logSkillInvocation acepta timeoutMs cuando skill_result=timeout', () => {
    const dir = mkTmpPipelineDir();
    ic.logSkillInvocation({
        pipelineDir: dir,
        skillInvoked: 'doc',
        skillResult: 'timeout',
        timeoutMs: 60000,
    });
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'logs', 'commander-skill-audit.jsonl'), 'utf8').trim());
    assert.equal(parsed.skill_result, 'timeout');
    assert.equal(parsed.timeout_ms, 60000);
});

test('#3418 SEC-D: logSkillInvocation acepta skill_result=launching_no_complete', () => {
    const dir = mkTmpPipelineDir();
    ic.logSkillInvocation({
        pipelineDir: dir,
        skillInvoked: 'doc',
        skillResult: 'launching_no_complete',
        error: 'launching_marker_without_tool_use',
    });
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'logs', 'commander-skill-audit.jsonl'), 'utf8').trim());
    assert.equal(parsed.skill_result, 'launching_no_complete');
});

// =============================================================================
// #3418 SEC-C — Redacción de tokens antes de truncar
// =============================================================================

test('#3418 SEC-C: formatSkillFailureResponse redacta gh PAT antes de truncar', () => {
    const err = 'gh: authentication failed using token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890 — please re-auth';
    const out = ic.formatSkillFailureResponse({ kind: 'gh_error', error: err });
    assert.ok(!out.includes('ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890'), 'PAT no debe aparecer en mensaje');
    assert.ok(out.includes('[REDACTED]') || /\*\*\*/.test(out), 'debe haber marcador de redacción');
});

test('#3418 SEC-C: formatSkillFailureResponse redacta AWS key', () => {
    const err = 'AKIAIOSFODNN7EXAMPLE causó error de credenciales';
    const out = ic.formatSkillFailureResponse({ kind: 'generic', error: err });
    assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('#3418 SEC-C: logSkillInvocation redacta gh PAT del campo error', () => {
    const dir = mkTmpPipelineDir();
    ic.logSkillInvocation({
        pipelineDir: dir,
        skillInvoked: 'doc',
        skillResult: 'error',
        error: 'gh failed: ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890 expired',
    });
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'logs', 'commander-skill-audit.jsonl'), 'utf8').trim());
    assert.ok(!parsed.error.includes('ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890'));
});

test('#3418 SEC-C: logSkillInvocation redacta JWT del campo input_text', () => {
    const dir = mkTmpPipelineDir();
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    ic.logSkillInvocation({
        pipelineDir: dir,
        inputText: `creá un issue con token ${jwt}`,
        skillInvoked: 'doc',
        skillResult: 'ok',
    });
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'logs', 'commander-skill-audit.jsonl'), 'utf8').trim());
    assert.ok(!parsed.input_text.includes(jwt), 'JWT no debe aparecer en input_text');
});

// =============================================================================
// #3418 CA-3 — Distinción launching_no_complete vs error en inspect/infer
// =============================================================================

test('#3418 CA-3: inspectResponseForOutcome detecta "Launching skill: doc"', () => {
    const r = ic.inspectResponseForOutcome('Launching skill: doc para crear el issue...');
    assert.equal(r.launchingDetected, true);
});

test('#3418 CA-3: inspectResponseForOutcome detecta "Invocando /doc nueva"', () => {
    const r = ic.inspectResponseForOutcome('Invocando /doc nueva para registrar el bug');
    // launchingDetected solo cubre "Launching|Invocando|Lanzando" + "skill: doc"
    // pero `skillsMentioned` igual debe captar /doc
    assert.ok(r.skillsMentioned.includes('doc'));
});

test('#3418 CA-3: inspectResponseForOutcome respuesta neutra → launchingDetected=false', () => {
    const r = ic.inspectResponseForOutcome('Hola, todo bien');
    assert.equal(r.launchingDetected, false);
});

test('#3418 CA-3: inferSkillResult prioriza timedOut sobre todo', () => {
    const r = ic.inferSkillResult({
        outcome: { issuesCreated: [3299], skillsMentioned: ['doc'], launchingDetected: false },
        timedOut: true,
    });
    assert.equal(r, ic.SKILL_RESULT_TIMEOUT);
});

test('#3418 CA-3: inferSkillResult con issues creados → OK', () => {
    const r = ic.inferSkillResult({
        outcome: { issuesCreated: [3299], skillsMentioned: ['doc'], launchingDetected: false },
    });
    assert.equal(r, ic.SKILL_RESULT_OK);
});

test('#3418 CA-3: inferSkillResult con launching pero sin issues → launching_no_complete (no unknown)', () => {
    const r = ic.inferSkillResult({
        outcome: { issuesCreated: [], skillsMentioned: ['doc'], launchingDetected: true },
    });
    assert.equal(r, ic.SKILL_RESULT_LAUNCHING_NO_COMPLETE);
});

test('#3418 CA-3: inferSkillResult sin issues y sin launching → error duro', () => {
    const r = ic.inferSkillResult({
        outcome: { issuesCreated: [], skillsMentioned: [], launchingDetected: false },
    });
    assert.equal(r, ic.SKILL_RESULT_ERROR);
});

test('#3418 CA-3: inferSkillResult con tool_use emitted pero sin result → TIMEOUT', () => {
    const r = ic.inferSkillResult({
        outcome: { issuesCreated: [], skillsMentioned: ['doc'], launchingDetected: false },
        toolUseEmitted: true,
        toolResultEmitted: false,
    });
    assert.equal(r, ic.SKILL_RESULT_TIMEOUT);
});

// =============================================================================
// #3418 UX — Mensaje de launching_no_complete
// =============================================================================

test('#3418 UX: formatSkillFailureResponse kind=launching_no_complete', () => {
    const out = ic.formatSkillFailureResponse({ kind: 'launching_no_complete' });
    assert.ok(/anunci[oó]/i.test(out));
    assert.ok(/\/doc nueva/.test(out));
});

test('#3418 UX: formatSkillFailureResponse kind=invalid_args con detalle', () => {
    const out = ic.formatSkillFailureResponse({ kind: 'invalid_args', error: 'título vacío' });
    assert.ok(/argumentos inválidos/i.test(out));
    assert.ok(out.includes('título vacío'));
});
