'use strict';

// =============================================================================
// task-contract.js — Wiring de fases del pipeline para consumir el CONTRATO DE
// TAREA genérico (Ola Puente · H3 · #4719).
//
// CONTEXTO
// --------
// H1 (#4717, `docs/pipeline/contrato-tarea-generico.md`) definió el **contrato
// de tarea**: cuatro campos que separan *"qué prueba que la tarea está lista"*
// (`definicion_de_listo` + `evidencia_requerida`) de *"quién la ejecuta y qué
// produce"* (`tipo_entregable` + `ejecutor`). H2 (#4718,
// `.pipeline/lib/provisioner-infra.js`) implementó el primer ejecutor de tipo
// distinto a código (`provisioner_infra`) y su registro aditivo `runExecutor`.
//
// Este módulo (H3) es el **wiring**: hace que las fases del pipeline `desarrollo`
// dejen de asumir "el entregable es código" y pasen a **leer el contrato** para
// derivar el ejecutor correcto. Para el ~95 % de las tareas (contrato ausente o
// `tipo_entregable: codigo`) el comportamiento es **idéntico al actual**
// (retrocompat total — CA-3 de #4717): el flujo cableado rama→diff→build→QA→PR
// sigue intacto. Sólo cuando el contrato declara un ejecutor no-código (p. ej.
// `provisioner_infra` para "crear una base de datos") las fases corren por el
// camino determinístico de este módulo.
//
// PRINCIPIO "NO BIG-BANG" (#4716)
// -------------------------------
// La cadena de fases NO cambia (`validacion → dev → build → verificacion →
// linteo → aprobacion → entrega`). Sólo cambia *qué significa* cada fase cuando
// lee el contrato. Una fase que no aplica a un `tipo_entregable` declara un
// **no-op explícito** (`fase_noop: true` + motivo) en vez de saltearse en
// silencio: el lifecycle sigue trazable y auditable (no reaparece el limbo de
// #4700).
//
// FRONTERA DE LIFECYCLE (contrato-kernel-adaptador §5)
// ----------------------------------------------------
// Este módulo NO mueve archivos de estado entre carpetas: devuelve **datos**
// (resultado + evidencia) que el Pulpo (kernel) usa para decidir la transición
// `trabajando/ → listo/`. El único dueño del lifecycle sigue siendo el Pulpo.
// =============================================================================

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const {
    resolveExecutorType,
    isCodeExecutor,
    runExecutor,
    EXECUTOR_TYPE,
    DELIVERABLE_TYPE,
    STATUS,
} = require('./provisioner-infra');

// Orden de fases del pipeline `desarrollo` (config.yaml). Informativo: define
// qué fases están "aguas abajo" de `dev` para el wiring del contrato.
const DEV_PIPELINE_PHASES = Object.freeze([
    'validacion', 'dev', 'build', 'verificacion', 'linteo', 'aprobacion', 'entrega',
]);

// Fases que hoy asumen "código" y que este módulo resuelve determinísticamente
// para contratos NO-código. `validacion` queda fuera a propósito: precede a
// `dev`, corre en ROOT (no necesita worktree) y valida el contrato mismo — puede
// seguir por su camino normal sin romper nada.
const CONTRACT_HANDLED_PHASES = Object.freeze([
    'dev', 'build', 'verificacion', 'linteo', 'aprobacion', 'entrega',
]);

// Subdirectorio donde la fase de definición puede dejar un contrato explícito
// por issue, y donde este módulo persiste la evidencia producida por el ejecutor.
const CONTRACTS_DIRNAME = 'contracts';
const EVIDENCE_DIRNAME = 'evidence';

// -----------------------------------------------------------------------------
// Lectura del contrato de tarea
// -----------------------------------------------------------------------------

/**
 * Resuelve el directorio `.pipeline` a partir de las rutas conocidas.
 * @param {{ROOT?: string, PIPELINE?: string}} opts
 * @returns {string|null}
 */
function resolvePipelineDir({ ROOT, PIPELINE } = {}) {
    if (PIPELINE) return PIPELINE;
    if (ROOT) return path.join(ROOT, '.pipeline');
    return null;
}

