// =============================================================================
// stuck-reconciler-deps.js — Cableado de dependencias del reconciler de fases
// varadas (#5396, extraído de `pulpo.js`).
//
// POR QUÉ EXISTE ESTE MÓDULO (SEC-0)
// -----------------------------------
// El objeto `deps` vivía inline en `pulpo.js` (16k líneas, con side-effects al
// requerirlo). Eso hacía IMPOSIBLE testear el cableado real: los tests mockeaban
// `allowed: true` y "pasaban" mientras producción seguía rota. Acá el cableado es
// importable y verificable sin cargar el Pulpo entero.
//
// LOS TRES DEFECTOS QUE ARREGLA (#5396)
// --------------------------------------
//  1. `isAllowed` reimplementaba a mano la política de ola leyendo
//     `ppMode.allowed_issues` (snake) cuando `getPipelineMode()` normaliza a
//     `allowedIssues` (camel). Efecto real: fail-OPEN fuera de ola (barría todo
//     el backlog histórico) y fail-CLOSED dentro de ola (self-healing muerto
//     justo cuando hace falta). Ahora delega en la API canónica
//     `partialPause.isIssueAllowedInState` (#5060).
//  2. `hasNeedsHuman` sólo miraba señales TRANSITORIAS (cola de GitHub sin
//     drenar + marker). Drenada la cola, el dedupe se apagaba y el mismo issue
//     se re-escalaba y re-notificaba en cada tick. Ahora devuelve el ORIGEN de
//     la supresión y consulta además el title-cache como hint fresco.
//  3. `escalate` encolaba SÓLO el label y nunca creaba el marker físico. Sin
//     marker, `servicio-reconciler.js` lo veía como `needs-human` fantasma,
//     encolaba `remove-label` ~30s después y se cerraba un bucle add/remove.
//     Ahora el bloqueo lo registra su dueño: `humanBlock.reportHumanBlock`.
//
// INVARIANTES DE SEGURIDAD
// ------------------------
//  - SEC-1: el marker físico es la FUENTE DE VERDAD; el title-cache es un HINT
//    que sólo puede SUPRIMIR de más, jamás habilitar un escalado.
//  - SEC-2: la frescura del cache se resuelve reusando `title-cache-freshness`
//    (`needsRefetch`), sin inventar un TTL nuevo.
//  - SEC-4: las notificaciones viajan en texto PLANO (sin `parse_mode`) porque
//    el `reason` interpola un `skill` derivado de un nombre de archivo.
//  - SEC-5.2: `escalate` valida el issue como entero positivo ANTES del
//    `path.join` que hace `reportHumanBlock`.
//  - #5396 rev-1: el skill del marker SIEMPRE pertenece a
//    `skills_por_fase[fase]` — la misma lista que valida el invariante de
//    dispatch de `pulpo.js`. Un marker con skill no despachable convierte la
//    vía de destrabe en un generador de spam de Telegram por tick.
//  - Línea roja (PO): nada de esto resuelve la ambigüedad solo. El fix es sobre
//    A QUIÉN se le avisa y CUÁNTAS VECES, nunca sobre auto-completar una fase.
// =============================================================================

'use strict';

const fsDefault = require('fs');
const path = require('path');

const partialPauseDefault = require('./partial-pause');
const humanBlockDefault = require('./human-block');
const processLivenessDefault = require('./process-liveness');
const { needsRefetch: needsRefetchDefault } = require('./title-cache-freshness');

// Fases PARALELAS de `desarrollo` (todos los skills deben estar, modelo
// `resultado: aprobado`). Mono-skill (dev/build/entrega) quedan afuera. Las de
// `definicion` (analisis/criterios) también: sus deliverables son dossiers que
// NO usan `resultado: aprobado`, así que el detector los malinterpretaría.
const DEFAULT_PARALLEL_PHASES = Object.freeze([
    { pipeline: 'desarrollo', fase: 'validacion' },
    { pipeline: 'desarrollo', fase: 'verificacion' },
    { pipeline: 'desarrollo', fase: 'aprobacion' },
]);

