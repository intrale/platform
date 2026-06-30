// =============================================================================
// inflight-executor.js — Ejecutor del fallback in-flight (#4309).
//
// CONTEXTO
// --------
// `commander/inflight-fallback.js` resuelve la **DECISIÓN** del fallback
// in-flight (qué provider de reemplazo usar cuando el primario se cuelga a
// mitad del stream) y ya está testeado. Lo que faltaba — y este módulo cierra —
// es la **EJECUCIÓN**: tras decidir, efectivamente disparar el secundario,
// reusando la MISMA maquinaria de spawn que el camino pre-spawn (paridad).
//
// El épico #3472 se partió en #3577 (detectores shadow, MERGEADO) y #3578
// (wire-up live, CERRADO-SIN-ENTREGAR). #4309 revive #3578 + lo generaliza
// más allá del Telegram Commander para que aplique a CUALQUIER agente del
// pipeline que se quede sin cuota propia a mitad de turno (CA-3).
//
// DISEÑO
// ------
// Este módulo es el "cerebro" skill-agnóstico, compartido entre el Commander y
// el lifecycle de spawn de agentes. NO spawnea ni manda Telegram: esos efectos
// se inyectan como callbacks (`runSecondary`, `onNotice`, `onCanned`). Eso lo
// hace 100% testeable con fakes, y garantiza que el spawn real reuse la
// maquinaria existente del caller (no un segundo ejecutor — requisito de
// paridad del architect).
//
// ORDEN DE ORQUESTACIÓN (CA-B1 de #3578)
// --------------------------------------
//   El caller ya hizo:  detector dispara -> _emitShadowSignal (DECISIÓN, se
//                       conserva) -> killProc(primario) + confirmar muerte.
//   Acá:
//     1. decideInflightFallback({ skill, attemptIndex, budgetMs, ... })
//        -> { shouldRetry, secondaryProvider, secondaryHandler, secondaryModel }
//        (emite inflight_fallback_initiated / exhausted / global_timeout).
//     2. Si NO shouldRetry -> onCanned(cannedResponse) y devolvemos executed:false.
//     3. Si shouldRetry:
//        a. acquireInflightLock (late-response del primario muerto se descarta).
//        b. onNotice(noticeText) — aviso UX al usuario.
//        c. runSecondary(decision) — el caller spawnea con la maquinaria
//           pre-spawn (buildChildEnv partial-override + spawn) y resuelve el turno.
//     El caller emite `inflight_fallback_completed` (EJECUCIÓN, distinto de la
//     señal de decisión — CA-4) cuando recibe executed:true.
//
// SEGURIDAD
// ---------
//   - NO construye env del child: eso lo hace `runSecondary` vía `buildChildEnv`
//     con partial-override `{ provider: secondary }` (invariante S-2, aislamiento
//     de credenciales cross-provider). Este módulo NUNCA toca API keys.
//   - Cap=1: lo impone `decideInflightFallback` (attemptIndex >= MAX). El caller
//     además NO debe llamar este executor más de una vez por turno.
//   - fail-closed: si `decide` lanza, devolvemos executed:false sin spawnear.
// =============================================================================
'use strict';

const inflightFallback = require('./commander/inflight-fallback');

const COMMANDER_SKILL = inflightFallback.COMMANDER_SKILL;

/**
 * runInflightFallback — orquesta decisión + lock + ejecución del secundario.
 *
 * @param {object} opts
 * @param {string} [opts.skill]              skill del agente (default COMMANDER_SKILL).
 * @param {string} opts.primaryProvider      provider del intento que se colgó.
 * @param {string} opts.primaryErrorClass    clasificación del fallo in-flight.
 * @param {number} [opts.primaryDurationMs]  ms acumulados del primario.
 * @param {string} [opts.primaryPartialOutput] parcial del primario (se hashea).
 * @param {number} [opts.attemptIndex]       0 = primer fallback in-flight del turno.
 * @param {number} [opts.budgetMs]           budget global (default 90s en el core).
 * @param {string} opts.pipelineDir          dir del pipeline (audit log).
 * @param {string} opts.lockNamespace        namespace del late-response lock:
 *                                           chat_id para el Commander,
 *                                           `issue-<n>` para agentes de pipeline.
 * @param {string} opts.requestId            id atómico del turno.
 * @param {function} [opts.runSecondary]     (decision) => void — spawnea el
 *                                           secundario y resuelve el turno.
 * @param {function} [opts.onNotice]         (noticeText) => void — aviso UX.
 * @param {function} [opts.onCanned]         (cannedText, reason) => void — el
 *                                           caller resuelve el turno con canned.
 * @param {function} [opts.decide]           inyectable (default core).
 * @param {function} [opts.acquireLock]      inyectable (default core).
 * @param {function} [opts.log]              (level, msg) => void.
 * @returns {{ executed:boolean, reason:string, secondaryProvider:?string,
 *             secondaryModel:?string, secondaryHandler:?object }}
 */
