// =============================================================================
// pacing-bucket.js — Presupuesto de ritmo (pacing budget) por proveedor.
// Issue #4289.
//
// OBJETIVO
//   Repartir proporcionalmente el consumo de la cuota SEMANAL de cada proveedor
//   para evitar gastar todo el cupo en pocos días. Mientras `weekly-quota.js`
//   mide "cuánto queda" y `provider-quota-guard.js` (#4282) conmuta al cruzar un
//   umbral de cuota real, este módulo agrega la pata de **ritmo**: a esta altura
//   de la semana deberías haber gastado `(tiempo transcurrido / semana) × 100%`.
//
// TOKEN BUCKET SEMANAL (NO corte diario rígido)
//   Cada hora se ACREDITA la porción proporcional del cupo (quota / 168h). El
//   crédito se ACUMULA: un día tranquilo deja saldo para otro día. Solo se apaga
//   cuando se AGOTA el crédito acumulado (saldo <= 0), no por cruzar un umbral
//   diario seco.
//
// 3 ESTADOS POR PROVEEDOR
//   🟢 verde  (en ritmo)            → operación normal.
//   🟡 amarillo (adelantado, con saldo) → de-prioriza en el reparto (prefiere
//                                          fallback) SIN apagar. Aviso Telegram.
//   🔴 rojo   (saldo agotado)       → desactiva temporalmente vía
//                                      `provider-disabled` (source:'pacing', TTL)
//                                      y deriva al fallback. Recupera solo.
//
// FUENTE DE DATO (reuso, NO re-extracción)
//   El consumo real viene del shape público de `dashboard-slices.quotaSlice`:
//     slice.providers[p].weekly = { pct, confidence }
//   Solo se descuenta consumo con `confidence === 'fresh'` (igual invariante que
//   #4282). El crédito se acredita por tiempo independientemente del dato.
//
// ANCLAJE TEMPORAL
//   La ventana semanal se ancla a `getLastWeeklyResetMs()` de `weekly-quota.js`
//   (mismo reset domingo 21:00 ART, configurable por `QUOTA_TZ_OFFSET_MIN`). NO
//   se define un reloj propio: así el bucket rota junto a la cuota real.
//
// INVARIANTES DE SEGURIDAD
//   - FAIL-OPEN en la capa de lectura: estado corrupto/ausente ⇒ `getPacingState`
//     devuelve 'green' (no de-prioriza ni apaga). La matriz de permisos sigue
//     fail-closed por separado, en dispatch-with-fallback.
//   - GRANULAR: solo afecta al proveedor excedido; el resto sigue normal.
//   - REVERSIBLE: la recuperación es automática (recálculo del bucket + drenado
//     por TTL del provider-disabled).
//   - DISTINCIÓN DE ORIGEN (CA-8): la recuperación solo limpia entradas de
//     provider-disabled con `source === 'pacing'`; nunca pisa un disable manual
//     (#3811) ni preventivo (#4282).
//   - El payload de las alertas es SOLO numérico/categórico (sin secretos).
//
// IO ATÓMICA: writeFileSync a tmp + renameSync (varios spawns escriben en
//   paralelo). Reloj inyectado por `now` — nunca `Date.now()` en el cálculo puro
//   (rompería los tests deterministas y el resume del pipeline).
//
// Sin dependencias externas nuevas (Node puro: fs, path) + weekly-quota.js.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// Anclaje de la ventana semanal a la cuota real (mismo reset que weekly-quota).
let getLastWeeklyResetMs;
try {
    ({ getLastWeeklyResetMs } = require('./weekly-quota'));
} catch {
    // Fallback defensivo: si weekly-quota no carga, ancla a un domingo fijo
    // calculado localmente. NO debería pasar en producción.
    getLastWeeklyResetMs = (now = Date.now()) => {
        const WEEK_MS = 7 * 24 * 3600 * 1000;
        return now - (now % WEEK_MS);
    };
}

// Kill-switch operacional + recuperación (compartido con #3811/#4282). Carga
// perezosa: inyectable en tests vía opts.disabledModule.
let providerDisabledModule = null;
try { providerDisabledModule = require('./provider-disabled'); } catch { /* opcional */ }

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

const WEEK_HOURS = 168;
const WEEK_MS = WEEK_HOURS * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

