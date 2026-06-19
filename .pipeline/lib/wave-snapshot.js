// =============================================================================
// wave-snapshot.js — Cálculo del snapshot ejecutivo de la ola (#3262).
//
// Función PURA: recibe el state del pipeline + lista de issues de la ola +
// promedios históricos y devuelve la data estructurada para renderizar
// (no toca disco, no toca red).
//
// Responde los 4 CA cuantitativos:
//   - CA-2: % avance por issue = faseIdx / total fases del lifecycle recorrido.
//   - CA-3: % avance total = (cerrados*100 + Σ%activos) / totalIssuesOla.
//   - CA-4: ETA absoluta = max(absoluteMs por issue activo) — paralelo, no suma.
//   - CA-5/CA-6: bloqueos + intervención humana (clasificación determinística).
//
// Refinamientos:
//   - PO-CA-2: denominador adaptativo (3 fases definicion + 7 desarrollo = 10
//     si pasó por ambas, 7 si entró Ready directo).
//   - PO-CA-4: si etaAverages no tiene data, hasEta=false → renderer muestra
//     "ETA insuficiente data" en vez de inventar.
//   - PO-CA-6: umbral configurable (`staleThresholdMin`, default 90 min).
//
// Reglas:
// - No throw. Si el state es inválido / vacío, devuelve `{ issues: [], totalPct: 0, ... }`.
// - Sin side-effects.
// =============================================================================

'use strict';

const { computeIssueEta, computeLaneEmptyEta } = require('./eta');

// Lifecycle completo si el issue pasa por definicion + desarrollo.
// Replicado localmente para evitar acoplamiento con config.yaml — coincide con
// el shape de `state.allFases` que computa `dashboard.getPipelineState`.
const LIFECYCLE_FULL = [
    { pipeline: 'definicion', fase: 'analisis' },
    { pipeline: 'definicion', fase: 'criterios' },
    { pipeline: 'definicion', fase: 'sizing' },
    { pipeline: 'desarrollo', fase: 'validacion' },
    { pipeline: 'desarrollo', fase: 'dev' },
    { pipeline: 'desarrollo', fase: 'build' },
    { pipeline: 'desarrollo', fase: 'verificacion' },
    { pipeline: 'desarrollo', fase: 'linteo' },
    { pipeline: 'desarrollo', fase: 'aprobacion' },
    { pipeline: 'desarrollo', fase: 'entrega' },
];
const LIFECYCLE_DEV_ONLY = LIFECYCLE_FULL.filter((f) => f.pipeline === 'desarrollo');

const DEFAULT_STALE_THRESHOLD_MIN = 90;
const HUMAN_INTERVENTION_LABELS = new Set([
    'needs-human',
    'bug-en-pipeline',
    'needs-definition', // queda en intervención si lleva > N min sin promoverse
]);

/**
 * Determina el lifecycle aplicable a un issue.
 * Si tiene fases de `definicion/*` en su matrix, usa el full (10 fases).
 * Si solo tiene `desarrollo/*`, usa el dev-only (7 fases).
 *
 * @param {object} issueData
 * @returns {{lifecycle: Array, denominador: number}}
 */
function pickLifecycle(issueData) {
    const fases = issueData && issueData.fases ? issueData.fases : {};
    const tieneDefinicion = Object.keys(fases).some((k) => k.startsWith('definicion/'));
    if (tieneDefinicion) {
        return { lifecycle: LIFECYCLE_FULL, denominador: LIFECYCLE_FULL.length };
    }
    return { lifecycle: LIFECYCLE_DEV_ONLY, denominador: LIFECYCLE_DEV_ONLY.length };
}

/**
 * Encuentra el índice de la fase actual dentro del lifecycle.
 * Si la fase no aparece en el lifecycle (caso raro de config divergente),
 * retorna -1.
 *
 * @param {Array} lifecycle
 * @param {string} faseActual - "pipeline/fase"
 * @returns {number}
 */
function findFaseIdx(lifecycle, faseActual) {
    if (!faseActual) return -1;
    for (let i = 0; i < lifecycle.length; i++) {
        const key = `${lifecycle[i].pipeline}/${lifecycle[i].fase}`;
        if (key === faseActual) return i;
    }
    return -1;
}

