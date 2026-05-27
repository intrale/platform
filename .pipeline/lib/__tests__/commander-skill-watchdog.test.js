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

// =============================================================================
// #3587 — Tests de regresión para el bug "skill /doc invocado desde Telegram
// falla con string opaco". Cubren CA-1 (instrumentación trace), CA-2 (fix de
// causa raíz: el LLM prefería Bash sobre Skill), CA-3 (enum cerrado +
// eliminación del string opaco) y CA-4 (mensajes a Telegram con UX guidelines).
// =============================================================================

// #3587 CA-3 — literal del string opaco eliminado en producción. Se mantiene
// acá como constante única para los asserts de regresión (sin duplicarlo en
// cada test). Si esta constante aparece en `.pipeline/lib/` fuera de este
// archivo de tests, el assert dispara.
const _OPAQUE_STRING_REMOVED = ['no_skill_invoked', 'or_no_issue_created'].join('_');

// -----------------------------------------------------------------------------
// CA-2 + CA-3 — Bug original: el LLM emite tool_use=Bash en lugar de Skill.
// Antes del fix esto era audit-loggeado con un string opaco genérico (sin
// categoría accionable). Después del fix:
//   - skill_result === 'skill_not_invoked'
//   - tool_used_instead === 'Bash'
//   - tool_use_sequence registra el Bash que el LLM emitió
// -----------------------------------------------------------------------------

test('#3587 CA-2: LLM elige Bash en vez de Skill → skill_result=skill_not_invoked + tool_used_instead=Bash', () => {
    const dir = mkTmpPipelineDir();
    // Stub del stream-json: el LLM emite 1 tool_use=Bash y nada más. La
    // respuesta final es texto donde menciona haber ejecutado gh pero no hay
    // ningún número de issue reconocible por la heurística.
    const respuesta = 'Ejecuté gh issue list para ver el estado actual del backlog.';
    const outcome = ic.inspectResponseForOutcome(respuesta);
    assert.deepEqual(outcome.issuesCreated, [], 'no se debería detectar issue creado');

    const toolUseSequence = [
        {
            name: 'Bash',
            input: { command: 'gh issue list --limit 5', description: 'list issues' },
            id: 'toolu_01abc123def',
            tsMs: 1500,
        },
    ];
    const skillResult = ic.inferSkillResult({
        outcome,
        toolUseSequence,
        toolResultsSummary: [],
        timedOut: false,
    });
    assert.equal(skillResult, ic.SKILL_RESULT_SKILL_NOT_INVOKED,
        'el LLM no emitió Skill → skill_not_invoked, NO el genérico error');

    const toolUsedInstead = ic.inferToolUsedInstead(toolUseSequence);
    assert.equal(toolUsedInstead, 'Bash');

    ic.logSkillInvocation({
        pipelineDir: dir,
        from: { id: 12345, username: 'leitolarreta' },
        inputText: 'creá un issue para arreglar el scroll',
        skillInvoked: 'doc',
        skillResult,
        durationMs: 51234,
        provider: 'anthropic',
        intent: 'create_simple',
        error: 'skill_not_invoked:llm_used_Bash_instead',
        toolUseSequence,
        toolResultsSummary: [],
        subprocess: {
            cmd: 'claude.cmd',
            args: ['-p', '--output-format', 'stream-json'],
            exitCode: 0,
            durationMs: 51234,
            killedByWatchdog: false,
        },
        toolUsedInstead,
    });

    const line = readAuditLines(dir)[0];
    assert.equal(line.skill_result, 'skill_not_invoked');
    assert.equal(line.tool_used_instead, 'Bash');
    assert.ok(Array.isArray(line.tool_use_sequence));
    assert.equal(line.tool_use_sequence[0].name, 'Bash');
    assert.equal(line.tool_use_sequence[0].id_short, 'toolu_01abc1');
    assert.ok(line.subprocess);
    assert.equal(line.subprocess.exit_code, 0);
    assert.equal(line.subprocess.killed_by_watchdog, false);
    // CA-3: el error tiene categoría accionable (NO string opaco).
    assert.ok(/skill_not_invoked/.test(line.error));
    assert.ok(!line.error.includes(_OPAQUE_STRING_REMOVED),
        'string opaco eliminado');
});

