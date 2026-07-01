'use strict';

// =============================================================================
// sherlock-presence.js — Canal de presencia observacional del Sherlock (#4335).
//
// Espejo de `commander-presence.js`. Sherlock corre in-process para validar cada
// turno del Commander; para que aparezca como agente activo en el dashboard (y
// pueda linkearse su `sherlock-<reqId>.log`) publicamos su presencia en un
// archivo de runtime SEPARADO del filesystem de fases (`sherlock-presence.json`
// en la raíz de `.pipeline/`, NUNCA bajo `<pipeline>/<fase>/trabajando/`). Así:
//
//   - Los contadores de concurrencia del pulpo (`countRunningBySkill` /
//     `countRunningDevs`) solo escanean `trabajando/` → jamás ven la presencia →
//     no consume slot ni altera el paralelismo. Se cumple por construcción.
//   - SEC-1: el archivo NO contiene PII (texto, chat_id, tokens). Solo persiste
//     `petitionId` (opaco, hex random), `fase` (enum) y `startedAt`.
//     `writePresence` descarta cualquier campo no whitelisteado.
//   - SEC-5: escritura atómica (temp + rename) para que el dashboard nunca lea
//     JSON parcial. Single-writer (el brazo Commander del pulpo).
//   - Riesgo stale: `readPresence` aplica TTL por `startedAt`; presencia vieja
//     (crash a mitad de verificación) se ignora.
//
// La lectura para el merge en el dashboard vive en `dashboard-slices.js`
// (`activeAgents`), que usa su propio `safeReadJson` + chequeo de TTL. Este
// helper expone `readPresence` para tests y consumidores que prefieran la
// lectura validada centralizada.
// =============================================================================

const fs = require('fs');
const path = require('path');

// Enum cerrado de fases. Sherlock tiene una sola fase observable ('verificando'),
// pero se modela como set para paridad con commander-presence y defensa en
// profundidad (cualquier valor fuera del set se rechaza al escribir/leer).
const PHASES = Object.freeze(['verificando']);
const PHASE_SET = new Set(PHASES);

// TTL por defecto: presencia más vieja que esto se considera stale.
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// Nombre del archivo de presencia. Vive en la raíz de runtime del pipeline,
// hermano de `commander-presence.json`.
const PRESENCE_FILENAME = 'sherlock-presence.json';

// Raíz por defecto del pipeline: `.pipeline/` (este módulo vive en
// `.pipeline/lib/`). Los tests inyectan un dir temporal vía `pipelineRoot`.
function defaultPipelineRoot() {
    return path.join(__dirname, '..');
}

function presencePath(pipelineRoot) {
    return path.join(pipelineRoot || defaultPipelineRoot(), PRESENCE_FILENAME);
}

function isValidPhase(fase) {
    return typeof fase === 'string' && PHASE_SET.has(fase);
}

// Escritura atómica: temp único + rename sobre el destino (SEC-5).
function atomicWrite(filepath, obj) {
    const dir = path.dirname(filepath);
    const tmp = path.join(dir, `.${PRESENCE_FILENAME}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, filepath);
}

/**
 * Publica la presencia del Sherlock al iniciar una verificación. Solo persiste
 * campos whitelisteados (SEC-1): petitionId, fase, startedAt. Cualquier otro
 * campo del objeto recibido se descarta.
 *
 * @param {{petitionId: string, fase?: string, startedAt?: number}} input
 * @param {{pipelineRoot?: string, now?: () => number}} [opts]
 * @returns {{petitionId: string, fase: string, startedAt: number}} el objeto persistido
 * @throws si la fase no pertenece al enum o falta petitionId
 */
function writePresence(input, opts = {}) {
    const fase = (input && input.fase) || 'verificando';
    if (!isValidPhase(fase)) {
        throw new Error(`sherlock-presence: fase inválida "${fase}" (esperado: ${PHASES.join('|')})`);
    }
    const petitionId = input && input.petitionId;
    if (!petitionId || typeof petitionId !== 'string') {
        throw new Error('sherlock-presence: petitionId requerido (string opaco)');
    }
    const now = (opts.now || Date.now)();
    const startedAt = typeof input.startedAt === 'number' ? input.startedAt : now;
    // SEC-1: shape mínima, sin PII. Reconstruimos el objeto desde cero para que
    // ningún campo extra se filtre a disco.
    const record = { petitionId: String(petitionId), fase, startedAt };
    atomicWrite(presencePath(opts.pipelineRoot), record);
    return record;
}

/**
 * Limpia la presencia (al terminar la verificación, éxito o error). Idempotente:
 * si el archivo no existe, no lanza.
 *
 * @param {{pipelineRoot?: string}} [opts]
 */
function clearPresence(opts = {}) {
    const filepath = presencePath(opts.pipelineRoot);
    try { fs.rmSync(filepath, { force: true }); }
    catch { /* idempotente: la presencia ya no está */ }
}

/**
 * Lee la presencia validada: aplica TTL, valida fase contra el enum y tolera
 * archivo ausente/corrupto devolviendo null. NO borra el archivo stale (la
 * limpieza la hace el writer en su finally); solo lo ignora en lectura.
 *
 * @param {{pipelineRoot?: string, ttlMs?: number, now?: () => number}} [opts]
 * @returns {{petitionId: string, fase: string, startedAt: number, durationMs: number}|null}
 */
function readPresence(opts = {}) {
    const filepath = presencePath(opts.pipelineRoot);
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(filepath, 'utf8')); }
    catch { return null; }
    if (!raw || typeof raw !== 'object') return null;
    if (!isValidPhase(raw.fase)) return null;
    if (!raw.petitionId || typeof raw.petitionId !== 'string') return null;
    const startedAt = typeof raw.startedAt === 'number' ? raw.startedAt : null;
    if (startedAt === null) return null;
    const now = (opts.now || Date.now)();
    const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : DEFAULT_TTL_MS;
    const durationMs = now - startedAt;
    if (durationMs >= ttlMs) return null; // stale
    return { petitionId: raw.petitionId, fase: raw.fase, startedAt, durationMs };
}

module.exports = {
    writePresence,
    clearPresence,
    readPresence,
    presencePath,
    isValidPhase,
    PHASES,
    PHASE_SET,
    DEFAULT_TTL_MS,
    PRESENCE_FILENAME,
};
