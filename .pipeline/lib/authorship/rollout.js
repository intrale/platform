'use strict';
// =============================================================================
// #7631 — Modo del gate `authorship` con rollout fail-closed (CA-6 · S8).
//
// Reglas:
//   - Bloque `authorship` ausente, con tipo inválido o `gate_mode` desconocido
//     → modo MÁS ESTRICTO que ya estuvo activo: `enforce` si alguna vez se vio
//     `enforce` (marcador persistente), `dry-run` si no. Nunca se apaga.
//   - `gate_mode: 'off'` apaga SÓLO si está escrito literalmente así.
//   - `enabled: false` NO apaga: se ignora con warning. El único apagado
//     posible es el explícito (`gate_mode: off`).
//   - PR creado antes de `go_live_date` → grandfathered (no se evalúa).
//
// El marcador `enforceSeen` vive en disco (`.pipeline/state/authorship-enforce-seen`)
// porque después de un `reset --hard` la memoria del proceso no prueba nada.
// El código lo escribe la primera vez que resuelve `enforce` y NUNCA lo borra.
// =============================================================================

const path = require('path');

const MODES = Object.freeze(['off', 'dry-run', 'enforce']);
// Destino resuelto POR LLAMADA vía `lib/write-target` (canal `estado`, #7112):
// en el pipeline productivo cae en el `.pipeline/` del repo principal, así el
// marcador sobrevive a worktrees efímeros. Sin ambiente declarado devuelve
// `null` (bloqueo ruidoso por stderr) y los lectores/escritores de abajo
// aplican su propia regla fail-closed.
const MARKER_DESTINO = 'state/authorship-enforce-seen';
function defaultMarkerFile() {
    return require('../write-target').safeWritePath(process.env,
        { canal: 'estado', destino: MARKER_DESTINO },
        'state', 'authorship-enforce-seen');
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {object|null} cfg — config completa del pipeline (o null).
 * @param {{prCreatedAt?: string|null, enforceSeen?: boolean}} [ctx]
 * @returns {{mode:'off'|'dry-run'|'enforce', grandfathered:boolean, reason:string, warnings:string[]}}
 */
function resolveAuthorshipMode(cfg, { prCreatedAt = null, enforceSeen = false } = {}) {
    const strict = enforceSeen === true ? 'enforce' : 'dry-run';
    const warnings = [];
    const fallback = (reason) => ({ mode: strict, grandfathered: false, reason, warnings });

    const section = isPlainObject(cfg) ? cfg.authorship : undefined;
    if (!isPlainObject(section)) return fallback('config-ausente-o-invalida');

    if (section.enabled !== undefined && typeof section.enabled !== 'boolean') {
        return fallback('enabled-tipo-invalido');
    }
    if (section.enabled === false) {
        warnings.push('authorship.enabled=false se ignora: el único apagado válido es gate_mode: off');
    }

    const gm = section.gate_mode;
    if (typeof gm !== 'string' || !MODES.includes(gm)) return fallback('gate_mode-invalido');

    const gld = section.go_live_date;
    if (gld !== undefined && gld !== null && typeof gld !== 'string') {
        return fallback('go_live_date-tipo-invalido');
    }

    if (gm === 'off') return { mode: 'off', grandfathered: false, reason: 'gate_mode-off-explicito', warnings };

    // Grandfathering: sólo con fecha y creación del PR ambas legibles. Si
    // cualquiera de las dos falta o no parsea, se evalúa (fail-closed).
    if (typeof gld === 'string' && gld) {
        const live = Date.parse(gld);
        const created = typeof prCreatedAt === 'string' ? Date.parse(prCreatedAt) : NaN;
        if (Number.isNaN(live)) warnings.push('authorship.go_live_date no parsea: no hay grandfathering');
        else if (!Number.isNaN(created) && created < live) {
            return { mode: gm, grandfathered: true, reason: 'pr-anterior-a-go_live_date', warnings };
        }
    }
    return { mode: gm, grandfathered: false, reason: 'config', warnings };
}

function readEnforceSeen(markerFile, fsImpl) {
    const _fs = fsImpl || require('fs');
    try {
        if (!markerFile) markerFile = defaultMarkerFile();
        // Sin destino resoluble no se puede probar que nunca hubo enforce ⇒ lo más estricto.
        if (!markerFile) return true;
        return _fs.existsSync(markerFile);
    } catch { return true; /* no poder leer ⇒ lo más estricto */ }
}

function markEnforceSeen(markerFile, fsImpl) {
    const _fs = fsImpl || require('fs');
    try {
        if (!markerFile) markerFile = defaultMarkerFile();
        if (!markerFile) return false; // escritura bloqueada: ya avisado por stderr
        if (_fs.existsSync(markerFile)) return true;
        _fs.mkdirSync(path.dirname(markerFile), { recursive: true });
        _fs.writeFileSync(markerFile, `${new Date().toISOString()}\n`, 'utf8');
        return true;
    } catch { return false; }
}

module.exports = {
    resolveAuthorshipMode,
    readEnforceSeen,
    markEnforceSeen,
    MODES,
    MARKER_DESTINO,
    defaultMarkerFile,
};
