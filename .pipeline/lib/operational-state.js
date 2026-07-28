// =============================================================================
// operational-state.js — Envoltorio único de acceso al estado operativo (#5108).
//
// Qué resuelve
// ------------
// Hoy el estado operativo del pipeline se toca desde ~193 lugares distintos, y
// cada uno conoce la ruta física del archivo que lee o escribe. Mientras siga
// así, mover ese estado a otro lado (#5107, Ola 9.4) es inviable: habría que
// reescribir cada punto de acceso, con riesgo de dejar la mitad leyendo el
// archivo viejo y la otra mitad el destino nuevo — dos fuentes de verdad.
//
// Este módulo es la única puerta de entrada. NO cambia dónde vive el dato ni el
// formato de los archivos: compone la superficie ya existente de `waves.js`
// (registro de olas) y `partial-pause.js` (allowlist efectiva de dispatch).
//
// Dirección de dependencia (INVARIANTE — ver test anti-ciclo)
// ----------------------------------------------------------
//     operational-state.js ──requiere──▶ waves.js
//                          ──requiere──▶ partial-pause.js
//             ▲
//             └── consumidores (migración en #5109)
//
// `partial-pause.js` ya requiere `waves.js` en top-level, y `waves.js` requiere
// `partial-pause.js` de forma DIFERIDA (dentro de la función) justo para esquivar
// el ciclo. La fachada respeta esa dirección y compone hacia abajo. Está
// PROHIBIDO agregar `require('./operational-state')` en cualquiera de los dos
// módulos base: rompería la carga por ciclo.
//
// Dos conceptos de "allowlist" — NO son lo mismo
// ----------------------------------------------
// La ambigüedad histórica entre estos dos es la razón de que el invariante de
// no-path se cumpliera siempre a medias. Acá tienen nombres distintos:
//
//   1. ALCANCE DE LA OLA — `getWaveScopeIssues()`
//      Derivado del registro de olas: proyección de los issues de la ola activa
//      filtrando los `completed`. Es SÓLO LECTURA: no se escribe, se deriva.
//      NO gatea el dispatch.
//
//   2. ALLOWLIST EFECTIVA — `getDispatchState()` / `isIssueAllowed()` / mutadores
//      El estado que REALMENTE gatea el dispatch del Pulpo. Escribible y
//      gateado por autorización (#3625).
//
// Semántica de dispatch preservada (#5060 — fail-closed)
// ------------------------------------------------------
// La fachada NO cambia ninguno de los tres modos vigentes:
//
//   paused        → deniega todo (halt total explícito, marker separado).
//   partial_pause → permite sólo los issues de la allowlist efectiva.
//   running       → DENIEGA (no es barra libre). Sin allowlist no hay ola
//                   vigente que acote el dispatch. El único escape es
//                   `PIPELINE_ALLOW_UNSCOPED_DISPATCH=1`, apagado por default.
//
// El incidente #5060 (2026-07-26) fue exactamente el fail-open contrario: al
// cerrarse una ola se vació la allowlist, el modo cayó a `running`, y el Pulpo
// dispatchó ~320 agentes sobre el backlog histórico. El disparador NO es
// hipotético: es el fin de ola normal. Hay un test de contrato que falla si esta
// fachada reintroduce ese fail-open.
//
// Autorización obligatoria en mutadores de allowlist (#3625)
// ----------------------------------------------------------
// El gate de autorización de `partial-pause.js` corre en GRACE MODE por default
// (sólo es estricto con `PARTIAL_PAUSE_STRICT_AUTH=1`), o sea que un caller sin
// `authorizedBy` pasaría en silencio con un warning. Por eso la fachada exige
// `authorizedBy` + `justification` en la propia firma y los propaga SIN default:
// llamar sin ellos tira `OperationalStateError`.
//
// La fachada NO inventa un `authorizedBy` genérico propio: colapsaría la
// trazabilidad de ~29 callers en una sola identidad y volvería inútil el audit
// trail. Cada caller declara el suyo (enum cerrado en `partial-pause-audit`).
//
// Fuera de alcance en esta historia
// ---------------------------------
// - NO se migran consumidores (eso es #5109).
// - NO se modifica ni deprecia la superficie de `waves.js` / `partial-pause.js`.
// - NO se cambia el formato ni la ubicación de los archivos.
// R8 (revertible en minutos) = borrar este módulo y sus tests.
//
// Contrato completo y tabla de garantías: `docs/pipeline/contrato-estado-operativo.md`
// =============================================================================

