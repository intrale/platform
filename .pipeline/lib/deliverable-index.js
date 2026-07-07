'use strict';

// =============================================================================
// deliverable-index.js — Índice estructurado de entregables por issue (#4255)
//
// Registro consultable `issue → fase → agente` de los entregables físicos que
// cada productor deja al cerrar su fase. Es la CAPA DE DIRECCIONAMIENTO que
// habilita el consumo agnóstico del canal (notificación Telegram hoy, app
// mobile mañana): el filesystem sigue siendo la fuente de verdad del binario,
// este manifest es el índice que dice "para el issue N, en la fase F, el agente
// A dejó el artefacto en <path>".
//
// Espeja estructuralmente a `handoff.js` (#2993):
//   - Un archivo JSON por issue: `.pipeline/deliverables/<issue>.json`.
//   - Upsert idempotente por clave `agente::fase` ("último write por fase"):
//     dos fases del mismo agente (PO en Definición + Aprobación) CONVIVEN, pero
//     un segundo write de la misma fase pisa al anterior.
//   - Redacción de metadata vía `lib/redact.js` antes de persistir.
//   - Atomic write (write-to-temp + rename).
//
// Reglas de seguridad (receta del Arquitecto, análisis SEC-1..SEC-6):
//   - CA-5 (path traversal): `issue` DEBE matchear `^\d+$` antes de tocar el FS.
//   - SEC-2 (path injection por `fase`/`agente`): AMBOS son enums CERRADOS.
//     `fase` deriva de `config.yaml → skills_por_fase`; `agente` de las claves
//     de `SKILL_SOURCES`. NUNCA son segmentos de path libres ni free-form.
//   - SEC-1 (canal Drive): cada entry porta `sensible:true|false` para que el
//     canal de consumo decida visibilidad (el flag se diseña acá; el canal lo
//     aplica en su sub-issue).
//   - Determinismo en tests: `timestamp` es inyectable por parámetro. Sin
//     `Date.now()`/`new Date()` implícito en la ruta testeada.
//
// Doctrina y contexto: docs/pipeline/entregables-multimedia-por-agente.md
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getSkillSourcesCatalog } = require('./skill-deliverable-attachments');
const { redactSecretValue, redactSensitive } = require('./redact');

// -----------------------------------------------------------------------------
// Enum de fases (SEC-2) — CERRADO, derivado de config.yaml → skills_por_fase.
// -----------------------------------------------------------------------------
//
// FALLBACK espeja el estado actual de `config.yaml` (definicion + desarrollo).
// Se usa sólo si el config no se puede leer/parsear (defensa: nunca abrir el
// enum por un config roto). El enum efectivo se recalcula desde el config real
// en `getPhaseEnum`, cacheado por proceso.

const FALLBACK_PHASES = Object.freeze([
    // definicion
    'analisis', 'criterios', 'sizing',
    // desarrollo
    'validacion', 'dev', 'build', 'verificacion', 'linteo', 'aprobacion', 'entrega',
]);

let _phaseEnumCache = null;

/**
 * Lee `config.yaml` (una vez por proceso) y extrae el set cerrado de nombres de
 * fase presentes en `pipelines.*.skills_por_fase`. Si algo falla, cae al
 * FALLBACK. El resultado se cachea.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.phaseEnum] - override explícito (tests).
 * @param {string} [opts.pipelineRoot] - root del repo (default: padre de lib/).
 * @returns {Set<string>}
 */
function getPhaseEnum(opts = {}) {
    if (Array.isArray(opts.phaseEnum)) {
        return new Set(opts.phaseEnum.map(String));
    }
    if (_phaseEnumCache) return _phaseEnumCache;

    const phases = new Set();
    try {
        const yaml = require('js-yaml');
        const root =
            typeof opts.pipelineRoot === 'string' && opts.pipelineRoot.length > 0
                ? opts.pipelineRoot
                : path.resolve(__dirname, '..');
        const cfgPath = path.join(root, 'config.yaml');
        const raw = fs.readFileSync(cfgPath, 'utf8');
        const cfg = yaml.load(raw) || {};
        const pipelines = cfg.pipelines || {};
        for (const pipelineCfg of Object.values(pipelines)) {
            const spf = (pipelineCfg && pipelineCfg.skills_por_fase) || {};
            for (const fase of Object.keys(spf)) phases.add(String(fase));
        }
    } catch {
        // Config ilegible → enum cerrado por FALLBACK (nunca free-form).
    }

    if (phases.size === 0) {
        for (const f of FALLBACK_PHASES) phases.add(f);
    }
    _phaseEnumCache = phases;
    return phases;
}

/** Invalida el cache del enum de fases (tests). */
function _resetPhaseEnumCache() {
    _phaseEnumCache = null;
}

