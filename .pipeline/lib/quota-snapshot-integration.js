// =============================================================================
// quota-snapshot-integration.js — Wire entre snapshot real (#3012) e infra
// existente (detector binario #2974, calibrador EMA, banner #2992) — #3013.
//
// Hija 2 del split de #3008. Esta capa es 100% ADITIVA: no modifica APIs
// públicas de `quota-exhausted.js` ni de `weekly-quota.js`. La idea es que
// el JSONL de snapshots que persiste #3012 deje de ser dato pasivo y pase
// a ser accionable:
//
//   1. `evaluateSnapshotAndGate(snapshot, opts)` — invocada por el scheduler
//      del #3012 después de cada parse exitoso. Decide si llamar
//      `setFlag({errorType:'snapshot_threshold_90', resetsAt})` y/o
//      `saveCalibration(metricsDir, obs)` con defense-in-depth (CA-S1).
//
//   2. `getBannerState(opts)` — lectura pasiva para el dashboard
//      (`/api/dash/quota-snapshot`). Devuelve `{state, lastSnapshot, ageMs,
//      ttlMin, parserState}` para el render del banner real-snapshot
//      (CA-14, CA-UX-1 a CA-UX-3, CA-UX-9).
//
// Defense-in-depth (CA-S1 a CA-S8):
//   - R1 — re-validación shape del snapshot (no asumir 3012 garantiza nada).
//   - R2 — lectura defensiva del .quota-parser-state.json (anti falso positivo).
//   - R4 — anti-spam por ventana semanal (lockfile en quota-snapshot-state.json).
//   - R5 — audit trail con `agent: 'quota-snapshot-integration'`.
//   - R6 — kill switch granular: `QUOTA_SNAPSHOT_ENABLED=false` apaga todo,
//          `QUOTA_SNAPSHOT_GATE_ENABLED=false` apaga sólo el gate.
//   - R7 — logs sin PII (cero pcts/usd/account_handle en strings de log).
//   - R8 — race en lectura del JSONL durante rotación → fallback a 'missing'.
//
// Sin nuevas dependencias externas (Node puro).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const quotaExhausted = require('./quota-exhausted');
const weeklyQuota = require('./weekly-quota');

// -----------------------------------------------------------------------------
// Paths y constantes
// -----------------------------------------------------------------------------

function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function snapshotJsonlFile() {
    return path.join(pipelineDir(), '.quota-history.jsonl');
}

function parserStateFile() {
    return path.join(pipelineDir(), '.quota-parser-state.json');
}

function integrationStateFile() {
    return path.join(pipelineDir(), '.quota-snapshot-integration-state.json');
}

function metricsDir() {
    return path.join(pipelineDir(), 'metrics');
}

function activityLogPath() {
    if (process.env.ACTIVITY_LOG_PATH) return process.env.ACTIVITY_LOG_PATH;
    return path.resolve(pipelineDir(), '..', '.claude', 'activity-log.jsonl');
}

// TTL/STALE/GATE defaults (configurables por env, narrativa §2.1).
const DEFAULT_TTL_MIN = 90;             // QUOTA_BANNER_TTL_MIN
const DEFAULT_STALE_MAX_HOURS = 6;      // QUOTA_BANNER_STALE_MAX_HOURS
const DEFAULT_GATE_PCT = 90;            // QUOTA_SNAPSHOT_GATE_PCT
const DEFAULT_PARSER_FAIL_ALERT = 3;    // QUOTA_PARSER_FAIL_ALERT_THRESHOLD

// Allowlist de categorías del parser-state (CA-S2). Cualquier valor fuera de
// esta lista se ignora para no leakear strings arbitrarios al banner/`/status`.
const PARSER_CATEGORY_ALLOWLIST = Object.freeze(new Set([
    'layout_drift',
    'tesseract_error',
    'account_unknown',
    'shape_invalid',
    'session_disconnected',
    'account_mismatch',
    'unknown',
]));

// -----------------------------------------------------------------------------
// Kill switch (R6)
// -----------------------------------------------------------------------------