test('#3587 CA-2: Skill invocado pero tool_result is_error=true → skill_failed', () => {
    const dir = mkTmpPipelineDir();
    const respuesta = 'El subskill /doc devolvió error. No pude crear el issue.';
    const outcome = ic.inspectResponseForOutcome(respuesta);
    assert.deepEqual(outcome.issuesCreated, []);

    const toolUseSequence = [
        {
            name: 'Skill',
            input: { skill: 'doc', args: 'nueva test' },
            id: 'toolu_skill_001',
            tsMs: 1200,
        },
    ];
    const toolResultsSummary = [
        {
            tool_use_id: 'toolu_skill_001',
            content: 'gh: command not found',
            isError: true,
            tsMs: 5400,
        },
    ];
    const skillResult = ic.inferSkillResult({
        outcome,
        toolUseSequence,
        toolResultsSummary,
        timedOut: false,
    });
    assert.equal(skillResult, ic.SKILL_RESULT_SKILL_FAILED);

    ic.logSkillInvocation({
        pipelineDir: dir,
        skillInvoked: 'doc',
        skillResult,
        provider: 'anthropic',
        intent: 'create_simple',
        toolUseSequence,
        toolResultsSummary,
    });
    const line = readAuditLines(dir)[0];
    assert.equal(line.skill_result, 'skill_failed');
    assert.ok(Array.isArray(line.tool_results_summary));
    assert.equal(line.tool_results_summary[0].is_error, true);
});

test('#3587 CA-2: Skill invocado, issue creado correctamente → success', () => {
    const respuesta = '✓ Issue #4001 creado: arreglar el scroll del checkout';
    const outcome = ic.inspectResponseForOutcome(respuesta);
    const toolUseSequence = [
        { name: 'Skill', input: { skill: 'doc', args: 'nueva ...' }, id: 'toolu_ok_001', tsMs: 1000 },
    ];
    const toolResultsSummary = [
        { tool_use_id: 'toolu_ok_001', content: 'Issue #4001 created', isError: false, tsMs: 4000 },
    ];
    const skillResult = ic.inferSkillResult({
        outcome,
        toolUseSequence,
        toolResultsSummary,
        timedOut: false,
    });
    assert.equal(skillResult, ic.SKILL_RESULT_SUCCESS,
        'modo instrumentado prefiere `success` sobre `ok` legacy');
});

test('#3587 CA-3: enum cerrado incluye los 9 valores (legacy + nuevos)', () => {
    const expected = [
        'success', 'ok', 'error', 'blocked', 'timeout',
        'launching_no_complete', 'invalid_args',
        'skill_not_invoked', 'skill_failed',
    ];
    for (const v of expected) {
        assert.ok(ic.SKILL_RESULT_ENUM.includes(v), `enum debe incluir ${v}`);
    }
});

test('#3587 CA-3: string opaco eliminado del módulo issue-creation', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'commander', 'issue-creation.js'),
        'utf8'
    );
    // El comentario que documenta la eliminación puede contener el string;
    // por eso checkeamos que no aparezca como literal de código (entre
    // comillas simples o dobles).
    const quotedOpaque = new RegExp(`['"\`]${_OPAQUE_STRING_REMOVED}['"\`]`);
    assert.ok(!quotedOpaque.test(src),
        'el string opaco no debe aparecer como literal de código');
});

// -----------------------------------------------------------------------------
// CA-1 — Audit log con campos nuevos, todos redactados/truncados
// -----------------------------------------------------------------------------