/**
 * Valida `fase` contra el enum cerrado (SEC-2). Lanza si no matchea.
 * @param {string} fase
 * @param {object} [opts]
 * @returns {string} fase normalizada
 */
function validatePhase(fase, opts = {}) {
    if (typeof fase !== 'string' || fase.length === 0) {
        throw new Error(`fase inválida (vacía): ${fase}`);
    }
    const enumSet = getPhaseEnum(opts);
    if (!enumSet.has(fase)) {
        throw new Error(`fase fuera del enum cerrado: ${fase}`);
    }
    return fase;
}

/**
 * Valida `agente` contra las claves de `SKILL_SOURCES` (SEC-2). Lanza si no
 * matchea. Es el mismo perfil que resuelve el directorio de escritura, así el
 * índice nunca referencia un agente sin perfil de entrega.
 * @param {string} agente
 * @returns {string} agente normalizado
 */
function validateAgent(agente) {
    if (typeof agente !== 'string' || agente.length === 0) {
        throw new Error(`agente inválido (vacío): ${agente}`);
    }
    const catalog = getSkillSourcesCatalog();
    if (!Object.prototype.hasOwnProperty.call(catalog, agente)) {
        throw new Error(`agente sin perfil en SKILL_SOURCES: ${agente}`);
    }
    return agente;
}

/**
 * Valida `issue` como entero positivo (CA-5 / path traversal). Devuelve string
 * canónico o lanza.
 * @param {string|number} issue
 * @returns {string}
 */
function validateIssueId(issue) {
    if (issue == null) throw new Error('deliverable-index: issue requerido');
    const s = String(issue).trim();
    if (!/^\d+$/.test(s) || s === '0') {
        throw new Error(`issue inválido (no ^\\d+$, > 0): ${issue}`);
    }
    return s;
}

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

function resolvePipelineDir(opts) {
    if (opts && typeof opts.pipelineRoot === 'string' && opts.pipelineRoot.length > 0) {
        const root = path.resolve(opts.pipelineRoot);
        return path.basename(root) === '.pipeline' ? root : path.join(root, '.pipeline');
    }
    // __dirname = .pipeline/lib → padre = .pipeline
    return path.resolve(__dirname, '..');
}

function deliverablesDir(opts) {
    return path.join(resolvePipelineDir(opts), 'deliverables');
}

function indexPathFor(issue, opts) {
    return path.join(deliverablesDir(opts), `${issue}.json`);
}

// -----------------------------------------------------------------------------
// Redacción de metadata (CA-6 / SEC-1)
// -----------------------------------------------------------------------------

/**
 * Redacta los campos string de metadata de una entry antes de persistir.
 * Cubre secrets embebidos (`redactSecretValue`) y emails/URLs (`redactSensitive`)
 * en `path`, `caption` y `descriptor` si existen. Los campos estructurales
 * (issue/fase/agente/tipo/bytes/sensible/timestamp) NO se tocan.
 * @param {object} entry
 * @returns {object} copia redactada
 */
function redactMeta(entry) {
    const out = { ...entry };
    for (const field of ['path', 'caption', 'descriptor', 'filename', 'motivo']) {
        if (typeof out[field] === 'string' && out[field].length > 0) {
            out[field] = redactSensitive(redactSecretValue(out[field]));
        }
    }
    return out;
}

// -----------------------------------------------------------------------------
// Lectura
// -----------------------------------------------------------------------------

/**
 * Lee el índice del issue. Si no existe o está corrupto, devuelve el shape
 * inicial `{ issue, entries: [] }` sin tirar (defensa: el índice es best-effort
 * sobre el FS que ya es fuente de verdad).
 * @param {string|number} issue
 * @param {object} [opts]
 * @returns {{issue:number, entries:Array}}
 */
function readDeliverableIndex(issue, opts = {}) {
    const issueId = validateIssueId(issue);
    const file = indexPathFor(issueId, opts);
    let raw = '';
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return { issue: Number(issueId), entries: [] };
        return { issue: Number(issueId), entries: [] };
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
            return { issue: Number(issueId), entries: [] };
        }
        return { issue: Number(issueId), entries: parsed.entries };
    } catch {
        // JSON corrupto → tratamos como índice vacío (el FS manda).
        return { issue: Number(issueId), entries: [] };
    }
}

// -----------------------------------------------------------------------------
// Escritura (upsert idempotente por clave `agente::fase`)
// -----------------------------------------------------------------------------

function entryKey(e) {
    return `${e.agente}::${e.fase}`;
}