function isEnabled() {
    const v = process.env.QUOTA_SNAPSHOT_ENABLED;
    if (v == null) return true;
    return String(v).toLowerCase() !== 'false';
}

function isGateEnabled() {
    if (!isEnabled()) return false;
    const v = process.env.QUOTA_SNAPSHOT_GATE_ENABLED;
    if (v == null) return true;
    return String(v).toLowerCase() !== 'false';
}

// -----------------------------------------------------------------------------
// Helpers de validación (R1, CA-S1)
// -----------------------------------------------------------------------------

function envNumber(name, fallback, opts) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    if (opts && Number.isFinite(opts.min) && n < opts.min) return fallback;
    if (opts && Number.isFinite(opts.max) && n > opts.max) return fallback;
    return n;
}

function getTtlMin() {
    return envNumber('QUOTA_BANNER_TTL_MIN', DEFAULT_TTL_MIN, { min: 1, max: 24 * 60 });
}

function getStaleMaxHours() {
    return envNumber('QUOTA_BANNER_STALE_MAX_HOURS', DEFAULT_STALE_MAX_HOURS, { min: 1, max: 168 });
}

function getGatePct() {
    return envNumber('QUOTA_SNAPSHOT_GATE_PCT', DEFAULT_GATE_PCT, { min: 1, max: 100 });
}

function getParserFailAlertThreshold() {
    return envNumber('QUOTA_PARSER_FAIL_ALERT_THRESHOLD', DEFAULT_PARSER_FAIL_ALERT, { min: 1, max: 1000 });
}

/**
 * Re-validación shape del snapshot (R1). Falla cerrado:
 *   - Cualquier pct fuera de [0, 100], NaN o Infinity → reject.
 *   - session_minutes_to_reset fuera de (0, 10080] → reject.
 *   - account_handle vacío → reject (ver R1, mismatch lo verifica el caller).
 *   - parse_confidence < 0.8 si está presente → reject (sólo gating; ver R1).
 *   - parse_warnings con flags críticos → reject para gating + calibración.
 *   - ts no parseable / en futuro / más viejo que stale_max → reject.
 *
 * Devuelve `{ ok, reason }`. La lista de razones es allowlist cerrada para
 * que se pueda usar como categoría de log sin riesgo de leak.
 */
function validateSnapshotShape(snapshot, opts = {}) {
    if (!snapshot || typeof snapshot !== 'object') {
        return { ok: false, reason: 'shape_invalid' };
    }

    const requiredPctKeys = [
        'weekly_all_models_pct',
        'session_pct',
        'weekly_sonnet_pct',
        'weekly_design_pct',
    ];
    for (const k of requiredPctKeys) {
        const v = snapshot[k];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
            return { ok: false, reason: 'pct_out_of_range' };
        }
    }

    const sessionMin = snapshot.session_minutes_to_reset;
    if (typeof sessionMin !== 'number' || !Number.isFinite(sessionMin)
            || sessionMin <= 0 || sessionMin > 7 * 24 * 60) {
        return { ok: false, reason: 'session_minutes_out_of_range' };
    }

    if (typeof snapshot.account_handle !== 'string' || snapshot.account_handle.trim() === '') {
        return { ok: false, reason: 'account_handle_empty' };
    }

    if (snapshot.parse_confidence != null) {
        const conf = Number(snapshot.parse_confidence);
        if (!Number.isFinite(conf) || conf < 0.8) {
            return { ok: false, reason: 'low_parse_confidence' };
        }
    }

    if (Array.isArray(snapshot.parse_warnings)) {
        const critical = new Set(['layout_drift', 'account_unknown', 'shape_invalid']);
        for (const w of snapshot.parse_warnings) {
            if (typeof w === 'string' && critical.has(w)) {
                return { ok: false, reason: 'critical_parse_warning' };
            }
        }
    }

    const tsMs = Date.parse(String(snapshot.ts || ''));
    if (!Number.isFinite(tsMs)) {
        return { ok: false, reason: 'ts_unparseable' };
    }
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    if (tsMs > now) {
        return { ok: false, reason: 'ts_in_future' };
    }
    const maxAgeMs = getStaleMaxHours() * 3600 * 1000;
    if (now - tsMs > maxAgeMs) {
        return { ok: false, reason: 'ts_too_old' };
    }

    return { ok: true };
}