const NEEDS_HUMAN_LABEL = 'needs-human';
// #5396 rev-1 — El marker YA NO usa un skill sintético.
//
// Antes se plantaba `<issue>.reconciler`. Ese nombre no existe en
// `skills_por_fase[fase]`, así que al destrabar (`unblockIssue`, o los botones
// 'Aprobar (unblock)' / 'Priorizar' de la propia notificación) el marker caía en
// `pendiente/` y entraba al despacho, donde el INVARIANTE skill∈fase de
// `pulpo.js` lo rebotaba a `pendiente/` SIN registrar cooldown y mandaba un
// Telegram "⛔ Pipeline bloqueó lanzamiento de reconciler:#N" en CADA tick.
// O sea: la vía de salida del bloqueo generaba exactamente el spam que este
// issue viene a eliminar.
//
// Ahora el skill sale de los skills REALES que motivaron la escalación (los
// mismos que usa el carril `requeue`) y se valida contra `skills_por_fase[fase]`
// antes de plantar el marker. La procedencia se conserva en el `reason` con el
// prefijo `[self-healing]`, que es lo que el dashboard y `listBlockedIssues()`
// muestran junto al `<issue>.<skill>`.
const SELF_HEALING_REASON_PREFIX = '[self-healing]';
const DEFAULT_SILENT_STREAK_THRESHOLD = 6; // ≈1h con ticks de 10 min

function labelNameOf(l) {
    if (typeof l === 'string') return l;
    return (l && typeof l.name === 'string') ? l.name : null;
}

/**
 * Cablea las dependencias reales del reconciler de fases varadas.
 *
 * Todo lo específico del Pulpo (helpers de paths, logger, sender de Telegram)
 * entra por `deps` para que el cableado sea importable desde un test sin
 * arrastrar `pulpo.js`. Los módulos de política (`partialPause`, `humanBlock`,
 * `titleCacheFreshness`) se requieren acá por default y son sobreescribibles.
 *
 * @param {object} opts
 * @param {object} opts.config           config.yaml ya parseado
 * @param {string} opts.PIPELINE         raíz de `.pipeline`
 * @param {string} opts.ROOT             raíz del repo (para los heartbeats)
 * @param {string} opts.pauseFile        path del `.paused`
 * @param {object} opts.ppMode           salida de `partialPause.getPipelineMode()`
 * @param {number} [opts.nowMs]
 * @param {number} [opts.staleMs]        umbral de liveness por mtime
 * @param {Array}  [opts.parallelPhases]
 * @param {object} [opts.deps]           inyecciones (fs, log, notify, helpers…)
 * @returns {object} deps para `runStuckPhaseReconciler`
 */
