// =============================================================================
// Tests del helper `lib/agent-models.js` — focados en #3076 (H4):
// single-source-of-truth para la allowlist de skills determinísticos.
//
// Cobertura:
//   - `getDeterministicSkills()` devuelve los skills con `provider:deterministic`.
//   - Caché funciona (mismo Set en llamadas sucesivas sin override).
//   - Override `jsonPath` evita el caché y refleja el archivo pasado.
//   - JSON inválido o ausente → Set vacío (no tira).
//   - El Set devuelto está congelado (`Object.isFrozen`).
//   - `_resetDeterministicSkillsCacheForTests` permite invalidar entre tests.
//
// La paridad con los 4 callers (`providers/deterministic.js`, `quota-exhausted.js`,
// `rest-mode-window.js`, `dashboard-slices.js`) la valida
// `deterministic-skills-coherence.test.js`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agentModels = require('../agent-models');

const PIPELINE_DIR = path.resolve(__dirname, '..', '..');
const CANONICAL_JSON = path.join(PIPELINE_DIR, 'agent-models.json');
const CANONICAL_SCHEMA = path.join(PIPELINE_DIR, 'agent-models.schema.json');

function tmpJsonPath(suffix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-models-h4-${suffix}-`));
    return path.join(dir, 'agent-models.json');
}

test.beforeEach(() => {
    // Cada test arranca con caché limpio para aislar.
    agentModels._resetDeterministicSkillsCacheForTests();
});

// ─── 1. Lectura del JSON canónico ────────────────────────────────────────────
test('getDeterministicSkills lee del JSON canónico', () => {
    const set = agentModels.getDeterministicSkills();
    assert.ok(set instanceof Set, 'debe ser un Set');
    // En HEAD post-#3072 los 4 skills deben estar declarados.
    for (const skill of ['build', 'tester', 'delivery', 'linter']) {
        assert.ok(set.has(skill),
            `skill "${skill}" debería tener provider:deterministic en agent-models.json`);
    }
});

test('getDeterministicSkills NO incluye skills LLM (anthropic, openai-codex)', () => {
    const set = agentModels.getDeterministicSkills();
    // Sanity: skills LLM declarados en el JSON canónico NO deben aparecer.
    for (const skill of ['guru', 'po', 'qa', 'backend-dev', 'pipeline-dev']) {
        assert.ok(!set.has(skill),
            `skill "${skill}" es LLM (anthropic) — NO debe estar en el set determinístico`);
    }
});

// ─── 2. Set congelado ───────────────────────────────────────────────────────
test('el Set devuelto está congelado (no se puede mutar)', () => {
    const set = agentModels.getDeterministicSkills();
    assert.ok(Object.isFrozen(set),
        'el Set debe estar congelado para prevenir mutación accidental por callers');
});

// ─── 3. Caché ────────────────────────────────────────────────────────────────
test('getDeterministicSkills cachea el resultado entre llamadas', () => {
    const set1 = agentModels.getDeterministicSkills();
    const set2 = agentModels.getDeterministicSkills();
    assert.strictEqual(set1, set2,
        'la segunda llamada debe devolver la misma instancia (caché activo)');
});

test('_resetDeterministicSkillsCacheForTests invalida el caché', () => {
    const set1 = agentModels.getDeterministicSkills();
    agentModels._resetDeterministicSkillsCacheForTests();
    const set2 = agentModels.getDeterministicSkills();
    assert.notStrictEqual(set1, set2,
        'tras reset, una nueva llamada debe devolver una instancia nueva');
    // Pero el contenido debe ser idéntico (mismo JSON).
    assert.deepEqual([...set1].sort(), [...set2].sort());
});

// ─── 4. Override de path (tests) ─────────────────────────────────────────────
test('option jsonPath permite leer un archivo de fixture', () => {
    const fixturePath = tmpJsonPath('fixture');
    const fixture = {
        $schema: './agent-models.schema.json',
        default_provider: 'anthropic',
        providers: {
            anthropic: {
                launcher: 'claude',
                model: 'claude-opus-4-7',
                spawn_args_template: ['-p', '{user_prompt}'],
                output_parser: 'anthropic-stream-json',
                quota_error_types: ['usage_limit_error'],
                resets_at_cap_max_days: 7,
                supports_tool_use: true,
                prompt_caching: { supported: true },
                credentials_env: ['ANTHROPIC_API_KEY'],
                permissions_mode: 'bypassPermissions',
            },
            deterministic: {
                launcher: 'node',
                model: 'deterministic',
                spawn_args_template: ['{script_path}', '{issue}', '--trabajando={trabajando_path}'],
                output_parser: 'none',
                quota_error_types: [],
                supports_tool_use: false,
                prompt_caching: { supported: false },
            },
        },
        skills: {
            'foo-skill': { provider: 'deterministic' },
            'bar-skill': { provider: 'anthropic' },
            'baz-skill': { provider: 'deterministic' },
        },
    };
    fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));

    const set = agentModels.getDeterministicSkills({
        jsonPath: fixturePath,
        schemaPath: CANONICAL_SCHEMA,
    });
    assert.deepEqual([...set].sort(), ['baz-skill', 'foo-skill']);
});

test('option jsonPath NO usa ni actualiza el caché global', () => {
    // Primero poblamos el caché global con el JSON canónico.
    const canonical = agentModels.getDeterministicSkills();
    // Luego llamamos con un override.
    const fixturePath = tmpJsonPath('no-cache');
    fs.writeFileSync(fixturePath, JSON.stringify({
        $schema: './agent-models.schema.json',
        default_provider: 'anthropic',
        providers: {
            anthropic: {
                launcher: 'claude',
                model: 'claude-opus-4-7',
                spawn_args_template: ['-p', '{user_prompt}'],
                output_parser: 'anthropic-stream-json',
                quota_error_types: ['usage_limit_error'],
                resets_at_cap_max_days: 7,
                supports_tool_use: true,
                prompt_caching: { supported: true },
                credentials_env: ['ANTHROPIC_API_KEY'],
                permissions_mode: 'bypassPermissions',
            },
            deterministic: {
                launcher: 'node',
                model: 'deterministic',
                spawn_args_template: ['{script_path}', '{issue}', '--trabajando={trabajando_path}'],
                output_parser: 'none',
                quota_error_types: [],
                supports_tool_use: false,
                prompt_caching: { supported: false },
            },
        },
        skills: {
            'only-one': { provider: 'deterministic' },
        },
    }));
    const override = agentModels.getDeterministicSkills({
        jsonPath: fixturePath,
        schemaPath: CANONICAL_SCHEMA,
    });
    assert.deepEqual([...override], ['only-one']);

    // La siguiente llamada sin override debe seguir devolviendo el caché original.
    const again = agentModels.getDeterministicSkills();
    assert.strictEqual(again, canonical,
        'el override no debe invalidar ni reemplazar el caché global');
});

// ─── 5. Tolerancia a fallos ──────────────────────────────────────────────────
test('JSON ausente → Set vacío congelado (no tira)', () => {
    const missing = path.join(os.tmpdir(), 'definitely-missing-' + Date.now() + '.json');
    const set = agentModels.getDeterministicSkills({
        jsonPath: missing,
        schemaPath: CANONICAL_SCHEMA,
    });
    assert.ok(set instanceof Set);
    assert.equal(set.size, 0);
    assert.ok(Object.isFrozen(set));
});

test('JSON corrupto → Set vacío (no tira)', () => {
    const corrupt = tmpJsonPath('corrupt');
    fs.writeFileSync(corrupt, '{esto-no-es-json}');
    const set = agentModels.getDeterministicSkills({
        jsonPath: corrupt,
        schemaPath: CANONICAL_SCHEMA,
    });
    assert.equal(set.size, 0);
});

// ─── 6. Single-source-of-truth: 4 callers comparten el mismo set ─────────────
test('los 4 callers consumen el mismo set del helper (post-H4)', () => {
    // Verifica empíricamente que tras #3076 ningún caller declara su propia
    // lista. Si alguien re-introduce un literal `new Set([...])` con skills
    // determinísticos, este test cae cuando el JSON cambie.
    const fromHelper = [...agentModels.getDeterministicSkills()].sort();
    const sources = {
        'providers/deterministic.js': [...require('../agent-launcher/providers/deterministic').DETERMINISTIC_SKILLS].sort(),
        'quota-exhausted.js':         [...require('../quota-exhausted').DETERMINISTIC_SKILLS].sort(),
        'rest-mode-window.js':        [...require('../rest-mode-window').DETERMINISTIC_SKILLS].sort(),
        'dashboard-slices.js':        [...require('../dashboard-slices')._DETERMINISTIC_SKILLS].sort(),
    };
    for (const [src, list] of Object.entries(sources)) {
        assert.deepEqual(list, fromHelper,
            `${src} debe leer DETERMINISTIC_SKILLS del helper agent-models.js, ` +
            `pero declara una lista distinta: [${list.join(', ')}]. ` +
            `Esto reintroduciría el drift que H4 (#3076) eliminó.`);
    }
});