// -----------------------------------------------------------------------------
// Excepción explícita `no_aplica` (CA-3, #4506)
// -----------------------------------------------------------------------------
//
// Cuando el entregable genuinamente no aplica (cierre `aprobado` sin adjuntos y
// sin nota sustantiva), en vez de silencio se persiste UNA entry `tipo:
// "exception"` / `estado: "no_aplica"` con un `motivo` string. La entry:
//   - NO representa un binario → no requiere `path` (validación relajada SÓLO
//     para este tipo; todo otro tipo sigue exigiendo `path` no vacío).
//   - Comparte la clave idempotente `agente::fase` → un entregable real
//     posterior del mismo agente/fase la PISA.
//   - Redacta el `motivo` (REQ-SEC-1) y lo capa (REQ-SEC-3) antes de persistir.

// REQ-SEC-3: cap de longitud del `motivo`. Es un string de índice (pocos KiB),
// NO un artefacto — el cap de 5 MiB de `write-deliverable` no aplica acá.
const MOTIVO_MAX_CHARS = 2048;

/**
 * Capa el `motivo` a `MOTIVO_MAX_CHARS` (REQ-SEC-3). Si excede, corta en límite
 * de palabra (UX G-1: no a mitad de token) y agrega un marcador `…`. El
 * resultado nunca supera `MOTIVO_MAX_CHARS`.
 * @param {string} s
 * @returns {string}
 */
function capMotivo(s) {
    if (typeof s !== 'string') return '';
    if (s.length <= MOTIVO_MAX_CHARS) return s;
    const hard = s.slice(0, MOTIVO_MAX_CHARS - 1);
    const lastSpace = hard.lastIndexOf(' ');
    const body = lastSpace > MOTIVO_MAX_CHARS * 0.5 ? hard.slice(0, lastSpace) : hard;
    return `${body}…`;
}

/**
 * Agrega o reemplaza la entry del `agente` en la `fase` para `issue`. Clave
 * multi-fase (`agente::fase`): un segundo write de la misma fase pisa al
 * anterior ("último write por fase"), pero dos fases del mismo agente conviven.
 *
 * @param {object} entry
 * @param {string|number} entry.issue          - `^\d+$` (CA-5).
 * @param {string} entry.fase                  - enum cerrado (SEC-2).
 * @param {string} entry.agente                - clave de SKILL_SOURCES (SEC-2).
 * @param {string} entry.tipo                  - document|image|video|animation|exception.
 * @param {string} [entry.path]                - path del binario (relativo al repo).
 *                                               Requerido salvo `tipo:'exception'`.
 * @param {string} [entry.motivo]              - motivo de la excepción. Requerido
 *                                               (y no vacío) sólo si `tipo:'exception'`
 *                                               (#4504, CA-3). Se redacta en `redactMeta`
 *                                               y se capa a MOTIVO_MAX_CHARS (#4506, REQ-SEC-3).
 * @param {number} [entry.bytes]               - tamaño del binario.
 * @param {boolean} [entry.sensible=false]     - flag de sensibilidad (SEC-1).
 * @param {string} [entry.timestamp]           - ISO inyectable (determinismo tests).
 *                                               Default: `new Date().toISOString()`.
 * @param {string} [entry.pipelineRoot]        - dir `.pipeline` (default `path.resolve(__dirname,'..')`).
 *                                               OJO: NO es el repo root — es el dir `.pipeline`.
 *                                               El adapter `write-deliverable.js` traduce
 *                                               repo-root → `.pipeline` antes de llamar acá (CA-4).
 * @returns {object} la entry persistida (redactada).
 */
