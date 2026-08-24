'use strict';

// =============================================================================
// design-decision-gate-io.js — TODO el I/O del gate de decisión de arquitectura
// (#6448, A-1).
//
// POR QUÉ EXISTE ESTE MÓDULO
// --------------------------
// `detectDesignDecision()` es SÍNCRONA y NO LANZA por contrato (CA-15): corre
// dentro del intake y una excepción suya frena el pipeline entero. Meterle la
// consulta de la firma del arquitecto la volvería `async` y rompería todos sus
// call sites, incluido el fail-open del intake.
//
// Así que el detector queda PURO y todo lo que toca el mundo —la consulta a
// GitHub, la lectura de la traza local y la escritura de la auditoría— vive
// acá, con `exec` inyectable. Con eso:
//
//   · CA-12 (cero llamadas de red en el camino feliz) se cumple POR
//     CONSTRUCCIÓN: el caller sólo invoca este módulo cuando el detector YA
//     decidió escalar.
//   · CA-31 (tests sin red real) se cumple inyectando `exec`.
//
// REGLA R1 (heredada de `architect-audit.js`): sobre cualquier path de
// `audit/` se escribe SÓLO con `appendFileSync`. Un `writeFileSync` ahí trunca
// el histórico entero de auditoría. Hay test estático por grep.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { redactAll } = require('./sherlock-audit-jsonl');
const { parseGraphqlBody } = require('./gh-title-fetch');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

const GATE_AUDIT_FILE = 'design-decision-gate.jsonl';
// Traza que escribe el propio arquitecto durante su corrida
// (`lib/architect-audit.js::appendTokens`). Es el ancla de la condición (g).
const ARCHITECT_TOKENS_FILE = 'architect-tokens.jsonl';

const GH_OWNER = 'intrale';
const GH_REPO = 'platform';

// Cuántos comentarios se traen. La firma es de los últimos del issue; 60 cubre
// con holgura los issues más conversados del repo (el más largo medido tiene 13).
const COMMENTS_LIMIT = 60;

const GH_TIMEOUT_MS = 20000;

// CA-30 / RS-5.1 — tope del texto libre que entra a la traza. El fragmento ya
// viene acotado del detector (200); este techo es la segunda red.
const MAX_TEXTO_TRAZA = 240;
const MAX_ERROR = 120;

/**
 * Un solo round-trip (CA-13): la fecha de última edición del body y los
 * comentarios vienen en la MISMA query. Dos llamadas serían dos oportunidades
 * de fallar y el doble de costo en el único camino que paga red.
 *
 * CA-16 / RS-3.5 — el número va como VARIABLE TIPADA (`-F num=`), jamás
 * interpolado en el string de la query. `issueNum` nace de nombres de archivo
 * del filesystem: tratarlo como texto de una query es exactamente el patrón que
 * no se puede dejar pasar.
 */
const SIGNOFF_QUERY = `query($owner:String!,$repo:String!,$num:Int!){
  repository(owner:$owner,name:$repo){ issue(number:$num){
    lastEditedAt
    comments(last:${COMMENTS_LIMIT}){ nodes{ createdAt body authorAssociation isMinimized author{login} } }
  }}}`;

// -----------------------------------------------------------------------------
// Resolución de paths (sin bind a tiempo de carga — sirve a tests con tmpdir)
// -----------------------------------------------------------------------------

function resolvePipelineDir(opts) {
    if (opts && opts.pipelineDir) return opts.pipelineDir;
    if (opts && opts.pipelineRoot) return opts.pipelineRoot;
    // __dirname = .pipeline/lib → padre = .pipeline
    return path.resolve(__dirname, '..');
}

function auditFilePath(fileName, opts) {
    return path.join(resolvePipelineDir(opts), 'audit', fileName);
}

// -----------------------------------------------------------------------------
// Lectura de la firma (única llamada de red del gate)
// -----------------------------------------------------------------------------

/**
 * Contexto de firma de un issue: fecha de última edición del body + comentarios.
 *
 * NUNCA LANZA. Cualquier fallo (red, JSON ilegible, `errors` de GraphQL,
 * `comments` que no es array) devuelve `{ ok: false, error }` y el caller
 * ESCALA — fail-closed del carril de firma (D-3 / RS-3.1 / CA-14). El motivo
 * técnico va al log y a la traza, nunca al texto que lee el operador.
 *
 * @param {number|string} issue
 * @param {object} [opts]
 * @param {Function} [opts.exec] — inyectable para tests (CA-31). Firma de
 *   `execFileSync(file, args, options) → string`.
 * @returns {{ok: boolean, lastEditedAt: (string|null), comments: Array, error: (string|null)}}
 */
