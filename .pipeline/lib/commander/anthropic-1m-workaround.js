// =============================================================================
// anthropic-1m-workaround.js — Feature flag + ciclo de vida operativo del
// workaround del bug Anthropic CLI Opus 4.7 1M (#3506 / #3508).
//
// CICLO DE VIDA
// -------------
// El bug upstream "Usage credits required for 1M context" del CLI de Anthropic
// Claude Code se mitigó en #3506: el parser clasifica el caso como
// `errorClass: 'cli_1m_context_glitch'`, NO contamina el flag de quota, NO rota
// provider, avisa al usuario por Telegram para que reintente. Es un workaround
// **temporal** esperando fix de Anthropic upstream.
//
// Este módulo agrega:
//
//   1. Feature flag operativo `ANTHROPIC_1M_WORKAROUND_ENABLED` (env var).
//      Default = `true` (workaround activo). El operador setea `=0` o `=false`
//      para probar empíricamente si Anthropic ya arregló: con flag OFF, el
//      error cae al path genérico `quota_exhausted` (comportamiento pre-#3506).
//      Si nunca se activa el flag de quota → el bug upstream está resuelto.
//
//   2. Contador `cli_1m_glitch_hits` y timestamp `last_hit_at` persistidos en
//      `commander-session.json` bajo la sección `anthropic_1m_workaround`.
//      Permite saber empíricamente la frecuencia del bug y la fecha del último
//      hit.
//
//   3. Chequeo TTL: si pasaron >14 días sin hits y el flag sigue activo, el
//      Pulpo emite alerta Telegram a Leo sugiriendo probar el kill-switch.
//      Cooldown de 7 días entre alertas para no spamear.
//
// PARA REMOVER ESTE WORKAROUND
// ----------------------------
// 1. Setear `ANTHROPIC_1M_WORKAROUND_ENABLED=0` en el entorno del Pulpo.
// 2. Esperar 24-48h de uso normal del pipeline.
// 3. Si no aparecen errores nuevos en `errorClass=quota_exhausted` con shape
//    1M context, crear PR para remover #3506 + #3508 completos.
// 4. Si reaparecen → revertir flag a 1, abrir issue de regresión upstream.
//
// SCOPE DE SEGURIDAD (SEC-1..SEC-7 del #3508)
// -------------------------------------------
// SEC-1 — Validación estricta del feature flag (A03 Injection):
//        whitelist explícita `'0'|'1'|'true'|'false'|undefined`. Cualquier
//        otro valor → fail-safe (workaround enabled = default protector).
//        PROHIBIDO `eval`, `JSON.parse` o coerción implícita del env var.
// SEC-2 — Short-circuit antes de los regex pesados: el chequeo del flag corre
//        ANTES de `CLI_1M_CONTEXT_GLITCH_PATTERN.test()` y de
//        `sanitizeRawExcerpt`. Preserva las garantías ReDoS de #3506 (tests
//        1MB <50ms) en ambos modos.
// SEC-3 — Default seguro = enabled. Convención positiva-enabled (no invertir
//        a `DISABLED`).
// SEC-4 — Validación de tipos al leer `commander-session.json` (A08 Integrity
//        Failures): timestamps en rango `[0, Date.now()+24h]`, hits enteros
//        ≥ 0. Corrupt → log + reset, NO crash.
// SEC-5 — Sanitización del log del hit (A09 Logging Failures): SOLO
//        `timestamp`, `provider`, `errorClass`, `evidence` (saneada por
//        sanitizeRawExcerpt). Prohibido leakear prompt, contexto del agente,
//        headers, tokens.
// SEC-6 — Alerta Telegram con cooldown 7 días. Persistir `last_alert_sent_at`.
//        Corrupt/futuro → tratar como 0 (permitir envío) + loggear.
// SEC-7 — Naming consistente: el contador es `cli_1m_glitch_hits`. NUNCA
//        `fallback_opus_1m_to_standard` (engañoso, no hay fallback).
//
// Sin dependencias externas. Node puro.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// -----------------------------------------------------------------------------
// Constantes operativas — autodocumentadas en el JSON persistido (CA-8/UX-5).
// -----------------------------------------------------------------------------
const FEATURE_FLAG_ENV = 'ANTHROPIC_1M_WORKAROUND_ENABLED';
const TTL_DAYS_THRESHOLD = 14;
const COOLDOWN_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// -----------------------------------------------------------------------------
// #3987 — KILL SWITCH DE ESCALACIÓN A FALLBACK.
//
// PROBLEMA: el texto "Usage credits required for 1M context" tiene DOS causas
// que se escriben idéntico:
//   (a) El glitch transitorio del CLI (Anthropic SANO, hay cuota) → la política
//       #3506 es "no rotes, reintentá en el mismo Anthropic".
//   (b) La cuota Anthropic AGOTADA de verdad → el CLI escupe ese MISMO texto.
//       Acá "reintentá en el mismo" es un loop muerto: el Commander queda mudo
//       y el multi-provider nunca rota a OpenAI/Gemini (incidente 2026-06-12).
//
// El clasificador no puede distinguir (a) de (b) por el texto. La señal que SÍ
// los separa es la PERSISTENCIA: el glitch transitorio se resuelve en 1-2
// reintentos; la cuota agotada falla indefinidamente. Por eso contamos hits
// CONSECUTIVOS (sin un spawn exitoso de por medio) y, al cruzar el umbral,
// escalamos: tratamos el caso como cuota real → el caller setea el flag de
// quota con TTL corto → el siguiente dispatch rota al fallback. Anthropic se
// reintenta al expirar el gate (mínimo 5 min); si seguía agotado, re-escala.
//
// El contador se resetea con `resetConsecutive()` en cada spawn exitoso del
// Commander (Anthropic volvió → el episodio terminó) y por staleness (>6h sin
// hits → episodio viejo, no acumular).
//
// Umbral configurable por env `ANTHROPIC_1M_ESCALATION_THRESHOLD` (default 3).
// `0` = kill switch deshabilitado (comportamiento pre-#3987: nunca escala).
// -----------------------------------------------------------------------------
const ESCALATION_THRESHOLD_ENV = 'ANTHROPIC_1M_ESCALATION_THRESHOLD';
const DEFAULT_ESCALATION_THRESHOLD = 3;
const MAX_ESCALATION_THRESHOLD = 50; // sanity cap contra valores absurdos
// Si pasaron más de 6h desde el último hit consecutivo, el episodio se
// considera viejo y el contador reinicia (no acumulamos glitches de días
// distintos como si fueran la misma caída).
const CONSECUTIVE_STALE_MS = 6 * 60 * 60 * 1000;

