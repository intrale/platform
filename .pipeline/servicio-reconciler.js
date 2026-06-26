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
const yaml = require('js-yaml');

require('./lib/sanitize-console').install();
const { sanitize } = require('./sanitizer');
const humanBlock = require('./lib/human-block');
const { isMarkerArtifact } = require('./lib/marker-artifact');
const admissionGate = require('./lib/admission-gate');
// #3381 — Gate de screenshots+mockup (default OFF, activable por env var).
const screenshotsMockupGate = require('./hooks/screenshots-mockup-gate');

const ROOT = process.env.PIPELINE_MAIN_ROOT || path.resolve(__dirname, '..');
const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);
const GH_BIN = process.env.GH_BIN || 'C:\\Workspaces\\gh-cli\\bin\\gh.exe';
const LOG_DIR = path.join(PIPELINE, 'logs');
const GH_QUEUE = path.join(PIPELINE, 'servicios', 'github', 'pendiente');

const RECONCILE_INTERVAL_MS = parseInt(process.env.RECONCILER_INTERVAL_MS || '300000', 10); // 5 min default
const RECONCILER_LABEL = 'needs-human';

// #3175 — Sweep paralelo de admission gate. Kill-switch por env var para
// poder cortar instantáneo sin reiniciar el reconciler. Default ON; setear
// `ADMISSION_SWEEP_ENABLED=0` para desactivar.
const ADMISSION_SWEEP_ENABLED = process.env.ADMISSION_SWEEP_ENABLED !== '0';
const ADMISSION_DRY_RUN = process.env.ADMISSION_GATE_DRY_RUN === '1';
const ADMISSION_TELEGRAM_QUEUE = path.join(PIPELINE, 'servicios', 'telegram', 'pendiente');

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

