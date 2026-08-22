'use strict';

// =============================================================================
// sherlock-presence.js — Canal de presencia observacional del Sherlock (#4332).
//
// Port 1:1 de `commander-presence.js` (#3948, EP-7): publica que el Sherlock
// está verificando adversarialmente una respuesta del Commander en un archivo de
// runtime SEPARADO del filesystem de fases (`sherlock-presence.json` en la raíz
// de `.pipeline/`, NUNCA bajo `<pipeline>/<fase>/trabajando/`). Así:
//
//   - CA-5: los contadores de concurrencia del pulpo (`countRunningBySkill` /
//     `countRunningDevs`) solo escanean `trabajando/` → jamás ven la presencia
//     → no consume slot ni altera el paralelismo. Se cumple por construcción.
//   - CA-6 / SEC-1..SEC-2: el archivo NO contiene PII (texto del mensaje,
//     chat_id, from, tokens, veredicto). Solo persiste `petitionId` (opaco),
//     `fase` (enum cerrado de UN valor) y `startedAt`. `writePresence` descarta
//     cualquier campo no whitelisteado (reconstrucción explícita, nunca spread).
//   - SEC-5 / CA-6: escritura atómica (temp + rename) para que el dashboard
//     nunca lea JSON parcial. Single-writer (el bloque Sherlock del brazo
//     Commander del pulpo).
//   - CA-4 / SEC-4 / riesgo stale: `readPresence` aplica TTL por `startedAt`;
//     presencia vieja (Sherlock colgado / matado sin clear) se ignora en lectura.
//
// La lectura para el merge en el dashboard vive en `dashboard-slices.js`
// (`activeAgents`) y en el render de `dashboard.js`, cada uno con su propio
// chequeo de TTL. Este helper expone `readPresence` para tests y para el render
// que prefiera la lectura validada centralizada.
// =============================================================================

const fs = require('fs');
const path = require('path');

// Enum cerrado de fases (CA-6 / SEC-4). El Sherlock SOLO verifica: enum mínimo de
// un valor. Cualquier valor fuera de este set se rechaza al escribir y se ignora
// al leer (defensa en profundidad). No se reusa el enum del Commander.
const PHASES = Object.freeze(['verificando']);
const PHASE_SET = new Set(PHASES);

// TTL por defecto: presencia más vieja que esto se considera stale (CA-4).
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// Nombre del archivo de presencia. Vive en la raíz de runtime del pipeline,
// separado del canal del Commander (`commander-presence.json`).
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

// Escritura atómica: escribimos a un temp único y renombramos sobre el destino.
// `rename` es atómico dentro del mismo filesystem → el dashboard nunca lee un
// JSON a medio escribir (SEC-5).
function atomicWrite(filepath, obj) {
    const dir = path.dirname(filepath);
    const tmp = path.join(dir, `.${PRESENCE_FILENAME}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, filepath);
}

/**
 * Publica la presencia del Sherlock al iniciar la verificación de una respuesta
 * del Commander. Solo persiste campos whitelisteados (SEC-1): petitionId, fase,
 * startedAt. Cualquier otro campo del objeto recibido se descarta.
 *
 * @param {{petitionId: string, fase: string, startedAt?: number}} input
 * @param {{pipelineRoot?: string, now?: () => number}} [opts]
 * @returns {{petitionId: string, fase: string, startedAt: number}} el objeto persistido
 * @throws si la fase no pertenece al enum o falta petitionId
 */
function writePresence(input, opts = {}) {
    const fase = input && input.fase;
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
    // ningún campo extra (texto, chat_id, from, tokens, veredicto) se filtre a
    // disco.
    const record = { petitionId: String(petitionId), fase, startedAt };
    atomicWrite(presencePath(opts.pipelineRoot), record);
    return record;
}

/**
 * Limpia la presencia (al terminar la verificación, éxito, timeout o error).
 * Idempotente: si el archivo no existe, no lanza (CA-3 — desaparece al terminar).
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
 * archivo ausente/corrupto devolviendo null (SEC-4 / CA-4). NO borra el archivo
 * stale (la limpieza la hace el writer en su finally); solo lo ignora en lectura.
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
    if (durationMs >= ttlMs) return null; // stale (CA-4)
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
