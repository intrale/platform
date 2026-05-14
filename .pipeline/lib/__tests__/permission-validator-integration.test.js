// =============================================================================
// permission-validator-integration.test.js — Test de integración real.
//
// Issue #3082 — CA-7 + CA-18.
//
// Iteramos los SKILL.md reales del repo + agent-models.json real, y validamos:
//   - Cada skill declara required_permissions (CA-7).
//   - Las capabilities declaradas están en el catálogo (CA-9 negative path).
//   - Cada skill pasa validateSpawn contra su provider+mode actuales.
//
// Esto es el "test de paridad real" que el PO pidió en CA-18 — sin necesidad
// de YAML truth table separada porque la matriz canónica YA es la fuente de
// verdad y los assertions corren contra ella.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const permissionValidator = require('../permission-validator');
const skillsMetadata = require('../skills-metadata');
const { resolveProviderForSkill } = require('../agent-launcher/resolve-provider');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SKILLS_ROOT = path.join(REPO_ROOT, '.claude', 'skills');
const PIPELINE_DIR = path.join(REPO_ROOT, '.pipeline');

test('todos los skills reales del repo declaran required_permissions (CA-7)', () => {
    const r = skillsMetadata.lintAllSkillsForPreCommit({ skillsRoot: SKILLS_ROOT });
    if (!r.ok) {
        const missing = r.errors.filter(e => e.kind === 'missing').map(e => e.skill);
        const unknown = r.errors.filter(e => e.kind === 'unknown_capability').map(e => e.skill);
        const msg = [];
        if (missing.length) msg.push(`Skills sin required_permissions: ${missing.join(', ')}`);
        if (unknown.length) msg.push(`Skills con capability inválida: ${unknown.join(', ')}`);
        assert.fail(msg.join(' | '));
    }
});

test('todos los skills reales del repo pasan validateSpawn contra su provider configurado (CA-18 real)', () => {
    const { registry } = skillsMetadata.loadAllSkillsMetadata({ skillsRoot: SKILLS_ROOT });
    const failures = [];
    for (const [skill, meta] of Object.entries(registry)) {
        const required = Array.isArray(meta.required_permissions) ? meta.required_permissions : [];
        const resolved = resolveProviderForSkill(skill, { pipelineDir: PIPELINE_DIR });
        if (!resolved) {
            failures.push({ skill, reason: 'no_resolve' });
            continue;
        }
        if (resolved.provider === 'deterministic') continue; // gate no aplica
        const r = permissionValidator.validateSpawn({
            skill,
            provider: resolved.provider,
            mode: resolved.mode || 'bypassPermissions',
            requiredCapabilities: required,
        });
        if (!r.ok) {
            failures.push({ skill, provider: resolved.provider, mode: resolved.mode, reason: r.reason, missing: r.missing });
        }
    }
    if (failures.length > 0) {
        const msg = failures.map(f => `${f.skill}@${f.provider}/${f.mode}: ${f.reason} (missing: ${(f.missing || []).join(',')})`).join('\n');
        assert.fail(`Skills que no validan contra su provider configurado:\n${msg}`);
    }
});

test('NON_DEGRADABLE skills reales del repo declaran al menos UNA capability que codex/full-auto no concede', () => {
    // Garantiza CA-11: si alguien apunta uno de estos skills a codex,
    // validateSpawn DEBE rechazar fail-CLOSED sin posibilidad de override.
    const { registry } = skillsMetadata.loadAllSkillsMetadata({ skillsRoot: SKILLS_ROOT });
    const failures = [];
    for (const skill of permissionValidator.NON_DEGRADABLE_SKILLS) {
        const meta = registry[skill];
        if (!meta) continue;
        const required = Array.isArray(meta.required_permissions) ? meta.required_permissions : [];
        const r = permissionValidator.validateSpawn({
            skill,
            provider: 'openai-codex',
            mode: 'full-auto',
            requiredCapabilities: required,
        });
        if (r.ok) {
            failures.push({ skill, reason: 'NON_DEGRADABLE skill DEBE fail-CLOSED en codex/full-auto pero pasó' });
        } else if (r.reason !== 'non_degradable') {
            failures.push({ skill, reason: `esperaba reason=non_degradable, fue ${r.reason}` });
        }
    }
    if (failures.length > 0) {
        assert.fail(`NON_DEGRADABLE coherence check falló: ${failures.map(f => `${f.skill}: ${f.reason}`).join(' | ')}`);
    }
});

test('schema de skills (docs/skills/skill-metadata.schema.json) declara enum coherente con KNOWN_CAPABILITIES', () => {
    const fs = require('node:fs');
    const schemaPath = path.join(REPO_ROOT, 'docs', 'skills', 'skill-metadata.schema.json');
    assert.ok(fs.existsSync(schemaPath), `Falta schema en ${schemaPath}`);
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const itemEnum = schema.properties.required_permissions.items.enum;
    const capabilities = require('../capabilities');
    const known = [...capabilities.KNOWN_CAPABILITIES].sort();
    const inSchema = [...itemEnum].sort();
    assert.deepEqual(inSchema, known, 'El enum del schema debe coincidir con KNOWN_CAPABILITIES');
});
