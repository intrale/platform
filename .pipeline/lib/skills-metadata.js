// =============================================================================
// skills-metadata.js — Loader y validador del frontmatter de SKILL.md files.
//
// Issue: #3082 (S4 multi-provider) — CA-6, CA-7 del PO.
//
// Cada `.claude/skills/<skill>/SKILL.md` declara metadata en frontmatter YAML
// minimalista (NO uses libraries pesadas como js-yaml — parser propio porque
// el frontmatter del repo usa exclusivamente `key: value` y `key: [a, b, c]`).
//
// Campo obligatorio para #3082:
//   - required_permissions: array de strings; cada uno debe estar en
//     KNOWN_CAPABILITIES (lib/capabilities.js).
//
// Errores de carga:
//   - frontmatter ausente / mal formado → skip + warning (los skills viejos
//     que no migraron quedan sin metadata; el caller decide qué hacer).
//   - required_permissions con valores fuera del catálogo → throw para que
//     el pre-commit o boot fail-fast.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const capabilities = require('./capabilities');

// -----------------------------------------------------------------------------
// parseFrontmatter — extrae el bloque entre `---\n` y `\n---\n` del inicio
// del archivo. Devuelve { meta, body } o null si no hay frontmatter.
//
// Soporta valores: string, número, boolean, array inline (`[a, b, c]`).
// NO soporta YAML anidado — el frontmatter del repo es plano por convención.
// -----------------------------------------------------------------------------
function parseFrontmatter(content) {
    if (typeof content !== 'string') return null;
    if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return null;

    const startLen = content.startsWith('---\r\n') ? 5 : 4;
    const rest = content.slice(startLen);
    const endRe = /\r?\n---\r?\n/;
    const m = rest.match(endRe);
    if (!m) return null;
    const yamlBlock = rest.slice(0, m.index);
    const body = rest.slice(m.index + m[0].length);

    const meta = {};
    const lines = yamlBlock.split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (line.length === 0 || line.startsWith('#')) continue;
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        let value = line.slice(colonIdx + 1).trim();
        if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
            value = value.slice(1, -1);
        } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
            value = value.slice(1, -1);
        } else if (value.startsWith('[') && value.endsWith(']')) {
            // Array inline: [a, b, c]  ó  ["a", "b"]
            const inner = value.slice(1, -1).trim();
            if (inner.length === 0) {
                value = [];
            } else {
                value = inner.split(',').map(s => {
                    const t = s.trim();
                    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
                        return t.slice(1, -1);
                    }
                    return t;
                });
            }
        } else if (value === 'true') {
            value = true;
        } else if (value === 'false') {
            value = false;
        } else if (/^-?\d+(\.\d+)?$/.test(value)) {
            value = Number(value);
        }
        meta[key] = value;
    }
    return { meta, body };
}

// -----------------------------------------------------------------------------
// loadSkillMetadata — lee un SKILL.md específico y devuelve su metadata.
//
// Retorna `{ skill, meta, source }` o lanza si:
//   - el archivo no existe / no es legible
//   - falta frontmatter
//   - required_permissions tiene valores fuera del catálogo
//
// `required_permissions` ausente NO lanza acá — eso lo decide el caller.
// Algunos skills viejos pueden no haber migrado todavía y el lint pre-commit
// los marca por separado.
// -----------------------------------------------------------------------------
function loadSkillMetadata(skill, { skillsRoot, fsImpl } = {}) {
    const _fs = fsImpl || fs;
    const root = skillsRoot || path.join(process.env.PIPELINE_REPO_ROOT || process.cwd(), '.claude', 'skills');
    const filePath = path.join(root, skill, 'SKILL.md');
    if (!_fs.existsSync(filePath)) {
        throw new Error(`[skills-metadata] No existe SKILL.md para skill '${skill}' (path: ${filePath}).`);
    }
    const content = _fs.readFileSync(filePath, 'utf8');
    const parsed = parseFrontmatter(content);
    if (!parsed) {
        throw new Error(`[skills-metadata] SKILL.md de '${skill}' no tiene frontmatter YAML válido.`);
    }
    const { meta } = parsed;

    if (Object.prototype.hasOwnProperty.call(meta, 'required_permissions')) {
        if (!Array.isArray(meta.required_permissions)) {
            throw new Error(`[skills-metadata] required_permissions del skill '${skill}' debe ser array YAML inline, no '${typeof meta.required_permissions}'.`);
        }
        const check = capabilities.validateRequiredCapabilities(meta.required_permissions);
        if (!check.ok) {
            throw new Error(
                `[skills-metadata] Skill '${skill}' declara capabilities fuera del catálogo: ${check.unknown.join(', ')}.\n` +
                `  Catálogo: lib/capabilities.js (KNOWN_CAPABILITIES).\n` +
                `  Archivo afectado: ${filePath}`
            );
        }
    }
    return { skill, meta, source: filePath };
}

// -----------------------------------------------------------------------------
// loadAllSkillsMetadata — recorre `.claude/skills/<skill>/SKILL.md` y devuelve
// un registro { skill: meta }.
//
// Skills sin frontmatter o sin required_permissions quedan en el registro
// con `meta.required_permissions = []` por defecto y `meta.__missing_permissions = true`
// (para que el caller pueda alertar/lintear).
//
// Devuelve también `{ failures }` con los skills que fallaron parsing crítico
// (capabilities fuera del catálogo) para que el caller fail-fast en boot.
// -----------------------------------------------------------------------------
function loadAllSkillsMetadata({ skillsRoot, fsImpl } = {}) {
    const _fs = fsImpl || fs;
    const root = skillsRoot || path.join(process.env.PIPELINE_REPO_ROOT || process.cwd(), '.claude', 'skills');

    const registry = {};
    const failures = [];
    if (!_fs.existsSync(root)) {
        return { registry, failures };
    }
    const entries = _fs.readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith('_')) continue; // _frozen/, _shared/, etc.
        const skillName = e.name;
        try {
            const loaded = loadSkillMetadata(skillName, { skillsRoot: root, fsImpl: _fs });
            const meta = loaded.meta;
            if (!Object.prototype.hasOwnProperty.call(meta, 'required_permissions')) {
                meta.__missing_permissions = true;
                meta.required_permissions = [];
            }
            registry[skillName] = meta;
        } catch (err) {
            failures.push({ skill: skillName, error: err.message });
        }
    }
    return { registry, failures };
}

// -----------------------------------------------------------------------------
// lintAllSkillsForPreCommit — corre `loadAllSkillsMetadata` y reporta
// (a) skills sin required_permissions declarado, (b) skills con capabilities
// fuera del catálogo. Pensado para el hook pre-commit.
//
// Output:
//   { ok, errors: [{skill, kind: 'missing'|'unknown_capability', detail}] }
// -----------------------------------------------------------------------------
function lintAllSkillsForPreCommit(opts) {
    const { registry, failures } = loadAllSkillsMetadata(opts);
    const errors = failures.map(f => ({
        skill: f.skill,
        kind: 'unknown_capability',
        detail: f.error,
    }));
    for (const [skill, meta] of Object.entries(registry)) {
        if (meta.__missing_permissions === true) {
            errors.push({
                skill,
                kind: 'missing',
                detail: `Skill '${skill}' no declara 'required_permissions' en su frontmatter. ` +
                    `Agregar la línea con el subset del catálogo de lib/capabilities.js que corresponda.`,
            });
        }
    }
    return { ok: errors.length === 0, errors };
}

module.exports = {
    parseFrontmatter,
    loadSkillMetadata,
    loadAllSkillsMetadata,
    lintAllSkillsForPreCommit,
};
