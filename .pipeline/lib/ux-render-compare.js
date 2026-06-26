'use strict';

// -----------------------------------------------------------------------------
// ux-render-compare.js — Gate de validación UX: render real vs mockup aprobado.
//
// Issue #4228 (parte de #4227). Refuerza el gate de validación UX para que
// compare el render final implementado contra el mockup aprobado del issue y
// rebote a dev ante divergencias visibles relevantes, en lugar de aprobar por
// criterios genéricos.
//
// Este módulo concentra la lógica DETERMINÍSTICA del gate:
//   - Resolver el mockup de referencia (body del issue + assets locales).
//   - Capturar el render real (delegado a screenshot-capture.js, puerto 3200).
//   - Decidir el veredicto pasa/rechaza a partir de las divergencias que
//     clasifica el agente vision-capable.
//   - Manejar la degradación (dashboard caído): NO aprobar a ciegas.
//
// La comparación visual en sí (juicio "estas dos imágenes divergen") la hace el
// agente UX que es vision-capable; este módulo le arma el andamiaje y aplica la
// regla de decisión de forma testeable. Un diff pixel-perfect (pixelmatch/sharp)
// es un refinamiento futuro, no un blocker (ver análisis técnico del issue).
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const { extractSectionSlice, truncateBody } = require('./qa-evidence-gate');
const screenshotCapture = require('./screenshot-capture');

// -----------------------------------------------------------------------------
// Severidades de divergencia
// -----------------------------------------------------------------------------

// Orden de mayor a menor relevancia. El umbral por default ('media') bloquea
// las divergencias 'visibles relevantes' (critica/alta/media) y deja pasar las
// puramente cosméticas (baja).
const SEVERITIES = ['critica', 'alta', 'media', 'baja'];
const DEFAULT_BLOCKING_THRESHOLD = 'media';

// Marker estable para grep en logs / comments idempotentes.
const EVIDENCE_MARKER = '<!-- ux-render-compare:4228 -->';

// Patrón de imágenes markdown — replica el de qa-evidence-gate sin exponerlo,
// para no acoplar al detalle interno de ese módulo.
const IMAGE_MD_RE = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
const MAX_REFS = 20;

// -----------------------------------------------------------------------------
// Resolución del mockup de referencia
// -----------------------------------------------------------------------------

/**
 * Extrae las referencias de imagen de la sección `## Screenshots & Mockups`
 * del body del issue. Distingue heurísticamente la imagen "esperado" (mockup)
 * de la "actual" mirando el alt-text.
 *
 * @param {string} body — body crudo del issue (markdown).
 * @returns {{ all: string[], mockups: string[], reason: string }}
 */
function extractMockupRefs(body) {
    const truncated = truncateBody(body);
    if (!truncated) {
        return { all: [], mockups: [], reason: 'empty-body' };
    }
    const slice = extractSectionSlice(truncated);
    if (slice === null) {
        return { all: [], mockups: [], reason: 'section-missing' };
    }

    const all = [];
    const mockups = [];
    IMAGE_MD_RE.lastIndex = 0;
    let m;
    while ((m = IMAGE_MD_RE.exec(slice)) !== null && all.length < MAX_REFS) {
        const url = m[1];
        const alt = m[0].slice(2, m[0].indexOf(']')).toLowerCase();
        all.push(url);
        // El mockup "esperado" se marca con alt-text que lo identifica.
        if (/esperad|mockup|propuest|disen|diseñ|target/.test(alt)) {
            mockups.push(url);
        }
        if (IMAGE_MD_RE.lastIndex === m.index) IMAGE_MD_RE.lastIndex += 1;
    }

    if (all.length === 0) {
        return { all, mockups, reason: 'no-images' };
    }
    return { all, mockups, reason: 'ok' };
}

/**
 * Busca mockups locales en `.pipeline/assets/mockups/{issue}/`.
 *
 * @param {string|number} issue
 * @param {string} repoRoot
 * @returns {string[]} paths absolutos a los assets encontrados (png/svg)
 */
function resolveLocalMockups(issue, repoRoot) {
    const safeIssue = String(issue).replace(/[^0-9]/g, '');
    if (!safeIssue) return [];
    const dir = path.join(repoRoot, '.pipeline', 'assets', 'mockups', safeIssue);
    let entries;
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return entries
        .filter((f) => /\.(png|svg)$/i.test(f))
        .map((f) => path.join(dir, f));
}