/**
 * Verifica si el snapshot pertenece a la cuenta esperada (R1, CA-S1).
 * Comparación case-insensitive. EXPECTED_CLAUDE_ACCOUNT no definido → ok
 * (no podemos verificar, asumimos válido pero loggear).
 *
 * Devuelve { matches, expectedSet }. Si no matchea, el caller emite la
 * alerta CA-UX-7 (sin interpolar emails).
 */
function verifyAccountMatch(snapshot) {
    const expected = process.env.EXPECTED_CLAUDE_ACCOUNT;
    if (expected == null || String(expected).trim() === '') {
        return { matches: true, expectedSet: false };
    }
    const expectedNorm = String(expected).trim().toLowerCase();
    const actualNorm = String(snapshot.account_handle || '').trim().toLowerCase();
    return { matches: actualNorm === expectedNorm, expectedSet: true };
}

// -----------------------------------------------------------------------------
// IO atómica helper (mismo patrón que quota-exhausted.js)
// -----------------------------------------------------------------------------

function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function writeJsonAtomic(filepath, data) {
    ensureDir(path.dirname(filepath));
    const tmp = path.join(
        path.dirname(filepath),
        `.${path.basename(filepath)}.${process.pid}.${Date.now()}.tmp`,
    );
    const payload = JSON.stringify(data, null, 2);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
        fs.writeSync(fd, payload);
        try { fs.fsyncSync(fd); } catch {}
    } finally {
        try { fs.closeSync(fd); } catch {}
    }
    try {
        fs.renameSync(tmp, filepath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch {}
        throw err;
    }
}

// -----------------------------------------------------------------------------
// Estado de integración (anti-spam R4) — quien-disparó-cuándo-qué
// -----------------------------------------------------------------------------

function loadIntegrationState() {
    try {
        const raw = fs.readFileSync(integrationStateFile(), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
    return {
        last_gate_alert_at: null,
        last_gate_window_start: null,
        last_account_mismatch_alert_at: null,
        last_calibration_at: null,
    };
}

function saveIntegrationState(state) {
    try { writeJsonAtomic(integrationStateFile(), state); } catch {}
}

/**
 * Decide si emitir la alerta de "umbral 90%" según anti-spam por ventana
 * semanal (R4). La ventana se considera la misma si el `last_weekly_reset`
 * coincide; al cambiar la semana se permite re-alertar.
 */
function shouldEmitGateAlert(state, now) {
    const weeklyReset = weeklyQuota.getLastWeeklyResetMs(now);
    if (state.last_gate_window_start === weeklyReset) {
        return false;  // ya alertamos en esta semana
    }
    return true;
}

function markGateAlerted(state, now) {
    state.last_gate_window_start = weeklyQuota.getLastWeeklyResetMs(now);
    state.last_gate_alert_at = new Date(now).toISOString();
}

function markAccountMismatchAlerted(state, now) {
    state.last_account_mismatch_alert_at = new Date(now).toISOString();
}

function shouldEmitAccountMismatchAlert(state, now) {
    if (!state.last_account_mismatch_alert_at) return true;
    const lastMs = Date.parse(state.last_account_mismatch_alert_at);
    if (!Number.isFinite(lastMs)) return true;
    // Anti-spam: una sola alerta por hora (mismo handle puede repetirse en
    // cada snapshot → no spammear).
    return (now - lastMs) > 60 * 60 * 1000;
}

// -----------------------------------------------------------------------------
// Lectura defensiva del JSONL (R8) — última línea
// -----------------------------------------------------------------------------

/**
 * Lee la última línea válida del .quota-history.jsonl (snapshot más reciente).
 * Tolerante a:
 *   - Archivo inexistente → null + reason.
 *   - Race con rotación (rename in-flight) → null + reason 'io_error'.
 *   - Líneas truncadas / no JSON → ignora y avanza hacia atrás.
 *
 * NO lee todo el archivo en memoria si es grande: lee desde el final usando
 * un buffer chunked (max 64 KB suficiente para la última línea de cualquier
 * snapshot razonable). Si el archivo es < buffer, lee todo.
 */
function readLastSnapshotLine(filepath) {
    let stat;
    try {
        stat = fs.statSync(filepath);
    } catch (e) {
        if (e && e.code === 'ENOENT') return { ok: false, reason: 'absent' };
        return { ok: false, reason: 'io_error' };
    }
    if (stat.size === 0) return { ok: false, reason: 'empty' };

    // Leer hasta los últimos 64 KB (suficiente para varias líneas largas).
    const READ_MAX = 64 * 1024;
    const readSize = Math.min(stat.size, READ_MAX);
    const buf = Buffer.alloc(readSize);
    let fd;
    try {
        fd = fs.openSync(filepath, 'r');
        fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    } catch {
        return { ok: false, reason: 'io_error' };
    } finally {
        if (fd != null) { try { fs.closeSync(fd); } catch {} }
    }

    const text = buf.toString('utf8');
    const lines = text.split('\n').filter(l => l.trim() !== '');
    // Iterar desde la última hacia atrás, tomar el primer JSON válido.
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object') {
                return { ok: true, snapshot: parsed };
            }
        } catch {
            // línea corrupta o truncada (común en la primera línea del chunk
            // si arrancamos en medio de una línea), seguir buscando.
            continue;
        }
    }
    return { ok: false, reason: 'no_valid_lines' };
}

