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
    const out = ic.formatSkillFailureResponse({ kind: 'timeout' });
    assert.ok(/Tardó demasiado/.test(out));
    assert.ok(/⏱️/.test(out));
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