/**
 * #4098 — Normaliza el enum `state` del cache de títulos / matriz como fuente
 * autoritativa de "cerrado". Comparación defensiva (security CA-7): se castea a
 * String y se baja a minúsculas, nunca se interpola el valor crudo. Devuelve
 * `false` ante `undefined`/`null` para conservar el fallback por label/archivo
 * cuando el cache está frío (sin campo `state`).
 *
 * @param {object} entry - entrada de `issueTitles[id]` o `issueMatrix[id]`.
 * @returns {boolean}
 */
function isClosedState(entry) {
    return String((entry && entry.state) || '').toLowerCase() === 'closed';
}

/**
 * Clasifica el estado visual del issue según las reglas UX-2 (precedencia):
 * closed > blocked > paused > approval > dev > definition.
 *
 * #4098 — `closed` gana a todo lo demás: un issue cerrado en GitHub
 * (`state: CLOSED`) nunca debe renderizar como bloqueado/pausado aunque arrastre
 * un label de bloqueo residual (`blocked:dependencies`) en el cache.
 *
 * @returns {'closed'|'blocked'|'paused'|'approval'|'dev'|'definition'|'pending'}
 */
function classifyStatus({ isClosed, isBlocked, isPaused, faseActual, pct }) {
    if (isClosed) return 'closed';
    if (isBlocked) return 'blocked';
    if (isPaused) return 'paused';
    if (!faseActual) return 'pending';
    // Por fase: aprobacion/entrega = approval; dev/build/verif/linteo = dev; resto = definition.
    if (faseActual.endsWith('/aprobacion') || faseActual.endsWith('/entrega')) return 'approval';
    if (
        faseActual.endsWith('/dev')
        || faseActual.endsWith('/build')
        || faseActual.endsWith('/verificacion')
        || faseActual.endsWith('/linteo')
    ) return 'dev';
    return 'definition';
}

/**
 * Construye el snapshot ejecutivo a partir del state.
 *
 * @param {object} opts
 * @param {object} opts.state               - getPipelineState() output (issueMatrix, etaAverages, allFases, ...)
 * @param {object} opts.wave                - resolveActiveWave() output: { label, issues, source, openedAt }
 * @param {Array}  [opts.blocked]           - listBlockedIssues() output: [{ issue, skill, reason, age_hours, ... }]
 * @param {object} [opts.closedIssues]      - Set/object con números de issue cerrados en GitHub.
 *                                            Si no se pasa, se infiere desde `state.issueMatrix[id].labels`.
 * @param {number} [opts.now]               - epoch ms; default Date.now()
 * @param {number} [opts.staleThresholdMin] - default 90 min (PO-CA-6)
 * @param {Object<number,number[]>} [opts.blockDependencies] - #4075: mapa
 *        parentId → [childId,...] (resolveBlockDependencies). Cada bloqueo cuya
 *        clave figure acá se enriquece con `dependencies[]` (estado inline).
 * @returns {object} snapshot estructurado (ver shape inline)
 */
