// =============================================================================
// commander-skill-watchdog.test.js — Tests de regresión para #3418
//
// Cubre:
//   CA-4  — Invocación simple del Skill /doc termina con SKILL_RESULT_OK y
//           audit log con `issue_created` populado.
//   CA-5  — 4 invocaciones en paralelo cada una loggean su outcome propio
//           sin colisión ni pérdida de líneas en el JSONL.
//   CA-3  — Timeout simulado del watchdog 60s mapea correctamente a
//           SKILL_RESULT_TIMEOUT con `timeout_ms` populado.
//   SEC-F — El test paralelo respeta `createRateLimiter` por default (burst=10).
//
// NOTA: estos tests no spawnean Claude real. Para CA-4/CA-5 simulamos el
// efecto observable del flow (audit log + outcome inferido), no el proceso
// completo. Esto sigue la guideline del análisis de #3418
// (`definicion/analisis/guru`): "stub del spawn que emite tool_use:Skill +
// tool_use_result" se modela como llamadas directas al módulo de outcome
// inference. La instrumentación end-to-end del proceso queda para QA estructural.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ic = require('../commander/issue-creation');
const { createRateLimiter } = require('../commander/rate-limit');

function mkTmpPipelineDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cic-wd-'));
}

function readAuditLines(pipelineDir) {
    const file = path.join(pipelineDir, 'logs', 'commander-skill-audit.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// -----------------------------------------------------------------------------
// CA-4 — Regresión: invocación simple termina con SKILL_RESULT_OK
// -----------------------------------------------------------------------------

test('#3418 CA-4: invocación simple stub OK persiste audit con issue_created', () => {
    const dir = mkTmpPipelineDir();

    // Simulamos: el LLM emite tool_use:Skill, llega tool_result, y la respuesta
    // final del Commander contiene "#3299 creado". inferSkillResult debería
    // mapear a SKILL_RESULT_OK.
    const respuesta = '✅ Issue #3299 creado: arreglar el scroll del checkout';
    const outcome = ic.inspectResponseForOutcome(respuesta);
    assert.deepEqual(outcome.issuesCreated, [3299]);
    assert.equal(outcome.launchingDetected, false);

    const skillResult = ic.inferSkillResult({
        outcome,
        toolUseEmitted: true,
        toolResultEmitted: true,
        timedOut: false,
    });
    assert.equal(skillResult, ic.SKILL_RESULT_OK);

    const intent = ic.detectIssueCreationIntent('creá un issue para arreglar el scroll');
    assert.equal(intent.intent, ic.INTENT_CREATE_SIMPLE);

    ic.logSkillInvocation({
        pipelineDir: dir,
        from: { id: 12345, username: 'leitolarreta' },
        inputText: 'creá un issue para arreglar el scroll',
        skillInvoked: 'doc',
        skillResult,
        issueCreated: outcome.issuesCreated[0],
        durationMs: 4500,
        provider: 'anthropic',
        intent: intent.intent,
    });

    const lines = readAuditLines(dir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].skill_result, 'ok');
    assert.equal(lines[0].skill_invoked, 'doc');
    assert.equal(lines[0].issue_created, 3299);
    assert.equal(lines[0].intent, 'create_simple');
    assert.equal(lines[0].provider, 'anthropic');
});

// -----------------------------------------------------------------------------
// CA-5 — Regresión: 4 invocaciones paralelas cada una con su outcome
// -----------------------------------------------------------------------------

test('#3418 CA-5: 4 invocaciones paralelas registran 4 líneas en audit, sin pérdida', async () => {
    const dir = mkTmpPipelineDir();

    // SEC-F: usamos el rate-limiter por default (burst=10). 4 paralelas
    // caben sin necesidad de bypass.
    const rl = createRateLimiter({});
    assert.equal(rl._config.burst, 10);
    assert.equal(rl._config.ratePerMin, 30);

    const cases = [
        { input: 'creá un issue para arreglar X', issueNum: 3301 },
        { input: 'creá un issue para arreglar Y', issueNum: 3302 },
        { input: 'creá un issue para arreglar Z', issueNum: 3303 },
        { input: 'creá un issue para arreglar W', issueNum: 3304 },
    ];

    // Verificamos que el rate-limiter no bloquea ninguna de las 4 (burst=10).
    for (const c of cases) {
        const decision = rl.consume('chat-paralelo');
        assert.equal(decision.allowed, true, `caso ${c.issueNum} no debe ser rate-limited`);
    }

    // Lanzamos las 4 escrituras "en paralelo" — appendFileSync es sync pero
    // verificamos que el orden de líneas final tenga exactamente 4 entradas
    // y cada una con su `issue_created` propio.
    await Promise.all(cases.map((c) => {
        return new Promise((resolve) => {
            const outcome = ic.inspectResponseForOutcome(`Issue #${c.issueNum} creado: ${c.input}`);
            const skillResult = ic.inferSkillResult({
                outcome,
                toolUseEmitted: true,
                toolResultEmitted: true,
                timedOut: false,
            });
            ic.logSkillInvocation({
                pipelineDir: dir,
                from: { id: 12345, username: 'leitolarreta' },
                inputText: c.input,
                skillInvoked: 'doc',
                skillResult,
                issueCreated: c.issueNum,
                durationMs: 1000,
                provider: 'anthropic',
                intent: 'create_simple',
            });
            resolve();
        });
    }));

    const lines = readAuditLines(dir);
    assert.equal(lines.length, 4, '4 invocaciones → 4 líneas, ninguna perdida');
    const issuesLogged = lines.map((l) => l.issue_created).sort();
    assert.deepEqual(issuesLogged, [3301, 3302, 3303, 3304]);

    // SEC-F: ninguna debe haber sido silenciosa (todas con skill_result válido).
    for (const l of lines) {
        assert.ok(ic.SKILL_RESULT_ENUM.includes(l.skill_result), `skill_result válido: ${l.skill_result}`);
        assert.notEqual(l.skill_result, undefined, 'cero fallos silenciosos');
    }
});

test('#3418 CA-5: si una de las 4 falla, queda registrada con skill_result específico (no silenciosa)', () => {
    const dir = mkTmpPipelineDir();

    // Caso 1: OK
    ic.logSkillInvocation({
        pipelineDir: dir, skillInvoked: 'doc', skillResult: 'ok', issueCreated: 3301, provider: 'anthropic', intent: 'create_simple',
    });
    // Caso 2: timeout (watchdog 60s simulado)
    ic.logSkillInvocation({
        pipelineDir: dir, skillInvoked: 'doc', skillResult: 'timeout', timeoutMs: 60000, error: 'skill_watchdog_timeout_60s', provider: 'anthropic', intent: 'create_simple',
    });
    // Caso 3: launching_no_complete (LLM dijo "Launching" sin tool_use)
    ic.logSkillInvocation({
        pipelineDir: dir, skillInvoked: 'doc', skillResult: 'launching_no_complete', error: 'launching_marker_without_tool_use', provider: 'anthropic', intent: 'create_simple',
    });
    // Caso 4: invalid_args
    ic.logSkillInvocation({
        pipelineDir: dir, skillInvoked: 'doc', skillResult: 'invalid_args', error: 'título vacío', provider: 'anthropic', intent: 'create_simple',
    });

    const lines = readAuditLines(dir);
    assert.equal(lines.length, 4);
    const results = lines.map((l) => l.skill_result).sort();
    assert.deepEqual(results, ['invalid_args', 'launching_no_complete', 'ok', 'timeout']);
});

// -----------------------------------------------------------------------------
// CA-3 — Timeout simulado del watchdog 60s
// -----------------------------------------------------------------------------

test('#3418 CA-3: timeout 60s registra skill_result=timeout con timeout_ms=60000', () => {
    const dir = mkTmpPipelineDir();

    // Simulamos lo que `procesarTextoLibre` hace cuando detecta el marker
    // [SKILL_TIMEOUT:doc:60123ms] en la respuesta:
    const respuesta = '[SKILL_TIMEOUT:doc:60123ms]';
    const m = /\[SKILL_TIMEOUT:(\w+):(\d+)ms\]/.exec(respuesta);
    assert.ok(m);
    const skillName = m[1];
    const dur = Number(m[2]);

    ic.logSkillInvocation({
        pipelineDir: dir,
        skillInvoked: skillName,
        skillResult: ic.SKILL_RESULT_TIMEOUT,
        timeoutMs: dur,
        error: 'skill_watchdog_timeout_60s',
        provider: 'anthropic',
        intent: 'create_simple',
    });

    const parsed = readAuditLines(dir)[0];
    assert.equal(parsed.skill_result, 'timeout');
    assert.equal(parsed.timeout_ms, 60123);
    assert.equal(parsed.skill_invoked, 'doc');
    assert.equal(parsed.error, 'skill_watchdog_timeout_60s');
});

test('#3418 CA-3: launching_no_complete cuando LLM solo emite texto, sin tool_use', () => {
    const dir = mkTmpPipelineDir();

    // Bug original: el LLM dice "Launching skill: doc" como texto pero
    // nunca emite el evento `tool_use`. Antes del fix esto era `unknown`;
    // ahora debe ser `launching_no_complete`.
    const respuesta = 'Launching skill: doc para crear el issue...';
    const outcome = ic.inspectResponseForOutcome(respuesta);
    const skillResult = ic.inferSkillResult({
        outcome,
        toolUseEmitted: false,    // crítico: el evento estructurado NO llegó
        toolResultEmitted: false,
        timedOut: false,
    });
    assert.equal(skillResult, ic.SKILL_RESULT_LAUNCHING_NO_COMPLETE);

    ic.logSkillInvocation({
        pipelineDir: dir,
        skillInvoked: 'doc',
        skillResult,
        error: 'launching_marker_without_tool_use',
        provider: 'anthropic',
        intent: 'create_simple',
    });
    const parsed = readAuditLines(dir)[0];
    assert.equal(parsed.skill_result, 'launching_no_complete');
});

// -----------------------------------------------------------------------------
// SEC-F — Rate limiter por default no bloquea 4 paralelas pero sí 11+
// -----------------------------------------------------------------------------

test('#3418 SEC-F: rate-limiter default permite burst de 10, bloquea la 11ª', () => {
    const rl = createRateLimiter({});
    for (let i = 0; i < 10; i++) {
        assert.equal(rl.consume('chat-x').allowed, true, `request ${i + 1} debe pasar`);
    }
    assert.equal(rl.consume('chat-x').allowed, false, 'request 11 debe ser bloqueada');
});

// -----------------------------------------------------------------------------
// SEC-A — Allowlist no se amplía aunque se agreguen continuativos
// -----------------------------------------------------------------------------

test('#3418 SEC-A: ALLOWED_SKILLS_FOR_ISSUE_CREATION sigue siendo [doc, planner] exactamente', () => {
    assert.deepEqual([...ic.ALLOWED_SKILLS_FOR_ISSUE_CREATION], ['doc', 'planner']);
});

test('#3418 SEC-A: prompt block no menciona skills fuera de la allowlist', () => {
    const block = ic.buildIssueCreationPromptBlock();
    // Skills que NO deben aparecer como permitidos
    const forbidden = ['delivery', 'builder', 'reset', 'qa', 'ghostbusters', 'auth'];
    for (const skill of forbidden) {
        // Si aparece, debe ser en la cláusula PROHIBIDO — verificamos que la
        // mención esté en una línea que diga "PROHIBIDO"
        const re = new RegExp(`\\b${skill}\\b`);
        if (re.test(block)) {
            const lines = block.split('\n').filter((l) => re.test(l));
            for (const line of lines) {
                assert.ok(/PROHIBIDO|prohibido/.test(line), `skill ${skill} solo puede aparecer en cláusula PROHIBIDO, no como permitido: "${line}"`);
            }
        }
    }
});