// Default session path — el caller (pulpo.js) ya conoce su `SESSION_FILE`,
// pero exponemos el default para tests y para reutilización fuera de Pulpo.
const DEFAULT_SESSION_FILE = path.join(__dirname, '..', '..', 'commander-session.json');

// -----------------------------------------------------------------------------
// SEC-1 — isWorkaroundEnabled()
//
// Lee `process.env.ANTHROPIC_1M_WORKAROUND_ENABLED` con whitelist explícita.
// Acepta SOLO: `'0'`, `'1'`, `'true'`, `'false'`, `undefined`/ausente.
// Cualquier otro valor → fail-safe enabled (default protector).
//
// El argumento `envOverride` permite inyectar un object-like en tests sin
// mutar `process.env`.
// -----------------------------------------------------------------------------
function isWorkaroundEnabled(envOverride) {
    const src = envOverride && typeof envOverride === 'object' ? envOverride : process.env;
    const raw = src[FEATURE_FLAG_ENV];
    if (raw === undefined || raw === null) return true;
    // SEC-1: coerción explícita controlada. Nunca eval, nunca JSON.parse.
    const s = String(raw).trim().toLowerCase();
    if (s === '0' || s === 'false') return false;
    if (s === '1' || s === 'true') return true;
    // Valores raros (`'2'`, `'on'`, `'YES'`, `''`, `' 0 '` con espacios YA
    // strippeados → si el trim falla por unicode raro, fail-safe enabled).
    return true; // fail-safe: enabled (default protector).
}