function upsertDeliverableIndex(entry = {}) {
    const opts = { pipelineRoot: entry.pipelineRoot, phaseEnum: entry.phaseEnum };
    const issueId = validateIssueId(entry.issue);
    const fase = validatePhase(entry.fase, opts);
    const agente = validateAgent(entry.agente);

    if (typeof entry.tipo !== 'string' || entry.tipo.length === 0) {
        throw new Error(`tipo inválido: ${entry.tipo}`);
    }
    // Validación condicional por tipo. La entry `tipo:'exception'` registra
    // "el entregable no aplica + motivo" y por diseño NO tiene binario asociado.
    // No exige `path`; en su lugar exige `motivo` no vacío para no degradar a un
    // registro silencioso. El resto de tipos sigue requiriendo `path`.
    const isException = entry.tipo === 'exception';
    if (isException) {
        if (typeof entry.motivo !== 'string' || entry.motivo.trim().length === 0) {
            throw new Error(`motivo requerido para tipo=exception: ${entry.motivo}`);
        }
    } else if (typeof entry.path !== 'string' || entry.path.length === 0) {
        throw new Error(`path inválido: ${entry.path}`);
    }

    const timestamp =
        typeof entry.timestamp === 'string' && entry.timestamp.length > 0
            ? entry.timestamp
            : new Date().toISOString();

    const record = redactMeta({
        issue: Number(issueId),
        fase,
        agente,
        tipo: entry.tipo,
        // Sólo se persiste el campo relevante por tipo: `path` para binarios,
        // `motivo` (+ `estado:"no_aplica"`) para excepciones. Así el shape de cada
        // entry es inequívoco (#4506, CA-3).
        ...(isException
            ? { motivo: entry.motivo, estado: 'no_aplica' }
            : { path: entry.path }),
        bytes: Number.isFinite(entry.bytes) ? Number(entry.bytes) : null,
        sensible: Boolean(entry.sensible),
        timestamp,
        ...(isException ? { motivo: String(entry.motivo) } : {}),
    });
    // #4506 (REQ-SEC-3): capar el `motivo` de la excepción. `redactMeta` ya lo
    // redactó (secrets/PII fuera) — recién ahí se capa a MOTIVO_MAX_CHARS, para
    // no partir un secret a la mitad (redact-then-cap). Sólo aplica a `exception`;
    // `path`/`caption` de binarios no se capan.
    if (isException && typeof record.motivo === 'string') {
        record.motivo = capMotivo(record.motivo);
    }

    const idx = readDeliverableIndex(issueId, opts);
    const key = entryKey(record);
    idx.entries = idx.entries.filter((e) => entryKey(e) !== key).concat(record);
    idx.issue = Number(issueId);

    const file = indexPathFor(issueId, opts);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });

    // Atomic write: write-to-temp + rename.
    const tmp = path.join(
        dir,
        `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
    );
    fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), 'utf8');
    fs.renameSync(tmp, file);

    return record;
}

/**
 * Registra una entry de EXCEPCIÓN autoritativa "el entregable no aplica + motivo"
 * (#4502 / CA-3). Reusa el choke point atómico de `upsertDeliverableIndex` con la
 * misma clave `agente::fase` (idempotente: un segundo registro de la misma fase
 * pisa al anterior). El `motivo` pasa por `redactMeta` antes de persistir. NO
 * exige `path` — la excepción es la válvula de escape de la obligatoriedad y no
 * apunta a ningún binario.
 *
 * Autoridad (SEC-REQ-1 / OWASP A01/A08): esta entry SÓLO la escribe el pulpo tras
 * validar el input del agente. El agente NUNCA escribe el índice a mano ni se
 * auto-otorga la excepción vía su YAML editable.
 *
 * @param {object} entry
 * @param {string|number} entry.issue      - `^\d+$` (CA-5).
 * @param {string} entry.fase              - enum cerrado (SEC-2).
 * @param {string} entry.agente            - clave de SKILL_SOURCES (SEC-2).
 * @param {string} entry.motivo            - motivo legible (se redacta).
 * @param {string} [entry.timestamp]       - ISO inyectable (determinismo tests).
 * @param {string} [entry.pipelineRoot]    - root del store (default padre de lib/).
 * @returns {object} la entry persistida (redactada).
 */
function upsertException(entry = {}) {
    return upsertDeliverableIndex({
        issue: entry.issue,
        fase: entry.fase,
        agente: entry.agente,
        tipo: 'exception',
        motivo: entry.motivo,
        sensible: false,
        timestamp: entry.timestamp,
        pipelineRoot: entry.pipelineRoot,
        phaseEnum: entry.phaseEnum,
    });
}

// -----------------------------------------------------------------------------
// Consultas
// -----------------------------------------------------------------------------

/**
 * Devuelve las entries del issue en una fase dada.
 * @param {string|number} issue
 * @param {string} fase
 * @param {object} [opts]
 * @returns {Array}
 */
function queryByPhase(issue, fase, opts = {}) {
    const idx = readDeliverableIndex(issue, opts);
    return idx.entries.filter((e) => e.fase === fase);
}

/**
 * Devuelve las entries del issue producidas por un agente dado (puede haber
 * más de una si el agente participa en varias fases).
 * @param {string|number} issue
 * @param {string} agente
 * @param {object} [opts]
 * @returns {Array}
 */
function queryByAgent(issue, agente, opts = {}) {
    const idx = readDeliverableIndex(issue, opts);
    return idx.entries.filter((e) => e.agente === agente);
}

module.exports = {
    upsertDeliverableIndex,
    upsertException,
    readDeliverableIndex,
    queryByPhase,
    queryByAgent,
    // Validaciones (reuso desde write-deliverable.js + tests)
    validatePhase,
    validateAgent,
    validateIssueId,
    getPhaseEnum,
    redactMeta,
    // Paths (tests / debugging)
    indexPathFor,
    deliverablesDir,
    // Constantes / helpers de test
    FALLBACK_PHASES,
    MOTIVO_MAX_CHARS,
    capMotivo,
    _resetPhaseEnumCache,
};