function buildStuckReconcilerDeps(opts = {}) {
    const config = opts.config || {};
    const PIPELINE = opts.PIPELINE;
    const ROOT = opts.ROOT;
    const ppMode = opts.ppMode;
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : 15 * 60 * 1000;
    const parallelPhases = Array.isArray(opts.parallelPhases) && opts.parallelPhases.length
        ? opts.parallelPhases
        : DEFAULT_PARALLEL_PHASES;

    const d = opts.deps || {};
    const fs = d.fs || fsDefault;
    const partialPause = d.partialPause || partialPauseDefault;
    const humanBlock = d.humanBlock || humanBlockDefault;
    const processLiveness = d.processLiveness || processLivenessDefault;
    const needsRefetch = d.needsRefetch || needsRefetchDefault;
    const log = typeof d.log === 'function' ? d.log : () => { };
    // Sender de Telegram con markup: `(text, replyMarkup, opts)`. Sin él, no se
    // notifica (best-effort: nunca tumba el tick).
    const sendTelegramWithMarkup = typeof d.sendTelegramWithMarkup === 'function'
        ? d.sendTelegramWithMarkup
        : null;

    const fasePath = d.fasePath || ((p, f) => path.join(PIPELINE, p, f));
    const listWorkFiles = d.listWorkFiles || ((dir) => {
        try {
            return fs.readdirSync(dir)
                .filter((f) => !f.startsWith('.') && !f.endsWith('.gitkeep'))
                .map((f) => ({ name: f, path: path.join(dir, f) }));
        } catch { return []; }
    });
    const readYamlSafe = d.readYamlSafe || (() => ({}));

    const ghQueueDir = path.join(PIPELINE, 'servicios', 'github', 'pendiente');
    const titleCachePath = path.join(PIPELINE, '.issue-title-cache.json');
    const stuckStateFile = path.join(PIPELINE, '.stuck-reconciler-state.json');
    const allPhasesOf = (p) => (config.pipelines && config.pipelines[p] && config.pipelines[p].fases) || [];
    // MISMA fuente que el INVARIANTE skill∈fase de `pulpo.js:8596`
    // (`config.pipelines[pipeline].skills_por_fase[fase]`). Que `escalate` valide
    // contra esta lista es lo que garantiza que el marker sea despachable al
    // destrabar: si acá entra, el invariante del Pulpo no lo puede rebotar.
    const skillsOfPhase = (p, f) => {
        const spf = config.pipelines && config.pipelines[p] && config.pipelines[p].skills_por_fase;
        const list = spf && spf[f];
        return Array.isArray(list) ? list : [];
    };

    // ---- lectores del title-cache (hint, nunca autoridad — SEC-1) -----------
    const readTitleCache = () => {
        try { return JSON.parse(fs.readFileSync(titleCachePath, 'utf8')); }
        catch { return null; }
    };
    const readTitleCacheEntry = (issue) => {
        const cache = readTitleCache();
        if (!cache || typeof cache !== 'object') return null;
        const e = cache[String(issue)];
        return (e && typeof e === 'object') ? e : null;
    };
    /** Entrada sólo si es FRESCA según `needsRefetch` (SEC-2). */
    const readFreshEntry = (issue) => {
        const e = readTitleCacheEntry(issue);
        if (!e) return null;
        try { if (needsRefetch(e, { now: nowMs })) return null; }
        catch { return null; } // predicado roto → tratar como desconocida
        return e;
    };

    // ---- señales de "ya escalado" ------------------------------------------
    /** Marker físico en `<pipeline>/<fase>/bloqueado-humano/<issue>.*` */
    const hasBlockMarker = (issue) => {
        for (const p of Object.keys(config.pipelines || {})) {
            for (const f of allPhasesOf(p)) {
                try {
                    const entries = fs.readdirSync(path.join(fasePath(p, f), 'bloqueado-humano'));
                    if (entries.some((n) => n.startsWith(issue + '.'))) return true;
                } catch { /* dir ausente */ }
            }
        }
        return false;
    };
    /** Orden de label todavía sin drenar en la cola del servicio-github. */
    const hasQueuedLabel = (issue) => {
        try { return fs.readdirSync(ghQueueDir).some((n) => n.startsWith(issue + '-needs-human')); }
        catch { return false; }
    };

    return {
        nowMs,
        parallelPhases,
        requiredSkillsFor: skillsOfPhase,
        listPhaseFiles: (p, f, state) => {
            const dir = path.join(fasePath(p, f), state);
            return (listWorkFiles(dir) || []).map((wf) => {
                let mtimeMs = 0;
                try { mtimeMs = fs.statSync(wf.path).mtimeMs; } catch { /* ausente */ }
                return { name: wf.name, mtimeMs };
            });
        },
        readYaml: (p, f, state, name) => readYamlSafe(path.join(fasePath(p, f), state, name)),
        issueLiveElsewhere: (issue, p, currentFase) => {
            for (const f of allPhasesOf(p)) {
                if (f === currentFase) continue;
                for (const st of ['pendiente', 'trabajando']) {
                    try {
                        if (fs.readdirSync(path.join(fasePath(p, f), st)).some((n) => n.startsWith(issue + '.'))) return true;
                    } catch { /* dir ausente */ }
                }
            }
            return false;
        },

        // #5396 CA-1/CA-2 — devuelve el ORIGEN de la supresión, no un booleano.
        // Precedencia: marker (verdad) > cola > cache fresca (hint) > desconocida.
        // El `false` (no suprimir) SÓLO se alcanza con una entrada de cache FRESCA
        // que explícitamente NO tiene el label: la caché nunca habilita un
        // escalado por ausencia de datos.
        // @returns {false|'marker'|'cola'|'cache-label'|'cache-desconocida'}
        hasNeedsHuman: (issue) => {
            if (hasBlockMarker(issue)) return 'marker';
            if (hasQueuedLabel(issue)) return 'cola';
            const entry = readFreshEntry(issue);
            if (!entry) return 'cache-desconocida'; // fail-closed: no re-escalar
            const labels = Array.isArray(entry.labels) ? entry.labels : [];
            return labels.map(labelNameOf).includes(NEEDS_HUMAN_LABEL) ? 'cache-label' : false;
        },

        // #5396 CA-3 — API canónica de la ola (#5060). Reemplaza la
        // reimplementación a mano que leía `allowed_issues` (snake) sobre un
        // objeto normalizado a `allowedIssues` (camel).
        //   running       → false salvo PIPELINE_ALLOW_UNSCOPED_DISPATCH=1
        //   paused        → false
        //   partial_pause → issue ∈ allowedIssues
        isAllowed: (issue) => partialPause.isIssueAllowedInState(issue, ppMode),

        // Solo actuar sobre issues confirmados OPEN. Cerrado/notFound/desconocido
        // → no tocar (residuo).
        isIssueOpen: (issue) => {
            const e = readTitleCacheEntry(issue);
            return !!(e && e.state === 'OPEN');
        },

        // CA-UX-2 — título para que la notificación sea legible. Sólo si la
        // entrada está fresca; si no, el mensaje va sin título (nunca miente).
        issueTitle: (issue) => {
            const e = readFreshEntry(issue);
            return (e && typeof e.title === 'string' && e.title.trim()) ? e.title.trim() : null;
        },

        isPaused: () => { try { return fs.existsSync(opts.pauseFile); } catch { return false; } },

        // #4622 (CA-4): un `trabajando/` reciente ya NO alcanza como prueba de
        // vida. Se cruza el latido `agent-<issue>.heartbeat`: si su pid está
        // muerto (o su identidad no matchea por reuso de PID), el skill NO cuenta
        // como vivo. Sin latido legible, cae al criterio de mtime (compat).
        livenessOk: (name, mtimeMs) => {
            const recent = (nowMs - mtimeMs) < staleMs;
            if (!recent) return false; // viejo → muerto, sin importar el latido
            const issue = String(name).split('.')[0];
            const hbPath = path.join(ROOT, '.claude', 'hooks', `agent-${issue}.heartbeat`);
            let hb;
            try { hb = JSON.parse(fs.readFileSync(hbPath, 'utf8')); }
            catch { return recent; }
            return processLiveness.isAgentAlive(hb && hb.pid, {
                startedAt: hb && hb.pid_started_at,
                branch: hb && hb.branch,
                session: hb && hb.session,
            });
        },

        loadRetryState: () => { try { return JSON.parse(fs.readFileSync(stuckStateFile, 'utf8')); } catch { return {}; } },
        saveRetryState: (s) => { try { fs.writeFileSync(stuckStateFile, JSON.stringify(s, null, 2)); } catch { /* best-effort */ } },

        requeueWorkItem: (p, f, skill, issue) => {
            const dir = path.join(fasePath(p, f), 'pendiente');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${issue}.${skill}`), `issue: ${issue}\nfase: ${f}\npipeline: ${p}\n`);
        },

        // #5396 causa raíz 3 — registrar el bloqueo por su DUEÑO. `reportHumanBlock`
        // planta el marker físico (que es lo que `servicio-reconciler.js:490`
        // respeta para NO encolar `remove-label`) y encola el label él mismo.
        // Ya no se escribe el label a mano: eso dejaba el gate sin marker y
        // cerraba el bucle add/remove.
        //
        // ⚠️ Riesgo #1: `reportHumanBlock` MUEVE el work-item activo (incluido el
        // de `listo/`) hacia `bloqueado-humano/` salvo que reciba `pipeline`
        // explícito Y `moveFromActive: false`. Un issue varado tiene justamente
        // sus deliverables en `listo/` — moverlos destruiría la evidencia que el
        // detector usa. Los DOS parámetros son obligatorios (la guarda es
        // `if (!pipeline || opts.moveFromActive !== false)`).
        escalate: (issue, reason, meta = {}) => {
            const n = Number(issue);
            // SEC-5.2 — validar ANTES del path.join que hace reportHumanBlock.
            if (!Number.isInteger(n) || n <= 0) {
                log('reconciler', `escalate: issue inválido (${String(issue).slice(0, 40)}) — ignorado`);
                return false;
            }
            const phase = String(meta.fase || '').trim();
            const pipeline = String(meta.pipeline || '').trim();
            if (!phase || !pipeline) {
                // Fail-closed: sin pipeline explícito, `reportHumanBlock` haría
                // `findActiveMarker` y podría mover el deliverable de `listo/`.
                log('reconciler', `escalate #${n}: falta pipeline/fase explícitos — no se escala (protege evidencia)`);
                return false;
            }

            // #5396 rev-1 — ELEGIR UN SKILL CON CAMINO DE DISPATCH VÁLIDO.
            //
            // El marker termina en `pendiente/<issue>.<skill>` cuando el operador
            // destraba (`unblockIssue` / quick-actions). Si ese `<skill>` no está
            // en `skills_por_fase[fase]`, `pulpo.js` lo rebota contra el
            // INVARIANTE y notifica por Telegram en cada tick, sin cooldown.
            // Por eso el skill se valida contra la MISMA lista que usa el
            // invariante, y si no hay ninguno válido NO se escala (fail-closed:
            // mejor un log ruidoso que un bloqueo sin salida que spamea).
            const permitidos = skillsOfPhase(pipeline, phase);
            const candidatos = Array.isArray(meta.skills) ? meta.skills.map((s) => String(s || '').trim()) : [];
            // 1º el skill ambiguo/agotado que motivó la escalación (re-corre justo
            // el que quedó sin veredicto); 2º fallback determinista al primero de
            // la fase, para el caso 'estado indeterminado' que no imputa skill.
            const blockSkill = candidatos.find((s) => permitidos.includes(s)) || permitidos[0] || null;
            if (!blockSkill) {
                log('reconciler', `escalate #${n}: ${pipeline}/${phase} sin skills_por_fase — no se escala (el marker no tendría dispatch al destrabar)`);
                return false;
            }

            try {
                humanBlock.reportHumanBlock({
                    issue: n,
                    // Skill REAL de la fase (no el sintético `reconciler`): al
                    // destrabar, el work-item es despachable.
                    skill: blockSkill,
                    phase,
                    pipeline,                 // explícito → no busca marker activo
                    moveFromActive: false,    // ⚠️ no mover el deliverable de `listo/`
                    // El prefijo conserva la PROCEDENCIA que antes daba el nombre
                    // del skill sintético (riesgo #5): el dashboard y
                    // `listBlockedIssues()` muestran el reason junto al marker.
                    reason: `${SELF_HEALING_REASON_PREFIX} ${String(reason || 'fase varada')}`.slice(0, 500),
                    question: `¿Cómo destrabo #${n} en ${pipeline}/${phase}? (rechazo / cancelado / corrupto)`,
                    // `precondition` omitido → normalizePrecondition ⇒ HUMAN_JUDGMENT
                    // (fail-closed, #4748): nunca auto-re-evaluable.
                });
                return true;
            } catch (e) {
                log('reconciler', `error escalando #${n}: ${e && e.message}`);
                return false;
            }
        },

        workItemExists: (p, f, skill, issue) => {
            for (const st of ['pendiente', 'trabajando']) {
                try { if (fs.existsSync(path.join(fasePath(p, f), st, `${issue}.${skill}`))) return true; } catch { /* no-op */ }
            }
            return false;
        },

        // CA-8 / CA-UX-1 — texto PLANO (sin `parse_mode`, el reason interpola un
        // skill derivado de un nombre de archivo) PERO con los botones de acción
        // rápida. `reply_markup` es independiente del dialecto de parseo, así que
        // `sendTelegramWithMarkup(text, markup, { plain: true })` cumple ambos.
        // `sendTelegramPlain` NO sirve: hardcodea el markup a null y mata los botones.
        // Si el markup no se puede firmar, se envía igual el texto (CA-UX-1).
        notify: (msg, meta = {}) => {
            if (!sendTelegramWithMarkup) return;
            let markup = null;
            const n = Number(meta.issue);
            if (meta.action === 'escalate' && Number.isInteger(n) && n > 0) {
                try { markup = humanBlock.buildBlockedActionMarkup(n) || null; }
                catch { markup = null; }
            }
            try { sendTelegramWithMarkup(msg, markup, { plain: true }); }
            catch { /* best-effort: notificar nunca tumba el tick */ }
        },

        audit: (rec) => log('reconciler', typeof rec === 'string' ? rec : JSON.stringify(rec)),
    };
}

