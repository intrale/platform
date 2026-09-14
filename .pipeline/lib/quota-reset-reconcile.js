// =============================================================================
// quota-reset-reconcile.js — Re-verificación automática del flag de cuota (#7181)
//
// EL AGUJERO QUE CIERRA
//
// El flag `.pipeline/quota-exhausted.json` se escribe cuando un spawn falla por
// límite de cuota, y hasta ahora tenía exactamente dos formas de irse:
//
//   1. que venza su `resets_at`, o
//   2. `clearFlag` tras un spawn EXITOSO del provider.
//
// La segunda es inalcanzable mientras el flag está puesto: el gate bloquea el
// spawn, así que el éxito que probaría la recuperación nunca puede ocurrir. El
// flag gobierna su propia evidencia. Si el `resets_at` quedó mal escrito —el
// caso de #7161, un cap de 24h sobre una ventana de 5h— el provider queda
// apagado horas de más y NADA lo detecta: el health check de los providers
// CLI-OAuth es un scan del PATH (`isBinaryOnPath`), no consulta cuota, y por
// eso reporta `green` sin poder contradecir al flag jamás.
//
// LA FUENTE QUE SÍ SABE
//
// Codex persiste sus propios rate limits en los rollouts locales
// (`~/.codex/sessions/**/rollout-*.jsonl`), con `used_percent`, `window_minutes`
// y `resets_at` por ventana. Es la misma fecha que el CLI le muestra al usuario
// en el mensaje de error ("try again at 4:16 PM"). Está en disco, es gratis y
// no consume cuota: no hace falta gastar un spawn para saber cuándo vuelve.
//
// QUÉ HACE ESTE MÓDULO
//
// Compara el `resets_at` persistido en el flag contra el observado en los
// rollouts y, si el real es ANTERIOR, acorta la ventana (y la drena si ya
// venció). Nunca la alarga — ver `shortenResetsAt` en `quota-exhausted.js`.
//
// SEGURIDAD / COSTO
//  - Sólo lee: rollouts (cola acotada) y el flag. No spawnea nada.
//  - Throttle persistido: el barrido de rollouts recorre miles de archivos, así
//    que corre a lo sumo una vez cada `DEFAULT_MIN_INTERVAL_MS`.
//  - Fail-open: cualquier error deja el flag intacto. Un fallo de lectura NO
//    puede destrabar un provider capado.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Único provider con ventanas observables localmente. Anthropic no persiste un
// equivalente legible, así que no se reconcilia por acá (su fuente única es
// `claude -p /usage`, ver #4861).
const RECONCILABLE_PROVIDER = 'openai-codex';

// El barrido de rollouts es la parte cara (miles de archivos). 5 minutos es
// suficiente: la ganancia que perseguimos se mide en horas de apagón evitadas.
const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000;

// La medición tiene que ser contemporánea al agotamiento. Una lectura MUY
// anterior al `detected_at` del flag describe una ventana previa: su `resets_at`
// podría ya haber vencido y acortaríamos el gate por un dato que no habla del
// tope vigente.
const MAX_MEASUREMENT_LAG_MS = 30 * 60 * 1000;

function stateFile() {
    // Mismo override que `quota-exhausted.pipelineDir()`. Sin esto el throttle
    // vive siempre en el `.pipeline/` del checkout: los tests aislados le
    // escribirían encima al estado real y compartirían la ventana entre sí.
    const base = process.env.PIPELINE_DIR_OVERRIDE
        || path.join(__dirname, '..');
    return path.join(base, 'state', 'quota-reset-reconcile.json');
}

function readState() {
    try {
        return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {};
    } catch {
        return {};
    }
}

function writeState(state) {
    try {
        const dir = path.dirname(stateFile());
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8');
    } catch { /* best-effort: el throttle no puede romper el pipeline */ }
}

/**
 * Elige, entre las ventanas observadas, la que gobierna el tope vigente.
 *
 * Criterio: la ventana MÁS consumida con `resetAt` utilizable. Cuando Codex
 * corta, corta por la ventana que llegó al tope; su `resets_at` es la fecha que
 * el propio CLI anuncia. Ante empate gana la de sesión (rolling corta), que es
 * la que se agota primero en el uso real del pipeline.
 *
 * @param {{session:Object|null, weekly:Object|null}} windows
 * @returns {{resetAt:number, usedPercent:number, kind:string}|null}
 */
function pickGoverningWindow(windows) {
    const candidates = [];
    if (windows && windows.session && Number.isFinite(windows.session.resetAt)) {
        candidates.push({ ...windows.session, kind: 'session' });
    }
    if (windows && windows.weekly && Number.isFinite(windows.weekly.resetAt)) {
        candidates.push({ ...windows.weekly, kind: 'weekly' });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
        if (b.usedPercent !== a.usedPercent) return b.usedPercent - a.usedPercent;
        return a.kind === 'session' ? -1 : 1;
    });
    const top = candidates[0];
    return { resetAt: top.resetAt, usedPercent: top.usedPercent, kind: top.kind };
}

