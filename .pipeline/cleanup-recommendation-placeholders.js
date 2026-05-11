#!/usr/bin/env node
// Cleanup retroactivo de placeholders fantasma creados por svc-reconciler para
// issues con labels `source:recommendation` o `tipo:recomendacion`.
//
// Estos issues son recomendaciones auto-generadas (security/guru/planner) que
// tienen `needs-human` para triaje humano futuro, pero NO son agentes reales
// bloqueados. El reconciler los venía inventando como markers en
// `bloqueado-humano/`, lo que generaba alertas Telegram falsas y los mostraba
// en `/bloqueados` como si fueran agentes esperando destrabe.
//
// Este script:
//   1. Lee los issues con labels de recomendación desde GitHub
//   2. Recorre todos los markers en `*/bloqueado-humano/` con
//      `blocked_by:svc-reconciler` cuyo número de issue está en el set
//   3. Mueve marker + reason.json a `archivado/` con sufijo `.cleaned-recommendation`
//
// Es one-shot: corre una vez, después del fix del reconciler que ya no los crea.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PIPELINE = path.resolve(__dirname);
const GH_BIN = process.env.GH_BIN || 'C:\\Workspaces\\gh-cli\\bin\\gh.exe';

function listRecommendationIssues() {
    const a = JSON.parse(execSync(
        `"${GH_BIN}" issue list --label "source:recommendation" --state open --json number --limit 500`,
        { encoding: 'utf8', windowsHide: true },
    ));
    const b = JSON.parse(execSync(
        `"${GH_BIN}" issue list --label "tipo:recomendacion" --state open --json number --limit 500`,
        { encoding: 'utf8', windowsHide: true },
    ));
    return new Set([...a.map(i => i.number), ...b.map(i => i.number)]);
}

function walkBlockedDirs() {
    const matches = [];
    for (const pipeline of ['definicion', 'desarrollo']) {
        const root = path.join(PIPELINE, pipeline);
        if (!fs.existsSync(root)) continue;
        for (const phase of fs.readdirSync(root)) {
            const blockedDir = path.join(root, phase, 'bloqueado-humano');
            if (!fs.existsSync(blockedDir)) continue;
            for (const f of fs.readdirSync(blockedDir)) {
                if (f.startsWith('.')) continue;
                if (f.endsWith('.reason.json')) continue;
                if (f.endsWith('.guidance.txt')) continue;
                matches.push({ pipeline, phase, fileName: f, dir: blockedDir });
            }
        }
    }
    return matches;
}

function cleanup() {
    const recSet = listRecommendationIssues();
    console.log(`Issues con labels de recomendación: ${recSet.size}`);

    const markers = walkBlockedDirs();
    console.log(`Markers encontrados en bloqueado-humano/: ${markers.length}`);

    let cleaned = 0;
    let skippedNoReason = 0;
    let skippedNotReconciler = 0;
    let skippedNotRecommendation = 0;

    for (const m of markers) {
        const issueNum = parseInt(m.fileName.split('.')[0], 10);
        if (!Number.isFinite(issueNum)) continue;
        if (!recSet.has(issueNum)) { skippedNotRecommendation++; continue; }

        const markerPath = path.join(m.dir, m.fileName);
        const reasonPath = markerPath + '.reason.json';

        let reason;
        try { reason = JSON.parse(fs.readFileSync(reasonPath, 'utf8')); }
        catch { reason = null; }

        if (!reason) { skippedNoReason++; continue; }
        if (reason.blocked_by !== 'svc-reconciler') { skippedNotReconciler++; continue; }

        const archiveDir = path.join(PIPELINE, m.pipeline, m.phase, 'archivado');
        fs.mkdirSync(archiveDir, { recursive: true });
        const stamp = new Date().toISOString().slice(0, 10);
        const dstMarker = path.join(archiveDir, `${m.fileName}.cleaned-recommendation-${stamp}`);
        const dstReason = path.join(archiveDir, `${m.fileName}.reason.cleaned-recommendation-${stamp}.json`);
        fs.renameSync(markerPath, dstMarker);
        fs.renameSync(reasonPath, dstReason);
        cleaned++;
        console.log(`  cleaned: ${m.pipeline}/${m.phase}/${m.fileName} (issue #${issueNum})`);
    }

    console.log('');
    console.log(`Resumen:`);
    console.log(`  cleaned: ${cleaned}`);
    console.log(`  skipped (no reason.json): ${skippedNoReason}`);
    console.log(`  skipped (no reconciler-created): ${skippedNotReconciler}`);
    console.log(`  skipped (not in recommendation set): ${skippedNotRecommendation}`);
}

if (require.main === module) cleanup();
module.exports = { cleanup, listRecommendationIssues, walkBlockedDirs };
