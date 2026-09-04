// =============================================================================
// infra-noprogress.js — Breaker de NO-PROGRESO para rebotes de infra (#6746).
//
// QUÉ EVITA
// ---------
// Cuando un rebote se clasifica `infra`, `pulpo.js` lo reencola en la MISMA
// fase. Si esa re-ejecución no puede cambiar nada (porque la acción pedida vive
// en otra fase, o porque el arreglo no depende del agente que corre), el issue
// reintenta hasta agotar `rebote_numero_infra` sin ningún avance observable:
// mismo HEAD, mismo diff. Pasó al menos cuatro veces (#3741, #6179, #5460,
// #6496) y en #3741 costó ~USD 80-100/h.
//
// Este módulo es la red de seguridad INDEPENDIENTE DE LA CAUSA: aunque el
// clasificador de rebotes vuelva a equivocarse (o se equivoque por un motivo
// nuevo), el pipeline detecta que no hay progreso y ESCALA a `needs-human` en
// vez de reintentar.
//
// POR QUÉ EL ESTADO ES DEL PULPO Y NO DEL WORK-FILE (CA-2 / SEC-5)
// ----------------------------------------------------------------
// `lib/rebote-counter.js` decide con `data.rebote_tipo`, que lo escribe el
// AGENTE y que `moveFile` (renameSync puro) preserva intacto hasta `procesado/`:
// un agente que escriba una clave de más pone su contador en cero (Hallazgo 3 de
// `security`). Por eso el contador de no-progreso se DERIVA de un JSONL que
// escribe únicamente el proceso del Pulpo, nunca del work-file.
//
// PERSISTENCIA: `.pipeline/audit/infra-noprogress.jsonl` — APPEND-ONLY (CA-3).
// Una línea por ciclo infra; el conteo se agrega en lectura. El corte de
// episodio se marca con un registro `{kind:"reset"}`, NUNCA borrando (SEC-D).
//
//   {"ts":"2026-08-31T...","issue":6746,"fase":"dev",
//    "diff_hash":"f00a...","rebote_infra_n":2}
//
// SIN WRITER EXPORTADO (SEC-C.1)
// ------------------------------
// El módulo SERIALIZA (`buildRecord`) y el Pulpo ESCRIBE. No hay shebang, no hay
// `require.main === module` y no se exporta ninguna función que escriba en disco:
// un agente no tiene forma de invocar el writer para envenenar el contador.
//
// FAIL-OPEN A PROPÓSITO (SEC-E / RIESGO-4)
// ----------------------------------------
// Acá "no sé" NO puede escalar. El costo de un falso positivo (issue sano
// parkeado esperando a un humano) es mayor que el de un falso negativo (un ciclo
// más, que los gates de `infra_escalate_threshold` = 5 y `MAX_REBOTES_INFRA` = 20
// igual cortan). OJO: es lo INVERSO de `auto-recheck-counter.js::count`, que
// devuelve `Infinity` porque allá "no sé" tiene que BLOQUEAR. Copiar aquel
// fail-closed acá invertiría el sentido del breaker y lo convertiría en un DoS de
// disponibilidad (SEC-A). ANTE LA DUDA, NO ESCALAR.
//
// Node puro (fs, path).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
// CA-PO-1 — reuso del predicado ya testeado; no se re-deriva la lista de fases.
const { phaseRunsInIssueWorktree } = require('./phase-workspace');

// sha256 hex de `convergence.computeDiffHash` (SEC-C.4). Cualquier otra forma
// se descarta: un hash "raro" es dato no confiable, no evidencia de repetición.
const HASH_RE = /^[0-9a-f]{64}$/;

// RIESGO-3 — mismo criterio que `convergence-detector.js:57`. El issue termina en
// un nombre de archivo/consulta: estrictamente numérico o no se procesa.
const ISSUE_RE = /^\d+$/;

// CA-1 — N por default.
const DEFAULT_NOPROGRESO_MAX = 2;

// Con 1 escalaría en el PRIMER rebote, sin dos ciclos que comparar: eso no es
// "no-progreso", es "rebotó una vez". El piso del clamp es 2 por definición.
const MIN_NOPROGRESO_MAX = 2;

// Cota sana (CA-PO-2): un umbral enorme no puede desactivar el breaker.
const MAX_NOPROGRESO_MAX = 10;

// Un archivo desbordado no puede convertir la lectura en un cuelgue del tick.
const MAX_LINES = 20000;

/**
 * Ruta del JSONL de auditoría. Se expone para que el Pulpo (único escritor)
 * la use — el módulo no escribe (SEC-C.1).
 *
 * @param {string} pipelineDir Directorio `.pipeline`.
 * @returns {string}
 */
