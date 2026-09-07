'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJsonSafe, writeJsonAtomic } = require('./atomic-json');
const providerDisabled = require('./provider-disabled');

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const UNAVAILABLE_ALERT_TICKS = 3;
const NEXT_CYCLE_MS = 8 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Marker de estado — FUERA del árbol del repo.
//
// El marker persiste el calendario de vencimiento de la credencial del operador
// (`expires_at_epoch`, `refresh_expires_at_epoch`). Aunque no contiene el token
// (CA-11), es la misma clase de dato que #5901 · REQ-SEC-1 ya sacó del árbol
// para `credential-reminder-state.json`: publicado en un repo PÚBLICO revela la
// ventana exacta en la que la infra se queda sin poder lanzar agentes, sin que
// el tercero tenga que probar nada ni dejar rastro.
//
// Se espeja `EXTERNAL_STATE_DIR` de `lib/credential-rotation-cron.js:80` por las
// dos razones de siempre: lo que vive dentro del árbol se publica, y además se
// pierde en cada respawn (`reset --hard`).
//
// Defensa en profundidad: además de este path externo, el nombre legacy está en
// `.gitignore` y dado de alta en `SENSITIVE_PATHS` (`lib/sensitive-paths.js`),
// para que un marker dejado por una corrida vieja no pueda entrar por un
// `git add .`.
// ---------------------------------------------------------------------------
const EXTERNAL_STATE_DIR = path.join(os.homedir(), '.claude', 'pipeline-state');
const STATE_FILENAME = 'oauth-session-expiry-state.json';

// Forma lógica para los mensajes al operador: nombrar el path resuelto expone
// el home del host y no le sirve a nadie.
const EXTERNAL_STATE_FILE_LOGICO = `~/.claude/pipeline-state/${STATE_FILENAME}`;

/**
 * Path canónico del marker. `writeJsonAtomic` ya crea el directorio
 * (`atomic-json.js`: `mkdirSync(..., { recursive: true })`), así que no hace
 * falta prepararlo acá.
 *
 * @returns {string} path absoluto, fuera del árbol del repo.
 */
function defaultStateFilePath() {
    return path.join(EXTERNAL_STATE_DIR, STATE_FILENAME);
}

/**
 * Path LEGACY dentro del árbol del repo. Se conserva SÓLO para poder borrar el
 * marker que haya dejado una corrida anterior al fix. Nunca se escribe.
 *
 * @param {string} pipelineDir
 * @returns {string}
 */
function legacyStateFilePath(pipelineDir) {
    return path.join(pipelineDir || '.', STATE_FILENAME);
}

/**
 * Borra el marker legacy dentro del árbol si quedó de una corrida vieja.
 * No migra contenido: el estado son flags de umbral de un ciclo de horas, se
 * regenera solo en la evaluación siguiente y CA-6 ya cubre el arranque sin
 * lectura previa (no se emite nada hasta tener una).
 *
 * Best-effort y silencioso: nunca lanza, nunca mata el tick.
 *
 * @param {string} pipelineDir
 * @returns {boolean} true si había un legacy y se pudo borrar.
 */
function purgeLegacyStateFile(pipelineDir) {
    try {
        const legacy = legacyStateFilePath(pipelineDir);
        if (!fs.existsSync(legacy)) return false;
        fs.unlinkSync(legacy);
        return true;
    } catch (_) {
        // El marker no es crítico: si no se puede borrar, .gitignore y
        // SENSITIVE_PATHS siguen impidiendo que entre al índice.
        return false;
    }
}

function readExpiryFields() {
    try {
        const parsed = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
        const oauth = parsed && parsed.claudeAiOauth;
        const expiresAt = oauth && oauth.expiresAt;
        const refreshTokenExpiresAt = oauth && oauth.refreshTokenExpiresAt;
        if (!Number.isFinite(expiresAt)) return null;
        return {
            expiresAt,
            refreshTokenExpiresAt: Number.isFinite(refreshTokenExpiresAt) ? refreshTokenExpiresAt : null,
        };
    } catch (_) {
        // Intencionalmente vacío: el error de parseo puede contener credenciales.
        return null;
    }
}