/**
 * Lee el contrato de tarea de un issue. Prioridad (primer hit gana):
 *   1. `workData.contrato_tarea` — contrato inline en el work-file del ciclo.
 *   2. `.pipeline/contracts/<issue>.{yaml,yml,json}` — contrato por issue
 *      (lo deja la fase de definición; persiste entre fases).
 *   3. `null` — el kernel asume el contrato por defecto `codigo` (retrocompat).
 *
 * NUNCA lanza por "contrato ausente": devuelve `null`. Un contrato presente pero
 * corrupto (parse error) también devuelve `null` con `error` poblado en el
 * resultado extendido (ver `readTaskContractDetailed`) — el caller decide, y el
 * default seguro es el flujo de código (regresión cero).
 *
 * @param {object} opts
 * @param {string} [opts.ROOT]
 * @param {string} [opts.PIPELINE]
 * @param {string|number} [opts.issue]
 * @param {object} [opts.workData]  YAML del work-file ya parseado.
 * @param {function} [opts.readFile] Inyectable para tests (default fs.readFileSync).
 * @param {function} [opts.existsSync] Inyectable para tests (default fs.existsSync).
 * @returns {object|null} el contrato de tarea, o null.
 */
function readTaskContract(opts = {}) {
    return readTaskContractDetailed(opts).contract;
}

/**
 * Como `readTaskContract` pero devuelve `{ contract, source, error }` para
 * observabilidad. `source` ∈ `'inline' | 'file:<path>' | null`.
 */
function readTaskContractDetailed(opts = {}) {
    const { issue, workData } = opts;
    const readFile = opts.readFile || fs.readFileSync;
    const existsSync = opts.existsSync || fs.existsSync;

    // 1. Inline en el work-file.
    if (workData && typeof workData === 'object'
        && workData.contrato_tarea && typeof workData.contrato_tarea === 'object') {
        return { contract: workData.contrato_tarea, source: 'inline', error: null };
    }

    // 2. Archivo por issue.
    const pipelineDir = resolvePipelineDir(opts);
    if (pipelineDir && issue != null && /^\d+$/.test(String(issue))) {
        const dir = path.join(pipelineDir, CONTRACTS_DIRNAME);
        for (const ext of ['yaml', 'yml', 'json']) {
            const f = path.join(dir, `${issue}.${ext}`);
            let exists = false;
            try { exists = existsSync(f); } catch { exists = false; }
            if (!exists) continue;
            try {
                const raw = readFile(f, 'utf8');
                const parsed = ext === 'json' ? JSON.parse(raw) : yaml.load(raw);
                if (parsed && typeof parsed === 'object') {
                    // Se acepta tanto el contrato pelado como envuelto en
                    // `contrato_tarea:` (mismo esquema que el work-file inline).
                    const contract = (parsed.contrato_tarea && typeof parsed.contrato_tarea === 'object')
                        ? parsed.contrato_tarea
                        : parsed;
                    return { contract, source: `file:${f}`, error: null };
                }
                return { contract: null, source: `file:${f}`, error: 'contrato vacío o no es un objeto' };
            } catch (e) {
                // Parse error real de un contrato presente: NO se asume código a
                // ciegas sin dejar rastro; se reporta el error y el caller decide.
                return { contract: null, source: `file:${f}`, error: String(e && e.message ? e.message : e) };
            }
        }
    }

    // 3. Ausente → default `codigo`.
    return { contract: null, source: null, error: null };
}

// -----------------------------------------------------------------------------
// Derivación del wiring por fase
// -----------------------------------------------------------------------------

/**
 * `true` si el contrato lo maneja el lifecycle de código actual (rama → diff →
 * build → QA → PR). Contrato ausente o `tipo_entregable: codigo` ⇒ `true`.
 * @param {object|null} contract
 */
function isCodeContract(contract) {
    return isCodeExecutor(contract);
}

/**
 * Deriva el wiring de la fase `dev` según el contrato.
 *
 * @param {object|null} contract
 * @returns {{executorType: string, mode: 'code'|'executor', needsWorktree: boolean}}
 *   - `mode: 'code'`     → flujo cableado (crea worktree + rama + agente).
 *   - `mode: 'executor'` → ejecutor determinístico (provisioner_infra, …); NO
 *      crea worktree ni consume LLM.
 */
function deriveDevWiring(contract) {
    const executorType = resolveExecutorType(contract);
    const code = executorType === EXECUTOR_TYPE.DEV_CODIGO;
    return {
        executorType,
        mode: code ? 'code' : 'executor',
        needsWorktree: code,
    };
}

/**
 * ¿La fase `dev` necesita crear el worktree del issue para este contrato?
 * Retrocompat: contrato ausente/código ⇒ `true` (idéntico a hoy). Ejecutor
 * no-código ⇒ `false` (el ejecutor no produce un diff).
 *
 * @param {object|null} contract
 * @returns {boolean}
 */
function devNeedsWorktree(contract) {
    return deriveDevWiring(contract).needsWorktree;
}

/**
 * ¿Esta fase la resuelve el camino determinístico del contrato (no-código)?
 * Sólo `true` cuando el contrato es NO-código y la fase está en el conjunto de
 * fases que hoy asumen código. Para contratos de código SIEMPRE `false`.
 *
 * @param {string} fase
 * @param {object|null} contract
 * @returns {boolean}
 */
