// =============================================================================
// resolve-model-por-actor.test.js — #6271 (split de #6270)
//
// Verifica que la resolución del modelo sea por par (skill, provider) y lea el
// campo canónico `model_override` del schema real de agent-models.json.
//
// Bug original: `resolve-provider.js` leía `skillCfg.model`, campo que NO existe
// en el schema, con lo cual los 23 skills declarados resolvían de manera uniforme
// el literal legacy `claude-opus-4-7` ignorando su modelo declarado.
//
// Cobertura pedida por el issue: lectura de `model_override`, alias `model`,
// resolución por fallback, y ausencia de declaración.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    resolveProviderForSkill,
    resolveModelForSkillProvider,
    resolveModelsByProvider,
    readAgentModels,
    LEGACY_ANTHROPIC_MODEL,
} = require('../resolve-provider');

// Directorio real del pipeline (.pipeline/) desde __tests__/.
const REAL_PIPELINE_DIR = path.join(__dirname, '..', '..', '..');

// -----------------------------------------------------------------------------
// Fixture sintético: cubre los 4 casos del issue sin depender del JSON real.
// -----------------------------------------------------------------------------
function agentModels() {
    return {
        default_provider: 'anthropic',
        providers: {
            anthropic: { launcher: 'claude', model: 'claude-opus-4-7' },
            'openai-codex': { launcher: 'codex', model: 'gpt-5.5' },
            'gemini-google': { launcher: 'gemini', model: 'gemini-3-flash-preview' },
            cerebras: { launcher: 'cerebras', model: 'gpt-oss-120b' },
        },
        skills: {
            // Caso canónico: declara model_override + fallbacks con modelo propio.
            qa: {
                provider: 'anthropic',
                model_override: 'claude-sonnet-4-6',
                fallbacks: [
                    { provider: 'openai-codex', model_override: 'gpt-5.4' },
                    { provider: 'gemini-google', model_override: 'gemini-3-flash-preview' },
                ],
            },
            // Caso alias legacy: usa `model` en vez de `model_override`.
            'skill-alias': {
                provider: 'anthropic',
                model: 'claude-haiku-4-5',
            },
            // Caso ambos declarados: model_override gana sobre el alias.
            'skill-ambos': {
                provider: 'anthropic',
                model_override: 'claude-sonnet-4-6',
                model: 'modelo-viejo-ignorado',
            },
            // Caso sin declaración: hereda el default del provider.
            'skill-sin-modelo': {
                provider: 'openai-codex',
            },
            // Caso fallback legacy en shape string (sin modelo pin-eado).
            'skill-fb-string': {
                provider: 'anthropic',
                model_override: 'claude-sonnet-4-6',
                fallbacks: ['cerebras'],
            },
        },
    };
}