// -----------------------------------------------------------------------------
// #3987 — getEscalationThreshold()
//
// Lee `ANTHROPIC_1M_ESCALATION_THRESHOLD` con parseo estricto (mismo criterio
// defensivo que el feature flag — sin eval, sin coerción implícita peligrosa).
// Acepta enteros en `[0, MAX_ESCALATION_THRESHOLD]`. `0` deshabilita el kill
// switch. Cualquier valor inválido (no-numérico, negativo, fuera de rango,
// fraccionario) → default 3 (fail-safe protector: el kill switch ACTIVO es lo
// seguro porque evita la mudez total).
// -----------------------------------------------------------------------------
function getEscalationThreshold(envOverride) {
    const src = envOverride && typeof envOverride === 'object' ? envOverride : process.env;
    const raw = src[ESCALATION_THRESHOLD_ENV];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return DEFAULT_ESCALATION_THRESHOLD;
    }
    const s = String(raw).trim();
    // Solo dígitos puros (sin signos, sin decimales, sin notación científica).
    if (!/^\d+$/.test(s)) return DEFAULT_ESCALATION_THRESHOLD;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0 || n > MAX_ESCALATION_THRESHOLD) {
        return DEFAULT_ESCALATION_THRESHOLD;
    }
    return n;
}

// -----------------------------------------------------------------------------
// SEC-4 — Validadores de integridad del JSON persistido.
// -----------------------------------------------------------------------------
function isValidHitCount(value) {
    return Number.isInteger(value) && value >= 0;
}

function isValidTimestampMs(value) {
    if (value === null) return true; // null es válido (nunca-disparado/nunca-enviado).
    if (!Number.isFinite(value)) return false;
    if (value < 0) return false;
    // Rechazar timestamps futuros (>24h adelante) — bug en clock o corrupción
    // que dispararía supresión perpetua de la alerta TTL.
    if (value > Date.now() + MS_PER_DAY) return false;
    return true;
}

// -----------------------------------------------------------------------------
// UX-5 — Formateo `_human` con zona horaria local.
//
// Convierte epoch ms a string `YYYY-MM-DD HH:MM ±HHMM` legible. `null` o
// inválido → `"nunca"`.
// -----------------------------------------------------------------------------
function formatHumanTimestamp(ms) {
    if (ms === null || ms === undefined) return 'nunca';
    if (!Number.isFinite(ms)) return 'nunca';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return 'nunca';
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = d.getFullYear();
    const MM = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    // Offset firmado HH:MM
    const tzOffsetMin = -d.getTimezoneOffset(); // signo invertido respecto a JS
    const sign = tzOffsetMin >= 0 ? '+' : '-';
    const absMin = Math.abs(tzOffsetMin);
    const tzh = pad(Math.floor(absMin / 60));
    const tzm = pad(absMin % 60);
    return `${yyyy}-${MM}-${dd} ${hh}:${mm} ${sign}${tzh}:${tzm}`;
}

