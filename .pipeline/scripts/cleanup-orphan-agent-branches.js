#!/usr/bin/env node
// =============================================================================
// cleanup-orphan-agent-branches.js — Limpieza one-shot e idempotente.
//
// Detecta branches locales `agent/<n>-<skill>` que no tienen worktree
// asociado y las elimina. Antes de borrar, crea un tag de backup
// `backup/orphan-<branch>-<ts>` para preservar el SHA por si hace falta
// recuperarlo después (los tags backup tienen TTL de 30 días según la
// convención de `backup-agent-branch.js`).
//
// Uso:
//   node .pipeline/scripts/cleanup-orphan-agent-branches.js          # dry-run
//   node .pipeline/scripts/cleanup-orphan-agent-branches.js --apply  # ejecuta
//   node .pipeline/scripts/cleanup-orphan-agent-branches.js --apply --issue 3073
//
// Motivación (#3155):
//   El Pulpo rebotaba al crear worktrees nuevos porque iteraciones previas
//   dejaban branches `agent/<n>-<skill>` huérfanas. El fix de raíz vive en
//   `lib/worktree-launcher.js` (recovery automático), pero este script
//   resuelve el backlog ya existente y queda disponible como herramienta
//   operativa para casos similares en el futuro.
// =============================================================================
'use strict';

const { execSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const issueFilter = (() => {
    const idx = args.indexOf('--issue');
    return idx >= 0 ? args[idx + 1] : null;
})();

function sh(cmd, opts = {}) {
    return execSync(cmd, {
        cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, ...opts,
    });
}

function listAgentBranches() {
    const out = sh('git for-each-ref --format="%(refname:short)" refs/heads/agent/');
    return out.split('\n').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

function listBranchesInUse() {
    const out = sh('git worktree list --porcelain');
    const inUse = new Set();
    for (const raw of out.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('branch refs/heads/')) {
            inUse.add(line.slice('branch refs/heads/'.length));
        }
    }
    return inUse;
}

function backupAndDelete(branch) {
    const sanitized = branch.replace(/[/\\]/g, '-');
    const tagName = `backup/orphan-${sanitized}-${Date.now()}`;
    sh(`git tag "${tagName}" "${branch}"`);
    sh(`git branch -D "${branch}"`);
    return tagName;
}

function main() {
    console.log(`[cleanup-orphan] modo: ${apply ? 'APPLY' : 'DRY-RUN'}`);
    if (issueFilter) console.log(`[cleanup-orphan] filtrando issue: ${issueFilter}`);

    sh('git worktree prune');

    const allAgent = listAgentBranches();
    const inUse = listBranchesInUse();
    const orphans = allAgent
        .filter((b) => !inUse.has(b))
        .filter((b) => !issueFilter || b.startsWith(`agent/${issueFilter}-`));

    console.log(`[cleanup-orphan] branches agent/* totales: ${allAgent.length}`);
    console.log(`[cleanup-orphan] en uso por worktrees: ${allAgent.length - orphans.length}`);
    console.log(`[cleanup-orphan] huérfanas detectadas: ${orphans.length}`);

    if (orphans.length === 0) {
        console.log('[cleanup-orphan] nada que hacer.');
        return 0;
    }

    let ok = 0;
    let failed = 0;
    for (const branch of orphans) {
        if (!apply) {
            console.log(`  - ${branch} (dry-run, sin tocar)`);
            continue;
        }
        try {
            const tag = backupAndDelete(branch);
            console.log(`  ✓ ${branch} → ${tag} → deleted`);
            ok++;
        } catch (e) {
            console.log(`  ✗ ${branch}: ${e.message.split('\n')[0]}`);
            failed++;
        }
    }

    if (apply) {
        console.log(`[cleanup-orphan] resultado: ${ok} eliminadas, ${failed} fallidas.`);
        if (failed > 0) return 1;
    } else {
        console.log('[cleanup-orphan] re-ejecutar con --apply para eliminar.');
    }
    return 0;
}

try {
    process.exit(main());
} catch (e) {
    console.error(`[cleanup-orphan] ERROR: ${e.message}`);
    process.exit(2);
}
