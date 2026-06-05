// =============================================================================
// health-alerts.js — Dedupe + back-off + persistencia de alertas Telegram del
// healthcheck multi-provider (#3260 CA-4 / SR-4 / SR-5).
//
// Reglas inquebrantables (consolidadas del análisis security #3260):
//
//   - Payload **metadata-only**: `{ provider, state, reason_code, observed_at }`.
//     PROHIBIDO incluir API key (ni masked ni fingerprint), body de la
//     respuesta del provider, headers, stack traces con paths absolutos.
//   - Antes de postear, el payload pasa por `redactHeaders`/`redactJson` del
//     módulo `redact.js` (defense in depth — si alguien mete un campo nuevo
//     "demasiado expresivo" se redacta antes de salir).
//   - Dedupe efectivo 10 min: mismo combo `provider+state` no se reenvía
//     dentro de los 10 min siguientes (SR-5).
//   - Back-off exponencial cuando el estado rojo persiste >30 min: alerta
//     cada 30/60/120/240 min sin flood (SR-5).
//   - Estado persistido en `~/.claude/secrets/telegram-alerts-dedup.json`
//     (0600) para sobrevivir restarts del pulpo.
//
// Este módulo NO tiene network I/O propio — solo decide si emitir, y deja
// el envío a `health-cron.js` que invoca el helper de telegram ya existente
// (o queda como hint para integración posterior si no hay telegram conectado).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const redact = require('../redact');

const HOME_DEDUP_FILE = path.join(os.homedir(), '.claude', 'secrets', 'telegram-alerts-dedup.json');

// Ventanas en ms — el cron las llama con el `now` actual para chequear.
const DEDUP_WINDOW_MS = 10 * 60 * 1000;          // 10 min: re-alerta misma combo prohibida.
const BACKOFF_LEVELS_MS = Object.freeze([
    30 * 60 * 1000,  // 30 min: primera re-alerta si sigue rojo.
    60 * 60 * 1000,  // 60 min: segunda.
    120 * 60 * 1000, // 120 min.
    240 * 60 * 1000, // 240 min (4h): cap.
]);
const BACKOFF_CAP_MS = BACKOFF_LEVELS_MS[BACKOFF_LEVELS_MS.length - 1];

// Reason codes válidos espejados de live-ping.js (anti-leak: si llega un
// código provider-specific, lo mapeamos a `unknown` antes de persistirlo).
const ALLOWED_REASON_CODES = Object.freeze(new Set([
    'authenticated',
    'invalid_credentials',
    'forbidden',
    'quota_exhausted',
    'rate_limited',
    'unknown',
    'timeout',
    'network_error',
    'no_key_configured',
    'unknown_provider',
    // #3802 — providers CLI-OAuth (Claude Code / Codex): validados por CLI.
    'cli_oauth_ok',
    'cli_unavailable',
    'cli_binary_undeclared',
]));

// Estados válidos del provider (espejan los CA-3 / narrativa UX).
const ALLOWED_STATES = Object.freeze(new Set(['green', 'yellow', 'red']));