function getOAuthSessionExpiry(now = Date.now()) {
    const fields = readExpiryFields();
    if (!fields) return { expiresAt: null, minutesLeft: null, available: false };
    return {
        expiresAt: new Date(fields.expiresAt),
        minutesLeft: Math.floor((fields.expiresAt - now) / 60000),
        available: true,
    };
}

/**
 * CE-2 (REVISIÓN 2 de los criterios, cerrada por PO el 2026-09-06) — única
 * fuente de encendido.
 *
 * La evidencia de que la credencial fue rechazada NO se infiere del archivo de
 * credenciales: es la señal tipada que produce #6238, la entrada de
 * `provider-disabled` con `source: 'credential-death'` que el Pulpo escribe
 * sólo cuando el CLI devolvió la firma tipada de rechazo (TTL 60 min; con el
 * tick de 5 min hay 12 oportunidades de observarla). `getDisabledEntry` ya
 * drena las entradas vencidas: si devuelve la entrada, el apagado por
 * credencial rechazada está vigente ahora.
 *
 * Sólo lectura: este módulo nunca escribe sobre `provider-disabled`. Cualquier
 * excepción se trata como `false` (fail-open del chequeo, coherente con CA-7).
 */
function readCredentialDeathActive(disabledModule, now) {
    try {
        const entry = disabledModule.getDisabledEntry('anthropic', { now });
        return !!(entry && entry.source === 'credential-death');
    } catch (_) {
        return false;
    }
}

function emptyState() {
    return {
        expires_at_epoch: null,
        refresh_expires_at_epoch: null,
        t30_sent: false,
        t10_sent: false,
        unavailable_streak: 0,
        unavailable_since_epoch: null,
        health_alert_open: false,
        expiry_alert_open: false,
        renewal_unhealthy: false,
    };
}

function normalizeState(raw) {
    const base = emptyState();
    if (!raw || typeof raw !== 'object') return base;
    for (const key of Object.keys(base)) {
        if (typeof base[key] === 'boolean') base[key] = raw[key] === true;
        else if (Number.isFinite(raw[key])) base[key] = raw[key];
    }
    return base;
}

function save(statePath, state) {
    if (!writeJsonAtomic(statePath, state, { indent: 2 })) {
        throw new Error('oauth_expiry_state_write_failed');
    }
}

