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

// Labels que indican que `needs-human` está pegado por origen de recomendación
// (security/guru/planner generan issues auto y los marcan así para triaje humano
// futuro). NO hay un agente real bloqueado trabajando esos issues — son backlog
// pendiente de decisión. El reconciler NO debe inventar placeholders en
// bloqueado-humano/ para estos casos: el placeholder dispara alerta Telegram y
// los muestra en `/bloqueados` como si fueran agentes fantasma esperando
// destrabe, cuando en realidad son sugerencias que esperan triaje.
//
// Mantenemos el label `needs-human` en GitHub (visibilidad para `/doc priorizar`).
// Solo cortamos la creación automática de markers en filesystem.
const RECOMMENDATION_LABELS = new Set(['source:recommendation', 'tipo:recomendacion']);

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

// #2994 — `meta` opcional permite que el worker (servicio-github.js) re-valide
// que el estado del FS sigue justificando esta orden antes de invocar `gh`.
//
// Campos esperados en `meta` (todos opcionales, backward-compat):
//   - marker_path:  path absoluto del marker que disparó la orden (ej.
//                   .pipeline/desarrollo/dev/bloqueado-humano/2975.guru).
//                   El worker hace fs.existsSync() antes del `gh` — si el
//                   marker ya no está, descarta como `stale-marker-missing`.
//   - snapshot_at:  ISO timestamp del momento del encolado.
//   - marker_mtime: mtimeMs del marker en el momento del encolado. El worker
//                   compara contra el mtime actual; si el marker fue tocado
//                   después (rename/escritura humana), descarta como
//                   `stale-mtime`.
//
// Si `meta` es null, el JSON queda con shape clásico {action,issue,label} y
// el worker ejecuta SIN guardia (degradado seguro para órdenes pre-deploy).
function enqueueLabelApply(issueNum, label, meta = null) {
    fs.mkdirSync(GH_QUEUE, { recursive: true });
    const filename = `${issueNum}-${label}-reconciler-${Date.now()}.json`;
    const payload = { action: 'label', issue: issueNum, label };
    if (meta && typeof meta === 'object') {
        if (meta.marker_path) payload.marker_path = meta.marker_path;
        if (meta.snapshot_at) payload.snapshot_at = meta.snapshot_at;
        if (typeof meta.marker_mtime === 'number') payload.marker_mtime = meta.marker_mtime;
    }
    fs.writeFileSync(
        path.join(GH_QUEUE, filename),
        JSON.stringify(payload),
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

function isRecommendationIssue(labels) {
    if (!Array.isArray(labels)) return false;
    for (const l of labels) {
        if (RECOMMENDATION_LABELS.has(l)) return true;
    }
    return false;
}

function reconcileLabelToFilesystem(ghIssues, blockedByIssue) {
    let created = 0;
    let skippedRecommendations = 0;
    for (const issue of ghIssues) {
        if (blockedByIssue.has(issue.number)) continue;
        // Skip: recomendaciones auto-generadas (security/guru/planner) que
        // tienen `needs-human` para triaje futuro pero no son agentes bloqueados.
        // Inventar marker fantasma confunde al dashboard y dispara alerta Telegram.
        if (isRecommendationIssue(issue.labels)) {
            skippedRecommendations++;
            continue;
        }
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
    if (skippedRecommendations > 0) {
        log(`Skipped ${skippedRecommendations} issues con labels de recomendación (no se crean placeholders)`);
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
            // #2994 — Persistir snapshot del marker que justificó la orden.
            // El worker valida en O(1) que el marker sigue existiendo y no
            // fue tocado después; si fue tocado (destrabe humano que renombró
            // el archivo a `pendiente/`), descarta la orden y evita re-aplicar
            // un label sobre un issue que ya está destrabado.
            const meta = buildMarkerMeta(m);
            enqueueLabelApply(m.issue, RECONCILER_LABEL, meta);
            enqueued++;
        } catch (e) {
            log(`Error encolando label #${m.issue}: ${e.message.slice(0, 120)}`);
        }
    }
    return enqueued;
}

// #2994 — calcula el snapshot del marker justo antes de encolar la orden.
// El path se reconstruye desde los datos que ya tiene el reconciler en `m`
// (issue, skill, phase, pipeline) — no requiere I/O extra para descubrirlo.
//
// Si por algún motivo el marker no se puede statear (ej. fue movido entre
// el listBlockedIssues() y este punto), devolvemos `meta` con marker_path
// pero sin marker_mtime — el worker tratará la ausencia del archivo como
// `stale-marker-missing` y descartará la orden.
function buildMarkerMeta(m) {
    const markerPath = path.join(
        PIPELINE, m.pipeline, m.phase, humanBlock.BLOCK_SUBDIR, `${m.issue}.${m.skill}`,
    );
    const meta = {
        marker_path: markerPath,
        snapshot_at: new Date().toISOString(),
    };
    try {
        meta.marker_mtime = fs.statSync(markerPath).mtimeMs;
    } catch {
        // marker desapareció entre listado y stat → meta sin mtime; el worker
        // verá `marker_path` y al fallar existsSync descarta como missing.
    }
    return meta;
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
// CA3 (#2994) — Detectar destrabe humano y reconciliar siguiendo a GitHub
// -----------------------------------------------------------------------------
//
// Escenario: humano hace destrabe manual (mueve marker a `pendiente/` + quita
// label en GitHub vía `gh`). Si por timing el rename del marker falla o la
// operación queda parcial — o si el humano sólo quitó el label desde la UI
// de GitHub sin tocar el FS — la próxima corrida ve marker en
// `bloqueado-humano/` pero label ausente. Hoy el reconciler re-aplica el
// label, re-bloqueando el issue.
//
// Después de operación humana, GitHub pasa a ser autoritativo. La heurística:
//   marker existe en bloqueado-humano/  ∧  label ausente en GitHub
//   ∧  blocked_at > 60s  (suficientemente viejo para que un ciclo previo
//                          ya hubiera tenido tiempo de aplicar el label)
//   ∧  blocked_by ≠ 'svc-reconciler'  (no deshacer placeholders recién
//                                        creados por el propio reconciler)
//   ⇒ asumimos destrabe humano → mover marker a `pendiente/`.
//
// Esta regla corre ANTES de `reconcileMarkerToLabel` para evitar encolar la
// orden que después tendríamos que descartar como stale.

const HUMAN_UNBLOCK_GRACE_MS = 60 * 1000; // 60s

function reconcileHumanUnblockDetected(blockedMarkers, ghIssueSet, opts = {}) {
    const now = opts.now || Date.now();
    const logFn = opts.logStaleOrder || appendStaleOrderLog;
    let detected = 0;
    const movedIssues = new Set();

    for (const m of blockedMarkers) {
        if (ghIssueSet.has(m.issue)) continue; // label sigue presente: nada que hacer

        // Leer reason.json para inspeccionar blocked_at y blocked_by.
        const markerPath = path.join(
            PIPELINE, m.pipeline, m.phase, humanBlock.BLOCK_SUBDIR, `${m.issue}.${m.skill}`,
        );
        const reasonPath = markerPath + '.reason.json';
        let reason;
        try { reason = JSON.parse(fs.readFileSync(reasonPath, 'utf8')); }
        catch { reason = null; }

        if (reason && reason.blocked_by === 'svc-reconciler') continue; // placeholder propio

        // Ventana de gracia: si el bloqueo es muy reciente, asumimos que la
        // orden de label todavía no se procesó (el ciclo del worker tarda
        // hasta 10s + el polling normal). Forzar el destrabe acá podría
        // deshacer un bloqueo legítimo que estaba en flight.
        const blockedAt = reason && reason.blocked_at ? Date.parse(reason.blocked_at) : NaN;
        if (Number.isFinite(blockedAt) && (now - blockedAt) < HUMAN_UNBLOCK_GRACE_MS) continue;
        if (!Number.isFinite(blockedAt)) {
            // Sin blocked_at confiable, caemos al mtime del marker como proxy.
            let mtime;
            try { mtime = fs.statSync(markerPath).mtimeMs; } catch { mtime = NaN; }
            if (!Number.isFinite(mtime) || (now - mtime) < HUMAN_UNBLOCK_GRACE_MS) continue;
        }

        // Mover marker a `pendiente/` de la misma fase. Mantenemos el reason.json
        // como evidencia (renombrado para que no contamine el flow normal).
        const targetDir = path.join(PIPELINE, m.pipeline, m.phase, 'pendiente');
        const targetMarker = path.join(targetDir, `${m.issue}.${m.skill}`);
        try {
            fs.mkdirSync(targetDir, { recursive: true });
            fs.renameSync(markerPath, targetMarker);
            // El reason.json original dejaría rastro innecesario en pendiente/;
            // lo borramos. La traza del destrabe queda en stale-orders.log.
            try { fs.unlinkSync(reasonPath); } catch {}
            detected++;
            movedIssues.add(m.issue);
            try {
                logFn({
                    reason: 'human-unblock-detected',
                    issue: m.issue,
                    label: RECONCILER_LABEL,
                    snapshot_at: null,
                    current_mtime: null,
                    detail: `marker movido a ${m.pipeline}/${m.phase}/pendiente/`,
                });
            } catch {}
            log(`#${m.issue} destrabado por humano detectado — marker → pendiente/`);
        } catch (e) {
            log(`Error procesando destrabe humano #${m.issue}: ${e.message.slice(0, 120)}`);
        }
    }
    return { detected, movedIssues };
}

// -----------------------------------------------------------------------------
// Telemetría: log append-only de descartes/detecciones (CA5 #2994)
// -----------------------------------------------------------------------------
//
// Línea por evento. Formato JSONL para que el dashboard lo parse barato:
//   { ts, reason, issue, label, snapshot_at, current_mtime, detail }
//
// Reasons posibles:
//   - stale-marker-missing  (worker: marker_path ya no existe)
//   - stale-mtime           (worker: marker_mtime cambió desde el snapshot)
//   - human-unblock-detected (reconciler: detectó destrabe humano y movió marker)

function appendStaleOrderLog(entry) {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            reason: entry.reason || 'unknown',
            issue: entry.issue || null,
            label: entry.label || null,
            snapshot_at: entry.snapshot_at || null,
            current_mtime: entry.current_mtime ?? null,
            detail: entry.detail || null,
        }) + '\n';
        fs.appendFileSync(path.join(LOG_DIR, 'stale-orders.log'), line);
    } catch {
        // Telemetría es best-effort: si falla, el reconciler no debe morir.
    }
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

    // CA3 (#2994) — primero detectar destrabes humanos: corre ANTES que
    // reconcileMarkerToLabel para no encolar órdenes que tendríamos que
    // descartar como stale por GitHub-autoritativo.
    const unblockResult = reconcileHumanUnblockDetected(blockedMarkers, ghIssueSet);
    const detected = unblockResult.detected;
    // Filtrar markers ya movidos para que reconcileMarkerToLabel/Closed
    // no vuelvan a procesarlos en este mismo ciclo.
    const remaining = unblockResult.movedIssues.size > 0
        ? blockedMarkers.filter(m => !unblockResult.movedIssues.has(m.issue))
        : blockedMarkers;

    const enqueued = reconcileMarkerToLabel(remaining, ghIssueSet);
    const archived = reconcileClosedMarkers(remaining, ghIssueSet);

    const elapsed = Date.now() - t0;
    lastRunAt = Date.now();
    if (created || enqueued || archived || detected) {
        log(`Ciclo ${cycleCount} (${elapsed}ms): GH=${ghIssues.length} markers=${blockedMarkers.length} → +${created} placeholders, +${enqueued} labels encolados, +${archived} archivados, +${detected} destrabes humanos detectados`);
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
    reconcileHumanUnblockDetected,
    decidirFasePlaceholder,
    isRecommendationIssue,
    RECOMMENDATION_LABELS,
    listGhIssuesWithLabel,
    getIssueState,
    enqueueLabelApply,
    buildMarkerMeta,
    appendStaleOrderLog,
    HUMAN_UNBLOCK_GRACE_MS,
};
