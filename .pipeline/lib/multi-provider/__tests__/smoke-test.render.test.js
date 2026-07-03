// =============================================================================
// smoke-test.render.test.js — tests del renderer por-agente (#3785).
//
// Cubre CA-1..CA-3, CA-8, CA-10, CA-12:
//   - renderPerAgentMarkdown produce una fila por skill de agent-models.json.
//   - overall = PASS si ≥1 provider PASS; SKIPPED si todos SKIPPED/N-A;
//     FAIL en otro caso (WARN-only colapsa a FAIL, CA-3 literal).
//   - overall precedencia PASS > FAIL (WARN-only cuenta como FAIL) > SKIPPED.
//   - la columna overall muestra ícono + palabra (WCAG 1.4.1) + leyenda.
//   - el output NUNCA contiene error_detail crudo ni patrones de secret.
//   - renderTelegramReport lidera con veredicto accionable + FAILs primero.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const smoke = require('../smoke-test');

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function fixtureModels() {
    return {
        default_provider: 'anthropic',
        providers: {
            anthropic:       { launcher: 'claude',   model: 'claude-opus-4-7' },
            'openai-codex':  { launcher: 'codex',    model: 'gpt-5.5' },
            'gemini-google': { launcher: 'gemini',   model: 'gemini-2.0-flash' },
            'cerebras':      { launcher: 'cerebras', model: 'llama-3.3-70b' },
            'nvidia-nim':    { launcher: 'nvidia',   model: 'deepseek-v4' },
            deterministic:   { launcher: 'node',     model: 'deterministic' },
        },
        skills: {
            'backend-dev': { provider: 'anthropic', fallbacks: [{ provider: 'openai-codex' }] },
            'guru':        { provider: 'anthropic', fallbacks: [{ provider: 'openai-codex' }, { provider: 'cerebras' }] },
            'build':       { provider: 'deterministic' },
        },
    };
}

// matriz coverage sintética; cada celda sólo trae los campos "seguros"
// (skill/provider/status/latency_bucket/error_class) que el renderer consume.
function coverageWith(cells) {
    return { matrix: cells };
}

// -----------------------------------------------------------------------------
// CA-2 — una fila por skill de agent-models.json (incluye deterministic).
// -----------------------------------------------------------------------------
test('renderPerAgentMarkdown devuelve una fila por skill de agent-models.json', () => {
    const models = fixtureModels();
    const coverage = coverageWith([
        { skill: 'backend-dev', provider: 'anthropic', status: 'PASS' },
        { skill: 'backend-dev', provider: 'openai-codex', status: 'SKIPPED' },
        { skill: 'guru', provider: 'anthropic', status: 'PASS' },
    ]);
    const md = smoke.renderPerAgentMarkdown(coverage, models);
    const dataRows = md.split('\n').filter(l => l.startsWith('| ') && !/^\|\s*-+/.test(l.replace(/\|/g, '')) && !l.includes(' skill '));
    // header + separator excluidos: contamos filas de skill por presencia del nombre.
    for (const skill of Object.keys(models.skills)) {
        assert.ok(md.includes(`| ${skill}`), `falta fila para skill ${skill}`);
    }
    // 3 skills declarados → 3 filas de datos.
    const skillRowCount = Object.keys(models.skills)
        .filter(s => md.includes(`| ${s}`)).length;
    assert.equal(skillRowCount, 3);
    void dataRows;
});

// -----------------------------------------------------------------------------
// CA-3 — overall = PASS si al menos un provider de la cadena está PASS.
// -----------------------------------------------------------------------------
test('overall es PASS si al menos un provider de la cadena está PASS', () => {
    const models = fixtureModels();
    // guru: default FAIL, pero fallback openai-codex PASS.
    const coverage = coverageWith([
        { skill: 'guru', provider: 'anthropic', status: 'FAIL', error_class: 'timeout' },
        { skill: 'guru', provider: 'openai-codex', status: 'PASS' },
        { skill: 'guru', provider: 'cerebras', status: 'N/A' },
    ]);
    const rows = smoke.computeOverallBySkill(coverage, models);
    const guru = rows.find(r => r.skill === 'guru');
    assert.equal(guru.overall, 'PASS');
    // Y aparece con ícono + palabra en la tabla.
    const md = smoke.renderPerAgentMarkdown(coverage, models);
    assert.match(md, /guru.*✅ PASS/);
});

