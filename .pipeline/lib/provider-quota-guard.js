// =============================================================================
// provider-quota-guard.js — Alerta y switch preventivo por cuota de proveedor.
// Issue #4282.
//
// OBJETIVO
//   Anticipar la caída de un proveedor: avisar (Telegram + banner) y —si el
//   flag de switch preventivo está activo— degradar el primary a fallback
//   ANTES de quedarse sin cuota, en vez de descubrirlo al reventar.
//
// FUENTE DE DATO (reuso, NO re-extracción — CA-11)
//   Consume el shape público por proveedor de `dashboard-slices.quotaSlice`:
//     slice.providers[p] = {
//       provider, adapterStatus,
//       session: { pct, confidence },
//       weekly:  { pct, confidence },
//     }
//   El guard NO toca snapshots crudos, tokens ni material de auth.
//
// INVARIANTES DE SEGURIDAD (REQ-SEC-1..5 / CA-2,4,9,10)
//   - Solo actúa (alerta o switch) con `confidence === 'fresh'` (REQ-SEC-4).
//   - Config inválida → defaults conservadores + log, sin romper el ticker
//     (REQ-SEC-2): se valida `0 < warn < crit <= 100` numérico.
//   - El payload de la alerta/banner es SOLO numérico/categórico
//     (provider/pct/window/confidence/level) — sin secretos (REQ-SEC-1).
//   - El switch preventivo (soft) NUNCA fuerza el hard gate; precedencia y
//     no-vaciado de chain se resuelven en dispatch-with-fallback (REQ-SEC-3).
//   - Cada degradación preventiva loggea provider/pct/umbral/confidence
//     (REQ-SEC-5).
//
// ANTI-FLAPPING / DEDUPE (CA-8)
//   Una sola alerta por cruce de umbral (high-water-mark), reset al volver a
//   `ok`. El marker de degradación persiste mientras el nivel siga crit
//   (banda muerta) y se limpia al recuperar `ok`, con TTL de respaldo.
//
// Sin dependencias externas nuevas (Node puro). Estado persistido en JSON.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// -----------------------------------------------------------------------------
// Defaults conservadores
// -----------------------------------------------------------------------------

const DEFAULT_WARN = 80;
const DEFAULT_CRIT = 95;
const DEFAULT_MARKER_TTL_MIN = 90;   // vigencia del marker preventivo (respaldo)
const MAX_MARKER_TTL_MIN = 24 * 60;

const LEVEL_RANK = Object.freeze({ ok: 0, warn: 1, crit: 2 });
const RANK_LEVEL = Object.freeze(['ok', 'warn', 'crit']);

// Ventanas evaluadas por proveedor. Codex no tiene `session` (siempre null) y
// los free-tier exponen buckets `missing`: el gate de `fresh` los descarta solo.
const WINDOWS = Object.freeze(['session', 'weekly']);

// Patrones de secreto — defensa REQ-SEC-1 sobre el mensaje generado.
const SECRET_PATTERNS = [
    /AKIA[0-9A-Z]{16}/,                 // AWS access key id
    /\bBearer\s+[A-Za-z0-9._\-]+/i,     // Bearer token
    /\beyJ[A-Za-z0-9._\-]{20,}/,        // JWT
    /api[_-]?key/i,                     // api_key / api-key / apikey
    /sk-[A-Za-z0-9]{16,}/,              // OpenAI-style secret
];

// -----------------------------------------------------------------------------
// Paths / IO
// -----------------------------------------------------------------------------

function pipelineDirDefault() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function stateFile(pd) { return path.join(pd, '.provider-quota-guard-state.json'); }
function markerFile(pd) { return path.join(pd, '.provider-preventive-degrade.json'); }
function telegramQueueDir(pd) { return path.join(pd, 'servicios', 'telegram', 'pendiente'); }

function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
}

