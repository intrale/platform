// =============================================================================
// init-failed-state.js — Flag persistente para bootstrap de waves.json fallido
// (#3617, REQ-SEC-2 + G-UX-1 + CA-PO-2).
//
// Cuándo se activa
// ----------------
// Cuando `init-waves-from-partial.js` retorna { ok: false, action: 'error' }
// durante el boot del Pulpo. El Pulpo no debe procesar issues mientras este
// flag exista (fail-closed default-deny).
//
// Patrón de archivo
// -----------------
// `.pipeline/.init-failed.flag` — JSON con shape:
//   {
//     "ts": "ISO timestamp del init fallido",
//     "pid": pid del proceso que lo escribió,
//     "hostname": "..",
//     "reason": "string corto",
//     "errors": ["..."],
//     "source_sha256": "hash del .partial-pause.json leído (o null si no se pudo leer)"
//   }
//
// Mismo patrón que `lib/desync-detector.js:.desync-detected.flag` — el dispatch
// loop del Pulpo lo polea y entra en modo "init-blocked" (variante de
// human-block / desync-blocked).
//
// Recuperación
// ------------
// El flag se BORRA automáticamente cuando un siguiente boot llama a
// `init-waves-from-partial.js` y retorna { ok: true }. Si el operador prefiere
// destrabarlo manualmente (porque ya corrigió el archivo y no quiere esperar
// otro restart), puede `rm .pipeline/.init-failed.flag` — mismo trato que
// `.desync-detected.flag`.
//
// Reglas inquebrantables
// ----------------------
//   - Cero side effects en require.
//   - Tolerante a flag corrupto (parse error → trato como flag presente,
//     fail-closed conservador).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const FLAG_BASENAME = '.init-failed.flag';

function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.join(__dirname, '..');
}

function flagPath() {
    return path.join(pipelineDir(), FLAG_BASENAME);
}

/**
 * Escribe el flag con detalles del fallo. Idempotente: sobreescribe si existe.
 *
 * @param {{ reason: string, errors?: string[], source_sha256?: string|null }} info
 */
function setInitFailed(info = {}) {
    const payload = {
        ts: new Date().toISOString(),
        pid: process.pid,
        hostname: os.hostname(),
        reason: info.reason || 'unknown',
        errors: Array.isArray(info.errors) ? info.errors : [],
        source_sha256: info.source_sha256 || null,
    };
    try {
        fs.writeFileSync(flagPath(), JSON.stringify(payload, null, 2));
        return { ok: true, path: flagPath() };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Borra el flag si existe. No-op si ya no está.
 */
function clearInitFailed() {
    try {
        if (fs.existsSync(flagPath())) {
            fs.unlinkSync(flagPath());
        }
    } catch {}
}

/**
 * Devuelve true si el flag existe (independiente de si el contenido es válido).
 * Fail-closed: si el archivo existe pero está corrupto, igual devolvemos true
 * (el operador tiene que mirar igual).
 */
function isInitFailedSet() {
    return fs.existsSync(flagPath());
}

/**
 * Lee el contenido del flag. Retorna null si no existe o si parse falla.
 * Útil para el dashboard que renderiza el banner con el detalle.
 */
function readInitFailed() {
    if (!fs.existsSync(flagPath())) return null;
    try {
        const raw = fs.readFileSync(flagPath(), 'utf8');
        return JSON.parse(raw);
    } catch {
        return { reason: 'flag presente pero corrupto', errors: [], ts: null };
    }
}

module.exports = {
    setInitFailed,
    clearInitFailed,
    isInitFailedSet,
    readInitFailed,
    FLAG_BASENAME,
    _internal: { flagPath, pipelineDir },
};
