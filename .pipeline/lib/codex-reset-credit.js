// =============================================================================
// codex-reset-credit.js — Canje automático del reset de límite de uso de codex
// + reconciliación EN VIVO del flag de cuota. Issue #7185.
//
// EL AGUJERO QUE CIERRA
//
// Codex (plan ChatGPT) regala cada tanto "créditos de reset de límite de uso"
// (en el TUI: `/usage` → "Redeem usage limit reset"). Hasta ahora el pipeline no
// los conocía: al agotarse la cuota SEMANAL de `openai-codex` el provider quedaba
// gateado hasta el reset semanal aunque hubiera un crédito que lo liberaba al
// instante. Cuota gratis desperdiciada (2026-09-11: codex sin semanal con un
// reset canjeable sin usar).
//
// Y el caso hermano: el 09-11 el operador canjeó a mano desde el TUI minutos
// después de que dos spawns escribieran el flag hasta el día siguiente. El
// reconciliador de #7181 sólo lee rollouts, y no había rollout nuevo porque el
// flag impedía el spawn que lo generaría. Anthropic en reposo, el resto gateado:
// codex era la única pata viva y el pipeline quedó parado 1 h por un flag que
// ya no era cierto. La lectura en vivo que este módulo necesita para el canje
// es exactamente la evidencia fresca que a #7181 le faltaba.
//
// QUÉ HACE (un solo spawn efímero de `codex app-server` alimenta ambas ramas)
//
//   1. RECONCILIACIÓN EN VIVO (CA-9..CA-12). `account/rateLimits/read` → ventana
//      gobernante (misma regla que `pickGoverningWindow` de #7181). Si el
//      backend dice que el uso está permitido (`ordinaryUsageAllowed: true`) y
//      la ventana gobernante está por debajo del 100 % → el flag ya no es
//      cierto → `shortenResetsAt` a "ahora" (drena). Si el backend no publica el
//      permiso, se aplica la regla literal del issue: acortar sólo si el
//      `resetsAt` observado es anterior al del flag. Un snapshot que dice
//      "sigue agotado" NUNCA reescribe ni extiende el flag: sólo acorta.
//
//   2. CANJE (CA-1..CA-8). Sólo si el flag sigue vigente tras (1) y lo agotado
//      es la ventana SEMANAL (`secondary`, 10080 min). El cap rolling de 5 h se
//      libera solo: canjear ahí quema un crédito escaso por nada. Un crédito por
//      agotamiento, `max_per_week` por semana de codex (la semana se mide por el
//      `resetsAt` semanal observado al canjear, no por calendario). El
//      `idempotencyKey` (UUID) se persiste ANTES de llamar y se reusa en los
//      reintentos: `alreadyRedeemed` es éxito, jamás un segundo crédito.
//
// SEGURIDAD / COSTO
//  - Leer no consume cuota. Throttle persistido de 5 min (mismo que #7181).
//  - Fail-open respecto del flag (queda como está) y fail-closed respecto del
//    crédito (no se consume) ante app-server caído, timeout o schema distinto.
//    Una sola lectura fallida corta ambas ramas (CA-11).
//  - Sin slot de codex: `noop` sin tocar `state/` ni spawnear nada (mismo
//    contrato que `reconcileCodexReset`, #7188).
//  - Telegram: un solo mensaje por evento (el canje suprime el `restored`
//    genérico del notifier), silencio en `noCredit`/`nothingToReset`/cap 5 h.
//    Nada de la respuesta del app-server (accountId, títulos de créditos,
//    error.message) llega a logs ni a Telegram.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROVIDER = 'openai-codex';

const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000;
// Tras un drenado en vivo, si el próximo spawn vuelve a escribir el flag es que
// el snapshot y el CLI no coinciden (otro límite, spend control…). No drenar de
// nuevo en bucle cada 5 min: como mucho un drenado en vivo por hora.
const LIVE_DRAIN_BACKOFF_MS = 60 * 60 * 1000;
// Copy (e) del contrato UX: alerta única cuando el app-server lleva ≥ 1 h sin
// responder en barridos consecutivos.
const UNAVAILABLE_ALERT_AFTER_MS = 60 * 60 * 1000;
// Los intentos por `detected_at` se podan pasado este plazo (el flag nunca vive
// más de 31 días — `MAX_TTL_DAYS` — así que 45 cubre cualquier slot vigente).
const ATTEMPT_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;