function writeJsonAtomic(filepath, data) {
    ensureDir(path.dirname(filepath));
    const tmp = path.join(
        path.dirname(filepath),
        `.${path.basename(filepath)}.${process.pid}.tmp`,
    );
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filepath);
}

// -----------------------------------------------------------------------------
// Config (REQ-SEC-2): validación fail-safe del bloque multi_provider.quota_alert
// -----------------------------------------------------------------------------

/**
 * Valida un par de umbrales `{warn, crit}`. Devuelve el par normalizado o null
 * si es inválido (no numérico o fuera de `0 < warn < crit <= 100`).
 */
function validThresholdPair(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const warn = Number(obj.warn);
    const crit = Number(obj.crit);
    if (!Number.isFinite(warn) || !Number.isFinite(crit)) return null;
    if (!(warn > 0 && warn < crit && crit <= 100)) return null;
    return { warn, crit };
}

/**
 * Lee y valida el bloque `multi_provider.quota_alert` de la config parseada.
 * NUNCA lanza: ante cualquier anomalía cae a defaults conservadores y loggea.
 *
 * @param {object} rawConfig  config.yaml ya parseada (objeto)
 * @param {object} [opts]     { log }
 * @returns {{providers:object, defaults:{warn,crit}, preventiveSwitchEnabled:boolean, markerTtlMin:number}}
 */
function loadGuardConfig(rawConfig, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const out = {
        providers: {},
        defaults: { warn: DEFAULT_WARN, crit: DEFAULT_CRIT },
        preventiveSwitchEnabled: false,
        markerTtlMin: DEFAULT_MARKER_TTL_MIN,
    };
    try {
        const block = rawConfig
            && rawConfig.multi_provider
            && rawConfig.multi_provider.quota_alert;
        if (!block || typeof block !== 'object') {
            log('quota-guard: multi_provider.quota_alert ausente — defaults conservadores');
            return out;
        }

        // preventive_switch.enabled — solo `true` literal activa el switch.
        const ps = block.preventive_switch;
        out.preventiveSwitchEnabled = !!(ps && typeof ps === 'object' && ps.enabled === true);
        const ttl = Number(ps && ps.marker_ttl_minutes);
        if (Number.isFinite(ttl) && ttl > 0 && ttl <= MAX_MARKER_TTL_MIN) {
            out.markerTtlMin = ttl;
        }

        for (const [key, val] of Object.entries(block)) {
            if (key === 'preventive_switch') continue;
            if (key === 'defaults') {
                const d = validThresholdPair(val);
                if (d) out.defaults = d;
                else log("quota-guard: 'defaults' inválido — uso defaults internos");
                continue;
            }
            const pair = validThresholdPair(val);
            if (pair) out.providers[key] = pair;
            else log(`quota-guard: umbral inválido para '${key}' — ignorado (fallback a defaults)`);
        }
    } catch (e) {
        log(`quota-guard: error leyendo config — defaults (${e && e.message})`);
    }
    return out;
}

function thresholdsFor(provider, cfg) {
    return (cfg && cfg.providers && cfg.providers[provider])
        || (cfg && cfg.defaults)
        || { warn: DEFAULT_WARN, crit: DEFAULT_CRIT };
}

/**
 * Clasifica un pct contra `{warn, crit}` → 'ok' | 'warn' | 'crit' | 'unknown'.
 */
function classify(pct, thresholds) {
    if (!Number.isFinite(pct) || pct < 0) return 'unknown';
    const warn = Number.isFinite(thresholds && thresholds.warn) ? thresholds.warn : DEFAULT_WARN;
    const crit = Number.isFinite(thresholds && thresholds.crit) ? thresholds.crit : DEFAULT_CRIT;
    if (pct >= crit) return 'crit';
    if (pct >= warn) return 'warn';
    return 'ok';
}

// -----------------------------------------------------------------------------
// Estado (dedupe / banner) y marker (degradación preventiva)
// -----------------------------------------------------------------------------