function evaluate({ now = Date.now(), statePath, disabledModule = providerDisabled }) {
    const existed = fs.existsSync(statePath);
    const prev = normalizeState(readJsonSafe(statePath, null));
    const fields = readExpiryFields();

    if (!fields) {
        const next = { ...prev };
        next.unavailable_streak += 1;
        if (next.unavailable_since_epoch === null) next.unavailable_since_epoch = now;
        save(statePath, next);
        const healthAlert = next.unavailable_streak >= UNAVAILABLE_ALERT_TICKS && !next.health_alert_open;
        return {
            shouldEmit: healthAlert,
            alert: healthAlert ? 'health_unavailable' : null,
            healthAlert,
            ageMinutes: Math.max(0, Math.floor((now - next.unavailable_since_epoch) / 60000)),
            minutesLeft: null,
            reason: healthAlert ? 'health_unavailable' : 'unavailable',
        };
    }

    const epoch = fields.expiresAt;
    const minutesLeft = Math.floor((epoch - now) / 60000);

    // CA-4: cualquier salto de vigencia hacia adelante cuenta como renovación,
    // se observe antes o después del vencimiento anterior. Condicionarlo a que
    // ocurriera antes del vencimiento es lo que producía el latch permanente.
    // CA-14: esta comparación de `expiresAt` entre evaluaciones vale SÓLO para
    // el reset de umbrales y el apagado de CE-2 — nunca para encenderla.
    const renewed = prev.expires_at_epoch !== null && epoch > prev.expires_at_epoch;
    const credentialDeathActive = readCredentialDeathActive(disabledModule, now);

    const next = { ...prev };
    next.expires_at_epoch = epoch;
    next.refresh_expires_at_epoch = fields.refreshTokenExpiresAt;
    next.unavailable_streak = 0;
    next.unavailable_since_epoch = null;
    if (renewed) {
        next.t30_sent = false;
        next.t10_sent = false;
        next.renewal_unhealthy = false; // CA-4 / CA-15: el salto apaga CE-2.
    }
    // Fail-closed: si el encendido y el apagado coinciden en la misma
    // evaluación gana el encendido — ante evidencia de rechazo se avisa.
    if (credentialDeathActive) next.renewal_unhealthy = true;

    if (prev.health_alert_open) {
        save(statePath, next);
        return { shouldEmit: true, alert: 'health_recovered', minutesLeft, reason: 'health_recovered' };
    }
    if (!existed || prev.expires_at_epoch === null) {
        save(statePath, next);
        return { shouldEmit: false, minutesLeft, reason: 'first_reading' };
    }
    // CA-9 / CA-15: el episodio abierto se cierra solo cuando la vigencia saltó
    // hacia adelante y ya no queda evidencia de rechazo vigente.
    if (renewed && prev.expiry_alert_open && !next.renewal_unhealthy) {
        save(statePath, next);
        return { shouldEmit: true, alert: 'renewed', minutesLeft, reason: 'session_renewed' };
    }
    if (minutesLeft <= 0) {
        save(statePath, next);
        return { shouldEmit: false, minutesLeft, reason: 'already_expired' };
    }

    const refreshCannotCoverNextCycle = fields.refreshTokenExpiresAt !== null
        && fields.refreshTokenExpiresAt < epoch + NEXT_CYCLE_MS;
    const emissionCondition = refreshCannotCoverNextCycle || next.renewal_unhealthy;
    if (!emissionCondition) {
        save(statePath, next);
        return { shouldEmit: false, minutesLeft, reason: 'automatic_renewal_expected' };
    }

    let threshold = null;
    if (minutesLeft <= 10 && !next.t10_sent) threshold = 't10';
    else if (minutesLeft <= 30 && !next.t30_sent) threshold = 't30';
    if (!threshold) {
        save(statePath, next);
        return { shouldEmit: false, minutesLeft, reason: 'threshold_not_crossed_or_sent' };
    }
    save(statePath, next);
    return {
        shouldEmit: true,
        alert: 'expiry',
        threshold,
        minutesLeft,
        reason: refreshCannotCoverNextCycle ? 'refresh_insufficient' : 'credential_death',
    };
}

function recordEmitted({ statePath, alert, threshold }) {
    const state = normalizeState(readJsonSafe(statePath, null));
    if (alert === 'expiry') {
        if (threshold === 't10') {
            state.t10_sent = true;
            state.t30_sent = true;
        } else if (threshold === 't30') state.t30_sent = true;
        else return false;
        state.expiry_alert_open = true;
    } else if (alert === 'health_unavailable') state.health_alert_open = true;
    else if (alert === 'health_recovered') state.health_alert_open = false;
    else if (alert === 'renewed') state.expiry_alert_open = false;
    else return false;
    return writeJsonAtomic(statePath, state, { indent: 2 });
}

module.exports = {
    getOAuthSessionExpiry,
    evaluate,
    recordEmitted,
    defaultStateFilePath,
    legacyStateFilePath,
    purgeLegacyStateFile,
    CREDENTIALS_PATH,
    EXTERNAL_STATE_DIR,
    EXTERNAL_STATE_FILE_LOGICO,
    STATE_FILENAME,
    UNAVAILABLE_ALERT_TICKS,
    NEXT_CYCLE_MS,
};
