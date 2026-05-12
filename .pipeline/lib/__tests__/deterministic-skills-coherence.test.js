// =============================================================================
// Tests de coherencia de skills determinísticos — prevención de regresión.
//
// Origen: incidente 2026-05-11 (PR #3157). El skill `build` consumía $2.72/h
// con Opus 4.7 porque tres fuentes de verdad divergieron:
//
//   1. config.yaml > skills_por_fase.build → ['build']        (skill name "build")
//   2. agent-models.json > skills.build    → { provider: deterministic }
//   3. providers/deterministic.js          → DETERMINISTIC_SKILLS = ['builder', ...]
//   4. skills-deterministicos/builder.js   (archivo físico con nombre viejo)
//
// El Pulpo mandaba PIPELINE_SKILL=build pero la allowlist tenía 'builder', así
// que resolveProviderForSkill('build') caía al fallback Anthropic en lugar de
// dispatch al script Node puro. Ningún test detectaba ese drift.
//
// Estos tests validan las 4 fuentes en conjunto, así una próxima divergencia
// (rename de archivo, edición de allowlist, cambio de skill name en config)
// rompe la suite ANTES del merge.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const PIPELINE_DIR = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(PIPELINE_DIR, '..');

const detHandler = require('../agent-launcher/providers/deterministic');
const { resolveProviderForSkill } = require('../agent-launcher/resolve-provider');

