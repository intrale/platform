#!/usr/bin/env node
// =============================================================================
// Servicio Reconciler — Sincroniza label needs-human ↔ marker bloqueado-humano
// =============================================================================
//
// Contexto: hay tres fuentes de verdad de "issue bloqueado por humano":
//   1. Label `needs-human` en GitHub
//   2. Archivo en `<pipeline>/<fase>/bloqueado-humano/<issue>.<skill>`
//   3. Lo que muestra el dashboard /bloqueados (lee solo filesystem)
//
// Cualquier vía alternativa de bloquear (pause-all, label aplicado a mano desde
// GitHub UI, /unblock parcial, git stash -u accidental) rompe la sincronía y
// deja issues invisibles en el dashboard. Incidente 2026-04-29: 241 issues
// fantasma por un git stash -u que se llevó los markers untracked.
//
// Este servicio corre como proceso separado (no bloquea al pulpo) y cada
// RECONCILE_INTERVAL_MS:
//   1. Lista issues con label `needs-human` en GitHub (open).
//   2. Para cada uno sin marker físico → crea placeholder en la fase apropiada.
//   3. Lista markers en bloqueado-humano/.
//   4. Para cada marker cuyo issue NO tenga el label en GitHub → encola apply.
//   5. Para cada marker cuyo issue esté CLOSED → archiva el marker.
//
// Issue: #2880

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

require('./lib/sanitize-console').install();
const { sanitize } = require('./sanitizer');
const humanBlock = require('./lib/human-block');

const ROOT = process.env.PIPELINE_MAIN_ROOT || path.resolve(__dirname, '..');
const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);
const GH_BIN = process.env.GH_BIN || 'C:\\Workspaces\\gh-cli\\bin\\gh.exe';
const LOG_DIR = path.join(PIPELINE, 'logs');
const GH_QUEUE = path.join(PIPELINE, 'servicios', 'github', 'pendiente');

const RECONCILE_INTERVAL_MS = parseInt(process.env.RECONCILER_INTERVAL_MS || '300000', 10); // 5 min default
const RECONCILER_LABEL = 'needs-human';

function log(msg) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[${ts}] [svc-reconciler] ${msg}`);
}

// -----------------------------------------------------------------------------
// GitHub helpers
// -----------------------------------------------------------------------------

function listGhIssuesWithLabel(label) {
    try {
        const raw = execSync(
            `"${GH_BIN}" issue list --label "${label}" --state open --json number,labels --limit 500`,
            { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true }
        );
        const issues = JSON.parse(raw || '[]');
        return issues.map(i => ({
            number: i.number,
            labels: (i.labels || []).map(l => l.name),
        }));
    } catch (e) {
        log(`Error consultando GitHub: ${e.message.slice(0, 120)}`);
        return null;
    }
}

function getIssueState(issueNum) {
    try {
        const raw = execSync(
            `"${GH_BIN}" issue view ${issueNum} --json state`,
            { cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true }
        );
        return (JSON.parse(raw).state || 'UNKNOWN').toUpperCase();
    } catch {
        return 'UNKNOWN';
    }
}

function enqueueLabelApply(issueNum, label) {
    fs.mkdirSync(GH_QUEUE, { recursive: true });
    const filename = `${issueNum}-${label}-reconciler-${Date.now()}.json`;
    fs.writeFileSync(
        path.join(GH_QUEUE, filename),
        JSON.stringify({ action: 'label', issue: issueNum, label }),
    );
}

// -----------------------------------------------------------------------------
// Decidir fase para placeholder según labels del issue
// -----------------------------------------------------------------------------
//
// Heurística simple: leer labels y mapear a la fase de entrada de cada pipeline.
// Si no hay match claro, default a `definicion/analisis` (entrada del pipeline
// de definición — fase más permisiva, el siguiente reconcile puede ajustarla
// si el issue obtiene labels más específicos).
//
// El reason del marker indica que es un placeholder, así que el humano que
// /unblock-ee sabe que la fase puede no ser la "real" del issue.

function decidirFasePlaceholder(labels) {
    const labelSet = new Set(labels);
    if (labelSet.has('ready')) {
        return { pipeline: 'desarrollo', phase: 'dev', skill: 'guru' };
    }
    return { pipeline: 'definicion', phase: 'analisis', skill: 'guru' };
}

// -----------------------------------------------------------------------------
// Reconciliación: las 3 reglas
// -----------------------------------------------------------------------------

function reconcileLabelToFilesystem(ghIssues, blockedByIssue) {
    let created = 0;
    for (const issue of ghIssues) {
        if (blockedByIssue.has(issue.number)) continue;
        // Issue tiene label `needs-human` pero no hay marker físico → crear placeholder
        const { pipeline, phase, skill } = decidirFasePlaceholder(issue.labels);
        const targetDir = path.join(PIPELINE, pipeline, phase, humanBlock.BLOCK_SUBDIR);
        const targetFile = path.join(targetDir, `${issue.number}.${skill}`);
        if (fs.existsSync(targetFile)) continue;
        try {
            fs.mkdirSync(targetDir, { recursive: true });
            fs.writeFileSync(targetFile, '');
            fs.writeFileSync(targetFile + '.reason.json', JSON.stringify({
                issue: issue.number,
                skill,
                phase,
                pipeline,
                reason: 'Reconciler: issue tiene label needs-human en GitHub pero no había marker físico. Placeholder creado para mantener visibilidad en /bloqueados.',
                question: '[reconciler] Marker placeholder. Verificá la fase con criterio humano antes de /unblock; el reconciler eligió la fase por heurística sobre labels.',
                blocked_at: new Date().toISOString(),
                blocked_by: 'svc-reconciler',
            }, null, 2));
            created++;
        } catch (e) {
            log(`Error creando placeholder #${issue.number}: ${e.message.slice(0, 120)}`);
        }
    }
    return created;
}