'use strict';

const fs = require('fs');
const waves = require('./waves');
const partialPause = require('./partial-pause');
const { withLockSync } = require('./file-lock');
const { notifyTelegram } = require('./notify-telegram');

const LOCK_TIMEOUT_MS = 5000;
const LOCK_MAX_RETRIES = 3;

// -----------------------------------------------------------------------------
// Errores tipados (fail-closed). Referencia de diseño: `kernel-store.js`.
//
// Regla: ante estado corrupto NUNCA se devuelve un resultado parcial. Se tira un
// error tipado que nombra la etapa (`stage`) y el campo inválido (`field`).
// -----------------------------------------------------------------------------

class OperationalStateError extends Error {
    constructor(message, opts = {}) {
        super(message);
        this.name = 'OperationalStateError';
        this.code = opts.code || 'EOPSTATE';
        this.stage = opts.stage || null;
        if (opts.cause !== undefined) this.cause = opts.cause;
    }
}

class OperationalStateValidationError extends OperationalStateError {
    constructor(message, opts = {}) {
        super(message, { ...opts, code: opts.code || 'EOPSTATE_VALIDATION' });
        this.name = 'OperationalStateValidationError';
        this.field = opts.field || null;
        this.errors = Array.isArray(opts.errors) ? opts.errors : [];
    }
}

// Códigos de `waves.loadStateStrict()` que significan "el estado de disco no es
// confiable". Todos se traducen a `OperationalStateValidationError`.
const STRICT_READ_CODES = new Set([
    'EWAVES_READ',       // no se pudo leer el archivo
    'EWAVES_JSON',       // JSON inválido
    'EWAVES_SCHEMA',     // shape inválida
    'EWAVES_INTEGRITY',  // hash de integridad no coincide (corrupción / tampering)
]);

// Los mensajes de `validateStateStrict` arrancan con la ruta del campo inválido
// (ej. `active_wave.issues[0].number debe ser entero positivo`). Extraemos ese
// primer token para poblar `err.field` sin re-parsear el estado.
function firstInvalidField(errors) {
    if (!Array.isArray(errors) || errors.length === 0) return null;
    const token = String(errors[0]).trim().split(/\s+/)[0];
    return token || null;
}

function toValidationError(err, stage) {
    if (err && STRICT_READ_CODES.has(err.code)) {
        const errors = Array.isArray(err.errors) && err.errors.length > 0
            ? err.errors
            : [err.message];
        return new OperationalStateValidationError(
            `estado operativo inválido (${stage}): ${err.message}`,
            { stage, code: err.code, field: firstInvalidField(errors), errors, cause: err },
        );
    }
    return new OperationalStateError(
        `lectura del estado operativo falló (${stage}): ${err && err.message ? err.message : err}`,
        { stage, cause: err },
    );
}

// -----------------------------------------------------------------------------
// Olas · lectura
//
// Todas las lecturas parten de UN snapshot estricto (`waves.loadStateStrict()`),
// que valida shape + integridad y tira si algo no cierra. Las proyecciones se
// derivan de ese mismo snapshot: ningún consumidor recibe datos parciales ni una
// vista compuesta de dos lecturas distintas.
// -----------------------------------------------------------------------------