function auditFile(pipelineDir) {
    return path.join(String(pipelineDir || ''), 'audit', 'infra-noprogress.jsonl');
}

/**
 * Normaliza el nombre de fase a `[a-zA-Z_-]`. RIESGO-7 / SEC-C.2: la fase entra
 * en una string JSON; un `\n` forjado no puede inyectar un registro entero.
 * Se aplica IGUAL al escribir y al leer, así la comparación es simétrica.
 *
 * @param {*} fase
 * @returns {string}
 */
function normalizeFase(fase) {
    return String(fase == null ? '' : fase).replace(/[^a-z_-]/gi, '');
}

/**
 * CA-PO-2 — clamp fail-closed, calcado de `resolveRebotesMax`
 * (`rebote-counter.js:103-108`). `0`, negativo, `NaN`, `'2'` (string),
 * `Infinity`, `1` o ausente ⇒ default 2. `99` ⇒ 10. `5` ⇒ 5.
 *
 * @param {object} config Config del pipeline (`config.yaml` parseado).
 * @returns {number} Entero en [MIN_NOPROGRESO_MAX, MAX_NOPROGRESO_MAX].
 */
function resolveNoprogresoMax(config) {
    const raw = config && config.circuit_breaker && config.circuit_breaker.noprogreso_max;
    // Sólo se acepta un number entero: un `'2'` de YAML mal tipado cae al default
    // en vez de colarse por coerción silenciosa.
    if (typeof raw !== 'number' || !Number.isInteger(raw) || !Number.isFinite(raw)) {
        return DEFAULT_NOPROGRESO_MAX;
    }
    if (raw < MIN_NOPROGRESO_MAX) return DEFAULT_NOPROGRESO_MAX;
    return Math.min(raw, MAX_NOPROGRESO_MAX);
}

/**
 * Serializa UNA línea del JSONL, con su `\n` ya incluido — el caller hace UN
 * solo `appendFileSync` (SEC-C.3).
 *
 * SEC-C.2 — objeto de campos WHITELISTEADOS pasado por `JSON.stringify`, nunca
 * concatenación de strings. SEC-F — sin texto libre: no hay `motivo` y cualquier
 * clave extra del argumento se descarta.
 *
 * @param {object} args
 * @param {string|number} args.issue        Issue (estrictamente numérico, distinto de 0).
 * @param {string}        args.fase         Fase del ciclo.
 * @param {string|null}   args.diffHash     sha256 del diff, o `null` si desconocido.
 * @param {number}        [args.reboteInfraN] Observabilidad — NO es insumo (SEC-B).
 * @param {string}        [args.kind]       `'reset'` para marcar corte de episodio.
 * @param {number}        [args.now]        Epoch ms (inyectable para tests).
 * @returns {string} Línea JSON terminada en `\n`.
 * @throws {Error} Si el issue no es estrictamente numérico o es 0.
 */
function buildRecord({ issue, fase, diffHash, reboteInfraN, kind, now } = {}) {
    const s = String(issue == null ? '' : issue).trim();
    if (!ISSUE_RE.test(s) || Number(s) === 0) {
        throw new Error('infra-noprogress: issue invalido');
    }
    const rec = {
        ts: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
        issue: Number(s),
        fase: normalizeFase(fase),
        diff_hash: (typeof diffHash === 'string' && HASH_RE.test(diffHash)) ? diffHash : null,
        // SEC-B — observabilidad para el operador. El detector NO lo lee: viene
        // del work-file del agente y por eso no puede influir en la decisión.
        rebote_infra_n: Number.isInteger(reboteInfraN) ? reboteInfraN : 0,
    };
    if (kind === 'reset') rec.kind = 'reset';
    return JSON.stringify(rec) + '\n';
}

/**
 * Cuenta los registros de `(issue, fase)` POSTERIORES al último `{kind:"reset"}`
 * cuyo `diff_hash` es válido e igual a `diffHash`.
 *
 * SEC-C.4 — descarta líneas que no parsean y registros con `issue`/`diff_hash`
 * de forma inválida, y sigue contando el resto (un renglón corrupto no ciega el
 * breaker ni lo dispara).
 *
 * SEC-E — archivo ilegible o con más de `MAX_LINES` líneas ⇒
 * `{ n: 0, degraded: true }`. Ver la nota de FAIL-OPEN del encabezado: acá "no
 * sé" NO escala.
 *
 * @param {object}   args
 * @param {string}   args.pipelineDir
 * @param {string|number} args.issue
 * @param {string}   args.fase
 * @param {string}   args.diffHash
 * @param {object}   [args.fsImpl] Inyección para tests (no toca el audit real).
 * @returns {{ n: number, degraded: boolean }}
 */
