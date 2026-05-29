// =============================================================================
// desync-ack.js — Reconocimiento operacional del banner desync (#3617, CA-PO-3).
//
// Por qué este módulo existe
// --------------------------
// `lib/desync-detector.js` crea `.desync-detected.flag` cuando waves.json y
// .partial-pause.json divergen. El flag bloquea el dispatch del Pulpo hasta
// que un humano lo audita y lo borra.
//
// Pero hay un caso intermedio (CA-PO-3): el operador VIO la divergencia, sabe
// que es expected (ej. mid-promote manual) y quiere que el banner deje de
// gritarle. NO quiere destrabar el dispatch (ese sigue siendo decisión humana
// explícita borrando el flag principal), solo quiere "reconocer" que vio la
// alerta.
//
// Diseño
// ------
// Mantenemos un archivo separado `.pipeline/.desync-acknowledged.flag` con
// el SHA-256 del estado que el operador reconoció. El dashboard pregunta:
//   - ¿Hay desync ahora? → sí → calcular hash del estado actual.
//   - ¿Hay flag ack? → si el hash matchea → ocultar banner.
//   - Si el hash CAMBIA (nueva divergencia distinta a la reconocida), el banner
//     reaparece automáticamente.
//
// El flag de bloqueo (`.desync-detected.flag`) NO se toca. El dispatch del
// Pulpo sigue suspendido. El operador tiene que hacer eso explícitamente.
//
// API
// ---
//   computeStateHash({ waves_allowlist, partial_allowlist }) → string SHA-256
//   acknowledge(hash) → { ok }     persiste el hash reconocido
//   isAcknowledged(hash) → boolean compara hash actual vs persistido
//   clearAcknowledgement() → void  borra el flag ack
//   readAck() → Object|null        lee el ack guardado (para dashboard)
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const FLAG_BASENAME = '.desync-acknowledged.flag';

function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.join(__dirname, '..');
}

function flagPath() {
    return path.join(pipelineDir(), FLAG_BASENAME);
}

/**
 * Hash determinístico del estado de divergencia. Dos llamadas con los mismos
 * arrays ordenados deben dar el mismo hash, no importa orden de inserción.
 *
 * @param {{ waves_allowlist?: number[]|null, partial_allowlist?: number[]|null }} state
 * @returns {string}
 */
function computeStateHash(state) {
    const w = Array.isArray(state.waves_allowlist) ? [...state.waves_allowlist].sort((a, b) => a - b) : [];
    const p = Array.isArray(state.partial_allowlist) ? [...state.partial_allowlist].sort((a, b) => a - b) : [];
    const canonical = JSON.stringify({ w, p });
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Marca un estado de desync como reconocido por el operador.
 * Sobreescribe la ack previa (si hay).
 *
 * @param {string} hash — SHA-256 obtenido de computeStateHash
 * @param {Object} [meta] — { source?: string } para audit
 * @returns {{ ok: boolean, error?: string }}
 */
function acknowledge(hash, meta = {}) {
    if (typeof hash !== 'string' || hash.length !== 64) {
        return { ok: false, error: 'hash inválido (esperado SHA-256 hex de 64 chars)' };
    }
    const payload = {
        hash,
        acknowledged_at: new Date().toISOString(),
        pid: process.pid,
        hostname: os.hostname(),
        source: meta.source || 'dashboard',
    };
    try {
        fs.writeFileSync(flagPath(), JSON.stringify(payload, null, 2));
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Devuelve true si el hash actual coincide con el reconocido previamente.
 * Si no hay flag → false.
 * Si el flag está corrupto → false (fail-open hacia mostrar banner).
 */
function isAcknowledged(currentHash) {
    if (typeof currentHash !== 'string') return false;
    if (!fs.existsSync(flagPath())) return false;
    try {
        const raw = fs.readFileSync(flagPath(), 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && parsed.hash === currentHash;
    } catch {
        return false;
    }
}

function readAck() {
    if (!fs.existsSync(flagPath())) return null;
    try {
        const raw = fs.readFileSync(flagPath(), 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function clearAcknowledgement() {
    try {
        if (fs.existsSync(flagPath())) fs.unlinkSync(flagPath());
    } catch {}
}

module.exports = {
    computeStateHash,
    acknowledge,
    isAcknowledged,
    readAck,
    clearAcknowledgement,
    FLAG_BASENAME,
    _internal: { flagPath, pipelineDir },
};