function phaseHandledByContract(fase, contract) {
    if (isCodeContract(contract)) return false;
    return CONTRACT_HANDLED_PHASES.includes(fase);
}

// -----------------------------------------------------------------------------
// Persistencia de evidencia (producida por dev, consumida por verificacion/…)
// -----------------------------------------------------------------------------

/** Ruta del archivo de evidencia de un issue. */
function evidencePathFor({ ROOT, PIPELINE, issue }) {
    const pipelineDir = resolvePipelineDir({ ROOT, PIPELINE });
    if (!pipelineDir) throw new Error('no se pudo resolver el directorio .pipeline');
    return path.join(pipelineDir, EVIDENCE_DIRNAME, `${issue}.json`);
}

/** Persiste la evidencia del ejecutor a disco (best-effort friendly). */
function persistEvidence({ ROOT, PIPELINE, issue }, evidence, deps = {}) {
    const writeFile = deps.writeFile || fs.writeFileSync;
    const mkdir = deps.mkdir || fs.mkdirSync;
    const p = evidencePathFor({ ROOT, PIPELINE, issue });
    mkdir(path.dirname(p), { recursive: true });
    writeFile(p, JSON.stringify(evidence, null, 2));
    return p;
}

/** Lee la evidencia persistida de un issue, o `null` si no existe. */
function readEvidence({ ROOT, PIPELINE, issue }, deps = {}) {
    const readFile = deps.readFile || fs.readFileSync;
    const existsSync = deps.existsSync || fs.existsSync;
    let p;
    try { p = evidencePathFor({ ROOT, PIPELINE, issue }); } catch { return null; }
    try {
        if (!existsSync(p)) return null;
        return JSON.parse(readFile(p, 'utf8'));
    } catch { return null; }
}

// -----------------------------------------------------------------------------
// Runner determinístico de fases para contratos NO-código
// -----------------------------------------------------------------------------

/**
 * ¿La evidencia del ejecutor prueba el "listo"? Hoy soporta la evidencia del
 * `provisioner_infra` (`describe_table_round_trip`): exige round-trip completo.
 * Genérica ante otras evidencias: si trae `status`, respeta ese status.
 */
function evidenceProvesReady(evidence) {
    if (!evidence || typeof evidence !== 'object') return false;
    const rt = evidence.roundTrip;
    if (rt && typeof rt === 'object') {
        return !!(rt.create && rt.read && rt.delete && rt.confirmedGone);
    }
    if (typeof evidence.status === 'string') return evidence.status === STATUS.OK;
    // Sin round-trip ni status: la sola presencia del artefacto de describe basta.
    return !!evidence.describeTable;
}

/**
 * Ejecuta una fase para un contrato NO-código y devuelve el resultado que el
 * Pulpo debe escribir en el work-file. NUNCA mueve archivos de estado (eso es
 * del kernel) y NUNCA lanza: modela los errores como `resultado: rechazado`.
 *
 * Semántica por fase (alineada con `docs/pipeline/contrato-tarea-generico.md §3`
 * y `docs/pipeline/wiring-fases-contrato-tarea.md`):
 *   - `dev`          → corre el ejecutor del contrato (provisión + evidencia).
 *   - `build`        → no-op declarada (el entregable no compila).
 *   - `verificacion` → consume la evidencia del ejecutor y la compara con
 *                      `definicion_de_listo`.
 *   - `linteo`       → no-op declarada (no hay diff que lintear).
 *   - `aprobacion`   → verifica `definicion_de_listo` contra la evidencia.
 *   - `entrega`      → cierra el entregable sin exigir un PR de `platform`.
 *
 * @param {object} params
 * @param {string} params.fase
 * @param {object} params.contract
 * @param {string|number} params.issue
 * @param {string} [params.ROOT]
 * @param {string} [params.PIPELINE]
 * @param {object} [params.executorDeps]  se pasa tal cual a `runExecutor` (driver, now).
 * @param {object} [params.io]            inyección de fs para tests.
 * @returns {Promise<object>} `{ resultado, motivo?, ...metadata }`
 */