// Cupo semanal por proveedor expresado en puntos porcentuales (100% = cupo
// completo). El consumo real (`weekly.pct`) está en las mismas unidades.
const DEFAULT_WEEKLY_QUOTA = 100;

// Margen sobre el ritmo lineal para disparar amarillo (puntos de ratio, 0..1).
// realRatio > expectedRatio + YELLOW_MARGIN ⇒ adelantado.
const DEFAULT_YELLOW_MARGIN = 0.05; // 5 puntos porcentuales de adelanto.

// TTL del disable por rojo (respaldo anti-zombie + recuperación automática).
const DEFAULT_TTL_RED_MIN = 60;
const MAX_TTL_RED_MIN = 24 * 60;

// Proveedores válidos (replica de provider-disabled.VALID_PROVIDERS; el
// `deterministic` se excluye — no consume cuota).
const VALID_PROVIDERS = Object.freeze([
    'anthropic',
    'openai-codex',
    'gemini-google',
    'cerebras',
    'nvidia-nim',
]);

// Patrones de secreto — defensa sobre el mensaje generado.
const SECRET_PATTERNS = [
    /AKIA[0-9A-Z]{16}/,
    /\bBearer\s+[A-Za-z0-9._\-]+/i,
    /\beyJ[A-Za-z0-9._\-]{20,}/,
    /api[_-]?key/i,
    /sk-[A-Za-z0-9]{16,}/,
];

const STATES = Object.freeze({ GREEN: 'green', YELLOW: 'yellow', RED: 'red' });

// -----------------------------------------------------------------------------
// Paths / IO atómica
// -----------------------------------------------------------------------------

function pipelineDirDefault() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function stateFile(pd) {
    return path.join(pd || pipelineDirDefault(), 'state', 'pacing-bucket.json');
}

function telegramQueueDir(pd) {
    return path.join(pd || pipelineDirDefault(), 'servicios', 'telegram', 'pendiente');
}

function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
}