function deepClone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function normalizeIssue(issue) {
    const n = Number(String(issue).replace(/^#/, '').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Snapshot validado del registro de olas. Fail-closed: tira
 * `OperationalStateValidationError` si el estado de disco está corrupto.
 *
 * @returns {Object} estado completo validado
 * @throws {OperationalStateValidationError|OperationalStateError}
 */
function readWaveStateStrict() {
    try {
        return waves.loadStateStrict();
    } catch (err) {
        throw toValidationError(err, 'read:waves');
    }
}

function plannedOf(state) {
    return Array.isArray(state.planned_waves) ? state.planned_waves : [];
}

function archivedOf(state) {
    return Array.isArray(state.archived_waves) ? state.archived_waves : [];
}

/**
 * Ola activa, o `null` si no hay ninguna.
 * @returns {Object|null}
 */
function getActiveWave() {
    const state = readWaveStateStrict();
    return state.active_wave ? deepClone(state.active_wave) : null;
}

/**
 * Ola planificada por número, o `null`.
 * @param {number} waveNumber
 * @returns {Object|null}
 */
function getPlannedWave(waveNumber) {
    const state = readWaveStateStrict();
    const w = plannedOf(state).find((x) => x && x.number === waveNumber);
    return w ? deepClone(w) : null;
}

/**
 * Todas las olas en orden: activa → planificadas → archivadas, cada una con
 * `status` explícito.
 * @returns {Array<Object>}
 */
function listWaves() {
    const state = readWaveStateStrict();
    const out = [];
    if (state.active_wave) out.push({ ...deepClone(state.active_wave), status: 'active' });
    for (const w of plannedOf(state)) out.push({ ...deepClone(w), status: 'planned' });
    for (const w of archivedOf(state)) out.push({ ...deepClone(w), status: 'archived' });
    return out;
}

/**
 * Horizonte de planificación: ola activa + N planificadas.
 * @param {number} [N=5]
 * @returns {Array<Object>}
 */
function getHorizon(N) {
    const limit = Number.isInteger(N) && N > 0 ? N : 5;
    const state = readWaveStateStrict();
    const out = [];
    if (state.active_wave) out.push({ ...deepClone(state.active_wave), status: 'active' });
    for (const w of plannedOf(state).slice(0, limit)) {
        out.push({ ...deepClone(w), status: 'planned' });
    }
    return out;
}

/**
 * Issues que bloquean al dado, según las dependencias declaradas.
 * @param {number|string} issueNumber
 * @returns {number[]}
 */
function getBlockingIssues(issueNumber) {
    const n = normalizeIssue(issueNumber);
    if (!n) return [];
    const state = readWaveStateStrict();
    const deps = Array.isArray(state.dependencies) ? state.dependencies : [];
    return deps
        .filter((d) => d && normalizeIssue(d.blocked) === n)
        .map((d) => normalizeIssue(d.blocker))
        .filter(Boolean);
}

/**
 * Token de versión del estado actual (ETag para escrituras condicionales — lo
 * consume #5113). Se devuelve tal cual al mutador en `meta.expectedVersion`.
 * @returns {string|null}
 */
function getVersion() {
    return waves.versionToken(readWaveStateStrict());
}

/**
 * Token de versión de un snapshot ya leído (función pura).
 * @param {Object} state
 * @returns {string|null}
 */
function versionToken(state) {
    return waves.versionToken(state);
}

// -----------------------------------------------------------------------------
// Olas · mutación
//
// La superficie de escritura son FUNCIONES DE MUTACIÓN, no un `save(snapshot)`.
// Cada una delega en la variante ya existente de `waves.js`, que hace el
// read-modify-write COMPLETO dentro del lock (con `invalidateCache()` antes de
// leer).
//
// Exponer `save(estadoCompleto)` sería el bug: el caller leería el snapshot
// FUERA del lock, mutaría en memoria, y el segundo escritor pisaría al primero
// — archivo válido pero actualización perdida. Por eso NO se exporta.
//
// Los errores de dominio de `waves.js` (`EWAVES_SHAPE`, `EWAVES_NOT_FOUND`,
// `EWAVES_VERSION_CONFLICT`, …) se propagan TAL CUAL: las capas HTTP ya los
// mapean a códigos de estado, y envolverlos rompería a los consumidores que
// migren en #5109.
// -----------------------------------------------------------------------------

/** Agrega un issue a una ola (activa o planificada). */
function addIssueToWave(waveNumber, issue, meta = {}) {
    return waves.addIssueToWave(waveNumber, issue, meta);
}

/** Quita un issue de una ola planificada (la activa está bloqueada por contrato). */
function removeIssueFromWave(waveNumber, issueNumber, meta = {}) {
    return waves.removeIssueFromWave(waveNumber, issueNumber, meta);
}

/** Marca issues como `completed` en la ola activa (poda del desync reductivo). */
function markIssuesCompletedInActiveWave(numbers, meta = {}) {
    return waves.markIssuesCompletedInActiveWave(numbers, meta);
}

/** Declara la dependencia padre → hijos. */
function addDependency(parent, blockedBy, meta = {}) {
    return waves.addDependency(parent, blockedBy, meta);
}

/** Crea una ola planificada. */
function createPlannedWave(spec, meta = {}) {
    return waves.createPlannedWave(spec, meta);
}

/** Edita metadata de una ola planificada. */
function editWave(waveNumber, patch, meta = {}) {
    return waves.editWave(waveNumber, patch, meta);
}

/** Da de baja una ola planificada. */
function deletePlannedWave(waveNumber, meta = {}) {
    return waves.deletePlannedWave(waveNumber, meta);
}

/** Reordena las olas planificadas. */
function reorderPlannedWaves(newOrder, meta = {}) {
    return waves.reorderPlannedWaves(newOrder, meta);
}

/**
 * Promueve una ola planificada a activa.
 *
 * Por default usa la variante TRANSACCIONAL (`promoteWaveAtomic`), que coordina
 * el registro de olas y la allowlist efectiva con marker + recovery de boot. La
 * variante no transaccional sigue disponible con `{ atomic: false }` para los
 * callers históricos que sólo tocan el registro.
 *
 * @param {number} waveNumber
 * @param {Object} [metadata] — `{ atomic?: boolean, updated_by?, source?, note?, ... }`
 */
function promoteWave(waveNumber, metadata = {}) {
    const { atomic = true, ...rest } = metadata || {};
    return atomic
        ? waves.promoteWaveAtomic(waveNumber, rest)
        : waves.promoteWaveToActive(waveNumber, rest);
}

/** Archiva una ola (transaccional, con recovery de boot). */
function archiveWave(waveNumber, metadata = {}) {
    return waves.archiveWave(waveNumber, metadata);
}

// -----------------------------------------------------------------------------
// Alcance de la ola (derivado, SÓLO LECTURA)
//
// Proyección de los issues de la ola activa filtrando los `completed`. NO es la
// allowlist que gatea el dispatch — para eso está `isIssueAllowed()`.
// -----------------------------------------------------------------------------

/**
 * Issues en alcance de la ola activa (derivado, no escribible).
 * @returns {number[]}
 */
function getWaveScopeIssues() {
    // Delega en `waves.getAllowlist()` para preservar su efecto colateral de
    // alerta dedupada por boot cuando no hay ola activa (#3616).
    return waves.getAllowlist();
}

// -----------------------------------------------------------------------------
// Allowlist efectiva · lectura (gate real de dispatch)
// -----------------------------------------------------------------------------

/**
 * Estado de dispatch vigente.
 * @returns {{ mode: 'running'|'paused'|'partial_pause', allowedIssues: number[],
 *   allowedSkills: string[], createdAt: string|null, source: string|null,
 *   acceptedDepRisk: boolean, depSources: Object|null }}
 */
function getDispatchState() {
    return partialPause.getPipelineMode();
}

/**
 * ¿Puede procesarse este issue? Tabla de verdad (#5060):
 *   paused        → false
 *   partial_pause → issue ∈ allowlist
 *   running       → false, salvo `PIPELINE_ALLOW_UNSCOPED_DISPATCH=1`
 * @param {number|string} issue
 * @returns {boolean}
 */
function isIssueAllowed(issue) {
    return partialPause.isIssueAllowed(issue);
}

/** Variante pura de `isIssueAllowed` sobre un estado ya leído. */
function isIssueAllowedInState(issue, state) {
    return partialPause.isIssueAllowedInState(issue, state);
}

/**
 * ¿Puede correr este skill? Hermana semántica indexada por skill. NO le aplica
 * el fail-closed de issues: los skills del control-plane (smoke-tests,
 * harnesses de diagnóstico) no consumen backlog y deben seguir corriendo entre
 * olas — denegarlos dejaría al pipeline sin diagnóstico justo cuando no hay ola.
 */
function isSkillAllowed(skillName) {
    return partialPause.isSkillAllowed(skillName);
}

/** Variante pura de `isSkillAllowed` sobre un estado ya leído. */
function isSkillAllowedInState(skillName, state) {
    return partialPause.isSkillAllowedInState(skillName, state);
}

/**
 * ¿Está prendido el escape hatch de dispatch sin ola? Es la ÚNICA vía de
 * dispatch sin allowlist y jamás debe quedar prendido en operación normal.
 * @returns {boolean}
 */
function unscopedDispatchEnabled() {
    return partialPause.unscopedDispatchEnabled();
}

// -----------------------------------------------------------------------------
// Allowlist efectiva · mutación — `authorizedBy` + `justification` OBLIGATORIOS
// -----------------------------------------------------------------------------

function requireAuthorization(fnName, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (!o.authorizedBy || typeof o.authorizedBy !== 'string' || !o.authorizedBy.trim()) {
        throw new OperationalStateError(
            `${fnName} requiere authorizedBy (#3625): identificá quién autoriza la mutación ` +
            'con un valor del enum cerrado de partial-pause-audit.',
            { code: 'EOPSTATE_UNAUTHORIZED', stage: `mutate:${fnName}` },
        );
    }
    if (!o.justification || typeof o.justification !== 'string' || !o.justification.trim()) {
        throw new OperationalStateError(
            `${fnName} requiere justification (#3625): explicá por qué se muta la allowlist.`,
            { code: 'EOPSTATE_UNAUTHORIZED', stage: `mutate:${fnName}` },
        );
    }
    // Propagados SIN default ni reescritura: el audit trail debe conservar la
    // identidad real del caller, no una identidad genérica de la fachada.
    return o;
}

// El path del marker no se conoce acá: se lo pedimos al módulo dueño del estado.
function dispatchMarkerPath() {
    return partialPause._paths().PARTIAL_FILE;
}

/**
 * Ejecuta `fn` con el lock del marker de allowlist tomado. `withLockSync` es
 * reentrante por proceso (pid + startTime), así que el lock que toma
 * `setPartialPause` adentro se comparte con éste en vez de deadlockear. Esto
 * hace que el read-modify-write de `addToAllowlist`/`removeFromAllowlist` sea
 * atómico frente a otros escritores del MISMO proceso.
 *
 * Frente a escritores de OTROS procesos el lock es de archivo, así que también
 * serializa. Ver la tabla de garantías del contrato.
 */
function withDispatchLock(fn) {
    return withLockSync(dispatchMarkerPath(), fn, {
        component: 'operational-state-lock',
        timeoutMs: LOCK_TIMEOUT_MS,
        maxRetries: LOCK_MAX_RETRIES,
        notify: notifyTelegram,
    });
}

/**
 * Reemplaza la allowlist efectiva completa.
 *
 * REEMPLAZO, no merge: lo que el caller NO declara en `opts` no se conserva
 * (skills, dep_sources, metadata de ola). Es la semántica deliberada de un
 * setter — para mutaciones incrementales que preservan el resto del marker
 * están `addToAllowlist` / `removeFromAllowlist`.
 *
 * OJO (semántica vigente preservada): con lista de issues Y de skills vacías,
 * esto equivale a un `clearAllowlist()` — se borra el marker y el modo cae a
 * `running`, que DENIEGA (#5060). No es "habilitar todo".
 *
 * @param {Array<number|string>} issues
 * @param {{ authorizedBy: string, justification: string, source?: string,
 *   acceptedDepRisk?: boolean, depSources?: Object, authorizationTtls?: Object,
 *   allowedSkills?: string[], extra?: Object }} opts
 */
function setAllowlist(issues, opts = {}) {
    return partialPause.setPartialPause(issues, requireAuthorization('setAllowlist', opts));
}

/**
 * Variante transaccional de `setAllowlist`: nunca borra el marker (lista vacía
 * escribe un JSON válido con `allowed_issues: []`) y devuelve el snapshot previo
 * para que el caller pueda hacer rollback. La usa la promoción de ola.
 */
function setAllowlistAtomic(issues, opts = {}) {
    return partialPause.setPartialPauseAtomic(issues, requireAuthorization('setAllowlistAtomic', opts));
}

// -----------------------------------------------------------------------------
// RMW COMPLETO del marker (fix del rebote rev-1 · security)
//
// `partialPause.readPreviousAllowlist()` devuelve SÓLO `allowed_issues`, y
// `setPartialPause()` reescribe el marker DESDE CERO. Un read-modify-write que
// lea sólo el eje issues destruye en silencio todo lo demás del marker:
// `allowed_skills` (el gate de skills #3680), `dep_sources` /
// `accepted_dep_risk` (#2893), `wave_number` / `wave_name` (#4030) y `source`
// (audit trail #3625, que quedaba en "unknown").
//
// Eso no era sólo pérdida de metadata: era un ENSANCHAMIENTO de autorización.
// Al perderse `allowed_skills`, un `addToAllowlist` de un issue apagaba la
// ventana de skills; y al vaciar los issues, el marker se borraba, el modo caía
// a `running` y — como el gate de skills NO es fail-closed en `running`
// (`partial-pause.js`: `if (state.mode === 'running') return true`) — quedaban
// permitidos TODOS los skills, `delivery` (el que mergea a main) incluido. El
// caller pedía quitar un issue y terminaba levantando una restricción que nunca
// pidió levantar.
//
// Por eso el RMW lee el marker COMPLETO (raw) dentro del mismo lock y
// re-propaga cada campo al `opts` de `setPartialPause`. No se usa
// `getPipelineMode()` para esto por dos razones: (1) no devuelve
// `wave_number`/`wave_name`/`wave_goal`, y (2) con `.paused` presente devuelve
// el estado `paused` con listas vacías, así que un RMW durante un halt total
// borraría igual los skills del marker de allowlist.
//
// La ruta física NO se conoce acá: se la pedimos al módulo dueño del estado
// (`dispatchMarkerPath()`), igual que hace el lock. El invariante de §2 del
// contrato se mantiene.
// -----------------------------------------------------------------------------

/** Lee el marker de allowlist crudo y completo. `null` si no existe o no parsea. */
function readDispatchMarkerRaw() {
    try {
        const parsed = JSON.parse(fs.readFileSync(dispatchMarkerPath(), 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        // Marker ausente o ilegible: no hay nada que preservar. Fail-closed en el
        // sentido que importa acá — no inventamos campos que no leímos.
        return null;
    }
}

/** Issues del marker crudo, normalizados igual que `partial-pause`. */
function markerIssues(marker) {
    const arr = marker && Array.isArray(marker.allowed_issues) ? marker.allowed_issues : [];
    return arr.map(normalizeIssue).filter(Boolean);
}

function normalizeSkills(list) {
    return Array.isArray(list)
        ? [...new Set(list.filter((s) => typeof s === 'string').map((s) => s.trim()).filter(Boolean))].sort()
        : [];
}

/**
 * Traduce los campos preservables del marker crudo a claves del `opts` que
 * consume `setPartialPause`. Todo lo que NO esté acá se pierde en cada write:
 * si mañana el marker gana un campo, se agrega en este mapa.
 */
function preservedOptsFromMarker(marker) {
    if (!marker) return {};
    const out = {};
    const skills = normalizeSkills(marker.allowed_skills);
    if (skills.length > 0) out.allowedSkills = skills;
    if (marker.accepted_dep_risk === true) out.acceptedDepRisk = true;
    if (marker.dep_sources && typeof marker.dep_sources === 'object') out.depSources = marker.dep_sources;
    if (marker.authorization_ttls && typeof marker.authorization_ttls === 'object') {
        out.authorizationTtls = marker.authorization_ttls;
    }
    if (typeof marker.source === 'string' && marker.source.trim()) out.source = marker.source;
    if (Number.isInteger(marker.wave_number) && marker.wave_number > 0) out.waveNumber = marker.wave_number;
    if (typeof marker.wave_name === 'string' && marker.wave_name.trim()) out.waveName = marker.wave_name;
    if (typeof marker.wave_goal === 'string' && marker.wave_goal.trim()) out.waveGoal = marker.wave_goal;
    return out;
}

/**
 * Merge de preservados + declarados. El caller PISA lo preservado, pero sólo en
 * las claves que declara explícitamente: una clave ausente (o `undefined`)
 * conserva el valor del marker en vez de resetearlo.
 */
function mergeDeclaredOverPreserved(preserved, declared) {
    const out = { ...preserved };
    for (const [k, v] of Object.entries(declared || {})) {
        if (v !== undefined) out[k] = v;
    }
    return out;
}

/**
 * Agrega issues a la allowlist efectiva preservando los existentes **y el resto
 * del marker** (skills, dep_sources, accepted_dep_risk, metadata de ola,
 * source). Read-modify-write completo bajo el lock del marker.
 *
 * El caller puede pisar cualquier campo declarándolo en `opts` (ej. mandar
 * `allowedSkills` reemplaza la ventana de skills); lo que NO declara se
 * conserva.
 */
function addToAllowlist(issues, opts = {}) {
    const authorized = requireAuthorization('addToAllowlist', opts);
    const toAdd = (Array.isArray(issues) ? issues : [issues])
        .map(normalizeIssue)
        .filter(Boolean);
    return withDispatchLock(() => {
        const marker = readDispatchMarkerRaw();
        const current = markerIssues(marker);
        const merged = [...new Set([...current, ...toAdd])].sort((a, b) => a - b);
        const effective = mergeDeclaredOverPreserved(preservedOptsFromMarker(marker), authorized);

        // Un `add` jamás debe BORRAR el marker. Si no quedó nada que habilitar
        // (nada para agregar y marker vacío/ausente), `setPartialPause([])`
        // delegaría en `clearPartialPause` — un clear disfrazado de add. No-op.
        if (merged.length === 0 && normalizeSkills(effective.allowedSkills).length === 0) {
            return {
                ok: true,
                noop: true,
                allowedIssues: [],
                allowedSkills: [],
                msg: 'addToAllowlist sin efecto: no hay issues válidos para agregar',
            };
        }
        return partialPause.setPartialPause(merged, effective);
    });
}

/**
 * Quita issues de la allowlist efectiva preservando el resto **y el resto del
 * marker**. Read-modify-write completo bajo el lock del marker.
 *
 * Borrar el gate tiene que ser DELIBERADO, no un efecto colateral de un
 * `remove`. Por eso, si la remoción vaciaría `allowed_issues`:
 *
 *   - con `allowed_skills` activos → se conserva la ventana de skills: el marker
 *     queda con `allowed_issues: []` y el modo sigue en `partial_pause`
 *     (dispatch de issues denegado, gate de skills intacto).
 *   - sin skills → se RECHAZA (`ok: false`, `reason: 'would-clear-allowlist'`)
 *     y no se escribe nada. Vaciar la allowlist se pide con `clearAllowlist()`,
 *     que es explícito y audita como `clear`. El caller que igual quiera el
 *     clear desde acá lo declara con `allowClear: true`.
 *
 * El motivo es de autorización, no de prolijidad: al borrarse el marker el modo
 * cae a `running`, donde el gate de skills pasa de restrictivo a permisivo (deja
 * pasar TODOS los skills, `delivery` incluido).
 */
function removeFromAllowlist(issues, opts = {}) {
    const authorized = requireAuthorization('removeFromAllowlist', opts);
    const { allowClear = false, ...declared } = authorized;
    const toRemove = new Set(
        (Array.isArray(issues) ? issues : [issues]).map(normalizeIssue).filter(Boolean),
    );
    return withDispatchLock(() => {
        const marker = readDispatchMarkerRaw();
        const current = markerIssues(marker);
        const remaining = current.filter((n) => !toRemove.has(n));
        const effective = mergeDeclaredOverPreserved(preservedOptsFromMarker(marker), declared);
        const skills = normalizeSkills(effective.allowedSkills);

        if (remaining.length === 0 && skills.length === 0 && !allowClear) {
            return {
                ok: false,
                rejected: true,
                reason: 'would-clear-allowlist',
                allowedIssues: current,
                allowedSkills: skills,
                msg: 'removeFromAllowlist NO aplicado: vaciaría la allowlist y borraría el marker, ' +
                     'lo que degrada el modo a `running` y ensancha el gate de skills (los permite ' +
                     'todos, delivery incluido). Vaciarla es una decisión explícita: usá ' +
                     'clearAllowlist(), o declará `allowClear: true` en el opts.',
            };
        }
        return partialPause.setPartialPause(remaining, effective);
    });
}

/** Vacía la allowlist efectiva (borra el marker → modo `running` → deniega). */
function clearAllowlist(opts = {}) {
    return partialPause.clearPartialPause(requireAuthorization('clearAllowlist', opts));
}

/** Levanta TODO modo de pausa (total + parcial). Equivalente a `/resume`. */
function resumeAll(opts = {}) {
    return partialPause.resumeAll(requireAuthorization('resumeAll', opts));
}

/** Activa el halt total. Marker separado y explícito: gana sobre la allowlist. */
function setFullPause(opts = {}) {
    return partialPause.setFullPause(requireAuthorization('setFullPause', opts));
}

/** Levanta el halt total. NO toca la allowlist efectiva. */
function clearFullPause(opts = {}) {
    return partialPause.clearFullPause(requireAuthorization('clearFullPause', opts));
}

/**
 * Origen de la pausa total: `config-corruption-halt` (auto) vs manual.
 * Fail-closed: cualquier marker ambiguo se reporta como manual, para que un
 * auto-recovery jamás pise una pausa puesta a propósito por el operador.
 */
function readFullPauseOrigin() {
    return partialPause.readFullPauseOrigin();
}

// -----------------------------------------------------------------------------

module.exports = {
    // ── Olas · lectura ───────────────────────────────────────────────────────
    getActiveWave,
    getPlannedWave,
    listWaves,
    getHorizon,
    getBlockingIssues,
    getVersion,
    versionToken,
    // ── Olas · mutación (read-modify-write bajo lock) ────────────────────────
    addIssueToWave,
    removeIssueFromWave,
    markIssuesCompletedInActiveWave,
    addDependency,
    createPlannedWave,
    editWave,
    deletePlannedWave,
    reorderPlannedWaves,
    promoteWave,
    archiveWave,
    // ── Alcance de ola (derivado, sólo lectura) ──────────────────────────────
    getWaveScopeIssues,
    // ── Allowlist efectiva · lectura (gate de dispatch) ──────────────────────
    getDispatchState,
    isIssueAllowed,
    isIssueAllowedInState,
    isSkillAllowed,
    isSkillAllowedInState,
    unscopedDispatchEnabled,
    readFullPauseOrigin,
    // ── Allowlist efectiva · mutación (authorizedBy OBLIGATORIO) ─────────────
    setAllowlist,
    setAllowlistAtomic,
    addToAllowlist,
    removeFromAllowlist,
    clearAllowlist,
    resumeAll,
    setFullPause,
    clearFullPause,
    // ── Errores ──────────────────────────────────────────────────────────────
    OperationalStateError,
    OperationalStateValidationError,
    // ── Internos: SÓLO tests. Ningún consumidor debe usar esto — es la única
    //    superficie que revela rutas físicas, y existe para que los tests puedan
    //    montar fixtures y limpiar caché.
    _internal: {
        paths: () => ({ ...waves._paths(), ...partialPause._paths() }),
        invalidateCache: () => waves.invalidateCache(),
        readWaveStateStrict,
        requireAuthorization,
    },
};