function withPipelineDir(models, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am6271-'));
    try {
        fs.writeFileSync(path.join(dir, 'agent-models.json'), JSON.stringify(models), 'utf8');
        return fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// -----------------------------------------------------------------------------
// CA-1 — lectura de model_override
// -----------------------------------------------------------------------------
test('el skill resuelve el modelo declarado en model_override y no el literal legacy', () => {
    const m = agentModels();
    assert.equal(resolveModelForSkillProvider(m, 'qa', 'anthropic'), 'claude-sonnet-4-6');
    assert.notEqual(resolveModelForSkillProvider(m, 'qa', 'anthropic'), LEGACY_ANTHROPIC_MODEL);
});

test('resolveProviderForSkill expone el model_override del skill', () => {
    withPipelineDir(agentModels(), (dir) => {
        const r = resolveProviderForSkill('qa', { pipelineDir: dir });
        assert.equal(r.provider, 'anthropic');
        assert.equal(r.model, 'claude-sonnet-4-6');
        assert.equal(r.source, 'agent-models');
    });
});

test('actores distintos resuelven modelos distintos', () => {
    withPipelineDir(agentModels(), (dir) => {
        const qa = resolveProviderForSkill('qa', { pipelineDir: dir }).model;
        const alias = resolveProviderForSkill('skill-alias', { pipelineDir: dir }).model;
        assert.notEqual(qa, alias, 'los modelos no pueden ser uniformes entre actores');
    });
});

// -----------------------------------------------------------------------------
// Alias de compatibilidad `model`
// -----------------------------------------------------------------------------
test('el campo model se acepta como alias de compatibilidad', () => {
    const m = agentModels();
    assert.equal(resolveModelForSkillProvider(m, 'skill-alias', 'anthropic'), 'claude-haiku-4-5');
});

test('model_override tiene precedencia sobre el alias model', () => {
    const m = agentModels();
    assert.equal(resolveModelForSkillProvider(m, 'skill-ambos', 'anthropic'), 'claude-sonnet-4-6');
});

// -----------------------------------------------------------------------------
// CA-2 — resolución contra un proveedor de la cadena de respaldo
// -----------------------------------------------------------------------------
test('el fallback aporta su propio model_override, no el del primario', () => {
    const m = agentModels();
    assert.equal(resolveModelForSkillProvider(m, 'qa', 'openai-codex'), 'gpt-5.4');
    assert.equal(resolveModelForSkillProvider(m, 'qa', 'gemini-google'), 'gemini-3-flash-preview');
    // El override del primario NO debe filtrarse al fallback (bug advertido en #3221).
    assert.notEqual(resolveModelForSkillProvider(m, 'qa', 'openai-codex'), 'claude-sonnet-4-6');
});

test('un fallback en shape string legacy usa el model default de su provider', () => {
    const m = agentModels();
    assert.equal(resolveModelForSkillProvider(m, 'skill-fb-string', 'cerebras'), 'gpt-oss-120b');
});

test('models_by_provider mapea toda la cadena declarada del skill', () => {
    const m = agentModels();
    assert.deepEqual(resolveModelsByProvider(m, 'qa'), {
        'anthropic': 'claude-sonnet-4-6',
        'openai-codex': 'gpt-5.4',
        'gemini-google': 'gemini-3-flash-preview',
    });
});

// -----------------------------------------------------------------------------
// CA-3 — ausencia de declaración: hereda el default sin excepción
// -----------------------------------------------------------------------------
test('un skill sin modelo declarado hereda el default de su provider sin tirar', () => {
    const m = agentModels();
    assert.doesNotThrow(() => resolveModelForSkillProvider(m, 'skill-sin-modelo', 'openai-codex'));
    assert.equal(resolveModelForSkillProvider(m, 'skill-sin-modelo', 'openai-codex'), 'gpt-5.5');
});

test('un skill inexistente cae al default de anthropic sin excepcion', () => {
    withPipelineDir(agentModels(), (dir) => {
        let r;
        assert.doesNotThrow(() => {
            r = resolveProviderForSkill('skill-que-no-existe', { pipelineDir: dir });
        });
        assert.equal(r.provider, 'anthropic');
        assert.equal(r.model, 'claude-opus-4-7');
        assert.equal(r.source, 'fallback-skill-not-found');
    });
});

test('el helper es defensivo ante models null, invalido o con error de lectura', () => {
    assert.equal(resolveModelForSkillProvider(null, 'qa', 'anthropic'), LEGACY_ANTHROPIC_MODEL);
    assert.equal(resolveModelForSkillProvider({ __readError: 'boom' }, 'qa', 'anthropic'), LEGACY_ANTHROPIC_MODEL);
    assert.equal(resolveModelForSkillProvider({}, 'qa', 'anthropic'), LEGACY_ANTHROPIC_MODEL);
    // El caller puede pedir "sin modelo" en vez del literal legacy.
    assert.equal(resolveModelForSkillProvider(null, 'qa', 'anthropic', { fallbackModel: null }), null);
});

test('models.defaults.model se sigue respetando si el provider no declara model', () => {
    const m = {
        providers: { 'sin-model': { launcher: 'x' } },
        defaults: { model: 'modelo-default-historico' },
        skills: { s: { provider: 'sin-model' } },
    };
    assert.equal(resolveModelForSkillProvider(m, 's', 'sin-model'), 'modelo-default-historico');
});

// -----------------------------------------------------------------------------
// CA-1 / CA-4 contra el archivo REAL del pipeline (no fixture).
// -----------------------------------------------------------------------------
test('contra el agent-models.json real los actores ya no resuelven un modelo uniforme', () => {
    const models = readAgentModels(REAL_PIPELINE_DIR);
    assert.ok(models && !models.__readError, 'el agent-models.json real debe leerse');

    const modelos = new Set();
    for (const skill of Object.keys(models.skills)) {
        const r = resolveProviderForSkill(skill, { pipelineDir: REAL_PIPELINE_DIR });
        if (r.model) modelos.add(r.model);
    }
    assert.ok(modelos.size > 1,
        `los skills reales deben resolver modelos distintos, se obtuvo: ${[...modelos].join(', ')}`);
});

test('los skills reales que declaran model_override resuelven ESE modelo', () => {
    const models = readAgentModels(REAL_PIPELINE_DIR);
    for (const [skill, cfg] of Object.entries(models.skills)) {
        if (typeof cfg.model_override !== 'string') continue;
        if (cfg.provider === 'deterministic') continue;
        const r = resolveProviderForSkill(skill, { pipelineDir: REAL_PIPELINE_DIR });
        assert.equal(r.model, cfg.model_override, `${skill} debe resolver su model_override`);
    }
});

test('CA-4: telegram-commander y telegram-sherlock son los identificadores canonicos y resuelven', () => {
    const models = readAgentModels(REAL_PIPELINE_DIR);

    for (const skill of ['telegram-commander', 'telegram-sherlock']) {
        const r = resolveProviderForSkill(skill, { pipelineDir: REAL_PIPELINE_DIR });
        assert.equal(r.source, 'agent-models', `${skill} no debe caer en fallback-skill-not-found`);
        assert.equal(r.model, models.skills[skill].model_override);
    }

    // Los nombres cortos NO deben existir como claves duplicadas (hallazgo de guru).
    assert.equal(models.skills.commander, undefined, 'no debe existir la clave duplicada `commander`');
    assert.equal(models.skills.sherlock, undefined, 'no debe existir la clave duplicada `sherlock`');

    // Y el motivo por el que los nombres cortos caen al default queda documentado
    // en el propio archivo (segunda opción habilitada por CA-4).
    assert.ok(models._doc.includes('telegram-commander') && models._doc.includes('telegram-sherlock'),
        'el _doc debe documentar los identificadores canonicos');
});

// -----------------------------------------------------------------------------
// Regresión: la rama determinística no se toca (sigue devolviendo model null).
// -----------------------------------------------------------------------------
test('los skills deterministicos siguen resolviendo model null', () => {
    for (const skill of ['build', 'tester', 'linter', 'delivery']) {
        const r = resolveProviderForSkill(skill, { pipelineDir: REAL_PIPELINE_DIR });
        assert.equal(r.provider, 'deterministic');
        assert.equal(r.model, null, `${skill} debe seguir sin modelo`);
    }
});