// -----------------------------------------------------------------------------
// CA-3 — overall = SKIPPED cuando todos los combos son SKIPPED / N/A.
// -----------------------------------------------------------------------------
test('overall es SKIPPED cuando todos los combos son SKIPPED/N-A', () => {
    const models = fixtureModels();
    const coverage = coverageWith([
        { skill: 'backend-dev', provider: 'anthropic', status: 'SKIPPED' },
        { skill: 'backend-dev', provider: 'openai-codex', status: 'N/A' },
    ]);
    const rows = smoke.computeOverallBySkill(coverage, models);
    const be = rows.find(r => r.skill === 'backend-dev');
    assert.equal(be.overall, 'SKIPPED');
});

// -----------------------------------------------------------------------------
// CA-3 — FAIL en todo caso que no sea PASS ni todos SKIPPED/N-A.
// WARN-only (sin PASS) colapsa a FAIL: un skill que sólo degradó no está sano.
// -----------------------------------------------------------------------------
test('overall es FAIL en todo caso que no sea PASS ni todos SKIPPED/N-A', () => {
    assert.equal(smoke.overallForStatuses(['FAIL', 'SKIPPED', 'N/A']), 'FAIL');
    assert.equal(smoke.overallForStatuses(['WARN', 'N/A']), 'FAIL');
    assert.equal(smoke.overallForStatuses(['WARN']), 'FAIL');
    assert.equal(smoke.overallForStatuses(['PASS', 'FAIL', 'WARN']), 'PASS');
    assert.equal(smoke.overallForStatuses(['FAIL', 'WARN']), 'FAIL');
    assert.equal(smoke.overallForStatuses(['N/A', 'N/A']), 'SKIPPED');
    assert.equal(smoke.overallForStatuses(['SKIPPED', 'N/A']), 'SKIPPED');
});

// -----------------------------------------------------------------------------
// CA-10 — leyenda de íconos + overall con ícono+palabra.
// -----------------------------------------------------------------------------
test('la tabla incluye leyenda de íconos y la columna overall muestra ícono+palabra', () => {
    const models = fixtureModels();
    const coverage = coverageWith([{ skill: 'guru', provider: 'anthropic', status: 'PASS' }]);
    const md = smoke.renderPerAgentMarkdown(coverage, models);
    assert.ok(md.includes('Leyenda:'), 'falta leyenda');
    assert.ok(md.includes('✅ PASS'), 'overall no muestra ícono+palabra');
    assert.ok(md.includes('| overall'), 'falta columna overall');
});

// -----------------------------------------------------------------------------
// CA-7 / CA-8 — el output NUNCA contiene error_detail crudo ni patrones de secret.
// -----------------------------------------------------------------------------
test('la tabla NUNCA contiene error_detail crudo ni patrones de secret', () => {
    const models = fixtureModels();
    // coverage con campos "peligrosos": el renderer debe ignorarlos y jamás
    // emitir su contenido (sólo lee skill/provider/status).
    const coverage = coverageWith([
        {
            skill: 'guru', provider: 'anthropic', status: 'FAIL',
            error_class: 'auth',
            // Campos que el renderer NO debe leer/emitir:
            error_detail: 'Authorization: Bearer sk-ant-api03-SUPERSECRETVALUE123456789',
            raw_response: 'bot token 7891234567:AAExampleBotTokenLongEnoughToMatch12345',
        },
    ]);
    const md = smoke.renderPerAgentMarkdown(coverage, models);
    const report = smoke.renderTelegramReport(coverage, models, {
        generatedAt: '2026-07-02T20:00:00Z',
        artifactPath: '.pipeline/multi-provider-coverage.json',
    });
    for (const out of [md, report.text]) {
        assert.doesNotMatch(out, /Bearer/i, 'contiene "Bearer"');
        assert.doesNotMatch(out, /sk-[a-z]/i, 'contiene patrón sk-');
        assert.doesNotMatch(out, /SUPERSECRET/i, 'contiene error_detail crudo');
        assert.doesNotMatch(out, /\d{6,}:[A-Za-z0-9_-]{20,}/, 'contiene bot token');
        assert.doesNotMatch(out, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, 'contiene JWT');
    }
});