/**
 * Resuelve la referencia de mockup combinando el body del issue y los assets
 * locales. Devuelve un objeto con la fuente elegida y motivo.
 *
 * @param {object} opts
 * @param {string} opts.body — body del issue
 * @param {string|number} opts.issue
 * @param {string} opts.repoRoot
 * @returns {{ ok: boolean, source: string, refs: string[], reason: string }}
 */
function resolveMockupReference(opts = {}) {
    const { body = '', issue, repoRoot = process.cwd() } = opts;

    const fromBody = extractMockupRefs(body);
    // Preferimos las marcadas como "esperado"; si no hay, usamos todas las del body.
    const bodyRefs = fromBody.mockups.length > 0 ? fromBody.mockups : fromBody.all;

    if (bodyRefs.length > 0) {
        return { ok: true, source: 'issue-body', refs: bodyRefs, reason: 'ok' };
    }

    const localRefs = resolveLocalMockups(issue, repoRoot);
    if (localRefs.length > 0) {
        return { ok: true, source: 'local-assets', refs: localRefs, reason: 'ok' };
    }

    // Sin mockup no se puede comparar — el gate no debe aprobar a ciegas.
    return {
        ok: false,
        source: 'none',
        refs: [],
        reason: fromBody.reason === 'ok' ? 'no-mockup-ref' : fromBody.reason,
    };
}

// -----------------------------------------------------------------------------
// Captura del render real
// -----------------------------------------------------------------------------

/**
 * Captura el render real del dashboard (puerto 3200) delegando en
 * screenshot-capture.capture(). Normaliza el resultado.
 *
 * @param {object} opts
 * @param {string} opts.outputPath
 * @param {string} opts.allowedRoot
 * @param {string} [opts.dashboardPath='/']
 * @param {Function} [opts._capture] — DI para tests
 * @returns {Promise<{ ok: boolean, outputPath?: string, reason?: string, detail?: string }>}
 */
async function captureCurrentRender(opts = {}) {
    const capture = opts._capture || screenshotCapture.capture;
    try {
        const result = await capture({
            outputPath: opts.outputPath,
            allowedRoot: opts.allowedRoot,
            dashboardPath: opts.dashboardPath || '/',
        });
        return result;
    } catch (e) {
        // capture() sólo tira por validación de input (path traversal, etc).
        return { ok: false, reason: 'capture-input-error', detail: String((e && e.message) || e) };
    }
}

/**
 * Clasifica una degradación de captura para la lógica de veredicto.
 * Distingue las causas de infra (no es culpa de dev) de las verificables.
 *
 * @param {{ ok: boolean, reason?: string }} captureResult
 * @returns {{ degraded: boolean, infra: boolean, reason: string|null }}
 */
function classifyDegradation(captureResult) {
    if (captureResult && captureResult.ok) {
        return { degraded: false, infra: false, reason: null };
    }
    const reason = (captureResult && captureResult.reason) || 'unknown';
    // dashboard-down / timeout / puppeteer-missing / mkdir-failed son infra:
    // impiden verificar pero no implican defecto del dev.
    const infraReasons = new Set([
        'dashboard-down',
        'timeout',
        'puppeteer-missing',
        'mkdir-failed',
        'capture-input-error',
        'unknown',
    ]);
    return { degraded: true, infra: infraReasons.has(reason), reason };
}

// -----------------------------------------------------------------------------
// Regla de decisión del veredicto
// -----------------------------------------------------------------------------

/**
 * Normaliza una severidad arbitraria a una de SEVERITIES; default 'media'
 * (conservador: ante duda, bloquea).
 */
function normalizeSeverity(value) {
    const v = String(value || '').trim().toLowerCase();
    return SEVERITIES.includes(v) ? v : 'media';
}

/**
 * ¿La severidad alcanza el umbral de bloqueo? (>= threshold en relevancia)
 */
function isBlocking(severity, threshold) {
    const sIdx = SEVERITIES.indexOf(normalizeSeverity(severity));
    const tIdx = SEVERITIES.indexOf(normalizeSeverity(threshold));
    // Índice menor = más relevante. Bloquea si es igual o más relevante que el umbral.
    return sIdx <= tIdx;
}

/**
 * Decide el veredicto del gate a partir de las divergencias clasificadas por el
 * agente vision y el estado de captura.
 *
 * Reglas (en orden):
 *   1. Si no hay mockup de referencia → no-verificable (NO aprobar).
 *   2. Si la captura está degradada → no-verificable (NO aprobar a ciegas).
 *   3. Si hay >=1 divergencia que alcanza el umbral de bloqueo → rechazado (rebote a dev).
 *   4. Si no → aprobado (con nota de divergencias menores si las hay).
 *
 * @param {object} opts
 * @param {Array<{aspecto?:string,descripcion?:string,severidad?:string}>} [opts.divergences=[]]
 * @param {boolean} [opts.mockupResolved=true]
 * @param {{degraded:boolean,infra:boolean,reason:string|null}} [opts.degradation]
 * @param {string} [opts.threshold='media']
 * @returns {{ resultado: 'aprobado'|'rechazado', causa: string, motivo: string, blocking: Array, menores: Array }}
 */