function reconcileMarkerToLabel(blockedMarkers, ghIssueSet, getStateFn = getIssueState) {
    let enqueued = 0;
    const seenIssue = new Set();
    for (const m of blockedMarkers) {
        if (ghIssueSet.has(m.issue)) continue;
        if (seenIssue.has(m.issue)) continue; // un solo encolado por issue (no por skill)
        seenIssue.add(m.issue);

        const state = getStateFn(m.issue);
        if (state === 'CLOSED' || state === 'UNKNOWN') {
            // No encolar label; el archivado de issues cerrados se hace en
            // reconcileClosedMarkers() para mantener responsabilidades separadas.
            continue;
        }
        try {
            enqueueLabelApply(m.issue, RECONCILER_LABEL);
            enqueued++;
        } catch (e) {
            log(`Error encolando label #${m.issue}: ${e.message.slice(0, 120)}`);
        }
    }
    return enqueued;
}

function reconcileClosedMarkers(blockedMarkers, ghIssueSet, getStateFn = getIssueState) {
    let archived = 0;
    const seenIssue = new Set();
    for (const m of blockedMarkers) {
        if (ghIssueSet.has(m.issue)) continue;
        if (seenIssue.has(m.issue)) continue;
        seenIssue.add(m.issue);

        const state = getStateFn(m.issue);
        if (state !== 'CLOSED') continue;

        // Mover marker (y reason.json) a archivado/ de la misma fase
        const archiveDir = path.join(PIPELINE, m.pipeline, m.phase, 'archivado');
        try {
            fs.mkdirSync(archiveDir, { recursive: true });
            const baseName = `${m.issue}.${m.skill}`;
            const srcMarker = path.join(PIPELINE, m.pipeline, m.phase, humanBlock.BLOCK_SUBDIR, baseName);
            const dstMarker = path.join(archiveDir, baseName);
            if (fs.existsSync(srcMarker)) {
                fs.renameSync(srcMarker, dstMarker);
            }
            try { fs.unlinkSync(srcMarker + '.reason.json'); } catch {}
            archived++;
        } catch (e) {
            log(`Error archivando #${m.issue}: ${e.message.slice(0, 120)}`);
        }
    }
    return archived;
}

// -----------------------------------------------------------------------------
// Loop principal
// -----------------------------------------------------------------------------

let lastRunAt = 0;
let cycleCount = 0;

function reconcileOnce() {
    const t0 = Date.now();
    cycleCount++;

    const ghIssues = listGhIssuesWithLabel(RECONCILER_LABEL);
    if (ghIssues === null) {
        log(`Ciclo ${cycleCount}: SKIP — GitHub no respondió`);
        return;
    }

    const ghIssueSet = new Set(ghIssues.map(i => i.number));
    const blockedMarkers = humanBlock.listBlockedIssues();
    const blockedByIssue = new Map();
    for (const m of blockedMarkers) {
        if (!blockedByIssue.has(m.issue)) blockedByIssue.set(m.issue, []);
        blockedByIssue.get(m.issue).push(m);
    }

    const created = reconcileLabelToFilesystem(ghIssues, blockedByIssue);
    const enqueued = reconcileMarkerToLabel(blockedMarkers, ghIssueSet);
    const archived = reconcileClosedMarkers(blockedMarkers, ghIssueSet);

    const elapsed = Date.now() - t0;
    lastRunAt = Date.now();
    if (created || enqueued || archived) {
        log(`Ciclo ${cycleCount} (${elapsed}ms): GH=${ghIssues.length} markers=${blockedMarkers.length} → +${created} placeholders, +${enqueued} labels encolados, +${archived} archivados`);
    } else {
        log(`Ciclo ${cycleCount} (${elapsed}ms): GH=${ghIssues.length} markers=${blockedMarkers.length} — sincronizado`);
    }
}

function main() {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.mkdirSync(GH_QUEUE, { recursive: true });

    log(`Iniciado — intervalo ${Math.round(RECONCILE_INTERVAL_MS / 1000)}s`);
    try { require('./lib/ready-marker').signalReady('svc-reconciler'); } catch {}

    // Primer ciclo en 30s para que el resto del pipeline arranque sin contienda.
    setTimeout(() => {
        try { reconcileOnce(); } catch (e) { log(`Error: ${e.message}`); }
        setInterval(() => {
            try { reconcileOnce(); } catch (e) { log(`Error: ${e.message}`); }
        }, RECONCILE_INTERVAL_MS);
    }, 30000);
}

fs.writeFileSync(path.join(PIPELINE, 'svc-reconciler.pid'), String(process.pid));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

process.on('uncaughtException', (err) => {
    const msg = sanitize(`[${new Date().toISOString()}] [svc-reconciler] CRASH uncaughtException: ${err.stack || err.message}\n`);
    try { fs.appendFileSync(path.join(LOG_DIR, 'svc-reconciler.log'), msg); } catch {}
    console.error(msg);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    const msg = sanitize(`[${new Date().toISOString()}] [svc-reconciler] CRASH unhandledRejection: ${reason?.stack || reason}\n`);
    try { fs.appendFileSync(path.join(LOG_DIR, 'svc-reconciler.log'), msg); } catch {}
    console.error(msg);
    process.exit(1);
});

// Exportar para tests unitarios (no se ejecuta main si se require como módulo)
if (require.main === module) {
    main();
}

module.exports = {
    reconcileOnce,
    reconcileLabelToFilesystem,
    reconcileMarkerToLabel,
    reconcileClosedMarkers,
    decidirFasePlaceholder,
    listGhIssuesWithLabel,
    getIssueState,
    enqueueLabelApply,
};
