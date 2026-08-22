#!/usr/bin/env node
// =============================================================================
// backfill-visual-baseline.js — Issue #3383 (CA-6)
//
// Aplica el label `needs:visual-baseline` y `bloqueado-humano` a todos los
// issues OPEN con label `app:*` cuyo body NO tiene sección "Screenshots &
// Mockups" con 2+ imágenes. NO los rechaza ni los saca del pipeline — los
// marca para que UX agregue retroactivamente el mockup esperado.
//
// Diseñado para correr ANTES de activar `PIPELINE_VISUAL_GATE_ENABLED=1` en
// producción: sin esto, los issues ya refinados se quedarían atascados al
// promover de build → verificación.
//
// Uso:
//   node .pipeline/scripts/backfill-visual-baseline.js               # dry-run
//   node .pipeline/scripts/backfill-visual-baseline.js --apply       # ejecuta
//   node .pipeline/scripts/backfill-visual-baseline.js --apply --limit 50
//
// Idempotente:
//   - No duplica labels (gh edit es idempotente por sí mismo).
//   - No agrega el label si el body ya tiene visual reference válida.
//   - Loguea por issue qué decisión tomó.
// =============================================================================

'use strict';

const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { hasVisualReference } = require(path.join(REPO_ROOT, '.pipeline', 'lib', 'qa-evidence-gate'));

const GH_BIN = process.env.GH_BIN
    || (process.platform === 'win32' ? 'C:\\Workspaces\\gh-cli\\bin\\gh.exe' : 'gh');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitArg = (() => {
    const idx = args.indexOf('--limit');
    return idx >= 0 ? parseInt(args[idx + 1], 10) : 200;
})();
const repoArg = (() => {
    const idx = args.indexOf('--repo');
    return idx >= 0 ? args[idx + 1] : 'intrale/platform';
})();

const TARGET_LABELS = ['app:client', 'app:business', 'app:delivery'];
const BACKFILL_LABEL = 'needs:visual-baseline';
const BLOCKED_LABEL = 'bloqueado-humano';

function ghJson(cmd) {
    const out = execSync(cmd, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return JSON.parse(out);
}

function listCandidates() {
    // Issues OPEN con algún label app:*.
    // Buscamos en repos y filtramos client-side con --json para tener body completo.
    const candidates = new Map(); // issue.number → issue (dedup entre labels)
    for (const label of TARGET_LABELS) {
        const cmd =
            `"${GH_BIN}" issue list --repo ${repoArg} --label "${label}" --state open `
            + `--limit ${limitArg} --json number,title,labels,body`;
        try {
            const items = ghJson(cmd);
            for (const item of items) {
                if (!candidates.has(item.number)) candidates.set(item.number, item);
            }
        } catch (e) {
            console.error(`[backfill] error listando label=${label}: ${e.message}`);
        }
    }
    return Array.from(candidates.values());
}

function alreadyHasLabel(issue, name) {
    return Array.isArray(issue.labels) && issue.labels.some((l) => l?.name === name);
}

function addLabel(issue, label) {
    const cmd = `"${GH_BIN}" issue edit ${issue.number} --repo ${repoArg} --add-label "${label}"`;
    execSync(cmd, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
}

function summarizeDecision(issue, decision) {
    const tag = decision.action.padEnd(8, ' ');
    const reason = decision.reason;
    const title = (issue.title || '').slice(0, 60);
    return `#${issue.number}\t${tag}\t${reason}\t${title}`;
}

function main() {
    const mode = apply ? 'APPLY' : 'DRY-RUN';
    console.log(`[backfill-visual-baseline] modo=${mode} repo=${repoArg} limit=${limitArg}`);
    console.log(`[backfill-visual-baseline] labels objetivo: ${TARGET_LABELS.join(', ')}`);
    console.log('');

    const candidates = listCandidates();
    console.log(`[backfill-visual-baseline] candidatos con app:*: ${candidates.length}`);

    const summary = { needs: 0, skipped_qa: 0, ok: 0, already_labeled: 0, errors: 0 };

    for (const issue of candidates) {
        // qa:skipped legítimo → no aplica gate (CA-3).
        if (alreadyHasLabel(issue, 'qa:skipped')) {
            summary.skipped_qa += 1;
            console.log(summarizeDecision(issue, { action: 'skip', reason: 'qa:skipped' }));
            continue;
        }

        // Si ya tiene needs:visual-baseline, idempotente — no re-label.
        if (alreadyHasLabel(issue, BACKFILL_LABEL)) {
            summary.already_labeled += 1;
            console.log(summarizeDecision(issue, { action: 'noop', reason: 'ya tiene needs:visual-baseline' }));
            continue;
        }

        // Evaluar gate con body actual.
        const labelNames = (issue.labels || []).map((l) => l?.name).filter(Boolean);
        const decision = hasVisualReference(issue.body || '', { labels: labelNames });
        if (decision.ok) {
            summary.ok += 1;
            console.log(summarizeDecision(issue, { action: 'noop', reason: `ok: ${decision.reason}` }));
            continue;
        }

        // Falla → aplicar label.
        summary.needs += 1;
        console.log(summarizeDecision(issue, { action: 'LABEL', reason: decision.reason }));

        if (apply) {
            try {
                addLabel(issue, BACKFILL_LABEL);
                addLabel(issue, BLOCKED_LABEL);
            } catch (e) {
                summary.errors += 1;
                console.error(`[backfill] error labeling #${issue.number}: ${e.message}`);
            }
        }
    }

    console.log('');
    console.log(`[backfill-visual-baseline] resumen:`);
    console.log(`  necesitan baseline: ${summary.needs}`);
    console.log(`  ya tenían label:    ${summary.already_labeled}`);
    console.log(`  qa:skipped (skip):  ${summary.skipped_qa}`);
    console.log(`  ok (con sección):   ${summary.ok}`);
    console.log(`  errores:            ${summary.errors}`);
    if (!apply && summary.needs > 0) {
        console.log('');
        console.log('  Para aplicar los labels, re-correr con --apply');
    }

    // Persistir reporte JSON para auditoría (ops puede revisarlo después).
    try {
        const outDir = path.join(REPO_ROOT, '.pipeline', 'logs');
        fs.mkdirSync(outDir, { recursive: true });
        const reportPath = path.join(outDir, `backfill-visual-baseline-${Date.now()}.json`);
        fs.writeFileSync(reportPath, JSON.stringify({
            timestamp: new Date().toISOString(),
            mode,
            repo: repoArg,
            summary,
            candidates: candidates.length,
        }, null, 2));
        console.log(`[backfill-visual-baseline] reporte: ${reportPath}`);
    } catch (e) {
        // No es fatal — el log de stdout ya tiene la info.
        console.error(`[backfill-visual-baseline] no se pudo escribir reporte: ${e.message}`);
    }

    process.exit(summary.errors > 0 ? 1 : 0);
}

if (require.main === module) {
    main();
}

module.exports = { listCandidates, alreadyHasLabel };