function fetchSignoffContext(issue, { exec = execFileSync } = {}) {
    const fallo = (motivo) => ({
        ok: false, lastEditedAt: null, comments: [], error: String(motivo).slice(0, MAX_ERROR),
    });
    let n;
    try {
        n = Number(issue);
        // CA-16 — validación ANTES de armar el comando.
        if (!Number.isInteger(n) || n <= 0) return fallo(`issue no es un entero positivo: ${String(issue).slice(0, 40)}`);
    } catch (e) {
        return fallo(`issue ilegible: ${(e && e.message) || e}`);
    }

    let salida;
    try {
        salida = exec('gh', [
            'api', 'graphql',
            '-f', `query=${SIGNOFF_QUERY}`,
            '-f', `owner=${GH_OWNER}`,
            '-f', `repo=${GH_REPO}`,
            '-F', `num=${n}`,
        ], { encoding: 'utf8', timeout: GH_TIMEOUT_MS });
    } catch (e) {
        // `gh` imprime el body con `errors` en stdout aunque salga con exit≠0:
        // se intenta parsear igual antes de darlo por perdido.
        salida = (e && (e.stdout || (e.output && e.output[1]))) || '';
        if (!salida) return fallo(`gh falló: ${(e && e.message) || e}`);
    }

    let cuerpo;
    try {
        // Parser compartido (no uno nuevo): tolera exit≠0 y distingue el error
        // transitorio del 404 genuino.
        cuerpo = parseGraphqlBody(String(salida || ''));
    } catch (e) {
        return fallo(`respuesta ilegible: ${(e && e.message) || e}`);
    }
    if (!cuerpo || cuerpo.ok !== true) return fallo('respuesta de GitHub ilegible');
    if (cuerpo.transient) return fallo('GitHub devolvió un error transitorio');
    const iss = cuerpo.repo && cuerpo.repo.issue;
    if (!iss || typeof iss !== 'object') return fallo('la respuesta no trajo el issue');

    const nodos = iss.comments && Array.isArray(iss.comments.nodes) ? iss.comments.nodes : null;
    if (!nodos) return fallo('la respuesta no trajo un array de comentarios');

    return {
        ok: true,
        // `null` significa "body nunca editado" y el detector lo lee como "no
        // hay edición posterior" (CA-5). NUNCA se sustituye por `updatedAt`:
        // ese cambia con cualquier comentario o label y invalidaría toda firma,
        // haciendo que el gate frene MÁS que hoy.
        lastEditedAt: iss.lastEditedAt == null ? null : String(iss.lastEditedAt),
        comments: nodos,
        error: null,
    };
}

// -----------------------------------------------------------------------------
// Corroboración local de la firma (condición (g) de D-1 — A-8)
// -----------------------------------------------------------------------------

/**
 * ¿La traza local del arquitecto corrobora que firmó este issue?
 *
 * Es el único discriminador que NO escribe el LLM: lo escribe
 * `lib/architect-audit.js` durante la corrida del arquitecto. Una inyección que
 * viaja por el body de un issue público hasta la salida de texto de otro agente
 * no puede producir una línea acá.
 *
 * Es lectura LOCAL: no cuenta contra CA-12 ni CA-13, que hablan de red.
 *
 * NUNCA LANZA. `available: false` (archivo inexistente, ilegible o vacío) es la
 * ÚNICA excepción y se da por cumplida la condición (CA-34): `.pipeline/audit/`
 * está gitignored y un respawn la borra; hacerlo fail-closed dejaría el gate
 * frenando más que hoy, que es el anti-patrón que este issue cierra.
 *
 * @param {number|string} issue
 * @param {object} [opts]
 * @param {string} [opts.pipelineRoot] — raíz `.pipeline/` (tests con tmpdir).
 * @returns {{available: boolean, corroborated: boolean}}
 */