function decideVerdict(opts = {}) {
    const divergences = Array.isArray(opts.divergences) ? opts.divergences : [];
    const threshold = opts.threshold || DEFAULT_BLOCKING_THRESHOLD;
    const degradation = opts.degradation || { degraded: false, infra: false, reason: null };
    const mockupResolved = opts.mockupResolved !== false;

    // 1. Sin mockup → no se puede comparar. No aprobar.
    if (!mockupResolved) {
        return {
            resultado: 'rechazado',
            causa: 'sin-mockup',
            motivo:
                'No se encontró mockup de referencia (ni en la sección "## Screenshots & Mockups" ' +
                'del issue ni en .pipeline/assets/mockups/<issue>/). El gate no aprueba sin algo ' +
                'contra qué comparar: adjuntar el mockup aprobado y reprocesar.',
            blocking: [],
            menores: [],
        };
    }

    // 2. Captura degradada → no-verificable. No aprobar a ciegas.
    if (degradation.degraded) {
        const infraNote = degradation.infra
            ? ' Es una degradación de infra (no necesariamente defecto del dev): asegurar que el ' +
              'dashboard esté levantado en el puerto 3200 (node .pipeline/dashboard.js) y reprocesar.'
            : '';
        return {
            resultado: 'rechazado',
            causa: 'no-verificable',
            motivo:
                `No se pudo capturar el render real para comparar (motivo: ${degradation.reason}). ` +
                'El gate de validación UX no aprueba sin evidencia comparativa.' +
                infraNote,
            blocking: [],
            menores: [],
        };
    }

    // 3/4. Particionar divergencias por umbral.
    const blocking = divergences.filter((d) => isBlocking(d && d.severidad, threshold));
    const menores = divergences.filter((d) => !isBlocking(d && d.severidad, threshold));

    if (blocking.length > 0) {
        const detalle = blocking
            .map((d, i) => `  ${i + 1}. [${normalizeSeverity(d.severidad)}] ${d.aspecto ? d.aspecto + ': ' : ''}${d.descripcion || ''}`.trimEnd())
            .join('\n');
        return {
            resultado: 'rechazado',
            causa: 'divergencia',
            motivo:
                `El render final diverge del mockup aprobado en ${blocking.length} aspecto(s) ` +
                `visible(s) relevante(s) (umbral: ${threshold}):\n${detalle}\n` +
                'Rebote a dev para alinear la implementación con el mockup. Evidencia comparativa adjunta.',
            blocking,
            menores,
        };
    }

    const notaMenores =
        menores.length > 0
            ? ` Divergencias menores (no bloqueantes) registradas: ${menores.length}.`
            : '';
    return {
        resultado: 'aprobado',
        causa: 'coincide',
        motivo:
            'El render final coincide con el mockup aprobado dentro del umbral de tolerancia.' +
            notaMenores +
            ' Evidencia comparativa adjunta como artefacto de la fase.',
        blocking: [],
        menores,
    };
}

// -----------------------------------------------------------------------------
// Evidencia
// -----------------------------------------------------------------------------

/**
 * Construye (y crea) el directorio de evidencia issue-scoped.
 *
 * @param {string|number} issue
 * @param {string} repoRoot
 * @returns {string} path absoluto al directorio de evidencia
 */
function evidenceDir(issue, repoRoot = process.cwd()) {
    const safeIssue = String(issue).replace(/[^0-9]/g, '') || 'unknown';
    const dir = path.join(repoRoot, '.pipeline', 'assets', 'mockups', safeIssue, 'validacion');
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch {
        /* best-effort: el caller maneja la ausencia */
    }
    return dir;
}

module.exports = {
    // constantes
    SEVERITIES,
    DEFAULT_BLOCKING_THRESHOLD,
    EVIDENCE_MARKER,
    // resolución de mockup
    extractMockupRefs,
    resolveLocalMockups,
    resolveMockupReference,
    // captura
    captureCurrentRender,
    classifyDegradation,
    // veredicto
    normalizeSeverity,
    isBlocking,
    decideVerdict,
    // evidencia
    evidenceDir,
};