// -----------------------------------------------------------------------------
// Lectura defensiva del .quota-parser-state.json (R2, CA-S2)
// -----------------------------------------------------------------------------

/**
 * Lee el archivo de estado del parser que mantiene #3012. Validación estricta:
 *   - Archivo ausente → 'parser-state-unavailable' (NO 'parser-offline').
 *   - JSON corrupto → 'parser-state-unavailable'.
 *   - fail_count_consecutive entero ≥ 0 y < 1000.
 *   - last_category ∈ allowlist.
 *   - last_fail_at / last_success_at ISO o null.
 */
function readParserState(filepath) {
    let raw;
    try {
        raw = fs.readFileSync(filepath, 'utf8');
    } catch {
        return { available: false };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { available: false };
    }
    if (!parsed || typeof parsed !== 'object') return { available: false };

    const fc = Number(parsed.fail_count_consecutive);
    const failCount = Number.isInteger(fc) && fc >= 0 && fc < 1000 ? fc : 0;

    let category = null;
    if (typeof parsed.last_category === 'string' && PARSER_CATEGORY_ALLOWLIST.has(parsed.last_category)) {
        category = parsed.last_category;
    }

    function safeIso(input) {
        if (typeof input !== 'string') return null;
        const ms = Date.parse(input);
        return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }

    return {
        available: true,
        fail_count_consecutive: failCount,
        last_category: category,
        last_fail_at: safeIso(parsed.last_fail_at),
        last_success_at: safeIso(parsed.last_success_at),
    };
}

// -----------------------------------------------------------------------------
// API pública 1: getBannerState (CA-14, CA-UX-1 a CA-UX-3)
// -----------------------------------------------------------------------------

/**
 * Resuelve el estado del banner real-snapshot a partir de los archivos del
 * #3012 + el kill switch del propio #3013.
 *
 * Estados (narrativa §2.1):
 *   - 'fresh'             — snapshot age < TTL; banner verde con dato real.
 *   - 'stale'             — TTL ≤ age < stale_max; banner ámbar.
 *   - 'missing'           — sin snapshot disponible (o feature off).
 *   - 'parser-offline'    — fail_count_consecutive >= alert_threshold.
 *
 * Output shape estable para `/api/dash/quota-snapshot`:
 *   {
 *     state: 'fresh'|'stale'|'missing'|'parser-offline',
 *     ageMs: number|null,
 *     ttlMin: number,
 *     staleMaxHours: number,
 *     lastSnapshot: object|null,   // shape sanitizada (sin account_handle leak)
 *     parserState: object|null,
 *   }
 */
