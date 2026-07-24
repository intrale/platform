// Harness determinístico: cruza cada enlace (skill, provider) de cada cadena
// de fallback contra la matriz de permisos usando el CÓDIGO REAL del pipeline.
// Uso: node .pipeline/scripts/audit-chains-permisos.js
'use strict';

const path = require('node:path');
const REPO = path.resolve(__dirname, '..', '..');
process.env.PIPELINE_REPO_ROOT = REPO;

const { readAgentModels, resolvePermissionMode } = require('../lib/agent-launcher/resolve-provider');
const validator = require('../lib/permission-validator');
const skillsMeta = require('../lib/skills-metadata');

const PIPELINE = path.join(REPO, '.pipeline');
const models = readAgentModels(PIPELINE);
const { registry } = skillsMeta.loadAllSkillsMetadata({ skillsRoot: path.join(REPO, '.claude', 'skills') });

let pass = 0, fail = 0;
const failures = [];

for (const [skill, cfg] of Object.entries(models.skills)) {
    if (cfg.provider === 'deterministic') continue;
    const meta = registry[skill];
    const required = (meta && Array.isArray(meta.required_permissions)) ? meta.required_permissions : [];
    const chain = [{ provider: cfg.provider }, ...(cfg.fallbacks || [])];
    chain.forEach((link, i) => {
        const provider = link.provider;
        const mode = resolvePermissionMode(models, provider);
        const r = validator.validateSpawn({ skill, provider, mode, requiredCapabilities: required });
        const tag = i === 0 ? 'primary' : `fb${i}`;
        if (r.ok) { pass++; }
        else { fail++; failures.push(`${skill} [${tag}] ${provider}/${mode} -> ${r.reason} (missing: ${(r.missing||[]).join(',')||'-'})`); }
    });
}

console.log(`PASS=${pass} FAIL=${fail} TOTAL=${pass+fail}`);
console.log('--- fallos ---');
for (const f of failures) console.log(f);
