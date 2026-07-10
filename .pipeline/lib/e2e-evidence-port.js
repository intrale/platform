// =============================================================================
// e2e-evidence-port.js — Puerto `e2e` del contrato kernel↔adaptador (#4573)
//
// Implementa la firma del puerto `e2e` definido en
// `docs/pipeline/contrato-kernel-adaptador.md` §3 (~L221):
//
//     { workItemRef, artefacto empaquetado, entorno objetivo }
//        → { status: ok|failed|skipped, artifacts[], diagnostics[], manifest }
//
// Los errores se modelan como DATOS en el resultado (`status:'failed'` +
// `diagnostics`), nunca como excepciones que crucen la frontera del puerto.
//
// Rol en el sistema
// -----------------
// Es el PRODUCTOR de evidencia que consume GATE 2 (#4574). GATE 2 confía en la
// evidencia para aprobar/bloquear; por eso el corazón de este módulo es que la
// representatividad sea VERIFICABLE, no auto-declarada (§10.3 del diseño):
//   - Frescura: derivada del `mtime` real del artefacto, jamás un campo que el
//     agente escribe a mano.
//   - Viewport efectivo: leído del browser por `screenshot-capture` (no el
//     valor pedido).
//   - Hash SHA-256: integridad / detección de manipulación posterior.
//   - Estado capturado: declarado (happy/error/empty), no solo happy-path.
//
// Tiered / lazy
// -------------
//   - Tier 1 (siempre, barato): render-vs-mockup del dashboard vía
//     `screenshot-capture` (`capture` + `renderHtmlToPng`).
//   - Tier 2 (lazy, caro): evidencia de producto (APK/emulador/video). Sólo se
//     dispara si el issue lo requiere (label `app:*` + criterio no verificable
//     por máquina) Y el adaptador declara la capability. Si no aplica →
//     `skipped` con razón explícita en el manifest.
//
// Seguridad (checklist del auditor `security` en el issue)
//   - SSRF (A10): no acepta URL/host/path dinámico; toda vista validada contra
//     `ALLOWED_PATHS` de `screenshot-capture` en código.
//   - Path traversal (A01): todo path de salida vía `resolveSafeOutputPath` con
//     `allowedRoot` fijo.
//   - Inyección de comandos (A03): Tier 2 usa `spawn(cmd, [args])` con `issue`
//     validado `^\d+$` y `flavor` contra allowlist — nunca shell string.
//   - Anti-zombi: timeout explícito + cleanup en `finally` en Tier 2.
//
// Feature-flag `PIPELINE_E2E_EVIDENCE_ENABLED` (default `0`), patrón espejo de
// `visual-gate.js` — kill-switch sin redeploy. Módulo nuevo, sin breaking
// changes: sólo reusa y extiende building blocks ya en `main`.
// =============================================================================

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const {
    capture,
    renderHtmlToPng,
    resolveSafeOutputPath,
    ALLOWED_PATHS,
    DEFAULT_VIEWPORT,
} = require('./screenshot-capture');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

const E2E_EVIDENCE_ENV = 'PIPELINE_E2E_EVIDENCE_ENABLED';

const MANIFEST_VERSION = '1.0.0';

// Estados de captura declarables (CA-6 · §10.3 no-solo-happy-path).
const CAPTURED_STATES = Object.freeze(['happy', 'error', 'empty']);

// Allowlist de flavors del producto (CA-7 / A03 — anti inyección de comando).
const FLAVORS = Object.freeze(['client', 'business', 'delivery']);

// Patrón estricto para el número de issue antes de pasarlo a un proceso (A03).
const ISSUE_RE = /^\d+$/;

// Timeout por defecto de la etapa Tier 2 (anti-zombi, coherente con /ghostbusters).
const TIER2_TIMEOUT_MS = 20 * 60 * 1000; // 20 min: build + emulador + screenrecord

// -----------------------------------------------------------------------------
// Feature-flag (patrón visual-gate.js:56)
// -----------------------------------------------------------------------------