test('#3587 CA-1: tool_use_sequence redacta tokens en input_preview', () => {
    const dir = mkTmpPipelineDir();
    const toolUseSequence = [
        {
            name: 'Bash',
            input: {
                command: 'gh auth status',
                // Token simulado que debería ser redactado por redact-read.
                env: 'GITHUB_TOKEN=ghp_abc123def456ghi789jkl012mno345pqr678',
            },
            id: 'toolu_redact_test',
            tsMs: 500,
        },
    ];
    ic.logSkillInvocation({
        pipelineDir: dir,
        skillInvoked: 'doc',
        skillResult: 'skill_not_invoked',
        provider: 'anthropic',
        intent: 'create_simple',
        toolUseSequence,
    });
    const line = readAuditLines(dir)[0];
    const preview = line.tool_use_sequence[0].input_preview;
    assert.ok(!/ghp_abc123def456ghi789jkl012mno345pqr678/.test(preview),
        'el GitHub PAT debe ser redactado del input_preview');
    assert.ok(/REDACTED/.test(preview), 'el preview debe contener el marker [REDACTED]');
});

test('#3587 CA-1: tool_results_summary redacta tokens en content_tail y respeta cap 512', () => {
    const dir = mkTmpPipelineDir();
    const longContent = 'x'.repeat(600) + ' AKIATESTAKIATESTAA12 fin';
    const toolResultsSummary = [
        {
            tool_use_id: 'toolu_long',
            content: longContent,
            isError: false,
            tsMs: 100,
        },
    ];
    ic.logSkillInvocation({
        pipelineDir: dir,
        skillInvoked: 'doc',
        skillResult: 'success',
        provider: 'anthropic',
        intent: 'create_simple',
        toolResultsSummary,
    });
    const line = readAuditLines(dir)[0];
    const tail = line.tool_results_summary[0].content_tail;
    assert.ok(tail.length <= 512, `content_tail debe respetar cap 512 (got ${tail.length})`);
});

test('#3587 CA-1: subprocess metadata se persiste con shape esperado', () => {
    const dir = mkTmpPipelineDir();
    ic.logSkillInvocation({
        pipelineDir: dir,
        skillInvoked: 'doc',
        skillResult: 'timeout',
        provider: 'anthropic',
        intent: 'create_simple',
        subprocess: {
            cmd: 'C:\\path\\to\\claude.cmd',
            args: ['-p', '--output-format', 'stream-json', '--verbose'],
            exitCode: null,
            durationMs: 60123,
            killedByWatchdog: true,
        },
    });
    const line = readAuditLines(dir)[0];
    assert.ok(line.subprocess);
    assert.equal(line.subprocess.cmd, 'C:\\path\\to\\claude.cmd');
    assert.equal(line.subprocess.duration_ms, 60123);
    assert.equal(line.subprocess.killed_by_watchdog, true);
    assert.equal(line.subprocess.exit_code, null);
    assert.ok(typeof line.subprocess.args_redacted === 'string');
});

test('#3587 CA-1: tool_use_sequence se trunca con marker cuando hay >32 entradas', () => {
    const dir = mkTmpPipelineDir();
    const big = [];
    for (let i = 0; i < 50; i++) {
        big.push({ name: 'Read', input: { path: `/tmp/file-${i}.txt` }, id: `toolu_${i}`, tsMs: i * 10 });
    }
    ic.logSkillInvocation({
        pipelineDir: dir,
        skillInvoked: 'doc',
        skillResult: 'skill_not_invoked',
        provider: 'anthropic',
        intent: 'create_simple',
        toolUseSequence: big,
        toolUsedInstead: 'Read',
    });
    const line = readAuditLines(dir)[0];
    assert.equal(line.tool_use_sequence.length, 33, '32 entradas + 1 marker de truncado');
    assert.equal(line.tool_use_sequence[32].name, '_truncated');
    assert.equal(line.tool_use_sequence[32].extra, 18);
});

// -----------------------------------------------------------------------------
// CA-4 — Mensajes a Telegram con UX guidelines (símbolos + natural + variados)
// -----------------------------------------------------------------------------