function defaultState() {
    return { providers: {}, banner: null };
}

function loadState(pd) {
    try {
        const raw = fs.readFileSync(stateFile(pd), 'utf8');
        const o = JSON.parse(raw);
        if (o && typeof o === 'object') {
            if (!o.providers || typeof o.providers !== 'object') o.providers = {};
            if (o.banner === undefined) o.banner = null;
            return o;
        }
    } catch { /* ausente / corrupto → default */ }
    return defaultState();
}

function saveState(pd, st) {
    try { writeJsonAtomic(stateFile(pd), st); } catch { /* best-effort */ }
}

function defaultMarker() {
    return { degraded: {} };
}

function loadMarker(pd) {
    try {
        const raw = fs.readFileSync(markerFile(pd), 'utf8');
        const o = JSON.parse(raw);
        if (o && typeof o === 'object') {
            if (!o.degraded || typeof o.degraded !== 'object') o.degraded = {};
            return o;
        }
    } catch { /* ausente / corrupto → default */ }
    return defaultMarker();
}

function saveMarker(pd, m) {
    try { writeJsonAtomic(markerFile(pd), m); } catch { /* best-effort */ }
}

/**
 * ¿El provider está marcado para degradación preventiva (soft) y vigente?
 * Consumido por `resolveSpawnWithFallback` (dispatch-with-fallback.js).
 * Fail-open: ante cualquier error → false (el soft gate nunca bloquea por bug).
 */
function isPreventivelyDegraded(provider, opts = {}) {
    try {
        if (!provider) return false;
        const pd = opts.pipelineDir || pipelineDirDefault();
        const now = Number.isFinite(opts.now) ? opts.now : Date.now();
        const m = opts.marker || loadMarker(pd);
        const entry = m && m.degraded && m.degraded[provider];
        if (!entry || typeof entry !== 'object') return false;
        const exp = Number(entry.expiresAt);
        if (!Number.isFinite(exp) || now >= exp) return false;
        return true;
    } catch {
        return false;
    }
}

// -----------------------------------------------------------------------------
// Telegram (FS queue) + mensaje (REQ-SEC-1: solo métricas, sin secretos)
// -----------------------------------------------------------------------------

function enqueueTelegram(pd, text, now) {
    try {
        const dir = telegramQueueDir(pd);
        ensureDir(dir);
        const file = path.join(dir, `${now}-provider-quota-guard.json`);
        fs.writeFileSync(file, JSON.stringify({ text, parse_mode: 'Markdown' }), 'utf8');
        return { ok: true, file };
    } catch (e) {
        return { ok: false, reason: e && e.message };
    }
}

function containsSecret(text) {
    if (typeof text !== 'string') return false;
    return SECRET_PATTERNS.some((re) => re.test(text));
}

const WINDOW_LABEL = Object.freeze({ session: 'sesión', weekly: 'semanal' });