function countSameHash({ pipelineDir, issue, fase, diffHash, fsImpl } = {}) {
    const _fs = fsImpl || fs;
    const s = String(issue == null ? '' : issue).trim();
    // Entrada inválida ⇒ 0 sin degradar: no hay nada que contar y no escala.
    if (!ISSUE_RE.test(s) || Number(s) === 0) return { n: 0, degraded: false };
    if (typeof diffHash !== 'string' || !HASH_RE.test(diffHash)) return { n: 0, degraded: false };

    const file = auditFile(pipelineDir);
    let raw;
    try {
        if (!_fs.existsSync(file)) return { n: 0, degraded: false }; // aún no hubo ciclos
        raw = _fs.readFileSync(file, 'utf8');
    } catch (_e) {
        return { n: 0, degraded: true }; // SEC-E
    }
    const lines = String(raw).split('\n');
    if (lines.length > MAX_LINES) return { n: 0, degraded: true }; // SEC-E

    const issueNum = Number(s);
    const faseNorm = normalizeFase(fase);
    let n = 0;
    for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let rec;
        try { rec = JSON.parse(t); } catch (_e) { continue; }        // SEC-C.4
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
        if (!Number.isInteger(rec.issue) || rec.issue !== issueNum) continue;
        if (typeof rec.fase !== 'string' || rec.fase !== faseNorm) continue;
        // SEC-D — el corte de episodio se marca, no se borra: todo lo anterior
        // al reset deja de contar.
        if (rec.kind === 'reset') { n = 0; continue; }
        if (typeof rec.diff_hash !== 'string' || !HASH_RE.test(rec.diff_hash)) continue;
        if (rec.diff_hash === diffHash) n++;
    }
    return { n, degraded: false };
}

/**
 * Veredicto del breaker. ÚNICO punto de decisión (SEC-B: cuenta el JSONL del
 * Pulpo, NUNCA `rebote_numero_infra`, que sale del work-file del agente).
 *
 * Semántica de N (CA-1, vinculante): `ciclos` cuenta ciclos con el MISMO hash
 * INCLUYENDO el actual, igual que el gate existente de `pulpo.js`
 * (`reboteInfraCount + 1 >= THRESHOLD`). Con el default 2 escala en el SEGUNDO
 * ciclo con hash idéntico.
 *
 * Tres compuertas independientes, todas fail-open hacia NO escalar (RIESGO-3):
 *   1. `phaseRunsInIssueWorktree` — sin worktree propio no hay diff comparable.
 *   2. `HASH_RE` sobre `diffHash` — `known:false` ⇒ hash desconocido ⇒ no escala.
 *   3. `countSameHash` degradado ⇒ no escala.
 *
 * @param {object} args
 * @param {string} args.pipelineDir
 * @param {string|number} args.issue
 * @param {string} args.fase
 * @param {string|null} args.diffHash
 * @param {object} [args.config]
 * @param {object} [args.fsImpl]
 * @returns {{escalar: boolean, ciclos: number, max: number, razon: string,
 *            degraded?: boolean, hashCorto?: string}}
 */
function shouldEscalate({ pipelineDir, issue, fase, diffHash, config, fsImpl } = {}) {
    const max = resolveNoprogresoMax(config);
    if (!phaseRunsInIssueWorktree(fase)) {                          // CA-PO-1
        return { escalar: false, razon: 'fase-sin-worktree-propio', max, ciclos: 0 };
    }
    if (typeof diffHash !== 'string' || !HASH_RE.test(diffHash)) {  // SEC-A
        return { escalar: false, razon: 'hash-desconocido', max, ciclos: 0 };
    }
    const { n, degraded } = countSameHash({ pipelineDir, issue, fase, diffHash, fsImpl });
    if (degraded) {
        return { escalar: false, razon: 'jsonl-ilegible', degraded: true, max, ciclos: 0 };
    }
    const ciclos = n + 1;                                           // +1 = el ciclo actual
    return {
        escalar: ciclos >= max,
        ciclos,
        max,
        razon: 'no-progreso',
        hashCorto: diffHash.slice(0, 12),                           // CA-UX-3
    };
}

// SEC-C.1 — se exportan LECTORES y un SERIALIZADOR. Ninguna función de este
// módulo escribe en disco; el append vive en el proceso del Pulpo.
module.exports = {
    buildRecord,
    countSameHash,
    shouldEscalate,
    resolveNoprogresoMax,
    normalizeFase,
    auditFile,
    DEFAULT_NOPROGRESO_MAX,
    MIN_NOPROGRESO_MAX,
    MAX_NOPROGRESO_MAX,
    MAX_LINES,
    HASH_RE,
};