/**
 * Devuelve true si `PIPELINE_E2E_EVIDENCE_ENABLED` está activo.
 * Se puede pasar `env` para testear sin tocar `process.env` real.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
    return String(env[E2E_EVIDENCE_ENV] || '0').trim() === '1';
}

// -----------------------------------------------------------------------------
// Representatividad — derivada, nunca auto-declarada (CA-2 / CA-3 / CA-4)
// -----------------------------------------------------------------------------

/**
 * Hash SHA-256 del artefacto (integridad, anti-manipulación · CA-4).
 * Lee los bytes del archivo: el hash cambia sí o sí cuando cambia el input.
 *
 * @param {string} filePath
 * @returns {string} 'sha256:<hex>'
 */
function sha256File(filePath) {
    const buf = fs.readFileSync(filePath);
    return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Frescura DERIVADA del `mtime` real del archivo (CA-2 / CA-3). Nunca acepta un
 * timestamp por parámetro: si el agente inyecta una fecha falsa, este helper la
 * ignora porque lee el filesystem. GATE 2 compara este valor contra el HEAD del
 * PR para rechazar evidencia stale.
 *
 * @param {string} filePath
 * @returns {string} ISO-8601
 */
function deriveFreshness(filePath) {
    return fs.statSync(filePath).mtime.toISOString();
}

/**
 * Normaliza el estado capturado declarado (CA-6). Tira si el valor no es uno de
 * los declarables — forzar honestidad en la declaración. La ausencia default a
 * `'happy'` (compat con el flujo actual, que sólo capturaba la pantalla feliz).
 *
 * @param {string} [state]
 * @returns {'happy'|'error'|'empty'}
 */
function normalizeCapturedState(state) {
    if (state == null) return 'happy';
    if (!CAPTURED_STATES.includes(state)) {
        throw new Error(`e2e-evidence-port: capturedState inválido (${state}); permitidos=${CAPTURED_STATES.join('|')}`);
    }
    return state;
}

/**
 * Construye una entrada de artefacto del manifest con los 4 campos de
 * representatividad (CA-2). Frescura y hash se DERIVAN del archivo real — el
 * único dato que el caller declara es `capturedState` (y se valida). El
 * `viewport` es el efectivo leído del browser por `screenshot-capture`.
 *
 * IMPORTANTE (anti-falsificación): si `meta` trae un campo `freshness` o `hash`,
 * se ignora deliberadamente — siempre se recalculan desde el filesystem.
 *
 * @param {string} outputPath — path del artefacto ya escrito
 * @param {Object} meta
 * @param {{width:number,height:number}} [meta.viewport] — viewport efectivo
 * @param {string} [meta.capturedState] — happy|error|empty
 * @param {string} [meta.kind] — 'render' | 'mockup' | 'video' | 'apk' ...
 * @returns {Object} entrada de artefacto
 */
function buildArtifactEntry(outputPath, meta = {}) {
    const viewport = meta.viewport && Number.isFinite(meta.viewport.width) && Number.isFinite(meta.viewport.height)
        ? { width: meta.viewport.width, height: meta.viewport.height }
        : null;
    return {
        kind: typeof meta.kind === 'string' ? meta.kind : 'artifact',
        path: outputPath,
        freshness: deriveFreshness(outputPath), // mtime REAL, no inyectable (CA-2/CA-3)
        viewport,                                // efectivo, leído del browser (CA-2)
        hash: sha256File(outputPath),            // SHA-256 (CA-4, integridad)
        capturedState: normalizeCapturedState(meta.capturedState), // CA-6
    };
}

/**
 * Ensambla el manifest completo de una corrida del puerto.
 *
 * @param {Object} parts
 * @param {Object} parts.workItemRef
 * @param {Object} parts.tier1 — { status, artifacts[], diagnostics[] }
 * @param {Object} parts.tier2 — { status, reason?, artifacts[] }
 * @returns {Object} manifest
 */
function buildManifest({ workItemRef = {}, tier1 = {}, tier2 = {} } = {}) {
    return {
        version: MANIFEST_VERSION,
        port: 'e2e',
        workItemRef: {
            issue: workItemRef.issue != null ? String(workItemRef.issue) : null,
            type: workItemRef.type || null,
        },
        tier1: {
            status: tier1.status || 'skipped',
            artifacts: Array.isArray(tier1.artifacts) ? tier1.artifacts : [],
            diagnostics: Array.isArray(tier1.diagnostics) ? tier1.diagnostics : [],
        },
        tier2: {
            status: tier2.status || 'skipped',
            reason: tier2.reason || null,
            artifacts: Array.isArray(tier2.artifacts) ? tier2.artifacts : [],
            // Extras opcionales de Tier 2 cuando queda `ready` (comando validado
            // a ejecutar por el runner del pipeline + timeout anti-zombi).
            ...(tier2.command ? { command: tier2.command } : {}),
            ...(tier2.timeoutMs ? { timeoutMs: tier2.timeoutMs } : {}),
        },
    };
}

// -----------------------------------------------------------------------------
// Decisión tiered / lazy (CA-5)
// -----------------------------------------------------------------------------

/**
 * Normaliza un label (string o {name}) y le saca el prefijo `app:`.
 * @param {string|{name:string}} l
 * @returns {string}
 */
function bareFlavorLabel(l) {
    const name = typeof l === 'string'
        ? l
        : (l && typeof l === 'object' && typeof l.name === 'string' ? l.name : '');
    return name.replace(/^app:/, '').toLowerCase();
}

/**
 * Decide si Tier 2 (APK/emulador/video, caro) debe dispararse (CA-5).
 * Sólo si: el adaptador declara la capability `e2e` Y el issue tiene un label
 * `app:client|business|delivery` Y hay al menos un criterio no verificable por
 * máquina (que un test unitario no cubre). En cualquier otro caso, Tier 2 se
 * resuelve como `skipped` con razón.
 *
 * @param {Object} opts
 * @param {Array} [opts.labels]
 * @param {boolean} [opts.hasNonMachineCriteria]
 * @param {{e2e?:boolean}} [opts.adapterCapability]
 * @returns {boolean}
 */
function shouldTriggerTier2({ labels, hasNonMachineCriteria, adapterCapability } = {}) {
    const hasAppLabel = (Array.isArray(labels) ? labels : [])
        .some((l) => FLAVORS.includes(bareFlavorLabel(l)));
    return Boolean(adapterCapability && adapterCapability.e2e)
        && hasAppLabel
        && Boolean(hasNonMachineCriteria);
}

/**
 * Explica por qué NO se dispara Tier 2 (para el manifest). Devuelve null si
 * SÍ debería dispararse.
 *
 * @param {Object} opts — mismos que shouldTriggerTier2
 * @returns {string|null}
 */
function tier2SkipReason(opts = {}) {
    if (shouldTriggerTier2(opts)) return null;
    const { labels, hasNonMachineCriteria, adapterCapability } = opts;
    if (!(adapterCapability && adapterCapability.e2e)) {
        return 'adaptador no declara la capability e2e';
    }
    const hasAppLabel = (Array.isArray(labels) ? labels : [])
        .some((l) => FLAVORS.includes(bareFlavorLabel(l)));
    if (!hasAppLabel) {
        return 'issue sin label app:client|business|delivery (sin superficie de producto)';
    }
    if (!hasNonMachineCriteria) {
        return 'sin criterio no verificable por máquina (tests unitarios alcanzan)';
    }
    return 'no aplica';
}

// -----------------------------------------------------------------------------
// Tier 2 — construcción segura del comando (CA-7 / A03)
// -----------------------------------------------------------------------------

/**
 * Construye el comando de build del APK como ARRAY de argumentos, nunca shell
 * string. Valida `issue` (`^\d+$`) y `flavor` (allowlist) ANTES de devolver —
 * si algo no calza, tira `Error` (el caller lo modela como `status:'failed'`).
 *
 * @param {Object} opts
 * @param {string|number} opts.issue
 * @param {string} opts.flavor — client|business|delivery
 * @returns {{cmd:string, args:string[]}}
 */
function buildTier2Command({ issue, flavor } = {}) {
    const issueStr = String(issue);
    if (!ISSUE_RE.test(issueStr)) {
        throw new Error(`e2e-evidence-port: issue inválido (${issueStr}); esperado ^\\d+$`);
    }
    if (!FLAVORS.includes(flavor)) {
        throw new Error(`e2e-evidence-port: flavor inválido (${flavor}); permitidos=${FLAVORS.join('|')}`);
    }
    // Capitaliza el flavor para la tarea gradle (assembleClientDebug, etc.).
    const cap = flavor.charAt(0).toUpperCase() + flavor.slice(1);
    return {
        cmd: './gradlew',
        args: [`:app:composeApp:assemble${cap}Debug`, '--no-daemon'],
    };
}

// -----------------------------------------------------------------------------
// Validación anti-SSRF de la vista del dashboard (CA-7 / A10)
// -----------------------------------------------------------------------------

/**
 * Asegura que la vista pedida esté en la allowlist de `screenshot-capture`.
 * El puerto NUNCA acepta URL/host/path dinámico: para capturar una ruta nueva
 * se agrega a `ALLOWED_PATHS` en código, no por parámetro.
 *
 * @param {string} view — path del dashboard ('/', '/v3', ...)
 * @returns {string} la misma vista si es válida
 */
function assertAllowedView(view) {
    const v = typeof view === 'string' && view.length > 0 ? view : '/';
    if (!ALLOWED_PATHS.includes(v)) {
        throw new Error(`e2e-evidence-port: vista no autorizada (${v}); allowed=${ALLOWED_PATHS.join(',')}`);
    }
    return v;
}

// -----------------------------------------------------------------------------
// Puerto `e2e` — entrada principal
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} E2eResult
 * @property {'ok'|'failed'|'skipped'} status
 * @property {Array} artifacts — entradas de artefacto del manifest
 * @property {Array<string>} diagnostics
 * @property {Object} manifest — corazón de la representatividad (CA-2)
 * @property {string} [reason] — set cuando status='skipped'
 */