function getBannerState(opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const ttlMin = getTtlMin();
    const staleMaxHours = getStaleMaxHours();
    const failAlertThreshold = getParserFailAlertThreshold();

    if (!isEnabled()) {
        return {
            state: 'missing',
            ageMs: null,
            ttlMin,
            staleMaxHours,
            lastSnapshot: null,
            parserState: null,
            reason: 'kill_switch',
        };
    }

    const parserState = readParserState(parserStateFile());
    const parserOffline = parserState.available
        && Number.isFinite(parserState.fail_count_consecutive)
        && parserState.fail_count_consecutive >= failAlertThreshold;

    const lastRead = readLastSnapshotLine(snapshotJsonlFile());
    if (!lastRead.ok) {
        // Sin snapshot → 'missing' (a menos que el parser esté offline,
        // en cuyo caso el estado prioritario es 'parser-offline').
        return {
            state: parserOffline ? 'parser-offline' : 'missing',
            ageMs: null,
            ttlMin,
            staleMaxHours,
            lastSnapshot: null,
            parserState: parserState.available ? parserState : null,
            reason: lastRead.reason || null,
        };
    }

    const snap = lastRead.snapshot;
    const tsMs = Date.parse(String(snap.ts || ''));
    if (!Number.isFinite(tsMs)) {
        return {
            state: parserOffline ? 'parser-offline' : 'missing',
            ageMs: null,
            ttlMin,
            staleMaxHours,
            lastSnapshot: null,
            parserState: parserState.available ? parserState : null,
            reason: 'ts_unparseable',
        };
    }

    const ageMs = Math.max(0, now - tsMs);
    const ttlMs = ttlMin * 60 * 1000;
    const staleMaxMs = staleMaxHours * 3600 * 1000;

    // Parser offline tiene prioridad visual incluso si hay snapshot fresco
    // — narrativa §2.1: el dato puede estar fresh por suerte pero el parser
    // está roto, hay que avisar.
    if (parserOffline) {
        return {
            state: 'parser-offline',
            ageMs,
            ttlMin,
            staleMaxHours,
            lastSnapshot: sanitizeSnapshotForOutput(snap),
            parserState,
        };
    }

    if (ageMs < ttlMs) {
        return {
            state: 'fresh',
            ageMs,
            ttlMin,
            staleMaxHours,
            lastSnapshot: sanitizeSnapshotForOutput(snap),
            parserState: parserState.available ? parserState : null,
        };
    }
    if (ageMs < staleMaxMs) {
        return {
            state: 'stale',
            ageMs,
            ttlMin,
            staleMaxHours,
            lastSnapshot: sanitizeSnapshotForOutput(snap),
            parserState: parserState.available ? parserState : null,
        };
    }
    // Demasiado viejo (> stale_max) → degradación graceful a missing.
    return {
        state: 'missing',
        ageMs,
        ttlMin,
        staleMaxHours,
        lastSnapshot: null,
        parserState: parserState.available ? parserState : null,
        reason: 'snapshot_too_old',
    };
}

/**
 * Sanitiza el snapshot antes de exponerlo a clientes (dashboard). Quita
 * campos que pueden contener PII (account_handle) y deja sólo lo que el
 * banner consume. Consistente con CA-S3 / CA-S7.
 */