/**
 * PURO — evalúa la racha de silencio del reconciler (CA-7 / CA-UX-3).
 *
 * Riesgo #2: fail-closed por caché + filtro de ola siempre activo + allowlist
 * vacía tras la poda de fin de ola componen un self-healing 100% mudo *por
 * diseño*. Ese es exactamente el estado de producción que nadie notó. Esta
 * función es lo que impide que CA-1…CA-4 se "cumplan" apagando el reconciler.
 *
 * CA-UX-3: NO se emite señal si la totalidad del silencio se explica por el
 * filtro de ola (es el comportamiento correcto, no una anomalía), y se emite
 * como máximo UNA vez por racha.
 *
 * @param {object|null} prev  estado previo `{ streak, signaled }`
 * @param {object} agg        `{ evaluados, escalados, requeued, suprimidos_por_ola }`
 * @param {object} [opts]     `{ threshold }`
 * @returns {{ next: {streak:number, signaled:boolean}, emitSignal: boolean }}
 */
function evaluateSilenceHealth(prev, agg = {}, opts = {}) {
    const threshold = Number.isFinite(opts.threshold) && opts.threshold > 0
        ? opts.threshold : DEFAULT_SILENT_STREAK_THRESHOLD;
    const evaluados = Number(agg.evaluados) || 0;
    const acciones = (Number(agg.escalados) || 0) + (Number(agg.requeued) || 0);

    // Hubo acción (o no había nada que evaluar) → racha reseteada.
    if (evaluados === 0 || acciones > 0) {
        return { next: { streak: 0, signaled: false }, emitSignal: false };
    }

    const streak = ((prev && Number(prev.streak)) || 0) + 1;
    const alreadySignaled = !!(prev && prev.signaled);
    // CA-UX-3 — silencio explicado 100% por el filtro de ola: es lo esperado.
    const explainedByWave = (Number(agg.suprimidos_por_ola) || 0) >= evaluados;
    const emitSignal = streak >= threshold && !alreadySignaled && !explainedByWave;

    return { next: { streak, signaled: alreadySignaled || emitSignal }, emitSignal };
}

module.exports = {
    buildStuckReconcilerDeps,
    evaluateSilenceHealth,
    DEFAULT_PARALLEL_PHASES,
    DEFAULT_SILENT_STREAK_THRESHOLD,
    SELF_HEALING_REASON_PREFIX,
};