function tryReadJson(file, fsImpl = fs) {
    if (!fsImpl.existsSync(file)) return null;
    try {
        return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function writeJsonAtomic(file, data, fsImpl = fs) {
    const dir = path.dirname(file);
    if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fsImpl.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fsImpl.renameSync(tmp, file);
    try { fsImpl.chmodSync(file, 0o600); } catch { /* Windows: best-effort */ }
}

function sanitizeReasonCode(code) {
    if (typeof code !== 'string') return 'unknown';
    return ALLOWED_REASON_CODES.has(code) ? code : 'unknown';
}

function sanitizeState(state) {
    if (typeof state !== 'string') return null;
    return ALLOWED_STATES.has(state) ? state : null;
}

function sanitizeProvider(provider) {
    // Solo aceptamos providers que matcheen el patrón seguro (lowercase + dash).
    if (typeof provider !== 'string' || !/^[a-z][a-z0-9-]{0,32}$/.test(provider)) return null;
    return provider;
}

/**
 * Decide si una transición de estado merece emisión a Telegram.
 *
 * Lógica:
 *   - Si NO hay registro previo de `provider+state` → emitir (primera vez).
 *   - Si el último envío fue hace < DEDUP_WINDOW_MS → suprimir.
 *   - Si el estado es `red` y persiste, aplicar back-off exponencial
 *     (30/60/120/240 min entre alertas).
 *   - Para estados `green` / `yellow` solo aplica la ventana dedup de 10 min.
 *
 * @param {object} params
 * @param {string} params.provider — `gemini-google`, `cerebras`, etc.
 * @param {string} params.state — `green` | `yellow` | `red`.
 * @param {string} params.reasonCode — código genérico (sanitizado al persistir).
 * @param {number} [params.now=Date.now()]
 * @param {string} [params.dedupFile=HOME_DEDUP_FILE]
 * @param {object} [params.fsImpl=fs]
 * @returns {{ shouldEmit: boolean, reasonNoEmit?: string, payload?: object, nextEligibleAt?: number, backoffLevel?: number }}
 */
function decide({ provider, state, reasonCode, now = Date.now(), dedupFile = HOME_DEDUP_FILE, fsImpl = fs } = {}) {
    const p = sanitizeProvider(provider);
    const s = sanitizeState(state);
    const code = sanitizeReasonCode(reasonCode);
    if (!p || !s) {
        return { shouldEmit: false, reasonNoEmit: 'invalid_input' };
    }

    const store = tryReadJson(dedupFile, fsImpl) || { alerts: {} };
    if (!store.alerts || typeof store.alerts !== 'object') store.alerts = {};

    const key = `${p}|${s}`;
    const prev = store.alerts[key];

    let shouldEmit = false;
    let backoffLevel = 0;

    if (!prev) {
        shouldEmit = true;
    } else {
        const elapsed = now - (prev.last_sent_at || 0);
        if (s === 'red') {
            // Back-off escalonado: después de la N-ésima alerta consecutiva, la
            // siguiente requiere esperar BACKOFF_LEVELS_MS[N-1] (cap en 240
            // min). Con consecutive_count=1 (1ra alerta enviada), la próxima
            // espera 30min (level 0). Con count=2 espera 60min (level 1), etc.
            const sentSoFar = prev.consecutive_count || 0;
            const levelIndex = Math.min(Math.max(sentSoFar - 1, 0), BACKOFF_LEVELS_MS.length - 1);
            const requiredGap = BACKOFF_LEVELS_MS[levelIndex];
            if (elapsed >= requiredGap) {
                shouldEmit = true;
                backoffLevel = levelIndex + 1;
            }
        } else {
            // green/yellow: solo dedup de 10 min.
            if (elapsed >= DEDUP_WINDOW_MS) shouldEmit = true;
        }
    }

    if (!shouldEmit) {
        const sentSoFar = prev ? (prev.consecutive_count || 0) : 0;
        const levelIndex = s === 'red'
            ? Math.min(Math.max(sentSoFar - 1, 0), BACKOFF_LEVELS_MS.length - 1)
            : 0;
        const gap = s === 'red' ? BACKOFF_LEVELS_MS[levelIndex] : DEDUP_WINDOW_MS;
        const next = prev ? prev.last_sent_at + gap : now;
        return {
            shouldEmit: false,
            reasonNoEmit: prev ? 'dedup_window' : 'unknown',
            nextEligibleAt: next,
        };
    }

    // Construir payload metadata-only (SR-4): nada de keys/fingerprints/body.
    const payload = {
        provider: p,
        state: s,
        reason_code: code,
        observed_at: new Date(now).toISOString(),
    };

    // SR-4: defense in depth — pasar por `redactValue` para garantizar que
    // si alguien futuramente suma una key sensible al payload, se redacta.
    const sanitized = redact.redactValue(payload);

    return {
        shouldEmit: true,
        payload: sanitized,
        backoffLevel,
    };
}

/**
 * Persiste el resultado de un envío (success o failure). Si el envío fue exitoso,
 * actualiza `last_sent_at` y `consecutive_count` para el cálculo del próximo
 * back-off. Si falló, NO incrementa el contador (deja la próxima decisión libre
 * para reintentar más rápido).
 *
 * @param {object} params
 * @param {string} params.provider
 * @param {string} params.state
 * @param {boolean} params.sent — true si se envió a Telegram exitosamente.
 * @param {number} [params.now=Date.now()]
 * @param {string} [params.dedupFile=HOME_DEDUP_FILE]
 * @param {object} [params.fsImpl=fs]
 */
function record({ provider, state, sent, now = Date.now(), dedupFile = HOME_DEDUP_FILE, fsImpl = fs } = {}) {
    const p = sanitizeProvider(provider);
    const s = sanitizeState(state);
    if (!p || !s || !sent) return;

    const store = tryReadJson(dedupFile, fsImpl) || { alerts: {} };
    if (!store.alerts || typeof store.alerts !== 'object') store.alerts = {};

    const key = `${p}|${s}`;
    const prev = store.alerts[key];

    store.alerts[key] = {
        last_sent_at: now,
        consecutive_count: (prev && prev.consecutive_count ? prev.consecutive_count : 0) + 1,
    };

    // Reset contadores de OTROS estados del mismo provider cuando éste se emite
    // (la cadena del back-off es por provider+state, no global).
    for (const otherKey of Object.keys(store.alerts)) {
        if (otherKey === key) continue;
        if (otherKey.startsWith(`${p}|`)) {
            // El otro estado del mismo provider quedó stale — resetear contador
            // para que cuando vuelva a aparecer empiece desde el primer nivel.
            store.alerts[otherKey] = { ...store.alerts[otherKey], consecutive_count: 0 };
        }
    }

    try { writeJsonAtomic(dedupFile, store, fsImpl); }
    catch { /* best-effort: si no podemos escribir, próxima decisión re-emite */ }
}

/**
 * Wrapper conveniente para la condición CA-4 (b): "más de 2 free providers
 * caídos simultáneamente". Acepta el snapshot completo y devuelve true si
 * 3+ free providers están en rojo y la última alerta global de "multi-down"
 * fue hace más de DEDUP_WINDOW_MS.
 *
 * Los providers free se identifican por estar en el set conocido (no incluye
 * anthropic / openai, que no son free tier).
 *
 * Groq fue descontinuado en #3353 (mayo 2026) por política inestable de
 * restricciones del proveedor.
 */
const FREE_PROVIDERS = Object.freeze(new Set(['gemini-google', 'cerebras', 'nvidia-nim']));

function decideMultiDown({ snapshot, now = Date.now(), dedupFile = HOME_DEDUP_FILE, fsImpl = fs } = {}) {
    if (!snapshot || !Array.isArray(snapshot.providers)) {
        return { shouldEmit: false, reasonNoEmit: 'invalid_snapshot' };
    }
    const reds = snapshot.providers.filter(p => p.state === 'red' && FREE_PROVIDERS.has(p.provider));
    if (reds.length < 3) return { shouldEmit: false, reasonNoEmit: 'below_threshold', red_count: reds.length };

    const store = tryReadJson(dedupFile, fsImpl) || { alerts: {} };
    if (!store.alerts || typeof store.alerts !== 'object') store.alerts = {};
    const prev = store.alerts['__multi_down__'];
    if (prev && (now - (prev.last_sent_at || 0)) < DEDUP_WINDOW_MS) {
        return { shouldEmit: false, reasonNoEmit: 'dedup_window', red_count: reds.length };
    }
    const payload = {
        event: 'multi_down',
        red_count: reds.length,
        providers_red: reds.map(p => p.provider).sort(),
        observed_at: new Date(now).toISOString(),
    };
    return {
        shouldEmit: true,
        payload: redact.redactValue(payload),
        red_count: reds.length,
    };
}

function recordMultiDown({ sent, now = Date.now(), dedupFile = HOME_DEDUP_FILE, fsImpl = fs } = {}) {
    if (!sent) return;
    const store = tryReadJson(dedupFile, fsImpl) || { alerts: {} };
    if (!store.alerts || typeof store.alerts !== 'object') store.alerts = {};
    store.alerts['__multi_down__'] = {
        last_sent_at: now,
        consecutive_count: ((store.alerts['__multi_down__'] && store.alerts['__multi_down__'].consecutive_count) || 0) + 1,
    };
    try { writeJsonAtomic(dedupFile, store, fsImpl); } catch { /* best-effort */ }
}

module.exports = {
    HOME_DEDUP_FILE,
    DEDUP_WINDOW_MS,
    BACKOFF_LEVELS_MS,
    BACKOFF_CAP_MS,
    ALLOWED_REASON_CODES,
    ALLOWED_STATES,
    FREE_PROVIDERS,
    decide,
    record,
    decideMultiDown,
    recordMultiDown,
    sanitizeProvider,
    sanitizeState,
    sanitizeReasonCode,
};