function readSignoffAudit(issue, opts = {}) {
    const file = auditFilePath(ARCHITECT_TOKENS_FILE, opts);
    let crudo;
    try {
        const n = Number(issue);
        if (!Number.isInteger(n) || n <= 0) return { available: false, corroborated: false };
        crudo = fs.readFileSync(file, 'utf8');
        if (!crudo || !crudo.trim()) return { available: false, corroborated: false };

        // Barrido por líneas con CORTE TEMPRANO: el archivo real ya tiene ~1000
        // líneas / 360 KB y crece append-only. Ni `JSON.parse` del archivo
        // entero, ni acumulación de todas las entradas.
        for (const linea of crudo.split(/\r?\n/)) {
            if (!linea || linea.charCodeAt(0) !== 123 /* '{' */) continue;
            let rec;
            try { rec = JSON.parse(linea); } catch { continue; }  // línea rota: se saltea, no invalida el barrido
            if (!rec || typeof rec !== 'object') continue;
            if (Number(rec.issue_id) !== n) continue;
            if (String(rec.skill) !== 'architect') continue;
            if (String(rec.decision) !== 'signoff') continue;
            return { available: true, corroborated: true };
        }
        return { available: true, corroborated: false };
    } catch {
        // Inexistente o ilegible ⇒ ausencia de la fuente no es evidencia en
        // contra (CA-34, mismo principio que CA-5).
        return { available: false, corroborated: false };
    }
}

// -----------------------------------------------------------------------------
// Traza auditable (punto 5 del issue — CA-27..CA-30)
// -----------------------------------------------------------------------------

/** Recorta y redacta cualquier texto libre que entre a la traza (CA-30). */
function textoTraza(v, max = MAX_TEXTO_TRAZA) {
    if (v == null) return '';
    const s = String(redactAll(String(v))).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) : s;
}

/**
 * Append-only a `.pipeline/audit/design-decision-gate.jsonl`.
 *
 * OBJETIVO OPERATIVO (punto 5 del issue): hoy no hay forma de saber cuántas
 * veces el gate frenó de más. Con esto la tasa de falsos positivos se mide en
 * vez de discutirse.
 *
 * Registra TAMBIÉN las verificaciones de firma RECHAZADAS con su motivo
 * (CA-28 / RS-5.2): sin el negativo sólo se cuentan falsos positivos y no se
 * detecta un intento de bypass.
 *
 * NUNCA LANZA: una traza que no se pudo escribir no puede frenar el intake.
 *
 * @returns {boolean} true si se escribió.
 */
function appendGateAudit(record, opts = {}) {
    try {
        const r = record && typeof record === 'object' ? record : {};
        const rechazados = (Array.isArray(r.signoff_rejected) ? r.signoff_rejected : [])
            .slice(0, 10)
            .map((x) => ({
                createdAt: textoTraza(x && x.createdAt, 40),
                motivo: textoTraza(x && x.motivo, 80),
            }));
        const linea = {
            timestamp: new Date().toISOString(),
            issue: Number(r.issue) || null,
            signals: (Array.isArray(r.signals) ? r.signals : []).map((s) => textoTraza(s, 60)),
            // El fragmento llega YA REDACTADO del detector (CA-27): este writer
            // no lo re-arma. La segunda pasada de `textoTraza` es sólo el techo.
            fragment: textoTraza(r.fragment),
            signoff_present: r.signoff_present === true,
            signoff_reason: textoTraza(r.signoff_reason, 160),
            signoff_rejected: rechazados,
            signoff_corroboracion: r.signoff_corroboracion === undefined ? null : r.signoff_corroboracion,
            escalated: r.escalated === true,
            error: r.error == null ? null : textoTraza(r.error, MAX_ERROR),
        };
        appendJsonl(auditFilePath(GATE_AUDIT_FILE, opts), linea);
        return true;
    } catch {
        return false;
    }
}

/**
 * Traza de cada destrabe (CA-29 / RS-4.4): issue, fase, marker y qué lo originó.
 * Mismo archivo y mismas reglas que `appendGateAudit`. Nunca lanza.
 */
function appendUnblockAudit({ issue, pipeline, phase, skill, action, origin } = {}, opts = {}) {
    try {
        appendJsonl(auditFilePath(GATE_AUDIT_FILE, opts), {
            timestamp: new Date().toISOString(),
            evento: 'unblock',
            issue: Number(issue) || null,
            pipeline: textoTraza(pipeline, 40),
            phase: textoTraza(phase, 40),
            skill: textoTraza(skill, 40),
            action: textoTraza(action, 40),
            origin: textoTraza(origin, 80),
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * REGLA R1 — la ÚNICA escritura permitida sobre `audit/`. Append, nunca
 * truncado. Está en una función sola para que el test estático por grep tenga
 * un solo lugar que auditar.
 */
function appendJsonl(file, record) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

module.exports = {
    fetchSignoffContext,
    readSignoffAudit,
    appendGateAudit,
    appendUnblockAudit,
    // Constantes / helpers expuestos para los tests.
    GATE_AUDIT_FILE,
    ARCHITECT_TOKENS_FILE,
    SIGNOFF_QUERY,
    COMMENTS_LIMIT,
    MAX_TEXTO_TRAZA,
    textoTraza,
};