// -----------------------------------------------------------------------------
// readState — lee la sección `anthropic_1m_workaround` del session con
// validación estricta. Si está corrupta o ausente → estado vacío seguro.
//
// Devuelve `{ state, corrupt }` para que el caller pueda loggear corrupciones
// (SEC-4).
// -----------------------------------------------------------------------------
function readState(sessionFile) {
    const file = sessionFile || DEFAULT_SESSION_FILE;
    const empty = {
        hits_total: 0,
        last_hit_at: null,
        last_alert_sent_at: null,
        // #3987 — kill switch: hits consecutivos del episodio actual.
        consecutive_hits: 0,
        consecutive_last_at: null,
    };

    let session;
    try {
        const raw = fs.readFileSync(file, 'utf8');
        session = JSON.parse(raw);
    } catch {
        // Archivo ausente o JSON corrupto → estado vacío, sin marcar corrupt
        // (es la condición inicial normal del pipeline).
        return { state: empty, corrupt: [] };
    }

    const section = session && session.anthropic_1m_workaround;
    if (!section || typeof section !== 'object') {
        return { state: empty, corrupt: [] };
    }

    const corrupt = [];
    const validated = { ...empty };

    if ('hits_total' in section) {
        if (isValidHitCount(section.hits_total)) {
            validated.hits_total = section.hits_total;
        } else {
            corrupt.push({ field: 'hits_total', value: section.hits_total });
        }
    }
    if ('last_hit_at' in section) {
        // Accept ISO string or epoch ms. El JSON canónico usa ISO + _human.
        const ms = normalizeTimestamp(section.last_hit_at);
        if (isValidTimestampMs(ms)) {
            validated.last_hit_at = ms;
        } else {
            corrupt.push({ field: 'last_hit_at', value: section.last_hit_at });
        }
    }
    if ('last_alert_sent_at' in section) {
        const ms = normalizeTimestamp(section.last_alert_sent_at);
        if (isValidTimestampMs(ms)) {
            validated.last_alert_sent_at = ms;
        } else {
            corrupt.push({ field: 'last_alert_sent_at', value: section.last_alert_sent_at });
            // SEC-6: corrupt/futuro → tratar como 0 (permitir envío).
            validated.last_alert_sent_at = null;
        }
    }
    // #3987 — campos del kill switch (SEC-4: misma validación estricta).
    if ('consecutive_hits' in section) {
        if (isValidHitCount(section.consecutive_hits)) {
            validated.consecutive_hits = section.consecutive_hits;
        } else {
            corrupt.push({ field: 'consecutive_hits', value: section.consecutive_hits });
            // Corrupto → 0 (fail-safe: no escalar por basura en el JSON).
            validated.consecutive_hits = 0;
        }
    }
    if ('consecutive_last_at' in section) {
        const ms = normalizeTimestamp(section.consecutive_last_at);
        if (isValidTimestampMs(ms)) {
            validated.consecutive_last_at = ms;
        } else {
            corrupt.push({ field: 'consecutive_last_at', value: section.consecutive_last_at });
            validated.consecutive_last_at = null;
        }
    }

    return { state: validated, corrupt };
}

// normalizeTimestamp acepta ISO string, epoch ms, o null. Devuelve epoch ms
// o `null` si no se pudo interpretar.
function normalizeTimestamp(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        const t = Date.parse(trimmed);
        return Number.isFinite(t) ? t : NaN; // NaN dispara isValidTimestampMs=false
    }
    return NaN;
}

// -----------------------------------------------------------------------------
// writeState — persiste la sección con todos los campos autodescriptivos
// (CA-8/UX-5: incluye `_human` por timestamp y constantes inline).
//
// Idempotente: leer-mutar-escribir el JSON completo. NO toca otras secciones
// del session.
// -----------------------------------------------------------------------------
function writeState(state, sessionFile) {
    const file = sessionFile || DEFAULT_SESSION_FILE;
    let session = {};
    try {
        const raw = fs.readFileSync(file, 'utf8');
        session = JSON.parse(raw) || {};
        if (typeof session !== 'object') session = {};
    } catch {
        session = {};
    }

    const enabled = isWorkaroundEnabled();
    const lastHitAt = state.last_hit_at;
    const lastAlertAt = state.last_alert_sent_at;
    const consecutiveLastAt = state.consecutive_last_at;

    session.anthropic_1m_workaround = {
        enabled,
        hits_total: state.hits_total,
        last_hit_at: lastHitAt === null ? null : new Date(lastHitAt).toISOString(),
        last_hit_at_human: formatHumanTimestamp(lastHitAt),
        last_alert_sent_at: lastAlertAt === null ? null : new Date(lastAlertAt).toISOString(),
        last_alert_sent_at_human: formatHumanTimestamp(lastAlertAt),
        ttl_days_threshold: TTL_DAYS_THRESHOLD,
        cooldown_days: COOLDOWN_DAYS,
        // #3987 — estado del kill switch de escalación a fallback.
        consecutive_hits: state.consecutive_hits || 0,
        consecutive_last_at: consecutiveLastAt === null || consecutiveLastAt === undefined
            ? null : new Date(consecutiveLastAt).toISOString(),
        consecutive_last_at_human: formatHumanTimestamp(
            consecutiveLastAt === undefined ? null : consecutiveLastAt),
        escalation_threshold: getEscalationThreshold(),
    };

    fs.writeFileSync(file, JSON.stringify(session, null, 2));
}