function sanitizeSnapshotForOutput(snap) {
    if (!snap || typeof snap !== 'object') return null;
    const out = {
        ts: typeof snap.ts === 'string' ? snap.ts : null,
        weekly_all_models_pct: numOrNull(snap.weekly_all_models_pct),
        weekly_sonnet_pct: numOrNull(snap.weekly_sonnet_pct),
        weekly_design_pct: numOrNull(snap.weekly_design_pct),
        session_pct: numOrNull(snap.session_pct),
        session_minutes_to_reset: numOrNull(snap.session_minutes_to_reset),
        daily_routines_used: numOrNull(snap.daily_routines_used),
        daily_routines_max: numOrNull(snap.daily_routines_max),
        api_overage_used_usd: numOrNull(snap.api_overage_used_usd),
        api_overage_cap_usd: numOrNull(snap.api_overage_cap_usd),
        parse_confidence: numOrNull(snap.parse_confidence),
        // account_handle deliberadamente NO incluido (CA-S3, CA-S7).
        // parse_warnings: solo si son strings cortos, sin contenido raw.
        parse_warnings: Array.isArray(snap.parse_warnings)
            ? snap.parse_warnings.filter(w => typeof w === 'string' && w.length < 64).slice(0, 8)
            : [],
    };
    return out;
}