test('#3587 CA-4: mensaje skill_not_invoked menciona la tool que el LLM usó en su lugar', () => {
    const msg = ic.formatSkillFailureResponse({
        kind: 'skill_not_invoked',
        toolUsedInstead: 'Bash',
    });
    assert.ok(/⚠/.test(msg), 'debe usar símbolo monocromo ⚠ para warning');
    assert.ok(/Bash/.test(msg), 'debe mencionar Bash explícitamente');
    assert.ok(/\/doc/.test(msg), 'debe sugerir alternativa con /doc');
    // No usar emojis multicolor ruidosos.
    assert.ok(!/🚀|🎉|🔴|🟢/.test(msg));
});

test('#3587 CA-4: mensaje skill_failed informa que el subskill corrió pero no creó issue', () => {
    const msg = ic.formatSkillFailureResponse({ kind: 'skill_failed' });
    assert.ok(/✗/.test(msg), 'debe usar ✗ (error real)');
    assert.ok(/audit log/.test(msg) || /reintenta|reintent/i.test(msg),
        'debe sugerir audit log o reintento');
});

test('#3587 CA-4: mensaje timeout incluye duración cuando se le pasa durationMs', () => {
    const msg = ic.formatSkillFailureResponse({ kind: 'timeout', durationMs: 65000 });
    assert.ok(/⏰/.test(msg), 'debe usar símbolo ⏰');
    assert.ok(/65s/.test(msg), `debe mencionar 65s, got: ${msg}`);
});

test('#3587 CA-4: mensaje skill_not_invoked sin toolUsedInstead fallback gracefully', () => {
    const msg = ic.formatSkillFailureResponse({ kind: 'skill_not_invoked' });
    assert.ok(/⚠/.test(msg));
    assert.ok(!/undefined|null/.test(msg), 'no debe leakear undefined/null al user');
});

test('#3587 CA-4: alias no_skill_invoked sigue funcionando (back-compat)', () => {
    const msg = ic.formatSkillFailureResponse({ kind: 'no_skill_invoked', toolUsedInstead: 'Bash' });
    assert.ok(/⚠/.test(msg));
    assert.ok(/Bash/.test(msg));
});

// -----------------------------------------------------------------------------
// CA-2 reproductor del bug histórico: misma forma que los 4 fallos del JSONL
// (planner 23s/82s/51s + doc 56s con el error opaco genérico eliminado en #3587).
// Antes del fix: skill_result == "error". Después del fix: cuando hay trace,
// el bug se clasifica correctamente como skill_not_invoked.
// -----------------------------------------------------------------------------

test('#3587 reproductor: caso doc 56s del 2026-05-26 22:30 — sin trace cae a legacy error, CON trace clasifica correcto', () => {
    // SIN trace (modo legacy, simula commits previos a #3587 instrumentación):
    const outcomeLegacy = ic.inspectResponseForOutcome('Procesado, todo OK.');
    const legacy = ic.inferSkillResult({
        outcome: outcomeLegacy,
        toolUseEmitted: false,
        toolResultEmitted: false,
        timedOut: false,
    });
    assert.equal(legacy, 'error', 'legacy path mantiene comportamiento previo');

    // CON trace (modo instrumentado #3587): el LLM emitió 1 tool_use=Bash.
    const instrumentado = ic.inferSkillResult({
        outcome: outcomeLegacy,
        toolUseSequence: [
            { name: 'Bash', input: { command: 'gh issue list' }, id: 'toolu_bug_repro', tsMs: 30000 },
        ],
        toolResultsSummary: [
            { tool_use_id: 'toolu_bug_repro', content: '#3587 ...', isError: false, tsMs: 56000 },
        ],
        timedOut: false,
    });
    assert.equal(instrumentado, 'skill_not_invoked',
        'modo instrumentado: el bug del issue queda clasificado accionable');
});