// -----------------------------------------------------------------------------
// recordHit — incrementa el contador y actualiza `last_hit_at`.
//
// Devuelve el estado resultante para que el caller pueda usarlo (e.g.
// formatear el mensaje extendido al usuario sin re-leer el archivo).
// -----------------------------------------------------------------------------
function recordHit(opts) {
    const o = opts || {};
    const sessionFile = o.sessionFile;
    const now = Number.isFinite(o.now) ? o.now : Date.now();

    const { state, corrupt } = readState(sessionFile);

    // SEC-4: si había campos corruptos, ya los resetea readState (vuelven a
    // empty). El caller puede loggear los corrupt.
    state.hits_total = state.hits_total + 1;
    state.last_hit_at = now;

    // #3987 — contador de hits CONSECUTIVOS del episodio actual. Si el último
    // hit consecutivo fue reciente (< CONSECUTIVE_STALE_MS) acumulamos; si pasó
    // mucho tiempo (o nunca hubo), arrancamos un episodio nuevo en 1.
    const prevAt = state.consecutive_last_at;
    const fresh = prevAt !== null && Number.isFinite(prevAt) && (now - prevAt) <= CONSECUTIVE_STALE_MS;
    state.consecutive_hits = fresh ? (state.consecutive_hits || 0) + 1 : 1;
    state.consecutive_last_at = now;

    writeState(state, sessionFile);

    // Decisión de escalación: umbral > 0 y alcanzamos/superamos el umbral.
    const threshold = getEscalationThreshold(o.envOverride);
    const escalate = threshold > 0 && state.consecutive_hits >= threshold;

    return { state, corrupt, escalate, consecutive: state.consecutive_hits, threshold };
}

// -----------------------------------------------------------------------------
// #3987 — resetConsecutive()
//
// Resetea el contador de hits consecutivos. El caller lo invoca cuando el
// Commander tuvo un spawn EXITOSO sobre Anthropic (la cuota volvió → el
// episodio de glitch/agotamiento terminó) para que un futuro glitch arranque
// un episodio nuevo desde cero. NO toca `hits_total` (contador histórico de
// por vida) ni `last_alert_sent_at`.
//
// Idempotente y best-effort: si no hay nada que resetear, no reescribe.
// -----------------------------------------------------------------------------
function resetConsecutive(opts) {
    const o = opts || {};
    const sessionFile = o.sessionFile;

    const { state, corrupt } = readState(sessionFile);
    if ((state.consecutive_hits || 0) === 0 && state.consecutive_last_at === null) {
        // Nada que resetear — evitamos reescritura innecesaria del JSON.
        return { state, corrupt, changed: false };
    }
    state.consecutive_hits = 0;
    state.consecutive_last_at = null;
    writeState(state, sessionFile);
    return { state, corrupt, changed: true };
}

