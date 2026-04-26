#!/usr/bin/env node
// Migración legacy issue #2653 — re-etiqueta issues abiertos generados por
// agentes que NO tengan tipo:recomendacion. Detecta candidatos por:
//   - Título que matchea ^\[(guru|security|po|ux|review)\]
//   - O label `agent:<rol>` presente en el issue
//
// Acción: agrega `tipo:recomendacion` + `needs-human` (idempotente). Si ya
// tiene cualquiera de los labels, los respeta.
//
// Uso:
//   node .pipeline/migrate-recomendaciones-legacy.js              # dry-run
//   node .pipeline/migrate-recomendaciones-legacy.js --apply      # aplica
//   node .pipeline/migrate-recomendaciones-legacy.js --apply --repo intrale/platform

'use strict';

const { spawnSync } = require('child_process');

const REPO = parseFlag('--repo') || 'intrale/platform';
const APPLY = process.argv.includes('--apply');
const GH = process.env.GH_PATH || 'gh';

const TIPO = 'tipo:recomendacion';
const NEEDS_HUMAN = 'needs-human';
const APPROVED = 'recommendation:approved';
const REJECTED = 'recommendation:rejected';

const TITLE_RE = /^\[(guru|security|po|ux|review)\]/i;
const AGENT_LABEL_RE = /^agent:(guru|security|po|ux|review)$/i;

function parseFlag(name) {
    const i = process.argv.indexOf(name);
    if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
    return null;
}

function gh(args) {
    const r = spawnSync(GH, args, { encoding: 'utf8', timeout: 60000 });
    return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function listOpenIssues() {
    const r = gh(['issue', 'list', '--repo', REPO, '--state', 'open', '--limit', '500',
        '--json', 'number,title,labels']);
    if (!r.ok) {
        console.error('Error listando issues:', r.stderr || r.status);
        process.exit(1);
    }
    return JSON.parse(r.stdout);
}

function isCandidate(issue) {
    const labels = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name || ''));
    if (labels.includes(TIPO)) return false;
    if (labels.includes(APPROVED) || labels.includes(REJECTED)) return false;
    if (TITLE_RE.test(issue.title || '')) return true;
    if (labels.some(l => AGENT_LABEL_RE.test(l))) return true;
    return false;
}

function applyMigration(issue) {
    const labels = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name || ''));
    const toAdd = [];
    if (!labels.includes(TIPO)) toAdd.push(TIPO);
    if (!labels.includes(NEEDS_HUMAN)) toAdd.push(NEEDS_HUMAN);
    if (toAdd.length === 0) return { ok: true, skipped: true };
    const r = gh(['issue', 'edit', String(issue.number), '--repo', REPO,
        '--add-label', toAdd.join(',')]);
    return { ok: r.ok, msg: r.stderr || '', added: toAdd };
}

function main() {
    console.log(`Migración recomendaciones legacy — repo=${REPO} apply=${APPLY}`);
    const issues = listOpenIssues();
    const candidates = issues.filter(isCandidate);
    console.log(`Issues abiertos: ${issues.length} — candidatos: ${candidates.length}`);
    if (candidates.length === 0) return;

    let migrated = 0, failed = 0;
    for (const it of candidates) {
        const labels = (it.labels || []).map(l => (typeof l === 'string' ? l : l.name || ''));
        const detected = TITLE_RE.test(it.title) ? 'titulo' : 'label';
        console.log(`#${it.number} (${detected}) — ${it.title}`);
        console.log(`  labels actuales: ${labels.join(', ') || '(ninguno)'}`);
        if (!APPLY) continue;
        const r = applyMigration(it);
        if (r.ok) {
            migrated++;
            console.log(`  -> agregado: ${(r.added || []).join(', ')}`);
        } else {
            failed++;
            console.log(`  -> ERROR: ${r.msg}`);
        }
    }
    console.log(`\nResumen: candidatos=${candidates.length} migrados=${migrated} fallidos=${failed}`);
    if (!APPLY) console.log('(dry-run — usar --apply para ejecutar)');
}

if (require.main === module) main();
module.exports = { isCandidate, TITLE_RE, AGENT_LABEL_RE };