function buildWaveSnapshot(opts) {
    const options = opts || {};
    const state = options.state || {};
    const wave = options.wave || { label: 'Ola actual', issues: [], source: 'unknown' };
    const blockedList = Array.isArray(options.blocked) ? options.blocked : [];
    const closedSet = options.closedIssues instanceof Set
        ? options.closedIssues
        : new Set(Array.isArray(options.closedIssues) ? options.closedIssues : []);
    const now = typeof options.now === 'number' ? options.now : Date.now();
    const staleThresholdMin = Number.isFinite(options.staleThresholdMin) && options.staleThresholdMin > 0
        ? options.staleThresholdMin
        : DEFAULT_STALE_THRESHOLD_MIN;

    // Index helper para bloqueos por issue.
    const blockedByIssue = new Map();
    for (const b of blockedList) {
        if (!blockedByIssue.has(Number(b.issue))) blockedByIssue.set(Number(b.issue), b);
    }

    const issueMatrix = state.issueMatrix || {};
    const etaAverages = state.etaAverages || {};

    const issuesOut = [];
    const issueEtas = [];     // Para computar ETA de ola (max sobre activos).
    const blocks = [];        // CA-5
    const humanInterventions = []; // CA-6

    let sumPctActive = 0;     // Para CA-3.
    let closedCount = 0;
    let etasMissing = 0;      // Issues activos sin estimación (PO-CA-4).
    let activeWithEta = 0;

    for (const issueNum of wave.issues) {
        const id = String(issueNum);
        const data = issueMatrix[id];

        // Issue sin presencia en pipeline: puede estar cerrado en GitHub o
        // recién admitido sin archivos. Tratarlo como "pendiente" salvo que
        // sepamos que está cerrado.
        const isClosedFromLabel = closedSet.has(Number(id));
        if (!data) {
            // Best-effort: levantar labels desde la cache de títulos cuando
            // el issue no esté en la matriz (CA-6 detección de needs-human /
            // bug-en-pipeline sobre issues sin actividad en pipeline).
            const titleCache = state.issueTitles || {};
            const cachedEntry = titleCache[id] || {};
            const rawLabels = Array.isArray(cachedEntry.labels) ? cachedEntry.labels : [];
            const labelsFromCache = rawLabels
                .map((l) => (typeof l === 'string' ? l : (l && l.name) || ''))
                .filter(Boolean);
            const labelNamesNoMatrix = new Set(labelsFromCache);

            const isBlockedNoMatrix = labelNamesNoMatrix.has('blocked:dependencies')
                || labelNamesNoMatrix.has('blocked:routing-manual')
                || labelNamesNoMatrix.has('needs-human');

            // #4098 — Fuente autoritativa de cerrado para issues fuera de la
            // matriz (ej. épico #4050 cerrado por sus hijos): `state: CLOSED` del
            // cache de títulos. Se honra ANTES que `isBlockedNoMatrix` para que un
            // cerrado con label de bloqueo residual caiga en la rama `closed` y no
            // se pinte 🛑. Fallback: si el cache no trae `state`, queda el
            // `isClosedFromLabel` (label/archivo del caller).
            const isClosedNoMatrix = isClosedFromLabel || isClosedState(cachedEntry);

            // Si está cerrado (por caller o por `state` del cache), 100%.
            if (isClosedNoMatrix) {
                closedCount += 1;
                issuesOut.push({
                    id: Number(id),
                    title: cachedEntry.title || '',
                    labels: labelsFromCache,
                    faseActual: null,
                    faseAbbrev: 'done',
                    faseIdx: -1,
                    denominador: 0,
                    pct: 100,
                    agente: null,
                    status: 'closed',
                    isClosed: true,
                    isBlocked: false,
                    isPaused: false,
                    isStale: false,
                    staleMin: 0,
                    bounces: 0,
                    hasEta: false,
                    etaAbsoluteMs: null,
                });
                continue;
            }
            // Issue sin matriz y sin cerrar → "pendiente" (0%).
            issuesOut.push({
                id: Number(id),
                title: cachedEntry.title || '',
                labels: labelsFromCache,
                faseActual: null,
                faseAbbrev: '—',
                faseIdx: -1,
                denominador: 0,
                pct: 0,
                agente: null,
                status: isBlockedNoMatrix ? 'blocked' : 'pending',
                isClosed: false,
                isBlocked: isBlockedNoMatrix,
                isPaused: false,
                isStale: false,
                staleMin: 0,
                bounces: 0,
                hasEta: false,
                etaAbsoluteMs: null,
            });
            // CA-5/CA-6 — issues sin matriz pero con label de bloqueo / intervención.
            if (isBlockedNoMatrix) {
                blocks.push({ id: Number(id), motivo: labelNamesNoMatrix.has('needs-human') ? 'requiere decisión humana' : 'bloqueado' });
                humanInterventions.push({ id: Number(id), motivo: 'tomar decisión bloqueante' });
            } else if (labelNamesNoMatrix.has('bug-en-pipeline')) {
                humanInterventions.push({ id: Number(id), motivo: 'investigar bug del pipeline' });
            } else if (labelNamesNoMatrix.has('needs-definition')) {
                humanInterventions.push({ id: Number(id), motivo: 'falta promover de needs-definition' });
            }
            continue;
        }

        const { lifecycle, denominador } = pickLifecycle(data);
        const faseIdx = findFaseIdx(lifecycle, data.faseActual);
        // CA-2: pct = (faseIdx + 1) / denominador * 100 — la fase "actual" cuenta
        // como avanzada hasta ahí. Si la fase no aparece en el lifecycle, pct=0.
        let pct = faseIdx >= 0 && denominador > 0
            ? Math.round(((faseIdx + 1) / denominador) * 100)
            : 0;

        // Detección de cierre por presencia de archivo en `entrega/procesado`
        // (todas las fases dev terminadas) o por label `closed`.
        const finalFaseEntries = (data.fases || {})['desarrollo/entrega'] || [];
        const hasEntregaProcesada = finalFaseEntries.some(
            (e) => e.estado === 'procesado' && e.resultado === 'aprobado',
        );
        // #4098 — `state: CLOSED` (cache de títulos o matriz) es fuente
        // autoritativa de cerrado, además del label/archivo de entrega.
        const titleEntry = state.issueTitles && state.issueTitles[id];
        const isClosedFromCache = isClosedState(data) || isClosedState(titleEntry);
        const isClosed = isClosedFromLabel || hasEntregaProcesada || isClosedFromCache;
        if (isClosed) pct = 100;

        const labels = Array.isArray(data.labels) ? data.labels : [];
        const labelNames = new Set(labels.map((l) => (typeof l === 'string' ? l : (l && l.name) || '')).filter(Boolean));

        // CA-5: bloqueos. Fuentes determinísticas:
        //   - blockedByIssue (file system `bloqueado-humano/`)
        //   - label `blocked:dependencies` / `blocked:routing-manual` / `needs-human`
        // #4098 — cerrado gana a bloqueado/pausado: un issue CLOSED no se reporta
        // como bloqueado aunque arrastre un label de bloqueo residual, así no
        // ensucia `blocks`/`humanInterventions` ni se pinta 🛑.
        const blockedHuman = blockedByIssue.get(Number(id));
        const isBlocked = !isClosed && (!!blockedHuman
            || labelNames.has('blocked:dependencies')
            || labelNames.has('blocked:routing-manual')
            || labelNames.has('needs-human'));

        const isPaused = !isClosed && !!labelNames.has('paused');

        // Stale: agente activo sin avance > N min.
        const staleMin = Number(data.staleMin || 0);
        const isStale = !isClosed && !isBlocked && staleMin >= staleThresholdMin;

        // Agente activo: si data.estadoActual === 'trabajando', extraer skill.
        let agente = null;
        if (data.estadoActual === 'trabajando' && data.faseActual && data.fases) {
            const entries = data.fases[data.faseActual] || [];
            const working = entries.find((e) => e.estado === 'trabajando');
            if (working) agente = working.skill || null;
        }

        // ETA por issue — sólo si está activo (no cerrado).
        let etaInfo = { absoluteMs: null, hasEta: false };
        if (!isClosed) {
            etaInfo = computeIssueEta({
                issueData: data,
                etaAverages,
                allFases: lifecycle,
                now,
            });
            if (etaInfo.hasEta && etaInfo.absoluteMs) {
                activeWithEta += 1;
                issueEtas.push({ absoluteMs: etaInfo.absoluteMs });
            } else {
                etasMissing += 1;
            }
        }

        // Status visual con precedencia UX-2.
        const status = classifyStatus({ isClosed, isBlocked, isPaused, faseActual: data.faseActual, pct });

        // CA-3: solo issues activos suman a sumPctActive (los cerrados ya cuentan 100 separados).
        if (isClosed) {
            closedCount += 1;
        } else {
            sumPctActive += pct;
        }

        // Abreviación de fase para móvil (CA-UX render-mobile).
        const faseAbbrev = abbreviateFase(data.faseActual, faseIdx, denominador);

        // Push de issue.
        issuesOut.push({
            id: Number(id),
            title: data.title || '',
            labels: [...labelNames],
            faseActual: data.faseActual || null,
            faseAbbrev,
            faseIdx,
            denominador,
            pct,
            agente,
            status,
            isClosed,
            isBlocked,
            isPaused,
            isStale,
            staleMin,
            bounces: Number(data.bounces || 0),
            hasEta: etaInfo.hasEta,
            etaAbsoluteMs: etaInfo.absoluteMs || null,
        });

        // CA-5: armar línea de bloqueo concreto.
        if (isBlocked) {
            const motivo = buildBlockMotive({ blockedHuman, labelNames, data });
            blocks.push({
                id: Number(id),
                motivo: motivo || 'bloqueado',
            });
        }

        // CA-6: intervención humana — needs-human, bug-en-pipeline, esperando
        // decisión de Leo, sin avance > N minutos.
        if (
            isBlocked
            || isStale
            || labelNames.has('bug-en-pipeline')
            || (labelNames.has('needs-definition') && staleMin >= staleThresholdMin)
        ) {
            humanInterventions.push({
                id: Number(id),
                motivo: buildInterventionMotive({
                    blockedHuman, labelNames, isStale, staleMin, data,
                }),
            });
        }
    }

    // #4075 — Enriquecer bloqueos con dependencias inline. La relación
    // parent→children llega en `opts.blockDependencies` (resuelta por
    // wave-resolver desde `.partial-pause.json` → authorization_ttls). Reusamos
    // el estado de ejecución YA calculado en `issuesOut` (no duplicamos lógica
    // ni agregamos latencia: CA "se resuelve contra la fuente de verdad real").
    const blockDependencies = options.blockDependencies && typeof options.blockDependencies === 'object'
        ? options.blockDependencies
        : {};
    const issueById = new Map(issuesOut.map((i) => [i.id, i]));
    const waveSet = new Set(
        (Array.isArray(wave.issues) ? wave.issues : [])
            .map((n) => Number(n))
            .filter((n) => Number.isInteger(n)),
    );
    for (const blk of blocks) {
        const depIds = Array.isArray(blockDependencies[blk.id]) ? blockDependencies[blk.id] : [];
        if (depIds.length === 0) continue;
        blk.dependencies = depIds.map((depId) => describeDependencyState(depId, {
            issueById,
            waveSet,
            closedSet,
        }));
    }

    // CA-3: % total
    const totalIssues = wave.issues.length;
    const totalPct = totalIssues > 0
        ? Math.round((closedCount * 100 + sumPctActive) / totalIssues)
        : 0;

    // CA-4: ETA absoluto (max sobre activos con eta).
    const etaAbsoluteMs = computeLaneEmptyEta(issueEtas);
    const etaAvailable = etaAbsoluteMs !== null;

    return {
        waveLabel: wave.label,
        waveSource: wave.source,
        waveOpenedAt: wave.openedAt || null,
        totalIssues,
        closedCount,
        activeCount: totalIssues - closedCount,
        totalPct,
        etaAbsoluteMs: etaAvailable ? etaAbsoluteMs : null,
        etaAvailable,
        etasMissing,           // CA-4: cuántos activos no tienen estimación
        activeWithEta,
        issues: issuesOut,
        blocks,
        humanInterventions,
        // Metadata útil para el renderer.
        generatedAt: now,
        staleThresholdMin,
    };
}