function writeJsonAtomic(filepath, data) {
    ensureDir(path.dirname(filepath));
    const tmp = path.join(
        path.dirname(filepath),
        `.${path.basename(filepath)}.${process.pid}.${Math.floor((data && data._w) || 0)}.tmp`,
    );
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
        fs.writeSync(fd, JSON.stringify(data, null, 2));
        try { fs.fsyncSync(fd); } catch { /* best-effort */ }
    } finally {
        try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
    try {
        fs.renameSync(tmp, filepath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
        throw err;
    }
}

// -----------------------------------------------------------------------------
// Estado persistido
// -----------------------------------------------------------------------------

function defaultStore() {
    return { schema_version: 1, providers: {} };
}

function loadStore(pd) {
    try {
        const raw = fs.readFileSync(stateFile(pd), 'utf8');
        const o = JSON.parse(raw);
        if (o && typeof o === 'object') {
            if (!o.providers || typeof o.providers !== 'object') o.providers = {};
            if (!o.schema_version) o.schema_version = 1;
            return o;
        }
    } catch { /* ausente / corrupto → default */ }
    return defaultStore();
}

function saveStore(pd, store) {
    try { writeJsonAtomic(stateFile(pd), store); } catch { /* best-effort */ }
}

// -----------------------------------------------------------------------------
// Config (fail-safe del bloque `pacing` de config.yaml)
// -----------------------------------------------------------------------------

/**
 * Lee y valida el bloque `pacing` de la config parseada. NUNCA lanza: ante
 * cualquier anomalía cae a defaults conservadores.
 *
 * @param {object} rawConfig  config.yaml ya parseada (objeto)
 * @returns {{enabled:boolean, weeklyQuota:number, yellowMargin:number, ttlRedMin:number}}
 */
function loadPacingConfig(rawConfig) {
    const out = {
        enabled: false,
        weeklyQuota: DEFAULT_WEEKLY_QUOTA,
        yellowMargin: DEFAULT_YELLOW_MARGIN,
        ttlRedMin: DEFAULT_TTL_RED_MIN,
    };
    try {
        const block = rawConfig && rawConfig.pacing;
        if (!block || typeof block !== 'object') return out;

        out.enabled = block.enabled === true;

        const wq = Number(block.weekly_quota_pct_per_provider);
        if (Number.isFinite(wq) && wq > 0 && wq <= 1000) out.weeklyQuota = wq;

        // Margen amarillo override por env o config (en puntos porcentuales 0..100).
        const ymEnv = Number(process.env.PACING_YELLOW_MARGIN_PCT);
        const ymCfg = Number(block.yellow_margin_pct);
        const ym = Number.isFinite(ymEnv) ? ymEnv : ymCfg;
        if (Number.isFinite(ym) && ym >= 0 && ym < 100) out.yellowMargin = ym / 100;

        const ttlEnv = Number(process.env.PACING_TTL_RED_MIN);
        const ttlCfg = Number(block.ttl_red_min);
        const ttl = Number.isFinite(ttlEnv) ? ttlEnv : ttlCfg;
        if (Number.isFinite(ttl) && ttl > 0 && ttl <= MAX_TTL_RED_MIN) out.ttlRedMin = ttl;
    } catch { /* defaults */ }
    return out;
}

// -----------------------------------------------------------------------------
// Núcleo determinístico — funciones puras (reloj inyectado)
// -----------------------------------------------------------------------------

function isValidProvider(name) {
    return typeof name === 'string' && VALID_PROVIDERS.includes(name);
}

/**
 * Crea un bucket fresco anclado al inicio de la semana `weekStart`.
 */
function resetBucket(provider, weekStart, weeklyQuota) {
    return {
        provider,
        week_start_ms: weekStart,
        weekly_quota: Number.isFinite(weeklyQuota) ? weeklyQuota : DEFAULT_WEEKLY_QUOTA,
        accrued_credit: 0,
        real_consumed: 0,
        state: STATES.GREEN,
        last_accrual_ms: weekStart,
        last_transition: null,
    };
}

/**
 * Fracción de la semana transcurrida en `now` (0..1), clamp defensivo.
 */
function elapsedFraction(bucket, now) {
    if (!bucket || !Number.isFinite(bucket.week_start_ms)) return 0;
    const frac = (now - bucket.week_start_ms) / WEEK_MS;
    if (!Number.isFinite(frac)) return 0;
    return Math.max(0, Math.min(1, frac));
}

/**
 * Acredita crédito proporcional por las horas completas transcurridas desde la
 * última acreditación. El crédito SE ACUMULA (día tranquilo deja saldo). Si la
 * ventana semanal rotó, devuelve un bucket nuevo. Mutación local + retorno.
 *
 * @param {object} bucket
 * @param {number} now    timestamp inyectado
 * @returns {object} bucket acreditado (puede ser uno nuevo si rotó la semana)
 */
function accrue(bucket, now) {
    const weekStart = getLastWeeklyResetMs(now);
    if (!bucket || bucket.week_start_ms !== weekStart) {
        // Rotación semanal: reinicia sin arrastrar consumo (anclaje a weekly-quota).
        return resetBucket(bucket && bucket.provider, weekStart, bucket && bucket.weekly_quota);
    }
    const quota = Number.isFinite(bucket.weekly_quota) ? bucket.weekly_quota : DEFAULT_WEEKLY_QUOTA;
    const hoursElapsed = Math.floor((now - bucket.last_accrual_ms) / HOUR_MS);
    if (hoursElapsed <= 0) return bucket;
    const creditPerHour = quota / WEEK_HOURS;
    bucket.accrued_credit += creditPerHour * hoursElapsed;
    // Cap: el crédito acreditado nunca supera el cupo semanal completo.
    if (bucket.accrued_credit > quota) bucket.accrued_credit = quota;
    bucket.last_accrual_ms += hoursElapsed * HOUR_MS;
    return bucket;
}

/**
 * Clasifica el bucket en 'green' | 'yellow' | 'red'.
 *   - 🔴 rojo:    saldo acumulado agotado (accrued_credit - real_consumed <= 0).
 *   - 🟡 amarillo: hay saldo, pero el consumo real va más rápido que el ritmo
 *                  lineal esperado (realRatio > expectedRatio + yellowMargin).
 *   - 🟢 verde:   en ritmo.
 *
 * @param {object} bucket
 * @param {number} now
 * @param {object} [cfg]  { yellowMargin }
 */
function classify(bucket, now, cfg = {}) {
    if (!bucket || !Number.isFinite(bucket.weekly_quota) || bucket.weekly_quota <= 0) {
        return STATES.GREEN; // fail-open
    }
    const yellowMargin = Number.isFinite(cfg.yellowMargin) ? cfg.yellowMargin : DEFAULT_YELLOW_MARGIN;
    const balance = bucket.accrued_credit - bucket.real_consumed;
    if (balance <= 0) return STATES.RED;
    const expectedRatio = elapsedFraction(bucket, now);
    const realRatio = bucket.real_consumed / bucket.weekly_quota;
    if (realRatio > expectedRatio + yellowMargin) return STATES.YELLOW;
    return STATES.GREEN;
}

/**
 * Saldo del bucket (crédito acumulado menos consumo). Informativo para el
 * dashboard.
 */
function balanceOf(bucket) {
    if (!bucket) return null;
    const b = bucket.accrued_credit - bucket.real_consumed;
    return Number.isFinite(b) ? b : null;
}

// -----------------------------------------------------------------------------
// Telegram (FS queue) — solo métricas, sin secretos
// -----------------------------------------------------------------------------

function containsSecret(text) {
    if (typeof text !== 'string') return false;
    return SECRET_PATTERNS.some((re) => re.test(text));
}

function enqueueTelegram(pd, text, now) {
    try {
        const dir = telegramQueueDir(pd);
        ensureDir(dir);
        const file = path.join(dir, `${now}-pacing-bucket.json`);
        fs.writeFileSync(file, JSON.stringify({ text, parse_mode: 'Markdown' }), 'utf8');
        return { ok: true, file };
    } catch (e) {
        return { ok: false, reason: e && e.message };
    }
}

const STATE_EMOJI = Object.freeze({ green: '🟢', yellow: '🟡', red: '🔴' });

function capitalize(s) {
    const str = String(s || '');
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Mensaje de transición de estado. SOLO datos numéricos/categóricos.
 */
function buildTransitionMessage(info) {
    const { provider, from, to, realPct, expectedPct } = info;
    const emoji = STATE_EMOJI[to] || '•';
    let headline;
    if (to === STATES.YELLOW) {
        headline = `${emoji} ${capitalize(provider)} va adelantado en su ritmo semanal.`;
    } else if (to === STATES.RED) {
        headline = `${emoji} ${capitalize(provider)} agotó su crédito de ritmo — derivando al fallback.`;
    } else {
        headline = `${emoji} ${capitalize(provider)} volvió a estar en ritmo.`;
    }
    const detail = `Consumo real ${Math.round(realPct)}% · esperado ${Math.round(expectedPct)}% (semana).`;
    const action = to === STATES.RED
        ? 'Desactivado temporalmente; vuelve solo al recargarse el bucket.'
        : (to === STATES.YELLOW ? 'Se prefieren otros proveedores sin apagarlo.' : 'Operación normal.');
    const msg = [headline, detail, action].join('\n');
    return containsSecret(msg) ? '[alerta de ritmo redactada]' : msg;
}

// -----------------------------------------------------------------------------
// Lectura para dispatch (read-only, FAIL-OPEN)
// -----------------------------------------------------------------------------

/**
 * Estado de pacing vigente de un proveedor, leído del bucket persistido.
 * FAIL-OPEN: ante ausencia / corrupción / provider inválido ⇒ 'green' (nunca
 * de-prioriza ni apaga por un bug propio). Consumido por dispatch-with-fallback.
 *
 * @param {string} provider
 * @param {object} [opts] { now, pipelineDir, store }
 * @returns {'green'|'yellow'|'red'}
 */
function getPacingState(provider, opts = {}) {
    try {
        if (!isValidProvider(provider)) return STATES.GREEN;
        const pd = opts.pipelineDir || pipelineDirDefault();
        const store = opts.store || loadStore(pd);
        const bucket = store && store.providers && store.providers[provider];
        if (!bucket || typeof bucket !== 'object') return STATES.GREEN;
        const st = bucket.state;
        if (st === STATES.YELLOW || st === STATES.RED) return st;
        return STATES.GREEN;
    } catch {
        return STATES.GREEN;
    }
}

// -----------------------------------------------------------------------------
// Evaluación principal (corre en el poll del dashboard, como #4282)
// -----------------------------------------------------------------------------

/**
 * Evalúa el slice multi-provider, acredita/clasifica cada bucket, persiste el
 * estado y dispara los efectos de transición (disable/clear + Telegram).
 *
 * @param {object} opts
 * @param {object} opts.slice        salida de quotaSlice (necesita `.providers`)
 * @param {object} [opts.config]     config ya cargada por loadPacingConfig
 * @param {object} [opts.rawConfig]  config.yaml parseada (si no se pasa config)
 * @param {number} [opts.now]
 * @param {string} [opts.pipelineDir]
 * @param {object} [opts.disabledModule]  inyectable (provider-disabled) para tests
 * @param {(text:string)=>void} [opts.sendTelegram]  sender inyectable (tests)
 * @param {object} [opts.store]      store inyectable (tests)
 * @param {boolean} [opts.persist]   default true
 * @returns {{enabled:boolean, transitions:Array, providers:object, store:object}}
 */
function evaluate(opts = {}) {
    const pd = opts.pipelineDir || pipelineDirDefault();
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const persist = opts.persist !== false;
    const cfg = opts.config || loadPacingConfig(opts.rawConfig || {});
    const disabled = opts.disabledModule || providerDisabledModule;
    const sendTelegram = typeof opts.sendTelegram === 'function'
        ? opts.sendTelegram
        : (text) => { enqueueTelegram(pd, text, now); };

    const result = { enabled: cfg.enabled, transitions: [], providers: {}, store: null };

    if (!cfg.enabled) {
        // Kill-switch: no evalúa ni escribe. El dispatch lee 'green' por fail-open.
        return result;
    }

    const slice = opts.slice;
    if (!slice || typeof slice !== 'object' || !slice.providers || typeof slice.providers !== 'object') {
        return result;
    }

    const store = opts.store || loadStore(pd);
    if (!store.providers || typeof store.providers !== 'object') store.providers = {};
    let dirty = false;

    for (const [provider, pdata] of Object.entries(slice.providers)) {
        if (!isValidProvider(provider)) continue;
        if (!pdata || typeof pdata !== 'object') continue;

        // 1. Acreditar por tiempo (rota la semana si corresponde).
        let bucket = store.providers[provider];
        const weekStart = getLastWeeklyResetMs(now);
        if (!bucket || typeof bucket !== 'object') {
            bucket = resetBucket(provider, weekStart, cfg.weeklyQuota);
        }
        // Mantener el cupo de config (puede haber cambiado entre corridas).
        bucket.weekly_quota = cfg.weeklyQuota;
        bucket = accrue(bucket, now);
        bucket.provider = provider;

        // 2. Descontar consumo real SOLO con dato fresco (igual invariante #4282).
        const weekly = pdata.weekly;
        const pct = weekly && Number(weekly.pct);
        const fresh = weekly && weekly.confidence === 'fresh' && Number.isFinite(pct) && pct >= 0;
        if (fresh) {
            bucket.real_consumed = pct;
        }

        // 3. Clasificar.
        const prevState = bucket.state || STATES.GREEN;
        const newState = classify(bucket, now, cfg);
        const expectedPct = elapsedFraction(bucket, now) * 100;
        const realPct = (bucket.real_consumed / (bucket.weekly_quota || DEFAULT_WEEKLY_QUOTA)) * 100;

        // 4. Efectos de transición.
        if (newState !== prevState) {
            bucket.last_transition = { from: prevState, to: newState, at: new Date(now).toISOString() };
            result.transitions.push({ provider, from: prevState, to: newState });

            if (newState === STATES.RED) {
                // Desactivar temporalmente vía provider-disabled (source pacing).
                if (disabled && typeof disabled.setProviderDisabled === 'function') {
                    try {
                        disabled.setProviderDisabled(provider, {
                            ttlMs: cfg.ttlRedMin * 60 * 1000,
                            source: 'pacing',
                            now,
                            auditLogEnabled: opts.auditLogEnabled,
                        });
                    } catch { /* best-effort: el disable nunca rompe la evaluación */ }
                }
            } else if (prevState === STATES.RED) {
                // Recuperación: limpiar el disable SOLO si lo puso pacing (CA-8).
                _clearPacingDisable(disabled, provider, now, opts.auditLogEnabled);
            }

            // Aviso Telegram en cada transición (incluida recuperación a verde).
            try {
                sendTelegram(buildTransitionMessage({
                    provider, from: prevState, to: newState, realPct, expectedPct,
                }));
            } catch { /* best-effort */ }
        }

        bucket.state = newState;
        store.providers[provider] = bucket;
        dirty = true;

        result.providers[provider] = {
            state: newState,
            balance: balanceOf(bucket),
            accrued_credit: bucket.accrued_credit,
            real_consumed: bucket.real_consumed,
            weekly_quota: bucket.weekly_quota,
            expected_pct: Math.round(expectedPct),
            real_pct: Math.round(realPct),
            week_start_ms: bucket.week_start_ms,
        };
    }

    if (persist && dirty) saveStore(pd, store);
    result.store = store;
    return result;
}

/**
 * Limpia el disable de un proveedor SOLO si su origen es 'pacing' (CA-8). Nunca
 * pisa un disable manual (#3811) ni preventivo (#4282). Best-effort.
 */
function _clearPacingDisable(disabled, provider, now, auditLogEnabled) {
    if (!disabled) return;
    try {
        let source = null;
        if (typeof disabled.getDisabledEntry === 'function') {
            const entry = disabled.getDisabledEntry(provider, { now, auditLogEnabled });
            source = entry && entry.source;
        } else if (typeof disabled.listDisabledProviders === 'function') {
            const list = disabled.listDisabledProviders({ now, auditLogEnabled });
            const entry = list && Array.isArray(list.disabled)
                ? list.disabled.find((e) => e && e.name === provider)
                : null;
            source = entry && entry.source;
        }
        // Si está apagado por otro origen, NO lo tocamos. Si no está apagado, el
        // clear es no-op idempotente. Solo limpiamos cuando el origen es pacing.
        if (source === 'pacing' && typeof disabled.clearProviderDisabled === 'function') {
            disabled.clearProviderDisabled(provider, { source: 'pacing', now, auditLogEnabled });
        }
    } catch { /* best-effort */ }
}

// -----------------------------------------------------------------------------
// Slice para el dashboard (read-only)
// -----------------------------------------------------------------------------

/**
 * Estado de pacing de todos los proveedores con bucket persistido. Read-only.
 * Shape mínimo para el dashboard: por proveedor `{state, balance, real_pct,
 * expected_pct}`. FAIL-OPEN: ante error ⇒ `{providers:{}}`.
 */
function readPacingSlice(opts = {}) {
    try {
        const pd = opts.pipelineDir || pipelineDirDefault();
        const now = Number.isFinite(opts.now) ? opts.now : Date.now();
        const store = opts.store || loadStore(pd);
        const providers = {};
        for (const [provider, bucket] of Object.entries((store && store.providers) || {})) {
            if (!bucket || typeof bucket !== 'object') continue;
            const expectedPct = elapsedFraction(bucket, now) * 100;
            const quota = bucket.weekly_quota || DEFAULT_WEEKLY_QUOTA;
            providers[provider] = {
                state: (bucket.state === STATES.YELLOW || bucket.state === STATES.RED)
                    ? bucket.state : STATES.GREEN,
                balance: balanceOf(bucket),
                real_pct: Math.round((bucket.real_consumed / quota) * 100),
                expected_pct: Math.round(expectedPct),
            };
        }
        return { providers };
    } catch {
        return { providers: {} };
    }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    // API principal
    evaluate,
    getPacingState,
    readPacingSlice,
    loadPacingConfig,

    // Núcleo determinístico (tests)
    accrue,
    classify,
    resetBucket,
    elapsedFraction,
    balanceOf,

    // Estado / IO (tests)
    loadStore,
    saveStore,
    stateFile,
    telegramQueueDir,
    pipelineDirDefault,

    // Helpers
    isValidProvider,
    buildTransitionMessage,
    containsSecret,

    // Constantes
    STATES,
    VALID_PROVIDERS,
    WEEK_HOURS,
    DEFAULT_WEEKLY_QUOTA,
    DEFAULT_YELLOW_MARGIN,
    DEFAULT_TTL_RED_MIN,
};