// -----------------------------------------------------------------------------
// CA-11 — reporte Telegram: veredicto accionable + FAILs primero + monospace.
// -----------------------------------------------------------------------------
test('renderTelegramReport lidera con veredicto y lista FAILs con skill×provider', () => {
    const models = fixtureModels();
    const coverage = coverageWith([
        { skill: 'backend-dev', provider: 'anthropic', status: 'PASS' },
        { skill: 'guru', provider: 'anthropic', status: 'FAIL', error_class: 'timeout' },
        { skill: 'guru', provider: 'openai-codex', status: 'FAIL', error_class: 'quota_exhausted' },
    ]);
    const report = smoke.renderTelegramReport(coverage, models, {
        generatedAt: '2026-07-02T20:00:00Z',
        artifactPath: '.pipeline/multi-provider-coverage.json',
    });
    const firstLine = report.text.split('\n')[0];
    assert.match(firstLine, /Smoke test multi-provider/);
    // Denominador excluye 'build' (deterministic) → 2 skills LLM.
    assert.match(report.text, /\/2 skills OK/);
    // FAILs nombran skill × provider: error_class.
    assert.match(report.text, /guru × anthropic: timeout/);
    assert.match(report.text, /guru × openai-codex: quota_exhausted/);
    // Tabla envuelta en bloque monospace.
    assert.ok(report.text.includes('```'), 'falta bloque monospace');
    // Artifact = ruta LOCAL, no URL.
    assert.ok(report.text.includes('.pipeline/multi-provider-coverage.json'));
    assert.doesNotMatch(report.text, /https?:\/\//);
});

// -----------------------------------------------------------------------------
// providerChainForSkill — respeta orden default + fallbacks (string u objeto).
// -----------------------------------------------------------------------------
test('providerChainForSkill respeta el orden default + fallbacks', () => {
    assert.deepEqual(
        smoke.providerChainForSkill({ provider: 'anthropic', fallbacks: [{ provider: 'openai-codex' }, 'cerebras'] }),
        ['anthropic', 'openai-codex', 'cerebras']
    );
    assert.deepEqual(smoke.providerChainForSkill({ provider: 'deterministic' }), ['deterministic']);
});

// -----------------------------------------------------------------------------
// CA-4 / CA-12 (regresión) — parseArgs del CLI: --format default json (back-compat),
// markdown opt-in, --telegram, sin romper flags existentes.
// -----------------------------------------------------------------------------
test('parseArgs mantiene --format=json por default y parsea markdown/telegram', () => {
    const { parseArgs } = require('../../../tools/multi-provider-smoke-test');
    // Default: json (back-compat — el stdout sigue siendo JSON).
    assert.equal(parseArgs([]).format, 'json');
    // Markdown opt-in.
    assert.equal(parseArgs(['--format=markdown']).format, 'markdown');
    // Case-insensitive.
    assert.equal(parseArgs(['--format=MARKDOWN']).format, 'markdown');
    // --telegram flag.
    assert.equal(parseArgs(['--telegram']).telegram, true);
    // Flags existentes intactos.
    const a = parseArgs(['--dry-run', '--skill=guru', '--provider=cerebras', '--no-telegram']);
    assert.equal(a.dryRun, true);
    assert.equal(a.skill, 'guru');
    assert.equal(a.provider, 'cerebras');
    assert.equal(a.noTelegram, true);
    assert.equal(a.format, 'json');
});