const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    max_per_week: 1,
    notify: true,
});

const SUCCESS_OUTCOMES = new Set(['reset', 'alreadyRedeemed']);
const KNOWN_OUTCOMES = new Set(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']);

// -----------------------------------------------------------------------------
// Estado persistido
// -----------------------------------------------------------------------------

function stateFile() {
    // Mismo envoltorio que `quota-reset-reconcile.stateFile()` (#7112 SEC-13).
    return require('./write-target').writePath(process.env,
        { canal: 'estado', destino: 'state/codex-reset-credit.json' },
        'state', 'codex-reset-credit.json');
}

function readState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeState(state) {
    try {
        const file = stateFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    } catch { /* best-effort: el estado no puede romper el pipeline */ }
}

function pruneAttempts(attempts, now) {
    const out = {};
    for (const [key, a] of Object.entries(attempts || {})) {
        const created = Date.parse(a && a.created_at);
        if (Number.isFinite(created) && now - created > ATTEMPT_RETENTION_MS) continue;
        out[key] = a;
    }
    return out;
}

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

/**
 * `config.yaml:quota_detector.codex_reset_credit`. Cualquier valor inválido cae
 * al default conservador; `enabled` sólo se apaga con `false` explícito.
 */
function resolveConfig(override) {
    let raw = override;
    if (raw === undefined) {
        try {
            const resolver = require('./config-resolver');
            const pipelineDir = require('./write-target').writeDir(process.env,
                { canal: 'estado', destino: 'config.yaml (lectura)' });
            const full = resolver.resolve({ pipelineDir });
            raw = full && full.quota_detector && full.quota_detector.codex_reset_credit;
        } catch {
            raw = undefined;
        }
    }
    const cfg = raw && typeof raw === 'object' ? raw : {};
    const maxPerWeek = Number(cfg.max_per_week);
    return {
        enabled: cfg.enabled !== false,
        max_per_week: Number.isInteger(maxPerWeek) && maxPerWeek >= 0 ? maxPerWeek : DEFAULT_CONFIG.max_per_week,
        notify: cfg.notify !== false,
    };
}

// -----------------------------------------------------------------------------
// Snapshot en vivo → forma interna
// -----------------------------------------------------------------------------

function toWindow(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const used = Number(raw.usedPercent);
    if (!Number.isFinite(used)) return null;
    const resetAt = Number(raw.resetsAt);
    const windowMinutes = Number(raw.windowDurationMins);
    return {
        usedPercent: used,
        resetAt: Number.isFinite(resetAt) ? resetAt : null,          // epoch SEGUNDOS (contrato del app-server)
        windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : null,
    };
}

/**
 * Extrae del `result` de `account/rateLimits/read` SÓLO los campos que las
 * decisiones necesitan. Lanza si el shape no es el esperado (→ CA-6/CA-11).
 *
 * Nombres reales (codex-cli 0.154.0, distintos de los del texto del issue):
 * `rateLimits.primary/secondary.{usedPercent, windowDurationMins, resetsAt}` y
 * `rateLimitResetCredits.{availableCount, credits|null}` a nivel raíz.
 */
function parseLiveSnapshot(result) {
    if (!result || typeof result !== 'object') {
        throw new Error('snapshot inválido: result no es objeto');
    }
    const rl = result.rateLimits;
    if (rl !== null && rl !== undefined && typeof rl !== 'object') {
        throw new Error('snapshot inválido: rateLimits con tipo inesperado');
    }
    const rc = result.rateLimitResetCredits;
    if (rc !== null && rc !== undefined && typeof rc !== 'object') {
        throw new Error('snapshot inválido: rateLimitResetCredits con tipo inesperado');
    }
    let availableCount = 0;
    let credits = null;
    if (rc) {
        const n = Number(rc.availableCount);
        if (!Number.isFinite(n)) throw new Error('snapshot inválido: availableCount no numérico');
        availableCount = Math.max(0, Math.trunc(n));
        if (Array.isArray(rc.credits)) {
            credits = rc.credits
                .filter(c => c && typeof c === 'object' && typeof c.id === 'string')
                .map(c => ({ id: c.id, status: c.status, resetType: c.resetType }));
        } else if (rc.credits !== null && rc.credits !== undefined) {
            throw new Error('snapshot inválido: credits con tipo inesperado');
        }
    }
    return {
        windows: {
            session: rl ? toWindow(rl.primary) : null,
            weekly: rl ? toWindow(rl.secondary) : null,
        },
        ordinaryUsageAllowed: typeof result.ordinaryUsageAllowed === 'boolean' ? result.ordinaryUsageAllowed : null,
        rateLimitReachedType: rl && typeof rl.rateLimitReachedType === 'string' ? rl.rateLimitReachedType : null,
        credits: { availableCount, credits },
    };
}

// -----------------------------------------------------------------------------
// Decisiones puras (testeables sin disco ni app-server)
// -----------------------------------------------------------------------------

/**
 * ¿El snapshot dice que codex sigue agotado? Cualquier señal de tope manda.
 */
function isStillExhausted(parsed, governing) {
    if (!governing) return true; // sin ventana legible no hay evidencia de recuperación
    if (governing.usedPercent >= 100) return true;
    if (parsed.ordinaryUsageAllowed === false) return true;
    if (parsed.rateLimitReachedType) return true;
    return false;
}

/**
 * Decide la reconciliación en vivo del flag.
 *
 * @returns {{action:'noop'|'shorten', reason:string, targetMs?:number, governing?:object}}
 */
function decideReconcile({ parsed, slot, now, lastLiveDrainMs, pickGoverningWindow }) {
    const governing = pickGoverningWindow(parsed.windows);
    if (!governing) return { action: 'noop', reason: 'no_governing_window' };
    if (isStillExhausted(parsed, governing)) {
        return { action: 'noop', reason: 'still_exhausted', governing };
    }
    const flagResetsMs = Date.parse(slot && slot.resets_at);
    const observedMs = governing.resetAt * 1000;

    if (parsed.ordinaryUsageAllowed === true) {
        // El backend afirma que el uso está permitido: el flag ya no es cierto.
        if (Number.isFinite(lastLiveDrainMs) && now - lastLiveDrainMs < LIVE_DRAIN_BACKOFF_MS) {
            return { action: 'noop', reason: 'live_drain_backoff', governing };
        }
        return {
            action: 'shorten',
            reason: 'usage_allowed_live',
            targetMs: Math.min(now, observedMs),
            governing,
        };
    }
    // Sin permiso explícito publicado: regla literal del issue — acortar sólo
    // si el reset observado es anterior al persistido (drena si ya pasó).
    if (Number.isFinite(flagResetsMs) && observedMs < flagResetsMs) {
        return { action: 'shorten', reason: 'observed_reset_earlier', targetMs: observedMs, governing };
    }
    return { action: 'noop', reason: 'observed_not_earlier', governing };
}

/**
 * ¿Qué ventana está agotada? `weekly` manda si llegó al tope (aunque la de
 * sesión también); `session` si sólo el cap rolling; `null` si no se puede
 * determinar (→ no canjear, fail-closed sobre el crédito).
 */
function classifyExhaustedWindow(windows) {
    if (!windows) return null;
    const weekly = windows.weekly;
    const session = windows.session;
    if (weekly && Number.isFinite(weekly.usedPercent) && weekly.usedPercent >= 100) return 'weekly';
    if (session && Number.isFinite(session.usedPercent) && session.usedPercent >= 100) return 'session';
    return null;
}

/**
 * Elige el crédito a canjear.
 *  - `availableCount > 0` es condición necesaria.
 *  - Si `credits` es array con filas → hace falta una `available` de tipo
 *    `codexRateLimits` (fail-closed ante filas inelegibles).
 *  - Si `credits` es `null` o `[]` (backend sin detalle o lista capada) → se
 *    canjea sin `creditId`: el backend elige el siguiente disponible.
 *
 * @returns {{eligible:boolean, reason:string, creditId:string|null}}
 */
function pickCredit(credits) {
    if (!credits || !(credits.availableCount > 0)) {
        return { eligible: false, reason: 'no_credit_available', creditId: null };
    }
    if (Array.isArray(credits.credits) && credits.credits.length > 0) {
        const match = credits.credits.find(c => c.status === 'available' && c.resetType === 'codexRateLimits');
        if (!match) return { eligible: false, reason: 'no_eligible_credit', creditId: null };
        return { eligible: true, reason: 'credit_selected', creditId: match.id };
    }
    return { eligible: true, reason: 'backend_selects', creditId: null };
}

/**
 * Canjes que siguen contando para la semana de codex en curso: los que se
 * hicieron con un `weekly_resets_at` que todavía no venció. Un canje sin
 * `weekly_resets_at` conocido cuenta 7 días desde el canje (conservador).
 */
function countRedemptionsThisWeek(redemptions, now) {
    let n = 0;
    for (const r of Array.isArray(redemptions) ? redemptions : []) {
        const weekEnd = Date.parse(r && r.weekly_resets_at);
        if (Number.isFinite(weekEnd)) {
            if (now < weekEnd) n++;
            continue;
        }
        const redeemed = Date.parse(r && r.redeemed_at);
        if (Number.isFinite(redeemed) && now - redeemed < 7 * 24 * 60 * 60 * 1000) n++;
    }
    return n;
}

// -----------------------------------------------------------------------------
// Barrido
// -----------------------------------------------------------------------------

function noopLog() {}

/**
 * Barrido completo: reconciliación en vivo + canje. Asíncrono (habla con el
 * app-server); NUNCA lanza — cualquier fallo se devuelve como resultado.
 *
 * @param {object} [opts]
 * @param {number}   [opts.now]
 * @param {boolean}  [opts.force]           saltea el throttle (tests / ops).
 * @param {object}   [opts.quotaModule]     inyectable (`quota-exhausted`).
 * @param {object}   [opts.adapter]         inyectable (`quota-adapters/openai-codex`).
 * @param {object}   [opts.reconcileModule] inyectable (`quota-reset-reconcile`, por `pickGoverningWindow`).
 * @param {object}   [opts.client]          inyectable (`codex-app-server-client`).
 * @param {object}   [opts.clientOpts]      opciones para el cliente (timeouts, launcher, spawnImpl).
 * @param {object}   [opts.notifier]        `quota-notifier` instanciado (opcional).
 * @param {Function} [opts.log]             `(msg) => void` → línea en pulpo.log.
 * @param {object}   [opts.config]          override de `quota_detector.codex_reset_credit`.
 * @param {number}   [opts.minIntervalMs]
 * @param {Function} [opts.uuid]            inyectable (tests).
 * @returns {Promise<{action:string, reason?:string, reconcile?:object, redeem?:object}>}
 */
async function runCodexLiveSweep(opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const log = typeof opts.log === 'function' ? opts.log : noopLog;
    const minIntervalMs = Number.isFinite(opts.minIntervalMs) ? opts.minIntervalMs : DEFAULT_MIN_INTERVAL_MS;
    const notifier = opts.notifier || null;
    const uuid = typeof opts.uuid === 'function' ? opts.uuid : () => crypto.randomUUID();

    // 0. Kill-switch (CA-7): sin efectos colaterales, ni disco ni spawn.
    const cfg = resolveConfig(opts.config);
    if (!cfg.enabled) return { action: 'skipped', reason: 'disabled' };

    let quotaModule; let adapter; let reconcileModule; let client;
    try {
        quotaModule = opts.quotaModule || require('./quota-exhausted');
        adapter = opts.adapter || require('./quota-adapters/openai-codex');
        reconcileModule = opts.reconcileModule || require('./quota-reset-reconcile');
        client = opts.client || require('./codex-app-server-client');
    } catch (e) {
        return { action: 'skipped', reason: 'module_unavailable', error: e && e.message };
    }

    // 1. ¿Hay slot de codex? Lectura barata; sin slot no se toca disco (#7188).
    let flag;
    try {
        flag = quotaModule.readDefensive({ now });
    } catch (e) {
        return { action: 'skipped', reason: 'flag_unreadable', error: e && e.message };
    }
    if (!flag || flag.exhausted !== true) return { action: 'noop', reason: 'no_active_flag' };
    const slots = Array.isArray(flag.providers) ? flag.providers : [];
    const slot = slots.find(s => s && s.provider === PROVIDER);
    if (!slot) return { action: 'noop', reason: 'provider_not_flagged' };

    // 2. Throttle persistido.
    let state = readState();
    const last = Number(state.last_run_ms);
    if (!opts.force && Number.isFinite(last) && now - last < minIntervalMs) {
        return { action: 'skipped', reason: 'throttled' };
    }
    state = { ...state, last_run_ms: now, attempts: pruneAttempts(state.attempts, now) };
    writeState(state);

    const audit = (event, excerpt) => {
        try {
            if (typeof quotaModule.appendAudit === 'function') {
                quotaModule.appendAudit({
                    event, provider: PROVIDER, model: slot.model || null,
                    error_type: slot.pattern_matched || null, raw_excerpt: excerpt, flag_set: true,
                }, { now });
            }
        } catch { /* best-effort */ }
    };

    // 3. Una sola sesión efímera para leer (y, si corresponde, canjear).
    let outcome;
    try {
        outcome = await client.withAppServer(async (session) => {
            const parsed = parseLiveSnapshot(await client.readRateLimits(session));
            return runDecisions({
                session, parsed, slot, state, cfg, now, log, audit, uuid, notifier,
                quotaModule, adapter, reconcileModule, client,
            });
        }, opts.clientOpts || {});
    } catch (e) {
        return handleLiveFailure({ e, state, now, cfg, notifier, log, audit });
    }

    // Éxito de transporte: se resetea la racha de fallos.
    if (state.consecutive_failures || state.first_failure_ms || state.unavailable_notified_ms) {
        writeState({ ...readState(), consecutive_failures: 0, first_failure_ms: null, unavailable_notified_ms: null });
    }
    return outcome;
}

function handleLiveFailure({ e, state, now, cfg, notifier, log, audit }) {
    const code = (e && e.code) || 'unknown';
    const fresh = readState();
    const failures = (Number(fresh.consecutive_failures) || 0) + 1;
    const firstFailure = Number.isFinite(Number(fresh.first_failure_ms)) && fresh.first_failure_ms
        ? Number(fresh.first_failure_ms) : now;
    const next = { ...fresh, consecutive_failures: failures, first_failure_ms: firstFailure };
    // Copy (e): una sola alerta cuando el fallo persiste ≥ 1 h de barridos.
    let alerted = false;
    if (cfg.notify && notifier && !fresh.unavailable_notified_ms
        && now - firstFailure >= UNAVAILABLE_ALERT_AFTER_MS && failures >= 2) {
        try { notifier.notifyAppServerUnavailable(); alerted = true; } catch { /* best-effort */ }
        if (alerted) next.unavailable_notified_ms = now;
    }
    writeState(next);
    audit('codex_app_server_unavailable', `code=${code} consecutive=${failures}`);
    log(`♻️ codex: app-server sin respuesta (${code}, racha=${failures}) — flag intacto, sin canje (CA-11)`);
    return { action: 'noop', reason: 'app_server_unavailable', code, consecutiveFailures: failures, alerted };
}

async function runDecisions(ctx) {
    const { session, parsed, slot, cfg, now, log, audit, uuid, notifier, quotaModule, adapter, reconcileModule, client } = ctx;
    let state = ctx.state;
    const result = { action: 'noop', reason: 'nothing_to_do', reconcile: null, redeem: null };

    // ---- Rama 1: reconciliación en vivo -------------------------------------
    const decision = decideReconcile({
        parsed, slot, now,
        lastLiveDrainMs: Number(state.last_live_drain_ms),
        pickGoverningWindow: reconcileModule.pickGoverningWindow,
    });
    const gov = decision.governing;
    const govTxt = gov ? `${gov.kind === 'weekly' ? 'semanal' : 'sesion'} ${Math.round(gov.usedPercent)} %` : 'sin ventana';
    let flagDrained = false;
    if (decision.action === 'shorten') {
        const shortened = quotaModule.shortenResetsAt({
            provider: PROVIDER,
            resetsAtMs: decision.targetMs,
            source: `codex_app_server:${gov.kind}`,
            now,
        });
        result.reconcile = { action: decision.action, reason: decision.reason, targetMs: decision.targetMs, shorten: shortened };
        if (shortened.adjusted) {
            const drained = shortened.reason === 'cleared_elapsed';
            flagDrained = drained;
            if (drained) {
                state = { ...readState(), last_live_drain_ms: now };
                writeState(state);
                if (notifier && cfg.notify) {
                    const weeklyPct = parsed.windows.weekly ? parsed.windows.weekly.usedPercent : gov.usedPercent;
                    try { notifier.markLiveReconcileClear({ pct: weeklyPct }); } catch { /* best-effort */ }
                }
            }
            const porQue = !drained
                ? `reset ${shortened.to}`
                : (decision.reason === 'usage_allowed_live' ? 'uso permitido por el backend, drenado' : 'reset ya pasado, drenado');
            log(`♻️ codex: flag acortado por snapshot en vivo (${govTxt} → ${porQue}; motivo=${decision.reason})`);
            result.action = drained ? 'cleared_live' : 'shortened_live';
            result.reason = decision.reason;
        } else {
            log(`♻️ codex: snapshot en vivo (${govTxt}) no acorta el flag (${shortened.reason})`);
        }
    } else {
        result.reconcile = { action: decision.action, reason: decision.reason };
        log(`♻️ codex: snapshot en vivo (${govTxt}) → reconciliación noop (${decision.reason})`);
    }
    if (flagDrained) {
        result.redeem = { action: 'skipped', reason: 'flag_drained_live' };
        return result;
    }

    // ---- Rama 2: canje ------------------------------------------------------
    // ¿Qué se agotó? (a) snapshot en vivo; (b) rollouts locales como respaldo.
    let exhaustedWindow = classifyExhaustedWindow(parsed.windows);
    let windowSource = 'codex_app_server';
    if (!exhaustedWindow) {
        try {
            const observed = typeof adapter.readObservedWindows === 'function' ? adapter.readObservedWindows({}) : null;
            exhaustedWindow = classifyExhaustedWindow(observed);
            windowSource = 'codex_rollout';
        } catch { exhaustedWindow = null; }
    }
    if (exhaustedWindow !== 'weekly') {
        const reason = exhaustedWindow === 'session' ? 'session_cap_not_redeemable' : 'exhausted_window_unknown';
        result.redeem = { action: 'skipped', reason, windowSource };
        if (exhaustedWindow === 'session') {
            log(`♻️ codex: cap de 5 h agotado (${windowSource}) — no se canjea crédito (regla de negocio)`);
        } else {
            log('♻️ codex: no se pudo determinar qué ventana se agotó — no se canjea (fail-closed sobre el crédito)');
        }
        audit('reset_credit_skipped', `reason=${reason} source=${windowSource}`);
        return result;
    }

    // Un intento lógico por agotamiento (clave = detected_at del slot).
    const attemptKey = String(slot.detected_at || 'unknown');
    const attempts = { ...(state.attempts || {}) };
    const previous = attempts[attemptKey];
    if (previous && previous.outcome && KNOWN_OUTCOMES.has(previous.outcome)) {
        result.redeem = { action: 'skipped', reason: 'already_attempted', outcome: previous.outcome };
        log(`♻️ codex: canje ya resuelto para este agotamiento (${previous.outcome}) — no se repite`);
        return result;
    }

    // max_per_week (CA-4): la semana es la de codex, no la del calendario.
    const usedThisWeek = countRedemptionsThisWeek(state.redemptions, now);
    if (usedThisWeek >= cfg.max_per_week) {
        const alreadyNotified = previous && previous.already_used_notified === true;
        if (!alreadyNotified) {
            attempts[attemptKey] = { ...(previous || { created_at: new Date(now).toISOString() }), already_used_notified: true };
            writeState({ ...readState(), attempts });
            if (notifier && cfg.notify) {
                const weeklyResetMs = parsed.windows.weekly && Number.isFinite(parsed.windows.weekly.resetAt)
                    ? parsed.windows.weekly.resetAt * 1000
                    : Date.parse(slot.resets_at);
                try { notifier.notifyResetCreditAlreadyUsed({ resetsAtMs: weeklyResetMs }); } catch { /* best-effort */ }
            }
        }
        result.redeem = { action: 'skipped', reason: 'max_per_week_reached', usedThisWeek, notified: !alreadyNotified };
        log(`♻️ codex: semanal agotada otra vez y el crédito ya se usó esta semana (${usedThisWeek}/${cfg.max_per_week}) — sin canje`);
        audit('reset_credit_skipped', `reason=max_per_week_reached used=${usedThisWeek} max=${cfg.max_per_week}`);
        return result;
    }

    // Crédito disponible (CA-3): sin crédito → silencio en Telegram.
    const pick = pickCredit(parsed.credits);
    if (!pick.eligible) {
        attempts[attemptKey] = {
            ...(previous || { created_at: new Date(now).toISOString() }),
            outcome: 'noCredit', resolved_at: new Date(now).toISOString(), local: true,
        };
        writeState({ ...readState(), attempts });
        result.redeem = { action: 'skipped', reason: pick.reason, availableCount: parsed.credits.availableCount };
        log(`♻️ codex: semanal agotada, sin crédito de reset disponible (${pick.reason}) — flag sigue su curso`);
        audit('reset_credit_skipped', `reason=${pick.reason} available=${parsed.credits.availableCount}`);
        return result;
    }

    // Idempotencia (CA-5): UUID persistido ANTES de llamar; reintento = misma clave.
    const idempotencyKey = previous && typeof previous.idempotency_key === 'string' && previous.idempotency_key
        ? previous.idempotency_key
        : uuid();
    attempts[attemptKey] = {
        ...(previous || {}),
        created_at: (previous && previous.created_at) || new Date(now).toISOString(),
        idempotency_key: idempotencyKey,
        credit_id: pick.creditId,
        outcome: previous && previous.outcome ? previous.outcome : null,
    };
    writeState({ ...readState(), attempts });

    let consumed;
    try {
        consumed = await client.consumeResetCredit(session, { idempotencyKey, creditId: pick.creditId });
    } catch (e) {
        // Sin respuesta: NO sabemos si se consumió. La clave queda persistida y
        // el próximo barrido reintenta con la misma (alreadyRedeemed = éxito).
        audit('reset_credit_consume_failed', `code=${(e && e.code) || 'unknown'}`);
        log(`♻️ codex: el canje no respondió (${(e && e.code) || 'unknown'}) — se reintenta con la misma clave en el próximo barrido`);
        result.redeem = { action: 'noop', reason: 'consume_unanswered', code: (e && e.code) || 'unknown' };
        return result;
    }
    const outcome = consumed && typeof consumed.outcome === 'string' ? consumed.outcome : 'unknown';
    if (!KNOWN_OUTCOMES.has(outcome)) {
        // Schema distinto: no asumimos nada; se reintenta con la misma clave.
        audit('reset_credit_consume_failed', `outcome_desconocido`);
        log('♻️ codex: el canje devolvió un outcome desconocido — flag intacto, se reintenta con la misma clave');
        result.redeem = { action: 'noop', reason: 'unknown_outcome' };
        return result;
    }

    const resolvedAt = new Date(now).toISOString();
    attempts[attemptKey] = { ...attempts[attemptKey], outcome, resolved_at: resolvedAt };

    if (!SUCCESS_OUTCOMES.has(outcome)) {
        // noCredit / nothingToReset: flag intacto, sin mensaje (copy c).
        writeState({ ...readState(), attempts });
        result.redeem = { action: 'skipped', reason: `outcome_${outcome}`, outcome };
        log(`♻️ codex: canje sin efecto (outcome=${outcome}) — flag sigue su curso, sin notificación`);
        audit('reset_credit_skipped', `outcome=${outcome}`);
        return result;
    }

    // Éxito: re-leer para saber créditos restantes reales y el nuevo reset semanal.
    let remaining = Math.max(0, parsed.credits.availableCount - 1);
    let weeklyResetsAtIso = parsed.windows.weekly && Number.isFinite(parsed.windows.weekly.resetAt)
        ? new Date(parsed.windows.weekly.resetAt * 1000).toISOString()
        : null;
    try {
        const after = parseLiveSnapshot(await client.readRateLimits(session));
        remaining = after.credits.availableCount;
        if (after.windows.weekly && Number.isFinite(after.windows.weekly.resetAt)) {
            weeklyResetsAtIso = new Date(after.windows.weekly.resetAt * 1000).toISOString();
        }
    } catch { /* la estimación previa alcanza */ }

    const redemptions = [...(Array.isArray(state.redemptions) ? state.redemptions : []), {
        redeemed_at: resolvedAt,
        weekly_resets_at: weeklyResetsAtIso,
        idempotency_key: idempotencyKey,
        credit_id: pick.creditId,
        outcome,
        detected_at: slot.detected_at || null,
    }].slice(-20);
    writeState({ ...readState(), attempts, redemptions, last_redeemed_at: resolvedAt });

    // Telegram ANTES del clear: así el `onFlagCleared` que dispara el watcher
    // encuentra la supresión puesta y no manda el `restored` genérico.
    if (notifier && cfg.notify) {
        try { notifier.notifyResetCreditRedeemed({ creditsRemaining: remaining }); } catch { /* best-effort */ }
    }
    let cleared = false;
    try {
        cleared = quotaModule.clearFlag({
            provider: PROVIDER,
            event: 'reset_credit_redeemed',
            reason: `crédito de reset canjeado (outcome=${outcome}); restantes=${remaining}`,
        }) === true;
    } catch { cleared = false; }
    audit('reset_credit_redeemed', `outcome=${outcome} remaining=${remaining} cleared=${cleared}`);
    log(`♻️ codex: canjeé un reset (outcome=${outcome}) — cuota semanal liberada, flag ${cleared ? 'drenado' : 'no encontrado'}; créditos restantes=${remaining}`);

    result.action = 'redeemed';
    result.reason = outcome;
    result.redeem = { action: 'redeemed', outcome, creditsRemaining: remaining, cleared, idempotencyKey };
    return result;
}

// -----------------------------------------------------------------------------
// Enganche fire-and-forget para el camino del spawn del pulpo
// -----------------------------------------------------------------------------

let inFlight = null;

/**
 * Dispara el barrido en background sin bloquear el spawn. Un solo barrido en
 * vuelo a la vez; el throttle interno decide si toca correr. Nunca lanza.
 * El resultado impacta en el SIGUIENTE spawn (CA-9: ≤ 5 min).
 *
 * @returns {Promise|null} la promesa del barrido (para tests) o `null` si ya había uno en vuelo.
 */
function scheduleCodexLiveSweep(opts = {}) {
    if (inFlight) return null;
    let p;
    try {
        p = runCodexLiveSweep(opts);
    } catch (e) {
        return null;
    }
    inFlight = p.then(
        (r) => { inFlight = null; return r; },
        (e) => {
            inFlight = null;
            try { (opts.log || noopLog)(`♻️ codex: barrido en vivo falló inesperadamente: ${e && e.message}`); } catch { /* */ }
            return { action: 'noop', reason: 'unexpected_error' };
        },
    );
    return inFlight;
}

module.exports = {
    runCodexLiveSweep,
    scheduleCodexLiveSweep,
    // helpers puros (tests)
    parseLiveSnapshot,
    decideReconcile,
    classifyExhaustedWindow,
    pickCredit,
    countRedemptionsThisWeek,
    resolveConfig,
    isStillExhausted,
    PROVIDER,
    DEFAULT_CONFIG,
    DEFAULT_MIN_INTERVAL_MS,
    LIVE_DRAIN_BACKOFF_MS,
    UNAVAILABLE_ALERT_AFTER_MS,
    _stateFile: stateFile,
    _readState: readState,
};