function runInflightFallback(opts = {}) {
    const {
        skill,
        primaryProvider,
        primaryErrorClass,
        primaryDurationMs,
        primaryPartialOutput,
        attemptIndex,
        budgetMs,
        pipelineDir,
        lockNamespace,
        requestId,
        runSecondary,
        onNotice,
        onCanned,
        // inyectables (default: módulo real)
        decide,
        acquireLock,
        log,
    } = opts;

    const _log = typeof log === 'function' ? log : () => {};
    const _decide = typeof decide === 'function' ? decide : inflightFallback.decideInflightFallback;
    const _acquireLock = typeof acquireLock === 'function' ? acquireLock : inflightFallback.acquireInflightLock;
    const _skill = skill || COMMANDER_SKILL;

    // 1. DECISIÓN — emite inflight_fallback_initiated/exhausted/global_timeout.
    let decision;
    try {
        decision = _decide({
            skill: _skill,
            primaryProvider,
            primaryErrorClass,
            primaryDurationMs,
            primaryPartialOutput,
            attemptIndex,
            budgetMs,
            pipelineDir,
            // El late-response lock + audit se namespacean por `chatId`. Para
            // agentes de pipeline `lockNamespace` es `issue-<n>` (no hay chat).
            chatId: lockNamespace,
            requestId,
            log,
        });
    } catch (e) {
        _log('inflight', `❌ executor: decideInflightFallback lanzó (${e && e.message}). Fail-closed, sin spawn.`);
        return { executed: false, reason: 'decide_error', secondaryProvider: null, secondaryModel: null, secondaryHandler: null };
    }

    // 2. Sin candidato (cap / budget / all_gated / sin credencial): canned.
    if (!decision || !decision.shouldRetry) {
        const reason = (decision && decision.reason) || 'no_decision';
        if (typeof onCanned === 'function') {
            try { onCanned(decision && decision.cannedResponse, reason); }
            catch (e) { _log('inflight', `⚠️ executor: onCanned lanzó (best-effort): ${e && e.message}`); }
        }
        return { executed: false, reason, secondaryProvider: null, secondaryModel: null, secondaryHandler: null };
    }

    // 3a. Claim del turno ANTES de spawnear el secundario: cualquier respuesta
    //     tardía del primario muerto se reconoce como duplicada (CA-7).
    try {
        _acquireLock({
            chatId: lockNamespace,
            requestId,
            secondaryProvider: decision.secondaryProvider,
        });
    } catch (e) {
        _log('inflight', `⚠️ executor: acquireInflightLock falló (best-effort): ${e && e.message}`);
    }

    // 3b. Aviso UX (decisión visible para el usuario/operador).
    if (decision.noticeText && typeof onNotice === 'function') {
        try { onNotice(decision.noticeText); }
        catch (e) { _log('inflight', `⚠️ executor: onNotice lanzó (best-effort): ${e && e.message}`); }
    }

    // 3c. EJECUCIÓN — el caller spawnea el secundario con la maquinaria pre-spawn
    //     y resuelve el turno. Si lanza, lo reportamos sin romper el lifecycle.
    if (typeof runSecondary === 'function') {
        try {
            runSecondary(decision);
        } catch (e) {
            _log('inflight', `❌ executor: runSecondary lanzó (${e && e.message}).`);
            return {
                executed: false,
                reason: 'run_secondary_error',
                secondaryProvider: decision.secondaryProvider || null,
                secondaryModel: decision.secondaryModel || null,
                secondaryHandler: decision.secondaryHandler || null,
            };
        }
    }

    return {
        executed: true,
        reason: 'ok',
        secondaryProvider: decision.secondaryProvider,
        secondaryModel: decision.secondaryModel || null,
        secondaryHandler: decision.secondaryHandler || null,
    };
}

module.exports = {
    runInflightFallback,
    COMMANDER_SKILL,
};