// -----------------------------------------------------------------------------
// checkTtlAlert — chequea si corresponde emitir la alerta TTL.
//
// Condiciones para emitir (CA-4):
//   1. Flag está habilitado (no tiene sentido alertar con flag OFF).
//   2. `last_hit_at` existe (si nunca hubo un hit, no es "presunto resuelto",
//      es "nunca disparó" — distinto evento).
//   3. `now - last_hit_at > TTL_DAYS_THRESHOLD * MS_PER_DAY`.
//   4. `last_alert_sent_at === null` OR `now - last_alert_sent_at > COOLDOWN_DAYS * MS_PER_DAY`.
//
// Devuelve `{ shouldEmit, reason, state }`.
// `reason` describe por qué NO emite (cuando shouldEmit=false), útil para
// debugging.
// -----------------------------------------------------------------------------
function checkTtlAlert(opts) {
    const o = opts || {};
    const sessionFile = o.sessionFile;
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    const envOverride = o.envOverride;

    const { state, corrupt } = readState(sessionFile);
    const enabled = isWorkaroundEnabled(envOverride);

    if (!enabled) {
        return { shouldEmit: false, reason: 'flag_disabled', state, corrupt };
    }
    if (state.last_hit_at === null) {
        return { shouldEmit: false, reason: 'no_hits_ever', state, corrupt };
    }
    const ageMs = now - state.last_hit_at;
    if (ageMs < TTL_DAYS_THRESHOLD * MS_PER_DAY) {
        return { shouldEmit: false, reason: 'ttl_not_reached', state, corrupt };
    }
    if (state.last_alert_sent_at !== null) {
        const cooldownAge = now - state.last_alert_sent_at;
        if (cooldownAge < COOLDOWN_DAYS * MS_PER_DAY) {
            return { shouldEmit: false, reason: 'cooldown_active', state, corrupt };
        }
    }
    return { shouldEmit: true, reason: null, state, corrupt };
}

// -----------------------------------------------------------------------------
// recordAlertSent — persiste `last_alert_sent_at = now` después de emitir la
// alerta TTL. NO toca `last_hit_at` ni `hits_total`.
// -----------------------------------------------------------------------------
function recordAlertSent(opts) {
    const o = opts || {};
    const sessionFile = o.sessionFile;
    const now = Number.isFinite(o.now) ? o.now : Date.now();

    const { state } = readState(sessionFile);
    state.last_alert_sent_at = now;
    writeState(state, sessionFile);
    return { state };
}

// -----------------------------------------------------------------------------
// formatStartupLogLine — UX-4 / CA-7.
//
// Devuelve EXACTAMENTE una de las dos líneas canónicas, según el estado del
// flag y los hits acumulados. El caller hace el `console.log` / `log()`.
// -----------------------------------------------------------------------------
function formatStartupLogLine(opts) {
    const o = opts || {};
    const sessionFile = o.sessionFile;
    const envOverride = o.envOverride;
    const enabled = isWorkaroundEnabled(envOverride);
    if (!enabled) {
        return `[multi-provider] ${FEATURE_FLAG_ENV}=0 detectado — workaround #3506 deshabilitado.`;
    }
    const { state } = readState(sessionFile);
    const lastHit = formatHumanTimestamp(state.last_hit_at);
    return `[multi-provider] ${FEATURE_FLAG_ENV}=1 (default) — workaround #3506 activo. Hits totales: ${state.hits_total}. Último hit: ${lastHit}.`;
}

// -----------------------------------------------------------------------------
// formatHitExtension — UX-1 / CA-5.
//
// Devuelve el snippet que el caller debe **anexar al final** del mensaje
// Telegram del hit (no reemplaza el mensaje principal del Pulpo). Tono
// natural, sin emojis del SO, sin truncar.
// -----------------------------------------------------------------------------
function formatHitExtension(opts) {
    const o = opts || {};
    const sessionFile = o.sessionFile;
    const { state } = readState(sessionFile);
    const lastHit = formatHumanTimestamp(state.last_hit_at);
    return (
        `\n\nWorkaround Anthropic 1M activo. Hits últimos 7 días: ${state.hits_total}. Último: ${lastHit}.\n` +
        `Para probar si Anthropic ya arregló: setear ${FEATURE_FLAG_ENV}=0 y reintentar.`
    );
}

