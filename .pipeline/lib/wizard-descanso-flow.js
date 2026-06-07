// =============================================================================
// wizard-descanso-flow.js — Flow del wizard "Configurar período de descanso".
//
// Issue #3739 (split de #3715 / paraguas #3669). Hija que registra el flow
// `descanso` sobre la infra compartida `lib/wizard-session.js` (#3724). NO
// reimplementa CSRF, sesión, idempotencia, timeout ni rate-limit: todo eso
// lo aporta la base. Acá vive SOLO la lógica de los 3 pasos del wizard.
//
// Adaptación a la API real de wizard-session (la receta del architect asumía
// `registerFlow(name, {handlers, opts})` con handlers que devolvían
// `{ok, next_step}`; la base mergeada por #3724 expone en cambio
// `registerFlow(name, {maxStep, validateStep, executeStep})`):
//
//   - `validateStep(step, params) → boolean`. Si devuelve false el framework
//     responde 409 y NO cachea el paso (el operador puede reintentar). Lo
//     usamos como gate duro de los pasos read-only (anomalías solo acepta
//     `acknowledged:true`) y de los límites de tamaño del confirm.
//   - `executeStep(session, step, params) → result`. Su retorno se cachea
//     como éxito (idempotencia). Hace el trabajo real y devuelve `{ok, ...}`.
//     La validación de la ventana (incluida el cap CA-D2) vive acá y, ante
//     payload inválido, devuelve `{ok:false, errors}` SIN persistir. El step
//     0 (ventana) crea siempre una sesión fresca (anti-fixation de la base),
//     así que un retorno `ok:false` nunca queda "pegado" por idempotencia.
//
// Mapeo de pasos (interno → UI del mockup de UX):
//   step 0 = Ventana horaria      (UI "Paso 1")
//   step 1 = Detector de anomalías (UI "Paso 2", read-only — R-1)
//   step 2 = Confirmación + preview (UI "Paso 3")
//
// La persistencia es ATÓMICA en el step 2: los steps 0 y 1 solo acumulan en
// `session.draft`. Recién el confirm escribe `rest-mode.json` (vía
// `setWindow`, que ya valida y audita en `rest-mode-audit.jsonl`) y agrega
// la entry `config_descanso` al audit chain `config-descanso-audit.jsonl`.
// =============================================================================
'use strict';

const path = require('node:path');

const restModeWindow = require('./rest-mode-window');
const auditLog = require('./audit-log');

// Pasos internos del flow.
const STEPS = Object.freeze({ VENTANA: 0, ANOMALIAS: 1, CONFIRM: 2 });
const MAX_STEP = 2;

// Límites de los campos libres del confirm (defensa en profundidad; el render
// los vuelve a escapar con escape-html — R-4/CA-G3).
const MOTIVO_MAX_LEN = 280;
const ACTOR_MAX_LEN = 80;

// Nombre del audit chain exclusivo del wizard de descanso (CA-D5). Convive
// con el audit legacy `rest-mode-audit.jsonl` que escribe `setWindow`.
const AUDIT_SUBPATH = ['audit', 'config-descanso-audit.jsonl'];

/**
 * Construye la definición del flow para `wizardSession.registerFlow`.
 * Se inyectan las dependencias (`pipelineDir`, `loadConfig`, `now`) por
 * closure porque `registerFlow` no recibe `opts` — esto mantiene el módulo
 * testeable (un test pasa un `pipelineDir` temporal y un `now` mockeado).
 *
 * @param {{pipelineDir:string, loadConfig?:Function, now?:Function}} deps
 * @returns {{maxStep:number, validateStep:Function, executeStep:Function, STEPS:object}}
 */