/**
 * Abrevia la fase para tablas estrechas (CA-UX render-mobile).
 * "desarrollo/verificacion" → "verif (4/7)" si tiene metadata de avance.
 */
function abbreviateFase(faseActual, faseIdx, denominador) {
    if (!faseActual) return '—';
    const parts = faseActual.split('/');
    const fase = parts[parts.length - 1] || faseActual;
    const ABREV = {
        analisis: 'an',
        criterios: 'crit',
        sizing: 'siz',
        validacion: 'val',
        dev: 'dev',
        build: 'build',
        verificacion: 'verif',
        linteo: 'lint',
        aprobacion: 'aprob',
        entrega: 'deliv',
    };
    const abbr = ABREV[fase] || fase.slice(0, 5);
    if (faseIdx >= 0 && denominador > 0) {
        return `${abbr} (${faseIdx + 1}/${denominador})`;
    }
    return abbr;
}

/**
 * Microcopy de motivo de bloqueo (CA-UX-3).
 * Formato: "<causa concreta>" — sin verbos genéricos tipo "esperando".
 */
function buildBlockMotive({ blockedHuman, labelNames, data }) {
    if (blockedHuman && (blockedHuman.reason || blockedHuman.question)) {
        const reason = (blockedHuman.reason || blockedHuman.question || '').trim();
        // Si el reason menciona un issue (`#1234`), úsalo en la respuesta tal cual.
        const truncated = reason.slice(0, 100);
        return truncated;
    }
    if (labelNames.has('blocked:dependencies')) {
        // Si el data trae `motivo_rechazo` y menciona un issue padre/hijo, lo usamos.
        if (data.motivo_rechazo && /#\d+/.test(data.motivo_rechazo)) {
            const match = data.motivo_rechazo.match(/#(\d+)/);
            return `espera cierre de #${match[1]}`;
        }
        return 'dependencias abiertas en GitHub';
    }
    if (labelNames.has('blocked:routing-manual')) {
        return 'routing manual sin agente asignado';
    }
    if (labelNames.has('needs-human')) {
        return 'requiere decisión humana';
    }
    return 'bloqueado';
}

/**
 * Microcopy de intervención humana (CA-UX-4).
 * Formato: "<acción esperada de Leo>" con verbo claro.
 */
function buildInterventionMotive({ blockedHuman, labelNames, isStale, staleMin, data }) {
    if (blockedHuman && blockedHuman.question) {
        return blockedHuman.question.slice(0, 120);
    }
    if (blockedHuman && blockedHuman.reason) {
        return `responder: ${blockedHuman.reason.slice(0, 100)}`;
    }
    if (labelNames.has('bug-en-pipeline')) {
        return 'investigar bug del pipeline';
    }
    if (labelNames.has('needs-human')) {
        return 'tomar decisión bloqueante';
    }
    if (labelNames.has('needs-definition') && staleMin > 0) {
        return `falta promover de needs-definition (${formatStale(staleMin)} sin acción)`;
    }
    if (isStale) {
        return `sin avance hace ${formatStale(staleMin)}`;
    }
    return 'revisar estado';
}

/**
 * #4075 — Describe el estado de ejecución de una dependencia para el render
 * inline de bloqueos. Distingue si la dependencia está DENTRO de la ola
 * (presente en la allowlist → `waveSet`) o FUERA, y su estado actual:
 *
 *   - En ola + cerrada       → "en ola, cerrado"
 *   - En ola + activa         → "en ola, <fase> <idx/denom>"  (ej. "en ola, dev 5/10")
 *   - En ola + sin fase       → "en ola, pendiente"
 *   - Fuera de ola            → "fuera de ola, abierto|cerrado"  (best-effort)
 *
 * El estado de la dependencia se toma del `issueById` (el mismo `issuesOut` que
 * ya se calculó para la tabla principal). Para dependencias fuera de la ola no
 * tenemos su fase (no se computa su matriz), así que sólo distinguimos
 * abierto/cerrado con la info disponible (`closedSet`).
 *
 * @param {number} depId
 * @param {{issueById: Map, waveSet: Set, closedSet: Set}} ctx
 * @returns {{id: number, inWave: boolean, isClosed: boolean, statusText: string}}
 */
function describeDependencyState(depId, ctx) {
    const id = Number(depId);
    const inWave = ctx.waveSet.has(id);
    if (inWave) {
        const issue = ctx.issueById.get(id);
        if (issue && issue.isClosed) {
            return { id, inWave: true, isClosed: true, statusText: 'en ola, cerrado' };
        }
        if (issue && issue.faseAbbrev && issue.faseAbbrev !== '—') {
            // "dev (5/10)" → "dev 5/10" (sin paréntesis para no colisionar con
            // los del clause "#NNNN (…)" en el render).
            const faseText = issue.faseAbbrev.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
            return { id, inWave: true, isClosed: false, statusText: `en ola, ${faseText}` };
        }
        return { id, inWave: true, isClosed: false, statusText: 'en ola, pendiente' };
    }
    const isClosed = ctx.closedSet.has(id);
    return {
        id,
        inWave: false,
        isClosed,
        statusText: `fuera de ola, ${isClosed ? 'cerrado' : 'abierto'}`,
    };
}

function formatStale(min) {
    if (!Number.isFinite(min) || min <= 0) return '0m';
    if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (m === 0) return `${h}h`;
    return `${h}h${m}m`;
}

module.exports = {
    buildWaveSnapshot,
    isClosedState,
    LIFECYCLE_FULL,
    LIFECYCLE_DEV_ONLY,
    DEFAULT_STALE_THRESHOLD_MIN,
    _internal: {
        pickLifecycle,
        findFaseIdx,
        isClosedState,
        classifyStatus,
        abbreviateFase,
        buildBlockMotive,
        buildInterventionMotive,
        describeDependencyState,
        formatStale,
    },
};