/**
 * Reconcilia el `resets_at` del flag de codex contra el reset observado.
 *
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {boolean} [opts.force]           saltea el throttle (tests / ops).
 * @param {object} [opts.quotaModule]      inyectable (tests).
 * @param {object} [opts.adapter]          inyectable (tests).
 * @param {number} [opts.minIntervalMs]
 * @returns {{action:string, [key:string]:any}}
 */
function reconcileCodexReset(opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const minIntervalMs = Number.isFinite(opts.minIntervalMs)
        ? opts.minIntervalMs
        : DEFAULT_MIN_INTERVAL_MS;

    // 1. Throttle — el barrido de rollouts es lo caro de todo esto.
    const state = readState();
    const last = Number(state.last_run_ms);
    if (!opts.force && Number.isFinite(last) && now - last < minIntervalMs) {
        return { action: 'skipped', reason: 'throttled' };
    }

    let quotaModule;
    let adapter;
    try {
        quotaModule = opts.quotaModule || require('./quota-exhausted');
        adapter = opts.adapter || require('./quota-adapters/openai-codex');
    } catch (e) {
        return { action: 'skipped', reason: 'module_unavailable', error: e && e.message };
    }

    // 2. ¿Hay slot activo de codex? `readDefensive` ya drena lo vencido.
    //    Es una lectura JSON barata: no marca el intento. #7188 — sin flag, o
    //    con flag de otro provider, salimos como `noop` SIN tocar disco (ni
    //    `state/`): este camino lo recorren también las sondas read-only.
    let snapshot;
    try {
        snapshot = quotaModule.readDefensive({ now });
    } catch (e) {
        return { action: 'skipped', reason: 'flag_unreadable', error: e && e.message };
    }
    if (!snapshot || snapshot.exhausted !== true) {
        return { action: 'noop', reason: 'no_active_flag' };
    }
    // `readDefensive` publica los slots vigentes como ARRAY (uno por provider);
    // los vencidos ya quedaron drenados antes de llegar acá.
    const slots = Array.isArray(snapshot.providers) ? snapshot.providers : [];
    const slot = slots.find(s => s && s.provider === RECONCILABLE_PROVIDER);
    if (!slot) {
        return { action: 'noop', reason: 'provider_not_flagged' };
    }

    // Marcamos el intento ANTES de hacer el trabajo caro (el barrido de
    // rollouts): si el barrido tira, el throttle igual corre y no reintentamos
    // en bucle contra un disco roto.
    writeState({ ...state, last_run_ms: now });

    // 3. Ventanas observadas por el propio Codex (sin gate de frescura: un
    //    `resets_at` futuro no envejece — ver `readObservedWindows`).
    let windows;
    try {
        windows = typeof adapter.readObservedWindows === 'function'
            ? adapter.readObservedWindows({})
            : null;
    } catch (e) {
        return { action: 'skipped', reason: 'rollouts_unreadable', error: e && e.message };
    }
    if (!windows) return { action: 'noop', reason: 'no_observed_windows' };

    // 4. La medición tiene que hablar del tope vigente, no de uno anterior.
    const detectedAt = Date.parse(slot.detected_at);
    if (Number.isFinite(detectedAt) && Number.isFinite(windows.tsMs)
        && windows.tsMs < detectedAt - MAX_MEASUREMENT_LAG_MS) {
        return {
            action: 'noop',
            reason: 'measurement_predates_flag',
            measuredAt: new Date(windows.tsMs).toISOString(),
            detectedAt: slot.detected_at,
        };
    }

    const governing = pickGoverningWindow(windows);
    if (!governing) return { action: 'noop', reason: 'no_governing_window' };

    // 5. Acortar (nunca alargar). `shortenResetsAt` drena solo si ya venció.
    const observedMs = governing.resetAt * 1000;
    const result = quotaModule.shortenResetsAt({
        provider: RECONCILABLE_PROVIDER,
        resetsAtMs: observedMs,
        source: `codex_rollout:${governing.kind}`,
        now,
    });

    return {
        action: result.adjusted ? result.reason : 'noop',
        reason: result.reason,
        window: governing.kind,
        usedPercent: governing.usedPercent,
        observedResetsAt: new Date(observedMs).toISOString(),
        flagResetsAt: slot.resets_at,
        ...(result.from ? { from: result.from, to: result.to } : {}),
    };
}

module.exports = {
    reconcileCodexReset,
    pickGoverningWindow,
    RECONCILABLE_PROVIDER,
    DEFAULT_MIN_INTERVAL_MS,
    MAX_MEASUREMENT_LAG_MS,
    _stateFile: stateFile,
};