function createFlow(deps) {
    const { pipelineDir } = deps || {};
    if (!pipelineDir || typeof pipelineDir !== 'string') {
        throw new Error('wizard-descanso-flow: createFlow requiere "pipelineDir"');
    }
    const nowFn = (deps && typeof deps.now === 'function') ? deps.now : () => Date.now();
    const cfgFn = (deps && typeof deps.loadConfig === 'function') ? deps.loadConfig : () => ({});

    function isPlainObject(v) {
        return v !== null && typeof v === 'object' && !Array.isArray(v);
    }

    // -------------------------------------------------------------------------
    // validateStep — gate duro (false → 409, retryable, sin persistir).
    // -------------------------------------------------------------------------
    function validateStep(step, params) {
        if (step === STEPS.VENTANA) {
            // Solo estructural. La validación profunda (incl. cap CA-D2) y los
            // mensajes en español se devuelven desde executeStep (step 0 crea
            // sesión fresca → un retorno ok:false no queda cacheado).
            return isPlainObject(params);
        }
        if (step === STEPS.ANOMALIAS) {
            // Read-only (R-1): el único campo aceptado es `acknowledged:true`.
            // Cualquier intento de editar thresholds (otro field) → 409.
            if (!isPlainObject(params)) return false;
            const keys = Object.keys(params);
            return params.acknowledged === true && keys.length === 1 && keys[0] === 'acknowledged';
        }
        if (step === STEPS.CONFIRM) {
            // `params` opcional. Si viene, valida tamaños de los campos libres.
            if (params == null) return true;
            if (!isPlainObject(params)) return false;
            if ('motivo' in params
                && (typeof params.motivo !== 'string' || params.motivo.length > MOTIVO_MAX_LEN)) {
                return false;
            }
            if ('actor' in params
                && (typeof params.actor !== 'string' || params.actor.length > ACTOR_MAX_LEN)) {
                return false;
            }
            return true;
        }
        return false;
    }

    // -------------------------------------------------------------------------
    // Step 0 — Ventana horaria.
    // -------------------------------------------------------------------------
    function execVentana(session, params) {
        const v = restModeWindow.validatePayload(params);
        if (!v.ok) {
            // Rechazo server-side: NO persiste, NO acumula draft. El cap CA-D2
            // (24h continuas) viene incluido en `v.errors` cuando aplica.
            return { ok: false, step: 'ventana', errors: v.errors, warnings: v.warnings || [] };
        }
        // Snapshot del estado previo para el `config_diff` del audit (CA-D5).
        let prevState = null;
        try { prevState = restModeWindow.getWindow({ pipelineDir }); } catch { prevState = null; }
        session.draft = Object.assign({}, session.draft || {}, {
            payload: params,            // payload crudo aceptado (se re-valida en setWindow)
            window: v.normalized,       // shape normalizado (active/schedule/timezone/manual)
        });
        session.snapshotBefore = prevState;
        const minutesPerDay = restModeWindow.totalContinuousMinutesPerDay(v.normalized.schedule);
        return {
            ok: true,
            step: 'ventana',
            warnings: v.warnings || [],
            minutes_per_day: minutesPerDay,
            cap_minutes: restModeWindow.MAX_CONTINUOUS_MINUTES_PER_DAY,
        };
    }

    // -------------------------------------------------------------------------
    // Step 1 — Detector de anomalías (read-only, R-1).
    // -------------------------------------------------------------------------
    function execAnomalias(session, _params) {
        const cfg = cfgFn() || {};
        const ca = isPlainObject(cfg.cost_anomaly_alert) ? cfg.cost_anomaly_alert : {};
        const channels = isPlainObject(ca.channels) ? ca.channels : {};
        // Solo se exponen los thresholds que REALMENTE existen (el cap snooze
        // está hardcoded en lib/rest-mode-state.js:50, config.yaml es doc-only).
        const thresholds = {
            max_snooze_hours: typeof ca.max_snooze_hours === 'number' ? ca.max_snooze_hours : 24,
            consecutive_baseline_checks_to_clear:
                typeof ca.consecutive_baseline_checks_to_clear === 'number'
                    ? ca.consecutive_baseline_checks_to_clear : 2,
            channels: {
                telegram: channels.telegram === true,
                dashboard_banner: channels.dashboard_banner === true,
            },
        };
        session.draft = Object.assign({}, session.draft || {}, { thresholds_snapshot: thresholds });
        return {
            ok: true,
            step: 'anomalias',
            read_only: true,
            thresholds,
            hint: 'Para modificar estos valores, ver config.yaml',
        };
    }

    // -------------------------------------------------------------------------
    // Step 2 — Confirmación + persistencia atómica + audit + preview.
    // -------------------------------------------------------------------------
    function execConfirm(session, params) {
        const draft = session.draft || {};
        if (!isPlainObject(draft.window) || draft.payload === undefined) {
            return { ok: false, step: 'confirm', errors: ['session sin ventana definida — reiniciar wizard'] };
        }
        const actor = (params && typeof params.actor === 'string' && params.actor)
            ? params.actor : 'wizard-descanso';
        const motivo = (params && typeof params.motivo === 'string') ? params.motivo : null;

        // Persistencia atómica: setWindow re-valida (cap CA-D2 incluido) y
        // escribe el audit legacy en rest-mode-audit.jsonl.
        const setRes = restModeWindow.setWindow(draft.payload, { pipelineDir, actor, now: nowFn });
        if (!setRes.ok) {
            return { ok: false, step: 'confirm', errors: setRes.errors };
        }

        const nowMs = nowFn();
        const describe = restModeWindow.describeRestModeNow(setRes.state, nowMs);
        const transition = restModeWindow.nextWindowTransition(setRes.state, nowMs);

        // Audit chain `config_descanso` (CA-D5). La NDJSON injection (R-3) la
        // cubre `appendChained` con `JSON.stringify` por línea (newlines en
        // valores quedan escapadas como `\n`). El `motivo` se guarda crudo acá;
        // el render del preview lo escapa con escape-html (R-4/CA-G3).
        const entry = {
            ts: new Date(nowMs).toISOString(),
            actor,
            action: 'config_descanso',
            config_diff: {
                prev: session.snapshotBefore || null,
                next: setRes.state,
            },
        };
        if (motivo !== null) entry.motivo = motivo;

        const result = {
            ok: true,
            done: true,
            state: setRes.state,
            next_period: describe.nextPeriod,
            transition,
            motivo,
        };
        try {
            const auditRes = auditLog.appendChained({
                file: path.join(pipelineDir, ...AUDIT_SUBPATH),
                entry,
            });
            result.audit = { hash_self: auditRes.hash_self, hash_prev: auditRes.hash_prev };
        } catch (e) {
            // El audit no debe revertir la persistencia ya hecha; se reporta
            // como warning para que la UI/QA lo detecten.
            result.audit_warning = e && e.message ? e.message : String(e);
        }
        return result;
    }

    async function executeStep(session, step, params) {
        if (step === STEPS.VENTANA) return execVentana(session, params);
        if (step === STEPS.ANOMALIAS) return execAnomalias(session, params);
        if (step === STEPS.CONFIRM) return execConfirm(session, params);
        return { ok: false, step: String(step), errors: ['step desconocido'] };
    }

    return { maxStep: MAX_STEP, validateStep, executeStep, STEPS };
}

module.exports = {
    createFlow,
    MAX_STEP,
    MOTIVO_MAX_LEN,
    ACTOR_MAX_LEN,
    STEPS,
    AUDIT_SUBPATH,
};