async function runContractPhase(params) {
    const { fase, contract, issue } = params;
    const executorType = resolveExecutorType(contract);
    const tipoEntregable = (contract && contract.tipo_entregable) || DELIVERABLE_TYPE.CODIGO;
    const io = params.io || {};

    const meta = {
        contrato_ejecutor: executorType,
        contrato_tipo_entregable: tipoEntregable,
        fase,
    };

    // Guard: esta función sólo aplica a contratos no-código. Un contrato de
    // código nunca debería llegar acá (retrocompat: lo maneja el flujo cableado).
    if (isCodeContract(contract)) {
        return {
            resultado: 'rechazado',
            motivo: 'runContractPhase invocado con contrato de código — debe ir por el flujo cableado',
            ...meta,
        };
    }

    switch (fase) {
        case 'dev': {
            let result;
            try {
                result = await runExecutor(contract, params.executorDeps || {});
            } catch (e) {
                return {
                    resultado: 'rechazado',
                    motivo: `ejecutor ${executorType} lanzó una excepción inesperada: ${String(e && e.message ? e.message : e)}`,
                    ...meta,
                };
            }
            // Persistir evidencia para las fases aguas abajo (best-effort).
            let evidencePath = null;
            if (result && result.evidence) {
                try {
                    evidencePath = persistEvidence(
                        { ROOT: params.ROOT, PIPELINE: params.PIPELINE, issue },
                        result.evidence, io,
                    );
                } catch { /* la evidencia también viaja en el resultado */ }
            }
            const ok = result && result.status === STATUS.OK;
            return {
                resultado: ok ? 'aprobado' : 'rechazado',
                motivo: ok
                    ? undefined
                    : `ejecutor ${executorType} no completó: ${(result && result.diagnostics || []).map(d => d.message).join('; ') || 'sin diagnóstico'}`,
                contrato_evidencia_tipo: result && result.evidenceType,
                contrato_evidencia_path: evidencePath,
                contrato_status: result && result.status,
                ...meta,
            };
        }

        case 'build':
        case 'linteo': {
            // No-op declarada: el entregable no compila ni tiene diff. Se registra
            // explícitamente para que el lifecycle sea trazable (no salteado).
            return {
                resultado: 'aprobado',
                fase_noop: true,
                motivo: `fase "${fase}" no aplica a tipo_entregable="${tipoEntregable}" (no compila / sin diff) — no-op declarada`,
                ...meta,
            };
        }

        case 'verificacion':
        case 'aprobacion': {
            // Consumir la evidencia del ejecutor y compararla con definicion_de_listo.
            const evidence = readEvidence(
                { ROOT: params.ROOT, PIPELINE: params.PIPELINE, issue }, io,
            );
            const proves = evidenceProvesReady(evidence);
            if (!evidence) {
                return {
                    resultado: 'rechazado',
                    motivo: `fase "${fase}": no se encontró evidencia del ejecutor para el issue (esperada de la fase dev)`,
                    ...meta,
                };
            }
            if (!proves) {
                return {
                    resultado: 'rechazado',
                    motivo: `fase "${fase}": la evidencia del ejecutor no prueba "definicion_de_listo" (round-trip/estado incompleto)`,
                    contrato_evidencia_tipo: evidence.type || null,
                    ...meta,
                };
            }
            return {
                resultado: 'aprobado',
                motivo: `fase "${fase}": evidencia del ejecutor verificada contra definicion_de_listo`,
                contrato_evidencia_tipo: evidence.type || null,
                ...meta,
            };
        }

        case 'entrega': {
            // Cierre del entregable sin PR de `platform`. El recurso ya existe y
            // respondió (evidencia round-trip); no hay rama que mergear.
            const evidence = readEvidence(
                { ROOT: params.ROOT, PIPELINE: params.PIPELINE, issue }, io,
            );
            return {
                resultado: 'aprobado',
                entregable_cerrado: true,
                motivo: `entrega de tipo_entregable="${tipoEntregable}" cerrada sin PR (el recurso existe y respondió)`,
                contrato_evidencia_tipo: (evidence && evidence.type) || null,
                ...meta,
            };
        }

        default:
            // Fase no cubierta por el wiring (p. ej. validacion): no la resolvemos
            // acá. El caller no debería invocar runContractPhase para estas fases.
            return {
                resultado: 'rechazado',
                motivo: `fase "${fase}" no está en el conjunto de fases resueltas por el contrato`,
                ...meta,
            };
    }
}

// -----------------------------------------------------------------------------
module.exports = {
    // constantes
    DEV_PIPELINE_PHASES,
    CONTRACT_HANDLED_PHASES,
    CONTRACTS_DIRNAME,
    EVIDENCE_DIRNAME,
    // lectura
    readTaskContract,
    readTaskContractDetailed,
    resolvePipelineDir,
    // derivación
    isCodeContract,
    deriveDevWiring,
    devNeedsWorktree,
    phaseHandledByContract,
    // evidencia
    evidencePathFor,
    persistEvidence,
    readEvidence,
    evidenceProvesReady,
    // runner
    runContractPhase,
    // re-export de conveniencia
    resolveExecutorType,
    isCodeExecutor,
};