function numOrNull(x) {
    return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

// -----------------------------------------------------------------------------
// API pública 2: evaluateSnapshotAndGate (CA-12 + CA-13 + CA-S1)
// -----------------------------------------------------------------------------

/**
 * Evalúa un snapshot recién persistido por #3012 y decide si:
 *   1. Setear el flag binario de cuota (gate antes del 429) — CA-12.
 *   2. Calibrar el EMA con dato real — CA-13.
 *
 * Defense-in-depth (R1/R4/R5/R6/R7):
 *   - Re-valida el shape antes de cualquier acción.
 *   - Verifica account_handle vs EXPECTED_CLAUDE_ACCOUNT.
 *   - Anti-spam: gate-alert sólo una vez por ventana semanal.
 *   - Audit trail con `agent: 'quota-snapshot-integration'`.
 *   - Logs sin PII.
 *
 * Inyectables (deps):
 *   - sendTelegram(text): para alertas CA-UX-7.
 *   - now(): para tests determinísticos.
 *   - log(level, msg, meta): logger del caller (default no-op).
 *
 * Devuelve `{ ok, action, reason, alerts }`:
 *   - ok=false → algo no pasó la validación; acción tomada: ninguna.
 *   - action: 'none' | 'calibrated' | 'gated' | 'gated_and_calibrated'.
 *   - reason: categoría del rechazo o de la acción.
 *   - alerts: lista de alertas Telegram emitidas (para tests).
 */
function evaluateSnapshotAndGate(snapshot, opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const sendTelegram = typeof opts.sendTelegram === 'function' ? opts.sendTelegram : null;
    const alerts = [];

    if (!isEnabled()) {
        log('info', 'quota-snapshot-integration: kill_switch off — skip');
        return { ok: false, action: 'none', reason: 'kill_switch', alerts };
    }

    // R1: re-validación obligatoria
    const validation = validateSnapshotShape(snapshot, { now });
    if (!validation.ok) {
        log('warn', `quota-snapshot-integration: snapshot rejected — ${validation.reason}`);
        return { ok: false, action: 'none', reason: validation.reason, alerts };
    }

    // R1 bis: cuenta esperada (si falla, alerta CA-UX-7 sin interpolar)
    const account = verifyAccountMatch(snapshot);
    if (!account.matches) {
        const state = loadIntegrationState();
        if (sendTelegram && shouldEmitAccountMismatchAlert(state, now)) {
            const text = QUOTA_SNAPSHOT_COPY.accountMismatch;
            try { sendTelegram(text); alerts.push({ type: 'account_mismatch', text }); } catch {}
            markAccountMismatchAlerted(state, now);
            saveIntegrationState(state);
        }
        log('warn', 'quota-snapshot-integration: snapshot rejected — account_mismatch');
        return { ok: false, action: 'none', reason: 'account_mismatch', alerts };
    }

    let didGate = false;
    let didCalibrate = false;
    const gatePct = getGatePct();

    // CA-12 / CA-S5: gate al detector binario (con kill switch granular).
    if (isGateEnabled() && snapshot.weekly_all_models_pct >= gatePct) {
        const state = loadIntegrationState();
        const isAlreadyExhausted = quotaExhausted.isQuotaExhausted();
        // Calcular resets_at: snapshot.session_minutes_to_reset es la sesión
        // (5h rolling), NO el reset semanal. Para el reset semanal usamos el
        // próximo cálculo del helper canónico (capResetsAt fallback hace lo
        // mismo si pasamos null). Documentado en docs/quota-tracking.md.
        const weeklyResetMs = weeklyQuota.getNextWeeklyResetMs(now);
        try {
            quotaExhausted.setFlag({
                errorType: 'snapshot_threshold_90',
                resetsAt: weeklyResetMs,
                now,
                agent: 'quota-snapshot-integration',
                rawExcerpt: 'snapshot_real',
            });
            didGate = true;
            log('warn', `quota-snapshot-integration: gate set (weekly_all_models_pct >= ${gatePct})`);
        } catch (e) {
            log('error', `quota-snapshot-integration: setFlag failed — ${e.message}`);
        }
        // R4: anti-spam por ventana semanal
        if (sendTelegram && !isAlreadyExhausted && shouldEmitGateAlert(state, now)) {
            const countdown = formatDayCountdown(weeklyResetMs - now);
            const hhmm = formatHHMMAt(weeklyResetMs);
            const dateLabel = formatDateLabel(weeklyResetMs);
            const text = QUOTA_SNAPSHOT_COPY.weeklyGate
                .replace('{date}', dateLabel)
                .replace('{hhmm}', hhmm)
                .replace('{countdown}', countdown);
            try { sendTelegram(text); alerts.push({ type: 'weekly_gate', text }); } catch {}
            markGateAlerted(state, now);
            saveIntegrationState(state);
        }
    }

    // CA-13: calibración EMA con dato real. Importante: computeQuota ANTES
    // para tener el pct heurístico SIN calibrar (ver guru §"Calibración:
    // secuencia obligatoria"). Si computeQuota falla (sin metrics dir),
    // saltea calibración pero NO falla todo el wire.
    try {
        const baseline = weeklyQuota.computeQuota(metricsDir(), activityLogPath());
        weeklyQuota.saveCalibration(metricsDir(), {
            realWeeklyPct: snapshot.weekly_all_models_pct,
            realSessionPct: snapshot.session_pct,
            pipelineWeeklyPct: baseline && Number.isFinite(baseline.pct) ? baseline.pct : 0,
            pipelineSessionPct: baseline && baseline.session && Number.isFinite(baseline.session.pct)
                ? baseline.session.pct : 0,
            sessionResetsInMinutes: snapshot.session_minutes_to_reset,
        });
        didCalibrate = true;
        const state = loadIntegrationState();
        state.last_calibration_at = new Date(now).toISOString();
        saveIntegrationState(state);
    } catch (e) {
        // Logs sin PII (R7): solo categoría.
        log('warn', `quota-snapshot-integration: calibration skipped — ${e.message ? 'io_error' : 'unknown'}`);
    }

    let action = 'none';
    if (didGate && didCalibrate) action = 'gated_and_calibrated';
    else if (didGate) action = 'gated';
    else if (didCalibrate) action = 'calibrated';

    return { ok: true, action, reason: 'success', alerts };
}

// -----------------------------------------------------------------------------
// Copy de los mensajes Telegram (CA-UX-7) — literal de narrativa §4
// -----------------------------------------------------------------------------

const QUOTA_SNAPSHOT_COPY = Object.freeze({
    // §4.1 — umbral 90% semanal alcanzado
    weeklyGate:
        'Cuota semanal al 90% segun snapshot real.\n' +
        'Pausando spawn de skills LLM para evitar 429.\n' +
        'Reset semanal estimado: {date} {hhmm} (en {countdown}).\n' +
        'Determinisicos siguen procesando.',
    // §4.3 — cuenta no esperada (sin interpolar emails — CA-S4)
    accountMismatch:
        'Snapshot capturado de una cuenta distinta a la esperada.\n' +
        'Descartado · no se contamina la calibracion.\n' +
        'Verifica login en Claude Desktop.\n' +
        'EXPECTED_CLAUDE_ACCOUNT no coincide con account_handle.',
});

// -----------------------------------------------------------------------------
// Helpers de formateo de fecha (sin libs)
// -----------------------------------------------------------------------------

function formatDayCountdown(deltaMs) {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return '0 h';
    const totalMin = Math.round(deltaMs / 60000);
    const days = Math.floor(totalMin / (24 * 60));
    const hours = Math.floor((totalMin - days * 24 * 60) / 60);
    if (days <= 0) return `${hours} h`;
    if (hours <= 0) return `${days} d`;
    return `${days} d ${hours} h`;
}

function formatHHMMAt(ms) {
    if (!Number.isFinite(ms)) return '--:--';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateLabel(ms) {
    if (!Number.isFinite(ms)) return '----';
    const d = new Date(ms);
    const days = ['DOM', 'LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB'];
    const pad = (n) => String(n).padStart(2, '0');
    return `${days[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

// -----------------------------------------------------------------------------
// Microcopy `/status` con snapshot fresco (CA-UX-8)
// -----------------------------------------------------------------------------

/**
 * Construye el bloque de texto de `/status` cuando hay snapshot fresco,
 * según narrativa §3 (formato literal, sin emojis, sin separador miles).
 *
 * Si el banner no está fresh, devuelve null y el caller usa el formato
 * heurístico actual.
 */
function buildStatusSnapshotBlock(opts = {}) {
    const banner = opts.bannerState || getBannerState({ now: opts.now });
    if (banner.state !== 'fresh' || !banner.lastSnapshot) return null;
    const snap = banner.lastSnapshot;
    const ageMin = Math.round(banner.ageMs / 60000);
    const sessionPct = pctText(snap.session_pct);
    const weeklyAll = pctText(snap.weekly_all_models_pct);
    const weeklySonnet = pctText(snap.weekly_sonnet_pct);
    const weeklyDesign = pctText(snap.weekly_design_pct);
    const sessionResetH = Math.max(0, Math.round((snap.session_minutes_to_reset || 0) / 60));
    const routinesUsed = Number.isFinite(snap.daily_routines_used) ? snap.daily_routines_used : 0;
    const routinesMax = Number.isFinite(snap.daily_routines_max) ? snap.daily_routines_max : 15;
    const overUsed = Number.isFinite(snap.api_overage_used_usd) ? snap.api_overage_used_usd : 0;
    const overCap = Number.isFinite(snap.api_overage_cap_usd) ? snap.api_overage_cap_usd : 0;
    return [
        `Cuota Anthropic — dato real (hace ${ageMin} min):`,
        `- Sesion: ${sessionPct} (reset en ${sessionResetH} h)`,
        `- Semanal: ${weeklyAll} todos / ${weeklySonnet} Sonnet / ${weeklyDesign} Design`,
        `- Rutinas: ${routinesUsed} / ${routinesMax} hoy`,
        `- Overage: $${overUsed} / $${overCap}`,
    ].join('\n');
}

function pctText(n) {
    if (!Number.isFinite(n)) return '--%';
    return `${Math.round(n)}%`;
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    // API pública
    evaluateSnapshotAndGate,
    getBannerState,
    buildStatusSnapshotBlock,

    // Helpers expuestos para tests / dashboard
    validateSnapshotShape,
    verifyAccountMatch,
    sanitizeSnapshotForOutput,
    readLastSnapshotLine,
    readParserState,
    isEnabled,
    isGateEnabled,
    shouldEmitGateAlert,

    // Constantes
    PARSER_CATEGORY_ALLOWLIST,
    QUOTA_SNAPSHOT_COPY,
    DEFAULT_TTL_MIN,
    DEFAULT_STALE_MAX_HOURS,
    DEFAULT_GATE_PCT,
    DEFAULT_PARSER_FAIL_ALERT,

    // Paths (útiles para tests)
    snapshotJsonlFile,
    parserStateFile,
    integrationStateFile,
    pipelineDir,
};