/**
 * Ejecuta el puerto `e2e` (#4573). Genera evidencia render-vs-mockup del
 * dashboard (Tier 1, siempre) y, si aplica, evidencia de producto (Tier 2,
 * lazy). Devuelve un resultado estructurado; los errores se modelan como datos.
 *
 * @param {Object} opts
 * @param {Object} opts.workItemRef — { issue, type, labels }
 * @param {Object} [opts.artefacto] — { dashboardView, mockupHtml, capturedState, viewport }
 * @param {Object} [opts.entornoObjetivo] — { adapterCapability, hasNonMachineCriteria, flavor }
 * @param {string} opts.allowedRoot — root fijo de escritura (CA-7 / A01)
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.renderOutputPath='render.png']
 * @param {string} [opts.mockupOutputPath='mockup.png']
 * @param {Function} [opts._capture] — DI para tests
 * @param {Function} [opts._renderHtmlToPng] — DI para tests
 * @returns {Promise<E2eResult>}
 */
async function runE2eEvidence(opts = {}) {
    const {
        workItemRef = {},
        artefacto = {},
        entornoObjetivo = {},
        allowedRoot,
        env = process.env,
        renderOutputPath = 'render.png',
        mockupOutputPath = 'mockup.png',
        _capture = capture,
        _renderHtmlToPng = renderHtmlToPng,
    } = opts;

    const labels = workItemRef.labels || [];
    const diagnostics = [];

    // Kill-switch (CA-8): si el flag está off, no producimos evidencia.
    if (!isEnabled(env)) {
        const manifest = buildManifest({
            workItemRef,
            tier1: { status: 'skipped', diagnostics: [`${E2E_EVIDENCE_ENV} != 1`] },
            tier2: { status: 'skipped', reason: 'flag-off' },
        });
        return { status: 'skipped', reason: 'flag-off', artifacts: [], diagnostics: [`${E2E_EVIDENCE_ENV} != 1`], manifest };
    }

    if (typeof allowedRoot !== 'string' || allowedRoot.length === 0) {
        const manifest = buildManifest({ workItemRef });
        return { status: 'failed', artifacts: [], diagnostics: ['allowedRoot requerido'], manifest };
    }

    const tier1Artifacts = [];
    const tier1Diagnostics = [];
    let tier1Status = 'ok';

    // -- Tier 1: render-vs-mockup del dashboard (CA-1) -------------------------
    try {
        const view = assertAllowedView(artefacto.dashboardView);
        const viewport = artefacto.viewport || DEFAULT_VIEWPORT;
        const capturedState = artefacto.capturedState; // validado en buildArtifactEntry

        // (a) Render real del dashboard.
        const renderRes = await _capture({
            outputPath: renderOutputPath,
            allowedRoot,
            dashboardPath: view,
            viewport,
        });
        if (renderRes && renderRes.ok) {
            tier1Artifacts.push(buildArtifactEntry(renderRes.outputPath, {
                kind: 'render',
                viewport: renderRes.effectiveViewport || viewport,
                capturedState,
            }));
        } else {
            tier1Status = 'failed';
            tier1Diagnostics.push(`render: ${(renderRes && renderRes.reason) || 'unknown'}`);
        }

        // (b) Render del mockup (HTML no confiable del LLM → JS deshabilitado).
        if (typeof artefacto.mockupHtml === 'string' && artefacto.mockupHtml.length > 0) {
            const mockupRes = await _renderHtmlToPng({
                html: artefacto.mockupHtml,
                outputPath: mockupOutputPath,
                allowedRoot,
                viewport,
            });
            if (mockupRes && mockupRes.ok) {
                tier1Artifacts.push(buildArtifactEntry(mockupRes.outputPath, {
                    kind: 'mockup',
                    viewport: mockupRes.effectiveViewport || viewport,
                    capturedState,
                }));
            } else {
                tier1Status = 'failed';
                tier1Diagnostics.push(`mockup: ${(mockupRes && mockupRes.reason) || 'unknown'}`);
            }
        }
    } catch (e) {
        // Input malicioso (SSRF/traversal) o capturedState inválido → dato, no throw.
        tier1Status = 'failed';
        tier1Diagnostics.push(String((e && e.message) || e));
    }

    // -- Tier 2: producto (APK/emulador/video), lazy (CA-5) --------------------
    const tier2Decision = {
        labels,
        hasNonMachineCriteria: Boolean(entornoObjetivo.hasNonMachineCriteria),
        adapterCapability: entornoObjetivo.adapterCapability,
    };
    let tier2;
    if (shouldTriggerTier2(tier2Decision)) {
        // Se dispara: construir el comando de forma segura. La ejecución real
        // (spawn con timeout + cleanup en finally) la orquesta el runner del
        // pipeline; acá dejamos el comando validado y el estado listo.
        try {
            const cmd = buildTier2Command({ issue: workItemRef.issue, flavor: entornoObjetivo.flavor });
            tier2 = {
                status: 'ready',
                reason: null,
                command: cmd,
                timeoutMs: TIER2_TIMEOUT_MS,
                artifacts: [],
            };
        } catch (e) {
            tier2 = { status: 'failed', reason: String((e && e.message) || e), artifacts: [] };
            diagnostics.push(`tier2: ${String((e && e.message) || e)}`);
        }
    } else {
        tier2 = { status: 'skipped', reason: tier2SkipReason(tier2Decision), artifacts: [] };
    }

    const manifest = buildManifest({
        workItemRef,
        tier1: { status: tier1Status, artifacts: tier1Artifacts, diagnostics: tier1Diagnostics },
        tier2,
    });

    const allArtifacts = tier1Artifacts.concat(tier2.artifacts || []);
    const status = tier1Status === 'failed' || tier2.status === 'failed' ? 'failed' : 'ok';
    return {
        status,
        artifacts: allArtifacts,
        diagnostics: diagnostics.concat(tier1Diagnostics),
        manifest,
    };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    // constantes
    E2E_EVIDENCE_ENV,
    MANIFEST_VERSION,
    CAPTURED_STATES,
    FLAVORS,
    TIER2_TIMEOUT_MS,
    // flag
    isEnabled,
    // helpers de representatividad (testeables aislados)
    sha256File,
    deriveFreshness,
    normalizeCapturedState,
    buildArtifactEntry,
    buildManifest,
    // decisión tiered
    shouldTriggerTier2,
    tier2SkipReason,
    buildTier2Command,
    assertAllowedView,
    // puerto
    runE2eEvidence,
};