// -----------------------------------------------------------------------------
// formatTtlAlertMessage — UX-2 / CA-6.
//
// Devuelve el cuerpo COMPLETO del mensaje Telegram TTL. Marker `🧪` semántico
// inicial (consistente con la convención del bot: marcador semántico, no
// decoración).
// -----------------------------------------------------------------------------
function formatTtlAlertMessage(opts) {
    const o = opts || {};
    const sessionFile = o.sessionFile;
    const envOverride = o.envOverride;
    const { state } = readState(sessionFile);
    const enabled = isWorkaroundEnabled(envOverride);
    const lastHit = formatHumanTimestamp(state.last_hit_at);
    const flagValue = enabled ? '1' : '0';
    const flagLabel = enabled ? 'activo' : 'deshabilitado';
    return (
        `🧪 Workaround Anthropic 1M sin hits hace ${TTL_DAYS_THRESHOLD} días — presunto resuelto upstream\n\n` +
        `Último hit: ${lastHit}\n` +
        `Hits totales acumulados: ${state.hits_total}\n` +
        `Flag actual: ${FEATURE_FLAG_ENV}=${flagValue} (${flagLabel})\n\n` +
        `Próximo paso sugerido:\n` +
        `1. Setear ${FEATURE_FLAG_ENV}=0 en el entorno.\n` +
        `2. Esperar 24-48h de uso normal del pipeline.\n` +
        `3. Si no aparecen errores nuevos en errorClass=quota_exhausted con shape 1M context,\n` +
        `   crear PR para remover el workaround completo (issue de seguimiento).\n` +
        `4. Si reaparecen → revertir flag a 1, abrir issue de regresión upstream.\n\n` +
        `Cooldown: esta alerta no se va a repetir por ${COOLDOWN_DAYS} días.`
    );
}

// -----------------------------------------------------------------------------
// sanitizeHitLog — SEC-5.
//
// Construye el objeto que se loggea por hit. SOLO los campos permitidos.
// `evidence` debe venir ya saneada por `sanitizeRawExcerpt` (#3506); este
// helper NO la procesa más, solo arma el shape.
// -----------------------------------------------------------------------------
function sanitizeHitLog(input) {
    const i = input || {};
    return {
        timestamp: typeof i.timestamp === 'string' ? i.timestamp : new Date().toISOString(),
        provider: typeof i.provider === 'string' ? i.provider : 'anthropic',
        errorClass: 'cli_1m_context_glitch',
        evidence: typeof i.evidence === 'string' ? i.evidence.slice(0, 200) : '',
    };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------
module.exports = {
    // API pública
    isWorkaroundEnabled,
    getEscalationThreshold,
    recordHit,
    resetConsecutive,
    checkTtlAlert,
    recordAlertSent,
    formatStartupLogLine,
    formatHitExtension,
    formatTtlAlertMessage,
    sanitizeHitLog,

    // Helpers expuestos para tests
    _readState: readState,
    _writeState: writeState,
    _formatHumanTimestamp: formatHumanTimestamp,
    _isValidHitCount: isValidHitCount,
    _isValidTimestampMs: isValidTimestampMs,
    _normalizeTimestamp: normalizeTimestamp,

    // Constantes
    FEATURE_FLAG_ENV,
    TTL_DAYS_THRESHOLD,
    COOLDOWN_DAYS,
    MS_PER_DAY,
    DEFAULT_SESSION_FILE,
    // #3987 — kill switch de escalación.
    ESCALATION_THRESHOLD_ENV,
    DEFAULT_ESCALATION_THRESHOLD,
    MAX_ESCALATION_THRESHOLD,
    CONSECUTIVE_STALE_MS,
};