// #3186 — encola orden `remove-label` para que el servicio-github le quite
// el label en GitHub. La action `remove-label` ya está soportada por
// `servicio-github.js` (línea ~451) y es idempotente: si el label ya fue
// removido, `gh issue edit --remove-label` no falla.
function enqueueLabelRemove(issueNum, label) {
    fs.mkdirSync(GH_QUEUE, { recursive: true });
    const filename = `${issueNum}-rm-${label}-reconciler-${Date.now()}.json`;
    fs.writeFileSync(
        path.join(GH_QUEUE, filename),
        JSON.stringify({ action: 'remove-label', issue: issueNum, label }),
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

// -----------------------------------------------------------------------------
// #4222 — Cruce label needs-human ↔ avance físico de fases (anti bloqueo fantasma)
// -----------------------------------------------------------------------------
//
// Caso #4191: un issue ya había avanzado físicamente a `verificacion`/`aprobacion`
// (sus markers en disco existían), pero en GitHub quedó pegado un `needs-human`
// stale. El reconciler veía el label, no lo cruzaba contra el avance real y
// plantaba un placeholder de bloqueo "para no perderlo" → bloqueo fantasma que
// figuraba como decisión humana pendiente cuando el issue ya venía resuelto.
//
// La guarda: antes de crear el placeholder, calcular la fase física más avanzada
// que alcanzó el issue (markers en `listo/` o `procesado/`) y compararla con la
// fase donde se plantaría el bloqueo. Si el issue progresó MÁS ALLÁ de esa fase,
// el label es stale: se limpia en GitHub y NO se planta bloqueo.

// Estados que evidencian que el issue YA superó (o cerró el trabajo de) una fase.
//   - `listo`     = la fase terminó su trabajo y espera evaluación.
//   - `procesado` = la fase siguiente ya tomó el issue (trabajo de la fase cerrado).
// Deliberadamente NO miramos `pendiente`/`trabajando`: estar encolado o en curso
// en una fase no implica haberla superado. Solo declaramos `stale` ante evidencia
// fuerte de avance (conservador: minimiza el riesgo de limpiar un bloqueo legítimo).
const PROGRESS_STATES = ['listo', 'procesado'];

// Fallback canónico si no se puede leer config.yaml (degradación segura). Debe
// mantenerse sincronizado con `pipelines.<p>.fases` de config.yaml.
const FALLBACK_PHASE_ORDER = {
    definicion: ['analisis', 'criterios', 'sizing'],
    desarrollo: ['validacion', 'dev', 'build', 'verificacion', 'linteo', 'aprobacion', 'entrega'],
};

let _globalPhaseOrderCache = null;

// Construye el orden GLOBAL de fases (pipeline+fase) leyendo el orden canónico
// de config.yaml. El orden global encadena los pipelines en el orden en que
// aparecen en config (definicion → desarrollo), reflejando el flujo natural del
// issue. Se cachea: el orden de fases no cambia en runtime.
function loadGlobalPhaseOrder() {
    if (_globalPhaseOrderCache) return _globalPhaseOrderCache;
    let orders = FALLBACK_PHASE_ORDER;
    try {
        const cfg = yaml.load(fs.readFileSync(path.join(PIPELINE, 'config.yaml'), 'utf8')) || {};
        if (cfg.pipelines && typeof cfg.pipelines === 'object') {
            const parsed = {};
            for (const [pname, pcfg] of Object.entries(cfg.pipelines)) {
                if (pcfg && Array.isArray(pcfg.fases)) parsed[pname] = pcfg.fases.slice();
            }
            if (Object.keys(parsed).length > 0) orders = parsed;
        }
    } catch {
        // config.yaml ausente o ilegible (p. ej. entorno de test) → fallback.
    }
    const global = [];
    for (const pname of Object.keys(orders)) {
        for (const fase of orders[pname]) global.push({ pipeline: pname, phase: fase });
    }
    _globalPhaseOrderCache = global;
    return global;
}

// Índice en el orden global de una terna (pipeline, fase). -1 si no existe.
function globalPhaseIndex(globalOrder, pipeline, phase) {
    return globalOrder.findIndex(g => g.pipeline === pipeline && g.phase === phase);
}

// Devuelve el índice (en el orden global) de la fase física más avanzada que
// alcanzó el issue, mirando markers en `listo/`/`procesado/` de cada fase.
// -1 si el issue no tiene evidencia física de avance en ninguna fase.
function findFurthestPhysicalPhaseIndex(issueNum, globalOrder) {
    const prefix = String(issueNum) + '.';
    let furthest = -1;
    for (let i = 0; i < globalOrder.length; i++) {
        const { pipeline, phase } = globalOrder[i];
        for (const state of PROGRESS_STATES) {
            const dir = path.join(PIPELINE, pipeline, phase, state);
            let entries;
            try { entries = fs.readdirSync(dir); } catch { continue; }
            const hasMarker = entries.some(
                f => f.startsWith(prefix) && f !== '.gitkeep' && !isMarkerArtifact(f),
            );
            if (hasMarker) { furthest = i; break; }
        }
    }
    return furthest;
}

// Decide si el `needs-human` de un issue es stale por avance físico de fases.
// Devuelve { stale: bool, furthestPhase?: string } — stale cuando el issue
// progresó ESTRICTAMENTE más allá de la fase donde se plantaría el bloqueo.
function isNeedsHumanStaleByProgress(issueNum, placeholderPipeline, placeholderPhase, opts = {}) {
    const globalOrder = opts.globalOrder || loadGlobalPhaseOrder();
    const findFurthest = opts.findFurthest || findFurthestPhysicalPhaseIndex;
    const placeholderIdx = globalPhaseIndex(globalOrder, placeholderPipeline, placeholderPhase);
    if (placeholderIdx < 0) return { stale: false };
    const furthestIdx = findFurthest(issueNum, globalOrder);
    if (furthestIdx > placeholderIdx) {
        return { stale: true, furthestPhase: `${globalOrder[furthestIdx].pipeline}/${globalOrder[furthestIdx].phase}` };
    }
    return { stale: false };
}

function reconcileLabelToFilesystem(ghIssues, blockedByIssue, opts = {}) {
    let created = 0;
    let skippedRecommendations = 0;
    let staleCleared = 0;
    const enqueueRemoveFn = opts.enqueueLabelRemove || enqueueLabelRemove;
    const logStaleFn = opts.logStaleOrder || appendStaleOrderLog;
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
        // #4222 — Guarda anti bloqueo fantasma: si el issue ya progresó más allá
        // de la fase donde se plantaría el bloqueo, el `needs-human` es stale.
        // Limpiar el label en GitHub y NO crear placeholder.
        const staleCheck = isNeedsHumanStaleByProgress(issue.number, pipeline, phase, opts);
        if (staleCheck.stale) {
            try { enqueueRemoveFn(issue.number, RECONCILER_LABEL); } catch (e) {
                log(`Error encolando remove-label stale #${issue.number}: ${e.message.slice(0, 120)}`);
            }
            try {
                logStaleFn({
                    reason: 'stale-needs-human-phase-progress',
                    issue: issue.number,
                    label: RECONCILER_LABEL,
                    snapshot_at: null,
                    current_mtime: null,
                    detail: `needs-human stale: issue progresó a ${staleCheck.furthestPhase} (más allá de ${pipeline}/${phase}); label limpiado, sin bloqueo`,
                });
            } catch {}
            log(`#${issue.number} needs-human stale (progresó a ${staleCheck.furthestPhase} > ${pipeline}/${phase}) — label limpiado, sin placeholder`);
            staleCleared++;
            continue;
        }
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
    if (staleCleared > 0) {
        log(`Limpiados ${staleCleared} labels needs-human stale por avance físico de fases (sin bloqueo)`);
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
// #3186 — Reconciliar markers resueltos por el guardian (re-aprobación)
// -----------------------------------------------------------------------------
//
// Asimetría histórica: `reconcileClosedMarkers` archiva markers cuando el
// issue queda CLOSED en GitHub, pero **no hay equivalente para el caso
// "guardian re-aprobó"**. Si guru rechaza, deja marker en
// `bloqueado-humano/3082.guru`. Si en una corrida posterior el mismo skill
// re-aprueba y dropea `listo/3082.guru`, el marker queda zombie: el reconciler
// sigue viéndolo y re-aplica `needs-human` cada ciclo (loop label↔reconciler).
//
// Esta función detecta dos casos:
//
//   A) GUARDIAN-RESOLVED:
//      Existe `<pipeline>/<phase>/{listo,procesado}/<issue>.<skill>` con
//      `mtime > marker.mtime`. Esto indica que el mismo skill que generó el
//      bloqueo emitió un resultado posterior — implícitamente, re-aprobó.
//
//      Por qué buscar en `listo/` Y `procesado/`: el pulpo promueve archivos
//      `listo/` → `procesado/` al instante en que la fase siguiente toma el
//      issue. Si el reconciler corre tarde (intervalo default 5min), el
//      archivo ya puede estar en `procesado/`. Sin esta extensión, el bug
//      original (#3082) se reproduce parcialmente.
//
//   B) TTL-EXPIRED:
//      `now - marker.mtime > RESOLVED_TTL_MS` (default 7 días). Red de
//      seguridad para markers que nadie tocó en una semana — típicamente
//      casos donde el archivo `listo/` fue borrado a mano o nunca existió
//      (humano intervino fuera del pipeline). Sin este TTL los markers
//      podrían acumularse indefinidamente.
//
// Al archivar:
//   - Marker → `<pipeline>/<phase>/archivado/<issue>.<skill>.<reason>-<ts>`
//     con timestamp sanitizado para Windows (sin `:` ni `.`).
//   - `.reason.json` se elimina (mismo patrón que `reconcileClosedMarkers`).
//   - `appendStaleOrderLog({ reason })` con reasons `guardian-resolved` o
//     `ttl-expired` para que `reconcilerStaleOrdersSlice` los cuente.
//
// Cross-fase remove-label: si después de archivar no quedan otros markers
// para el mismo issue (un issue puede estar bloqueado por varios skills en
// fases diferentes), encolar `remove-label needs-human`. Sin esta verificación
// podríamos quitar el label aunque haya otros bloqueos pendientes.

const RESOLVED_TTL_MS = parseInt(
    process.env.RECONCILER_RESOLVED_TTL_MS || String(7 * 24 * 60 * 60 * 1000),
    10,
); // 7 días default

// Busca resolución del guardian: archivo `<issue>.<skill>` en `listo/` o
// `procesado/` de la misma fase, con mtime > markerMtime.
// Devuelve { state, path, mtimeMs } o null.
function findGuardianResolution(marker, markerMtime) {
    const base = `${marker.issue}.${marker.skill}`;
    for (const state of ['listo', 'procesado']) {
        const candidate = path.join(PIPELINE, marker.pipeline, marker.phase, state, base);
        let stat;
        try { stat = fs.statSync(candidate); } catch { continue; }
        if (stat.mtimeMs > markerMtime) {
            return { state, path: candidate, mtimeMs: stat.mtimeMs };
        }
    }
    return null;
}

// Sanitiza un timestamp ISO para usarlo como sufijo de archivo en Windows.
// `2026-05-14T22:30:45.123Z` → `2026-05-14T22-30-45-123Z`.
function safeTsSuffix(ms) {
    return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

function reconcileResolvedMarkers(blockedMarkers, opts = {}) {
    const now = opts.now || Date.now();
    const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : RESOLVED_TTL_MS;
    const logFn = opts.logStaleOrder || appendStaleOrderLog;
    const enqueueRemoveFn = opts.enqueueLabelRemove || enqueueLabelRemove;
    const findResolutionFn = opts.findGuardianResolution || findGuardianResolution;

    const archivedMarkerKeys = new Set(); // `${issue}.${skill}`
    const archivedIssues = new Set();
    const archivedEntries = [];

    for (const m of blockedMarkers) {
        const markerPath = path.join(
            PIPELINE, m.pipeline, m.phase, humanBlock.BLOCK_SUBDIR, `${m.issue}.${m.skill}`,
        );
        let markerMtime;
        try { markerMtime = fs.statSync(markerPath).mtimeMs; }
        catch { continue; } // marker desapareció entre listado y stat — saltar

        let resolved = null;
        const guardian = findResolutionFn(m, markerMtime);
        if (guardian) {
            resolved = {
                reason: 'guardian-resolved',
                detail: `${m.pipeline}/${m.phase}/${guardian.state}/${m.issue}.${m.skill}`,
            };
        } else if ((now - markerMtime) > ttlMs) {
            const daysIdle = Math.round((now - markerMtime) / (24 * 3600 * 1000));
            resolved = {
                reason: 'ttl-expired',
                detail: `marker sin movimiento por ${daysIdle}d (TTL=${Math.round(ttlMs / (24 * 3600 * 1000))}d)`,
            };
        }

        if (!resolved) continue;

        // Archivar marker en <pipeline>/<phase>/archivado/ con sufijo
        // `<reason>-<ts>` para que sea evidente por qué se cerró.
        const archiveDir = path.join(PIPELINE, m.pipeline, m.phase, 'archivado');
        const base = `${m.issue}.${m.skill}`;
        const archivedName = `${base}.${resolved.reason}-${safeTsSuffix(now)}`;
        const dst = path.join(archiveDir, archivedName);

        try {
            fs.mkdirSync(archiveDir, { recursive: true });
            fs.renameSync(markerPath, dst);
        } catch (e) {
            log(`Error archivando marker resuelto #${m.issue}.${m.skill}: ${e.message.slice(0, 120)}`);
            continue;
        }
        try { fs.unlinkSync(markerPath + '.reason.json'); } catch {}

        archivedMarkerKeys.add(`${m.issue}.${m.skill}`);
        archivedIssues.add(m.issue);
        archivedEntries.push({
            issue: m.issue, skill: m.skill, reason: resolved.reason, archived_as: dst,
        });

        try {
            logFn({
                reason: resolved.reason,
                issue: m.issue,
                label: RECONCILER_LABEL,
                snapshot_at: null,
                current_mtime: markerMtime,
                detail: resolved.detail,
            });
        } catch {}

        log(`#${m.issue}.${m.skill} resuelto (${resolved.reason}) → archivado/${archivedName}`);
    }

    // Cross-fase: por cada issue con marker archivado, verificar si quedan
    // otros markers activos en blockedMarkers (en cualquier fase). Solo si
    // todos los markers del issue fueron archivados, encolamos remove-label
    // para que GitHub también quede sin `needs-human`.
    let removeLabelsEnqueued = 0;
    for (const issue of archivedIssues) {
        const stillBlocked = blockedMarkers.some(
            m => m.issue === issue && !archivedMarkerKeys.has(`${m.issue}.${m.skill}`),
        );
        if (stillBlocked) continue;
        try {
            enqueueRemoveFn(issue, RECONCILER_LABEL);
            removeLabelsEnqueued++;
        } catch (e) {
            log(`Error encolando remove-label #${issue}: ${e.message.slice(0, 120)}`);
        }
    }

    return {
        archived: archivedEntries.length,
        archivedIssues,
        archivedMarkerKeys,
        removeLabelsEnqueued,
        entries: archivedEntries,
    };
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
// #3175 — Admission gate sweep (huérfanos sin needs-definition/Ready)
// -----------------------------------------------------------------------------
//
// El workflow `.github/workflows/admission-gate.yml` cubre el caso event-driven
// (issue/PR recién creado). Pero hay paths que escapan al workflow:
//   - Issues creados durante un downtime de Actions.
//   - Issues creados antes del deploy del workflow (huérfanos históricos).
//   - PRs creados desde un fork con permisos limitados.
//
// Este sweep es defensa en profundidad: cada ciclo del reconciler escanea
// todos los issues/PRs OPEN del repo, filtra los que NO tengan label de
// admisión, aplica `needs-definition` y avisa por Telegram.
//
// El sweep es idempotente: aplicar un label ya existente es no-op en la API
// de GitHub. Y el formatTelegramAlert devuelve null cuando hay 0 huérfanos,
// así que no se alerta cuando todo está limpio (modo silencioso, CA-UX5).

function listGhItemsAll(kind) {
    // kind: 'issue' | 'pr'. Listamos open con labels/title/url para que
    // admissionGate.filterOrphans pueda decidir sin más I/O.
    const cmd = kind === 'pr' ? 'pr list' : 'issue list';
    try {
        const raw = execSync(
            `"${GH_BIN}" ${cmd} --state open --limit 500 --json number,labels,title,url`,
            { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true },
        );
        const items = JSON.parse(raw || '[]');
        return items;
    } catch (e) {
        log(`Error consultando GitHub (${kind}): ${e.message.slice(0, 120)}`);
        return null;
    }
}

function applyAdmissionLabel(issueNumber) {
    // Idempotente del lado de GitHub. Reusamos la cola de svc-github para
    // que el apply no bloquee el reconciler ni dependa de la latencia de
    // la API.
    try {
        fs.mkdirSync(GH_QUEUE, { recursive: true });
        const filename = `${issueNumber}-${admissionGate.DEFAULT_ADMISSION_LABEL}-admission-${Date.now()}.json`;
        const payload = {
            action: 'label',
            issue: issueNumber,
            label: admissionGate.DEFAULT_ADMISSION_LABEL,
        };
        fs.writeFileSync(path.join(GH_QUEUE, filename), JSON.stringify(payload));
        return true;
    } catch (e) {
        log(`Error encolando admission label #${issueNumber}: ${e.message.slice(0, 120)}`);
        return false;
    }
}

function enqueueTelegramAlert(text) {
    // Patrón estándar del pipeline: drop JSON en servicios/telegram/pendiente/
    // y svc-telegram lo envía. El svc-telegram ya hace sanitización doble
    // (sanitize-console + sanitize-payload + redact), pero el módulo
    // admission-gate ya redacta el título por nuestro lado — defensa en
    // profundidad.
    try {
        fs.mkdirSync(ADMISSION_TELEGRAM_QUEUE, { recursive: true });
        const filename = `${Date.now()}-admission-sweep.json`;
        const payload = { text, parse_mode: 'Markdown' };
        fs.writeFileSync(path.join(ADMISSION_TELEGRAM_QUEUE, filename), JSON.stringify(payload), 'utf8');
        return true;
    } catch (e) {
        log(`Error encolando alerta Telegram admission: ${e.message.slice(0, 120)}`);
        return false;
    }
}

function reconcileAdmissionOrphans(opts = {}) {
    // Devuelve {appliedCount, deferredCount, bootstrap, alertSent, dryRun}.
    // El opts.listIssues/opts.listPrs/opts.applyLabel/opts.enqueueAlert son
    // hooks para tests (todos opcionales; defaultean a las funciones reales).
    if (!ADMISSION_SWEEP_ENABLED) {
        return { skipped: true, reason: 'ADMISSION_SWEEP_ENABLED=0' };
    }

    const listIssuesFn = opts.listIssues || (() => listGhItemsAll('issue'));
    const listPrsFn = opts.listPrs || (() => listGhItemsAll('pr'));
    const applyFn = opts.applyLabel || applyAdmissionLabel;
    const alertFn = opts.enqueueAlert || enqueueTelegramAlert;
    const dryRun = opts.dryRun != null ? !!opts.dryRun : ADMISSION_DRY_RUN;

    const issues = listIssuesFn();
    const prs = listPrsFn();
    if (issues === null && prs === null) {
        return { skipped: true, reason: 'GitHub no respondió' };
    }

    const orphans = [
        ...admissionGate.filterOrphans(issues || []),
        ...admissionGate.filterOrphans(prs || []),
    ];

    if (orphans.length === 0) {
        // Modo silencioso (CA-UX5). No publicamos nada cuando todo OK.
        return { appliedCount: 0, deferredCount: 0, bootstrap: false, alertSent: false, dryRun };
    }

    const decision = admissionGate.applyBootstrapCap(orphans);
    let appliedCount = 0;
    if (!dryRun) {
        for (const o of decision.apply) {
            if (applyFn(o.number)) appliedCount++;
        }
    } else {
        // En dry-run reportamos cuántos se aplicarían pero no encolamos.
        appliedCount = decision.apply.length;
    }

    const alertText = admissionGate.formatTelegramAlert(decision);
    let alertSent = false;
    if (alertText && !dryRun) {
        alertSent = alertFn(alertText);
    }

    return {
        appliedCount,
        deferredCount: decision.deferred.length,
        bootstrap: decision.bootstrap,
        alertSent,
        dryRun,
    };
}

// -----------------------------------------------------------------------------
// #3381 — Sweep del screenshots+mockup gate (default OFF)
// -----------------------------------------------------------------------------
//
// Cuando SCREENSHOTS_MOCKUPS_GATE_ENABLED=1, escanea issues `Ready` en scope
// (app:* o area:pipeline con archivos de dashboard) y alerta por Telegram si
// alguno no tiene la sección `## Screenshots & Mockups` o el opt-out
// `ux:no-visual`. NO revierte labels automáticamente — solo señaliza para
// triaje humano + agente /ux. Mantener el principio "fail-soft" del rollout.

function listReadyIssuesWithBody() {
    try {
        const raw = execSync(
            `"${GH_BIN}" issue list --label "Ready" --state open --json number,labels,title,url,body --limit 500`,
            { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true },
        );
        return JSON.parse(raw || '[]');
    } catch (e) {
        log(`Error listando Ready issues (screenshots gate): ${e.message.slice(0, 120)}`);
        return null;
    }
}

function enqueueScreenshotsGateAlert(issues) {
    if (!Array.isArray(issues) || issues.length === 0) return false;
    const lines = [
        `🟠 Screenshots & Mockups gate — ${issues.length} issues Ready sin sección visual completa`,
        '',
    ];
    for (const it of issues) {
        const url = typeof it.url === 'string' && it.url ? it.url : `#${it.number}`;
        const title = admissionGate.safeTitle(it.title || '');
        const missing = Array.isArray(it.missing) ? it.missing.join(',') : 'unknown';
        lines.push(`[#${it.number}](${url}) — ${title} — falta: ${missing}`);
    }
    lines.push('');
    lines.push('Acción: invocar `/ux` o aplicar `ux:no-visual` con justificación.');
    lines.push('Más detalle: docs/pipeline/ux-visual-flow.md');

    const text = lines.join('\n');
    try {
        fs.mkdirSync(ADMISSION_TELEGRAM_QUEUE, { recursive: true });
        const filename = `${Date.now()}-screenshots-gate.json`;
        fs.writeFileSync(
            path.join(ADMISSION_TELEGRAM_QUEUE, filename),
            JSON.stringify({ text, parse_mode: 'Markdown' }),
            'utf8',
        );
        return true;
    } catch (e) {
        log(`Error encolando alerta screenshots-gate: ${e.message.slice(0, 120)}`);
        return false;
    }
}

function reconcileScreenshotsMockupGate(opts = {}) {
    // Devuelve {appliedCount, skipped, reason}.
    if (process.env[screenshotsMockupGate.FLAG_ENV_NAME] !== '1') {
        return { skipped: true, reason: 'flag-off' };
    }
    const listFn = opts.listReady || listReadyIssuesWithBody;
    const alertFn = opts.enqueueAlert || enqueueScreenshotsGateAlert;
    const items = listFn();
    if (items === null) return { skipped: true, reason: 'github-error' };

    const blocked = [];
    for (const it of items) {
        const result = screenshotsMockupGate.evaluate({
            labels: it.labels || [],
            body: it.body || '',
        }, { flag: '1' });
        if (result.gate === 'block') {
            blocked.push({
                number: it.number,
                title: it.title,
                url: it.url,
                missing: result.missing,
            });
        }
    }

    if (blocked.length === 0) {
        return { appliedCount: 0, skipped: false };
    }
    const sent = alertFn(blocked);
    return { appliedCount: blocked.length, alertSent: sent };
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

    // #3186 — primero, archivar markers ya resueltos por el guardian (re-aprobó)
    // o expirados por TTL. Corre ANTES que reconcileMarkerToLabel para no
    // re-aplicar el label sobre un issue que está funcionalmente destrabado;
    // ANTES que reconcileHumanUnblockDetected porque el guardian-resolved es
    // más específico (sabemos exactamente qué skill resolvió) que la detección
    // por "label ausente" — si ambos disparan, preferimos archivar a `archivado/`
    // (estado terminal) en vez de mover a `pendiente/` (estado de re-ejecución).
    const resolvedResult = reconcileResolvedMarkers(blockedMarkers);
    const resolved = resolvedResult.archived;
    const resolvedRemovedLabels = resolvedResult.removeLabelsEnqueued;
    const afterResolved = resolvedResult.archivedMarkerKeys.size > 0
        ? blockedMarkers.filter(m => !resolvedResult.archivedMarkerKeys.has(`${m.issue}.${m.skill}`))
        : blockedMarkers;

    // CA3 (#2994) — detectar destrabes humanos: corre ANTES que
    // reconcileMarkerToLabel para no encolar órdenes que tendríamos que
    // descartar como stale por GitHub-autoritativo.
    const unblockResult = reconcileHumanUnblockDetected(afterResolved, ghIssueSet);
    const detected = unblockResult.detected;
    // Filtrar markers ya movidos para que reconcileMarkerToLabel/Closed
    // no vuelvan a procesarlos en este mismo ciclo.
    const remaining = unblockResult.movedIssues.size > 0
        ? afterResolved.filter(m => !unblockResult.movedIssues.has(m.issue))
        : afterResolved;

    const enqueued = reconcileMarkerToLabel(remaining, ghIssueSet);
    const archived = reconcileClosedMarkers(remaining, ghIssueSet);

    // #3175 — Sweep paralelo del admission gate (defensa en profundidad).
    // Fallas del sweep son no-fatales: si GH no responde o falla la cola,
    // el ciclo del reconciler debe completar igual.
    let admissionResult = null;
    try {
        admissionResult = reconcileAdmissionOrphans();
    } catch (e) {
        log(`Admission sweep error: ${e.message.slice(0, 120)}`);
        admissionResult = { error: true };
    }

    // #3381 — Sweep del screenshots+mockup gate (default OFF). Mismo principio
    // que admission: fail-soft, no rompe el ciclo. Solo alerta — no auto-revert.
    let screenshotsResult = null;
    try {
        screenshotsResult = reconcileScreenshotsMockupGate();
    } catch (e) {
        log(`Screenshots+mockup sweep error: ${e.message.slice(0, 120)}`);
        screenshotsResult = { error: true };
    }

    const elapsed = Date.now() - t0;
    lastRunAt = Date.now();
    const admissionSummary = admissionResult && !admissionResult.skipped && !admissionResult.error
        ? `, +${admissionResult.appliedCount || 0} admission${admissionResult.bootstrap ? ' [BOOTSTRAP]' : ''}`
        : '';
    const screenshotsSummary = screenshotsResult && !screenshotsResult.skipped && !screenshotsResult.error && screenshotsResult.appliedCount
        ? `, +${screenshotsResult.appliedCount} screenshots-gate`
        : '';
    if (created || enqueued || archived || detected || resolved || (admissionResult && admissionResult.appliedCount) || (screenshotsResult && screenshotsResult.appliedCount)) {
        log(`Ciclo ${cycleCount} (${elapsed}ms): GH=${ghIssues.length} markers=${blockedMarkers.length} → +${created} placeholders, +${enqueued} labels encolados, +${archived} archivados (closed), +${detected} destrabes humanos, +${resolved} resueltos por guardian/TTL (-${resolvedRemovedLabels} labels removidos)${admissionSummary}${screenshotsSummary}`);
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
    reconcileResolvedMarkers,
    findGuardianResolution,
    safeTsSuffix,
    decidirFasePlaceholder,
    isRecommendationIssue,
    RECOMMENDATION_LABELS,
    // #4222 — Cruce label↔avance físico de fases (anti bloqueo fantasma)
    loadGlobalPhaseOrder,
    globalPhaseIndex,
    findFurthestPhysicalPhaseIndex,
    isNeedsHumanStaleByProgress,
    PROGRESS_STATES,
    FALLBACK_PHASE_ORDER,
    listGhIssuesWithLabel,
    getIssueState,
    enqueueLabelApply,
    enqueueLabelRemove,
    buildMarkerMeta,
    appendStaleOrderLog,
    HUMAN_UNBLOCK_GRACE_MS,
    RESOLVED_TTL_MS,
    // #3175 — Admission gate sweep
    reconcileAdmissionOrphans,
    applyAdmissionLabel,
    enqueueTelegramAlert,
    listGhItemsAll,
    ADMISSION_SWEEP_ENABLED,
    ADMISSION_DRY_RUN,
};
