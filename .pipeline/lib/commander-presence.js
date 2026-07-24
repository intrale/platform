'use strict';

// =============================================================================
// commander-presence.js — Canal de presencia observacional del Commander (#3948,
// EP-7 / #3947).
//
// Publica que el Commander está atendiendo una petición de Telegram en un
// archivo de runtime SEPARADO del filesystem de fases (`commander-presence.json`
// en la raíz de `.pipeline/`, NUNCA bajo `<pipeline>/<fase>/trabajando/`). Así:
//
//   - CA-2: los contadores de concurrencia del pulpo (`countRunningBySkill` /
//     `countRunningDevs`) solo escanean `trabajando/` → jamás ven la presencia
//     → no consume slot ni altera el paralelismo. Se cumple por construcción.
//   - SEC-1: el archivo NO contiene PII (texto del mensaje, chat_id, from,
//     tokens). Solo persiste `petitionId` (opaco), `fase` (enum) y `startedAt`.
//     `writePresence`/`updatePhase` descartan cualquier campo no whitelisteado.
//   - SEC-5: escritura atómica (temp + rename) para que el dashboard nunca lea
//     JSON parcial. Single-writer (el brazo Commander del pulpo).
//   - SEC-4 / riesgo stale: `readPresence` aplica TTL por `startedAt`; presencia
//     vieja (crash a mitad de petición) se ignora.
//
// La lectura para el merge en el dashboard vive en `dashboard-slices.js`
// (`activeAgents`), que usa su propio `safeReadJson` + chequeo de TTL. Este
// helper expone `readPresence` para tests y consumidores que prefieran la
// lectura validada centralizada.
// =============================================================================

const fs = require('fs');
const path = require('path');

// Enum cerrado de fases (CA-5 / SEC-1). Cualquier valor fuera de este set se
// rechaza al escribir y se ignora al leer (defensa en profundidad).
const PHASES = Object.freeze(['transcribiendo', 'pensando', 'verificando', 'enviando']);
const PHASE_SET = new Set(PHASES);

// TTL por defecto: presencia más vieja que esto se considera stale (CA-8).
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// Nombre del archivo de presencia. Vive en la raíz de runtime del pipeline,
// igual que el precedente `commander-session.json`.
const PRESENCE_FILENAME = 'commander-presence.json';

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

// Escritura atómica: escribimos a un temp único y renombramos sobre el destino.
// `rename` es atómico dentro del mismo filesystem → el dashboard nunca lee un
// JSON a medio escribir (SEC-5).
function atomicWrite(filepath, obj) {
    const dir = path.dirname(filepath);
    // Sufijo determinístico-por-proceso: evita colisión entre procesos sin
    // depender de Math.random (single-writer en producción, pero defensivo).
    const tmp = path.join(dir, `.${PRESENCE_FILENAME}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, filepath);
}

/**
 * Publica la presencia del Commander al iniciar la atención de una petición.
 * Solo persiste campos whitelisteados (SEC-1): petitionId, fase, startedAt.
 * Cualquier otro campo del objeto recibido se descarta.
 *
 * @param {{petitionId: string, fase: string, startedAt?: number}} input
 * @param {{pipelineRoot?: string, now?: () => number}} [opts]
 * @returns {{petitionId: string, fase: string, startedAt: number}} el objeto persistido
 * @throws si la fase no pertenece al enum o falta petitionId
 */
function writePresence(input, opts = {}) {
    const fase = input && input.fase;
    if (!isValidPhase(fase)) {
        throw new Error(`commander-presence: fase inválida "${fase}" (esperado: ${PHASES.join('|')})`);
    }
    const petitionId = input && input.petitionId;
    if (!petitionId || typeof petitionId !== 'string') {
        throw new Error('commander-presence: petitionId requerido (string opaco)');
    }
    const now = (opts.now || Date.now)();
    const startedAt = typeof input.startedAt === 'number' ? input.startedAt : now;
    // SEC-1: shape mínima, sin PII. Reconstruimos el objeto desde cero para que
    // ningún campo extra (texto, chat_id, from, tokens) se filtre a disco.
    const record = { petitionId: String(petitionId), fase, startedAt };
    atomicWrite(presencePath(opts.pipelineRoot), record);
    return record;
}

/**
 * Actualiza solo la fase de la presencia activa, preservando petitionId y
 * startedAt. Si no hay presencia activa (archivo ausente/corrupto), es un no-op
 * idempotente (devuelve null) — no resucita presencia muerta.
 *
 * @param {string} fase
 * @param {{pipelineRoot?: string}} [opts]
 * @returns {object|null} el objeto persistido o null si no había presencia
 * @throws si la fase no pertenece al enum
 */
function updatePhase(fase, opts = {}) {
    if (!isValidPhase(fase)) {
        throw new Error(`commander-presence: fase inválida "${fase}" (esperado: ${PHASES.join('|')})`);
    }
    const filepath = presencePath(opts.pipelineRoot);
    let current = null;
    try { current = JSON.parse(fs.readFileSync(filepath, 'utf8')); }
    catch { return null; }
    if (!current || typeof current !== 'object' || !current.petitionId) return null;
    const record = {
        petitionId: String(current.petitionId),
        fase,
        startedAt: typeof current.startedAt === 'number' ? current.startedAt : (opts.now || Date.now)(),
    };
    atomicWrite(filepath, record);
    return record;
}

/**
 * Limpia la presencia (al terminar la atención, éxito o error). Idempotente:
 * si el archivo no existe, no lanza (CA-1 — desaparece al terminar).
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
 * archivo ausente/corrupto devolviendo null (SEC-4). NO borra el archivo stale
 * (la limpieza la hace el writer en su finally); solo lo ignora en lectura.
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
    if (durationMs >= ttlMs) return null; // stale (CA-8)
    return { petitionId: raw.petitionId, fase: raw.fase, startedAt, durationMs };
}

module.exports = {
    writePresence,
    updatePhase,
    clearPresence,
    readPresence,
    presencePath,
    isValidPhase,
    PHASES,
    PHASE_SET,
    DEFAULT_TTL_MS,
    PRESENCE_FILENAME,
};