function loadAgentModels() {
    const p = path.join(PIPELINE_DIR, 'agent-models.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadConfigYaml() {
    const p = path.join(PIPELINE_DIR, 'config.yaml');
    return yaml.load(fs.readFileSync(p, 'utf8'));
}

function listSkillsInConfig(cfg) {
    const out = new Set();
    const pipelines = cfg.pipelines || {};
    for (const pipe of Object.values(pipelines)) {
        const skillsByPhase = pipe.skills_por_fase || {};
        for (const skills of Object.values(skillsByPhase)) {
            for (const s of (skills || [])) out.add(s);
        }
    }
    return out;
}

// ─── 1. Allowlist hardcoded ↔ archivo físico ─────────────────────────────────
test('cada skill en DETERMINISTIC_SKILLS tiene su archivo Node correspondiente', () => {
    const skillsDir = path.join(PIPELINE_DIR, 'skills-deterministicos');
    for (const skill of detHandler.DETERMINISTIC_SKILLS) {
        const scriptPath = path.join(skillsDir, `${skill}.js`);
        assert.ok(
            fs.existsSync(scriptPath),
            `skill "${skill}" está en DETERMINISTIC_SKILLS allowlist pero falta ` +
            `el archivo ${scriptPath}. Si el archivo se renombró, actualizar la allowlist en ` +
            `lib/agent-launcher/providers/deterministic.js — esto fue exactamente la regresión del #3157.`
        );
    }
});

// ─── 2. Archivo físico ↔ allowlist hardcoded ─────────────────────────────────
test('cada script en skills-deterministicos/ está declarado en DETERMINISTIC_SKILLS', () => {
    const skillsDir = path.join(PIPELINE_DIR, 'skills-deterministicos');
    const files = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.js'))
        .map(e => e.name.replace(/\.js$/, ''));

    for (const skill of files) {
        assert.ok(
            detHandler.DETERMINISTIC_SKILLS.has(skill),
            `archivo skills-deterministicos/${skill}.js existe pero el skill "${skill}" ` +
            `NO está en la allowlist DETERMINISTIC_SKILLS de lib/agent-launcher/providers/deterministic.js. ` +
            `El Pulpo nunca lo va a dispatchar al runner Node — caerá al fallback LLM.`
        );
    }
});

// ─── 3. agent-models.json ↔ allowlist hardcoded ──────────────────────────────
test('todo skill con provider:deterministic en agent-models.json está en DETERMINISTIC_SKILLS', () => {
    const models = loadAgentModels();
    for (const [skill, cfg] of Object.entries(models.skills || {})) {
        if (cfg.provider !== 'deterministic') continue;
        assert.ok(
            detHandler.DETERMINISTIC_SKILLS.has(skill),
            `skill "${skill}" tiene provider:deterministic en agent-models.json pero NO está ` +
            `en la allowlist DETERMINISTIC_SKILLS — el spawn fallará con "no está en la allowlist".`
        );
    }
});

test('todo skill en DETERMINISTIC_SKILLS está declarado como deterministic en agent-models.json', () => {
    const models = loadAgentModels();
    for (const skill of detHandler.DETERMINISTIC_SKILLS) {
        const cfg = (models.skills || {})[skill];
        assert.ok(
            cfg,
            `skill "${skill}" está en DETERMINISTIC_SKILLS allowlist pero no aparece en ` +
            `agent-models.json > skills. El hash sería resuelto como anthropic por fallback-skill-not-found.`
        );
        assert.equal(
            cfg.provider, 'deterministic',
            `skill "${skill}" está en DETERMINISTIC_SKILLS pero agent-models.json lo declara ` +
            `con provider:${cfg.provider} — inconsistencia que enmascara dispatch real (el código de ` +
            `resolveProviderForSkill prioriza la allowlist hardcoded, pero la confusión es peligrosa).`
        );
    }
});

// ─── 4. config.yaml ↔ allowlist hardcoded ────────────────────────────────────
test('los skills determinísticos referenciados en config.yaml coinciden con la allowlist', () => {
    const cfg = loadConfigYaml();
    const skillsInConfig = listSkillsInConfig(cfg);

    for (const skill of detHandler.DETERMINISTIC_SKILLS) {
        assert.ok(
            skillsInConfig.has(skill),
            `skill "${skill}" está en DETERMINISTIC_SKILLS pero NO aparece en config.yaml > skills_por_fase. ` +
            `Skill huérfana — nunca lo lanza el Pulpo.`
        );
    }
});

// ─── 5. End-to-end: resolveProviderForSkill devuelve deterministic ───────────
test('resolveProviderForSkill devuelve provider=deterministic para los 4 skills críticos', () => {
    for (const skill of detHandler.DETERMINISTIC_SKILLS) {
        const r = resolveProviderForSkill(skill, { pipelineDir: PIPELINE_DIR });
        assert.equal(
            r.provider, 'deterministic',
            `resolveProviderForSkill("${skill}") devolvió provider=${r.provider} (source=${r.source}). ` +
            `Esto significa que el skill caería en el fallback Anthropic/LLM y consumiría tokens innecesariamente. ` +
            `Causa raíz típica del #3157: mismatch entre skill name del Pulpo y allowlist hardcoded.`
        );
        assert.equal(r.source, 'deterministic-allowlist',
            `source debería ser 'deterministic-allowlist' (resuelto antes de leer agent-models.json), ` +
            `pero fue '${r.source}'.`
        );
    }
});

// ─── 6. buildSpawn produce comando Node, no claude ───────────────────────────
test('buildSpawn de cada skill determinístico spawnea node, no claude.exe', () => {
    for (const skill of detHandler.DETERMINISTIC_SKILLS) {
        const spawn = detHandler.buildSpawn({
            skill,
            issue: 9999,
            trabajandoPath: 'C:/tmp/fake',
            cwd: REPO_ROOT,
            env: { PATH: process.env.PATH || '' },
            ROOT: REPO_ROOT,
            PIPELINE: PIPELINE_DIR,
        });
        assert.equal(spawn.cmd, process.execPath,
            `buildSpawn("${skill}") debería usar node (process.execPath) pero usa ${spawn.cmd}`);
        assert.ok(spawn.scriptPath.endsWith(`${skill}.js`),
            `scriptPath debería terminar en ${skill}.js, no en ${spawn.scriptPath}`);
        assert.equal(spawn.spawnOpts.shell, false,
            `shell debe ser false para skills determinísticos (defensa I1)`);
    }
});

// ─── 7. Cross-source: 4 copias del allowlist sincronizadas ───────────────────
// La allowlist está duplicada en 4 archivos (cada uno lo declara para evitar
// require circular o por separación de responsabilidad). Antes de #3157 nadie
// validaba que coincidieran. Si una se actualiza y otras quedan atrás, vuelve
// el mismo patrón de bug — un skill nuevo se gatearía como LLM en un componente
// y como determinístico en otro.
test('las 4 copias del allowlist determinístico están sincronizadas', () => {
    const detSet = new Set(detHandler.DETERMINISTIC_SKILLS);
    const quotaSet = new Set(require('../quota-exhausted').DETERMINISTIC_SKILLS);
    const restSet = new Set(require('../rest-mode-window').DETERMINISTIC_SKILLS);
    const dashSet = new Set(require('../dashboard-slices')._DETERMINISTIC_SKILLS);

    const expected = Array.from(detSet).sort();
    const sources = {
        'agent-launcher/providers/deterministic.js': Array.from(detSet).sort(),
        'lib/quota-exhausted.js':                    Array.from(quotaSet).sort(),
        'lib/rest-mode-window.js':                   Array.from(restSet).sort(),
        'lib/dashboard-slices.js':                   Array.from(dashSet).sort(),
    };

    for (const [src, list] of Object.entries(sources)) {
        assert.deepEqual(list, expected,
            `${src} declara DETERMINISTIC_SKILLS=[${list.join(', ')}] pero la fuente canónica ` +
            `(agent-launcher/providers/deterministic.js) declara [${expected.join(', ')}]. ` +
            `Las 4 listas DEBEN coincidir — si divergen, un skill nuevo puede correr Node en un ` +
            `lado y caer al fallback LLM en otro (este es exactamente el patrón del #3157, ampliado).`
        );
    }
});