function capitalize(s) {
    const str = String(s || '');
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Construye el mensaje de alerta. SOLO interpola datos numéricos/categóricos
 * (provider/pct/window/level) — nunca el objeto crudo del provider (REQ-SEC-1).
 * Copy alineado con las guidelines de UX del issue (warn 🟡 / crit 🔴,
 * "dato actualizado" en vez de jerga, acción del switch explícita).
 */
function buildAlertMessage(info) {
    const { provider, pct, window, level, switchEnabled, degraded } = info;
    const emoji = level === 'crit' ? '🔴' : '🟡';
    const win = WINDOW_LABEL[window] || window;
    const pctTxt = `${Math.round(pct)}%`;
    let action;
    if (degraded) {
        action = 'Switch preventivo: ACTIVO → degradando a fallback.';
    } else if (switchEnabled) {
        action = 'Switch preventivo: ACTIVO (aún sin degradar).';
    } else {
        action = 'Switch preventivo: OFF (solo aviso).';
    }
    const msg = [
        `${emoji} ${capitalize(provider)} va al ${pctTxt} (${win}).`,
        `Nivel: ${level}. Dato actualizado.`,
        action,
    ].join('\n');
    // Defensa en profundidad: si por algún cambio futuro se colara un secreto,
    // no lo emitimos.
    return containsSecret(msg) ? '[alerta de cuota redactada]' : msg;
}

// -----------------------------------------------------------------------------
// Evaluación principal
// -----------------------------------------------------------------------------

/**
 * Evalúa el slice multi-provider y dispara alertas / marca degradación
 * preventiva según umbrales, con dedupe e invariante de `confidence === fresh`.
 *
 * @param {object} opts
 * @param {object} opts.slice        salida de quotaSlice (necesita `.providers`)
 * @param {object} [opts.config]     config ya cargada por loadGuardConfig
 * @param {object} [opts.rawConfig]  config.yaml parseada (si no se pasa config)
 * @param {number} [opts.now]
 * @param {string} [opts.pipelineDir]
 * @param {Function} [opts.log]
 * @param {(text:string)=>void} [opts.sendTelegram]  sender inyectable (tests)
 * @param {object} [opts.state]      estado inyectable (tests)
 * @param {object} [opts.marker]     marker inyectable (tests)
 * @param {boolean} [opts.persist]   default true; false → no escribe a disco
 * @returns {{alerts:Array, degraded:string[], cleared:string[], banner:object|null, state:object, marker:object}}
 */
function evaluate(opts = {}) {
    const pd = opts.pipelineDir || pipelineDirDefault();
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const persist = opts.persist !== false;
    const slice = opts.slice;
    const cfg = opts.config || loadGuardConfig(opts.rawConfig || {}, { log });
    const sendTelegram = typeof opts.sendTelegram === 'function'
        ? opts.sendTelegram
        : (text) => { enqueueTelegram(pd, text, now); };

    const result = { alerts: [], degraded: [], cleared: [], banner: null };

    if (!slice || typeof slice !== 'object' || !slice.providers || typeof slice.providers !== 'object') {
        log('quota-guard: slice inválido o sin `providers` — no actúa');
        return result;
    }

    const state = opts.state || loadState(pd);
    if (!state.providers || typeof state.providers !== 'object') state.providers = {};
    const marker = opts.marker || loadMarker(pd);
    if (!marker.degraded || typeof marker.degraded !== 'object') marker.degraded = {};

    let dirty = false;

    for (const [provider, pdata] of Object.entries(slice.providers)) {
        if (!pdata || typeof pdata !== 'object') continue;
        const th = thresholdsFor(provider, cfg);

        for (const window of WINDOWS) {
            const bucket = pdata[window];
            if (!bucket || typeof bucket !== 'object') continue;

            const pct = Number(bucket.pct);
            const confidence = bucket.confidence;
            const key = `${provider}:${window}`;
            const prev = state.providers[key] || { rank: 0, level: 'ok' };
            const prevRank = Number.isFinite(prev.rank) ? prev.rank : 0;

            // CA-2 / REQ-SEC-4: gate de integridad. Sin dato fresco no se actúa.
            // NO se resetea el estado por `stale` (evita falso "recuperado" y el
            // re-alerteo posterior cuando el dato vuelve fresco en el mismo nivel).
            if (confidence !== 'fresh' || !Number.isFinite(pct)) {
                continue;
            }

            const level = classify(pct, th);  // pct válido ⇒ ok|warn|crit
            const newRank = LEVEL_RANK[level] || 0;

            // -------- Recuperación a `ok`: reset dedupe + limpiar banner/marker.
            if (level === 'ok') {
                if (prevRank > 0) {
                    log(`quota-guard: ${key} recuperado a ok (pct=${Math.round(pct)})`);
                    result.cleared.push(key);
                    dirty = true;
                }
                state.providers[key] = { rank: 0, level: 'ok', pct: Math.round(pct) };
                if (marker.degraded[provider]) {
                    delete marker.degraded[provider];
                    dirty = true;
                }
                if (state.banner && state.banner.provider === provider && state.banner.window === window) {
                    state.banner = null;
                    dirty = true;
                }
                continue;
            }

            // -------- warn / crit con dato fresco.
            const crossedUp = newRank > prevRank;  // histéresis high-water-mark
            const hwRank = Math.max(prevRank, newRank);
            state.providers[key] = { rank: hwRank, level: RANK_LEVEL[hwRank], pct: Math.round(pct) };
            const switchEnabled = !!cfg.preventiveSwitchEnabled;

            // Marker preventivo: solo crit + switch on (CA-5). Banda muerta: se
            // re-escribe mientras siga crit, no oscila a fallback en warn.
            let didDegrade = false;
            if (level === 'crit' && switchEnabled) {
                const expiresAt = now + cfg.markerTtlMin * 60 * 1000;
                marker.degraded[provider] = {
                    provider,
                    pct: Math.round(pct),
                    window,
                    level,
                    confidence,
                    threshold: th.crit,
                    writtenAt: new Date(now).toISOString(),
                    expiresAt,
                };
                didDegrade = true;
                dirty = true;
                // REQ-SEC-5: auditable (provider/pct/umbral/confidence).
                log(`quota-guard: degradación preventiva provider=${provider} window=${window} `
                    + `pct=${Math.round(pct)} umbral=${th.crit} confidence=${confidence}`);
                if (!result.degraded.includes(provider)) result.degraded.push(provider);
            }

            // Banner anticipado — solo {provider,pct,window,confidence,level}
            // (REQ-SEC-1). Refleja el peor nivel vigente que cruzó.
            const banner = {
                active: true,
                provider,
                pct: Math.round(pct),
                window,
                confidence,
                level,
            };
            state.banner = banner;
            result.banner = banner;
            dirty = true;

            // CA-8: una sola alerta por cruce de umbral (al subir de nivel).
            if (crossedUp) {
                const text = buildAlertMessage({ provider, pct, window, level, switchEnabled, degraded: didDegrade });
                try {
                    sendTelegram(text);
                    result.alerts.push({ provider, window, level, text });
                    log(`quota-guard: alerta ${level} enviada provider=${provider} window=${window}`);
                } catch (e) {
                    log(`quota-guard: error enviando alerta: ${e && e.message}`);
                }
            }
        }
    }

    if (persist && dirty) {
        saveState(pd, state);
        saveMarker(pd, marker);
    }
    result.state = state;
    result.marker = marker;
    return result;
}

// -----------------------------------------------------------------------------
// Lectura del banner para el dashboard (read-only)
// -----------------------------------------------------------------------------

/**
 * Devuelve el banner anticipado vigente (o `{active:false}`). Read-only:
 * NO evalúa ni dispara efectos. Shape mínimo (REQ-SEC-1).
 */
function readBanner(opts = {}) {
    try {
        const pd = opts.pipelineDir || pipelineDirDefault();
        const st = opts.state || loadState(pd);
        const b = st && st.banner;
        if (b && b.active) {
            return {
                active: true,
                provider: b.provider,
                pct: b.pct,
                window: b.window,
                confidence: b.confidence,
                level: b.level,
            };
        }
    } catch { /* fail-safe */ }
    return { active: false };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    evaluate,
    isPreventivelyDegraded,
    readBanner,
    loadGuardConfig,
    validThresholdPair,
    thresholdsFor,
    classify,
    buildAlertMessage,
    containsSecret,
    // estado / marker (tests + integración)
    loadState,
    saveState,
    loadMarker,
    saveMarker,
    stateFile,
    markerFile,
    telegramQueueDir,
    pipelineDirDefault,
    // constantes
    DEFAULT_WARN,
    DEFAULT_CRIT,
    DEFAULT_MARKER_TTL_MIN,
    LEVEL_RANK,
};
