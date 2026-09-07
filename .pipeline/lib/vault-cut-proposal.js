// =============================================================================
// vault-cut-proposal.js — PRODUCTOR de la propuesta de corte del fallback del
// vault (#5460, split de #5452 · conserva D1..D6 de #5339 y REQ-SEC-1..15).
//
// Este módulo decide CUÁNDO ofrecerle al operador el botón
// «Confirmar corte del fallback», y qué hacer cuando el operador NO está.
// No ejecuta el corte: eso es `vault-cut-fallback.js` (#5459), colgado del
// callback por `operator-gate.handleOperationalCallback()` (#5458).
//
// Reparto de responsabilidades del corte:
//
//   #5458  capability + despacho aislado   → `operator-gate.js`, `action-token.js`
//   #5459  ejecutor idempotente + atómico  → `vault-cut-fallback.js`
//   #5460  ESTE módulo: propuesta, ausencia del operador, break-glass
//
// -----------------------------------------------------------------------------
// Invariantes NO negociables
// -----------------------------------------------------------------------------
//
//  1. CERO transiciones de carpetas. El productor NO mueve, renombra ni borra
//     un solo work-file. No conoce `waiting-operator/`, `pendiente/`,
//     `procesado/` ni `bloqueado-humano/`. Lo único que escribe es (a) su
//     propio estado de propuesta pendiente, (b) la señal local de ausencia, y
//     (c) una orden de label en la cola de GitHub. El test lo cementa
//     sembrando work-files y verificando que siguen byte a byte donde estaban.
//
//  2. Sólo propone con COBERTURA POSITIVA. El criterio es el de
//     `vault-shadow-metrics.evaluate()` (CA-18 de #5427): cada descriptor, en
//     cada host activo, con al menos una resolución por `vault`, cero evidencia
//     negativa, ventana cumplida. `cumple` y nada más. Ni `no_cumple` (todavía
//     no) ni `no_verificado` (no se sabe) habilitan el botón.
//
//  3. FALLO CERRADO en las cuatro causas de ausencia. `timeout`,
//     `telegram_ausente`, `allowlist_vacia` y `estado_indeterminado` conservan
//     el fallback, aplican `needs-human` y dejan señal local sanitizada. La
//     decisión la toma `operator-absence-policy.resolveOperationalAbsence()`,
//     que no tiene rama de auto-proceed.
//
//  4. Distinción explícita entre «todavía no» y «no se sabe». `no_cumple` es
//     una respuesta INFORMADA y negativa: la ventana sigue corriendo, no pasa
//     nada, no se molesta a nadie. `no_verificado` es AUSENCIA DE RESPUESTA:
//     el evaluador no pudo determinar el estado (sidecar de integridad, t0
//     reiniciado, hosts mal configurados). Confundirlas es el modo de falla
//     que convierte «no lo sé» en «esperá tranquilo» para siempre.
//
//  5. La señal local y el copy nunca traen infraestructura. Ni chat ids, ni
//     hostnames, ni ARNs, ni paths absolutos, ni el motivo crudo del
//     evaluador. Todo pasa por el enum cerrado de causas.
//
// -----------------------------------------------------------------------------
// Máquina de estados del productor
// -----------------------------------------------------------------------------
//
//   (sin propuesta) --cobertura cumple + canal + allowlist--> propuesta_publicada
//   propuesta_publicada --now < deadline--------------------> esperando_confirmacion
//   propuesta_publicada --now >= deadline-------------------> fail_closed(timeout)
//   (cualquiera) --bootstrap_fallback: false---------------> ya_cortado (limpia estado)
//
// El estado pendiente vive en un JSON propio bajo `.pipeline/state/`. Se limpia
// SIEMPRE que se decide (timeout o corte consumado): un estado pendiente
// inmortal republicaría el botón para siempre o dejaría el timeout disparando
// en loop.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const absencePolicy = require('./operator-absence-policy');
const { maxTtlFor } = require('./action-token');

// -----------------------------------------------------------------------------
// Constantes.
// -----------------------------------------------------------------------------

/** Acción operacional del corte. Debe coincidir con `OPERATIONAL_ACTIONS`. */
const CUT_ACTION = 'vault-cut-fallback';

/** Copy del botón. Es literal del criterio de aceptación de #5460. */
const CUT_BUTTON_TEXT = '🔐 Confirmar corte del fallback';

/** Nombre del archivo de estado de la propuesta pendiente. */
const PROPOSAL_STATE_FILE = 'vault-cut-proposal.json';

/** Nombre de la señal local de ausencia. Observable sin Telegram. */
const ABSENCE_SIGNAL_FILE = 'vault-cut-absence.json';

/**
 * Timeout por defecto de la propuesta: 6 h. Es DELIBERADAMENTE más largo que el
 * TTL criptográfico de la capability (`OPERATIONAL_TTL_MS` = 10 min en
 * `action-token.js`). Los dos relojes miden cosas distintas:
 *
 *   - El TTL del token acota cuánto vale UNA autorización una vez emitida
 *     (ventana de replay/robo). Corto por seguridad.
 *   - Este timeout acota cuánto esperamos al OPERADOR HUMANO antes de declarar
 *     ausencia. Corto por seguridad sería un falso positivo: un operador que
 *     duerme no es un operador ausente.
 *
 * Igualarlos rompería las dos cosas a la vez: o el token vive 6 h (superficie
 * de replay), o se escala a `needs-human` cada 10 minutos (ruido que enseña a
 * ignorar la alerta).
 */
const DEFAULT_PROPOSAL_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/** Cota dura del timeout de propuesta: 72 h. Más que esto no es "esperar". */
const MAX_PROPOSAL_TIMEOUT_MS = 72 * 60 * 60 * 1000;

/** Cota mínima: 1 min. Debajo de esto el operador no llega ni a leer. */
const MIN_PROPOSAL_TIMEOUT_MS = 60 * 1000;

/** Estados que devuelve `runProposalTick`. Enum cerrado. */
const OUTCOME = Object.freeze({
    YA_CORTADO: 'ya_cortado',
    ESPERANDO_COBERTURA: 'esperando_cobertura',
    ESPERANDO_CONFIRMACION: 'esperando_confirmacion',
    PROPUESTA_PUBLICADA: 'propuesta_publicada',
    FAIL_CLOSED: 'fail_closed',
});

/** Estado de la ventana sombra que HABILITA la propuesta. Uno solo. */
const COVERAGE_OK = 'cumple';

/** Estado que significa "todavía no, pero se sabe". No es ausencia. */
const COVERAGE_NOT_YET = 'no_cumple';

// -----------------------------------------------------------------------------
// Helpers puros.
// -----------------------------------------------------------------------------

/**
 * Normaliza el timeout de propuesta. Fuera de rango, no entero o ausente ⇒
 * default. Nunca lanza: un timeout mal configurado no puede impedir que el
 * productor evalúe (impedirlo dejaría el fallback abierto en silencio, que es
 * peor que esperar el default).
 * @param {*} value
 * @returns {number}
 */
function normalizeProposalTimeoutMs(value) {
    if (!Number.isInteger(value)) return DEFAULT_PROPOSAL_TIMEOUT_MS;
    if (value < MIN_PROPOSAL_TIMEOUT_MS || value > MAX_PROPOSAL_TIMEOUT_MS) {
        return DEFAULT_PROPOSAL_TIMEOUT_MS;
    }
    return value;
}

/**
 * Teclado de la propuesta. UN solo botón: no hay "Rechazar".
 *
 * Rechazar no existe a propósito. El estado por defecto YA es "no cortar": no
 * tocar nada conserva el fallback. Un botón de rechazo agregaría una acción
 * cuyo efecto es idéntico al silencio, con el costo de sugerir que el silencio
 * NO alcanza — y de fabricar una segunda capability que también hay que
 * autorizar, firmar y auditar.
 *
 * @param {string} callbackId — id opaco ya registrado por `operator-gate.register()`.
 * @returns {{inline_keyboard: Array<Array<{text:string, callback_data:string}>>}}
 */
function buildProposalKeyboard(callbackId) {
    return {
        inline_keyboard: [[{ text: CUT_BUTTON_TEXT, callback_data: String(callbackId) }]],
    };
}

/**
 * Copy de la propuesta. Sin infraestructura: no nombra hosts, ni secretos, ni
 * cuántos hay, ni paths más allá del runbook.
 * @param {object} p
 * @param {string} [p.runbook]
 * @param {number} [p.timeoutMs]
 * @returns {string}
 */
function buildProposalMessage({ runbook, timeoutMs } = {}) {
    const horas = Math.max(1, Math.round(normalizeProposalTimeoutMs(timeoutMs) / 3600000));
    const buttonTtlMs = maxTtlFor(CUT_ACTION);
    const minutosBoton = Math.max(1, Math.floor(buttonTtlMs / 60000));
    return [
        'VAULT · La ventana sombra cerró: se puede cortar el fallback',
        'Todos los secretos se resolvieron por el vault en todos los hosts activos,',
        'sin una sola caida al bootstrap. El criterio de salida esta cumplido.',
        '',
        'Confirmar corta la via vieja de resolucion. Es la ultima accion del cutover.',
        `El boton es valido por ~${minutosBoton} min; si expira, el fallback se CONSERVA.`,
        `Sin confirmacion, en ~${horas}h el issue queda en needs-human.`,
        `Runbook (incluye el ultimo punto de retorno): ${absencePolicy.sanitizeRunbookRef(runbook)}`,
    ].join('\n');
}

// -----------------------------------------------------------------------------
// Fábrica.
// -----------------------------------------------------------------------------

/**
 * Crea el productor de la propuesta con dependencias inyectables.
 *
 * @param {object} opts
 * @param {string}   [opts.pipelineDir]    — raíz `.pipeline/`.
 * @param {string}   [opts.configPath]     — `.pipeline/config.yaml`.
 * @param {string}   [opts.statePath]      — JSON de propuesta pendiente.
 * @param {string}   [opts.signalPath]     — señal local de ausencia.
 * @param {object}   opts.gate             — instancia de `operator-gate` (register).
 * @param {Function} opts.readFallbackState — `() => true|false` (`vault.bootstrap_fallback`).
 *                                            Puede lanzar ⇒ estado indeterminado.
 * @param {Function} opts.evaluateCoverage — `() => {estado, motivo}` de `vault-shadow-metrics`.
 * @param {Function} opts.resolveAllowlist — `() => Set|Array` de operadores autorizados.
 * @param {Function} opts.canSendTelegram  — `() => boolean` disponibilidad del canal.
 * @param {Function} opts.sendProposal     — `({text, replyMarkup}) => {ok:boolean}`.
 * @param {Function} [opts.applyNeedsHuman] — `(issue) => boolean` (encola el label).
 * @param {Function} [opts.notifyAbsence]  — `(params) => {ok}` (default: cola Telegram).
 * @param {Function} [opts.appendAudit]    — `(params) => void` (default: operator-absence-audit).
 * @param {Function} [opts.now]            — `() => number` ms.
 * @param {object}   [opts.fsImpl]
 * @param {Function} [opts.logger]         — `(msg) => void`.
 * @param {string}   [opts.runbook]
 * @param {number}   [opts.proposalTimeoutMs]
 */
function createVaultCutProposal(opts = {}) {
    const pipelineDir = opts.pipelineDir || path.resolve(__dirname, '..');
    const _fs = opts.fsImpl || fs;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const logger = typeof opts.logger === 'function' ? opts.logger : () => {};
    const runbook = absencePolicy.sanitizeRunbookRef(opts.runbook);
    const timeoutMs = normalizeProposalTimeoutMs(opts.proposalTimeoutMs);

    const statePath = opts.statePath || path.join(pipelineDir, 'state', PROPOSAL_STATE_FILE);
    const signalPath = opts.signalPath || path.join(pipelineDir, 'state', ABSENCE_SIGNAL_FILE);

    // -------------------------------------------------------------------------
    // Estado de la propuesta pendiente.
    // -------------------------------------------------------------------------

    /**
     * Lee el estado pendiente. Ilegible o con shape inválido ⇒ `null` (no hay
     * propuesta). Es fail-closed hacia "no hay pendiente": un estado corrupto no
     * puede disparar un timeout fantasma que escale a `needs-human` solo.
     * @returns {{issue:number, callback_id:string, published_at:string, deadline_ms:number}|null}
     */
    function readPending() {
        let raw;
        try { raw = _fs.readFileSync(statePath, 'utf8'); } catch { return null; }
        let doc;
        try { doc = JSON.parse(raw); } catch { return null; }
        if (!doc || typeof doc !== 'object') return null;
        if (!Number.isInteger(doc.issue) || doc.issue <= 0) return null;
        if (typeof doc.callback_id !== 'string' || !doc.callback_id) return null;
        if (!Number.isFinite(doc.deadline_ms)) return null;
        return doc;
    }

    /** Escribe el estado pendiente de forma atómica. `{ok:boolean}`. */
    function writePending(entry) {
        const dir = path.dirname(statePath);
        const temp = path.join(dir, `.${PROPOSAL_STATE_FILE}.${process.pid}.tmp`);
        try {
            _fs.mkdirSync(dir, { recursive: true });
            _fs.writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
            _fs.renameSync(temp, statePath);
            return { ok: true };
        } catch {
            try { _fs.unlinkSync(temp); } catch { /* best-effort */ }
            return { ok: false };
        }
    }

    /** Borra el estado pendiente. Idempotente, nunca lanza. */
    function clearPending() {
        try { _fs.unlinkSync(statePath); } catch { /* no existía */ }
    }

    // -------------------------------------------------------------------------
    // Auditoría (best-effort, nunca tumba el tick).
    // -------------------------------------------------------------------------

    function audit(params) {
        if (typeof opts.appendAudit === 'function') {
            try { opts.appendAudit(params); } catch { /* best-effort */ }
            return;
        }
        try {
            // eslint-disable-next-line global-require
            require('./operator-absence-audit').safeAppendDecision(params);
        } catch { /* best-effort: el audit no puede matar al productor */ }
    }

    // -------------------------------------------------------------------------
    // Rama de ausencia — ÚNICO camino a `needs-human`.
    // -------------------------------------------------------------------------

    /**
     * Aplica la política de ausencia: conserva el fallback, escribe la señal
     * local sanitizada, encola `needs-human` y notifica (best-effort).
     *
     * NO mueve ni un archivo del pipeline. En particular NO usa
     * `human-block.reportHumanBlock()`, que renombra el work-file activo del
     * issue a `bloqueado-humano/` — eso es exactamente la transición de carpeta
     * que el criterio de aceptación prohíbe. Se usa sólo el encolado del label.
     *
     * @param {object} params
     * @param {string} params.causa
     * @param {number} params.issue
     * @returns {object} outcome de `runProposalTick`.
     */
    function failClosed({ causa, issue }) {
        const decision = absencePolicy.resolveOperationalAbsence({ causa, runbook });

        // 1 · señal local PRIMERO: es el canal que sobrevive sin Telegram y sin
        // GitHub. Si esto falla, el operador se entera igual por el label, pero
        // queda auditado que la evidencia local no se pudo escribir.
        const signal = absencePolicy.writeOperationalAbsenceSignal({
            signalPath, causa: decision.causa, runbook: decision.runbook,
            now: new Date(now()), fsImpl: _fs,
        });

        // 2 · `needs-human` en GitHub (encolado, sin red desde acá).
        let labeled = false;
        if (typeof opts.applyNeedsHuman === 'function' && Number.isInteger(issue) && issue > 0) {
            try { labeled = opts.applyNeedsHuman(issue) === true; } catch { labeled = false; }
        }

        // 3 · aviso al operador. Si la causa ES `telegram_ausente`, este intento
        // falla por definición y no pasa nada: no es el canal de garantía.
        let notified = false;
        try {
            const notifier = typeof opts.notifyAbsence === 'function'
                ? opts.notifyAbsence
                : (p) => absencePolicy.notifyOperationalAbsence(p);
            const res = notifier({ causa: decision.causa, runbook: decision.runbook });
            notified = !!(res && res.ok);
        } catch { notified = false; }

        // 4 · audit tamper-evident. `gate: 'operacional'` porque NO hay gate de
        // lifecycle: dejarlo en null perdería que la decisión fue de esta clase.
        audit({
            issue, gate: 'operacional', clase: CUT_ACTION,
            actor: 'kernel:absence-policy', decision: 'fail-closed',
            reason: `corte del fallback no ejecutado: ${decision.causa}`,
            timestamp: new Date(now()).toISOString(),
            extra: {
                conserva_fallback: true,
                signal_escrita: signal.ok === true,
                needs_human_encolado: labeled,
                aviso_encolado: notified,
            },
        });

        // 5 · el pendiente se limpia SIEMPRE. Un pendiente vencido que sobrevive
        // vuelve a disparar `timeout` en cada tick y convierte una alerta en un
        // loop de alertas.
        clearPending();

        logger(`[vault-cut] fail-closed (${decision.causa}): el fallback se conserva. Runbook: ${decision.runbook}`);

        return {
            status: OUTCOME.FAIL_CLOSED,
            causa: decision.causa,
            runbook: decision.runbook,
            conserva_fallback: true,
            needs_human: true,
            signal_escrita: signal.ok === true,
            needs_human_encolado: labeled,
            aviso_encolado: notified,
            signal: signal.signal || null,
        };
    }

    // -------------------------------------------------------------------------
    // Tick del productor.
    // -------------------------------------------------------------------------

    /**
     * Evalúa una vez el criterio de salida y decide qué hacer.
     *
     * @param {object} params
     * @param {number} params.issue — issue del cutover (destino de `needs-human`).
     * @returns {object} `{status, ...}` — ver `OUTCOME`.
     */
    function runProposalTick({ issue } = {}) {
        const issueNum = Number(issue);
        const issueOk = Number.isInteger(issueNum) && issueNum > 0;

        // --- 1 · ¿el fallback sigue abierto? ---------------------------------
        // Un estado que no se puede leer, o que no es un booleano, es
        // INDETERMINADO. No se asume `false` ("ya está cortado, no hago nada":
        // dejaría el fallback abierto para siempre en silencio) ni `true`
        // ("está abierto, propongo": propondría cortar sobre un estado que
        // nadie pudo verificar).
        let fallbackAbierto;
        try {
            fallbackAbierto = opts.readFallbackState();
        } catch {
            return failClosed({ causa: 'estado_indeterminado', issue: issueNum });
        }
        if (fallbackAbierto === false) {
            clearPending();
            return { status: OUTCOME.YA_CORTADO, motivo: 'bootstrap_fallback_ya_en_false' };
        }
        if (fallbackAbierto !== true) {
            return failClosed({ causa: 'estado_indeterminado', issue: issueNum });
        }

        // --- 2 · ¿hay una propuesta viva? ------------------------------------
        // Se resuelve ANTES de reevaluar cobertura: si ya se preguntó, el tick
        // sólo mide el reloj del operador. Reevaluar primero republicaría el
        // botón en cada tick mientras la cobertura sigue cumpliendo, que es
        // spam garantizado.
        const pending = readPending();
        if (pending) {
            if (now() < pending.deadline_ms) {
                return {
                    status: OUTCOME.ESPERANDO_CONFIRMACION,
                    issue: pending.issue,
                    deadline_ms: pending.deadline_ms,
                };
            }
            return failClosed({ causa: 'timeout', issue: pending.issue || issueNum });
        }

        // --- 3 · cobertura positiva ------------------------------------------
        let coverage;
        try {
            coverage = opts.evaluateCoverage();
        } catch {
            return failClosed({ causa: 'estado_indeterminado', issue: issueNum });
        }
        const estado = coverage && typeof coverage.estado === 'string' ? coverage.estado : null;

        if (estado === COVERAGE_NOT_YET) {
            // Negativa INFORMADA: la ventana corre, falta cobertura o hay
            // evidencia negativa. Nadie tiene que hacer nada.
            return {
                status: OUTCOME.ESPERANDO_COBERTURA,
                motivo: 'criterio_de_salida_no_cumplido',
            };
        }
        if (estado !== COVERAGE_OK) {
            // `no_verificado` o cualquier estado desconocido: NO se sabe.
            return failClosed({ causa: 'estado_indeterminado', issue: issueNum });
        }

        // A partir de acá se va a preguntar. El issue tiene que ser válido: sin
        // él no hay dónde registrar el `needs-human` ni a qué bindear el token.
        if (!issueOk) {
            return failClosed({ causa: 'estado_indeterminado', issue: issueNum });
        }

        // --- 4 · allowlist de firmantes --------------------------------------
        // Vacía o irresoluble ⇒ nadie puede confirmar. Publicar el botón sería
        // peor que no publicarlo: quedaría un mensaje con una acción que
        // rechaza a todo el mundo, y el operador leería "el pipeline está roto"
        // en vez de "falta configurar el firmante".
        let allowlistSize = 0;
        try {
            const allow = opts.resolveAllowlist();
            allowlistSize = allow instanceof Set ? allow.size : (Array.isArray(allow) ? allow.length : 0);
        } catch {
            allowlistSize = 0;
        }
        if (allowlistSize === 0) {
            return failClosed({ causa: 'allowlist_vacia', issue: issueNum });
        }

        // --- 5 · canal disponible --------------------------------------------
        let canalOk = false;
        try { canalOk = opts.canSendTelegram() === true; } catch { canalOk = false; }
        if (!canalOk) {
            return failClosed({ causa: 'telegram_ausente', issue: issueNum });
        }

        // --- 6 · registrar la capability y publicar --------------------------
        // `register()` firma el token y persiste el binding server-side. Si
        // explota (material HMAC ausente, disco), no hay capability que ofrecer.
        let registered;
        try {
            registered = opts.gate.register({ issue: issueNum, action: CUT_ACTION });
        } catch {
            return failClosed({ causa: 'estado_indeterminado', issue: issueNum });
        }
        if (!registered || typeof registered.callbackData !== 'string' || !registered.callbackData) {
            return failClosed({ causa: 'estado_indeterminado', issue: issueNum });
        }

        let sent = false;
        try {
            const res = opts.sendProposal({
                text: buildProposalMessage({ runbook, timeoutMs }),
                replyMarkup: buildProposalKeyboard(registered.callbackData),
                issue: issueNum,
            });
            sent = !!(res && res.ok);
        } catch {
            sent = false;
        }
        if (!sent) {
            // El canal se cayó ENTRE la comprobación y el envío. Es la misma
            // situación operativa que "no hay canal": el operador no vio nada.
            return failClosed({ causa: 'telegram_ausente', issue: issueNum });
        }

        // --- 7 · persistir el pendiente --------------------------------------
        const publishedAt = now();
        const persisted = writePending({
            issue: issueNum,
            callback_id: registered.callbackData,
            published_at: new Date(publishedAt).toISOString(),
            deadline_ms: publishedAt + timeoutMs,
        });
        if (!persisted.ok) {
            // Sin pendiente persistido el timeout no puede dispararse nunca: la
            // propuesta quedaría viva para siempre sin escalar. Se escala ahora
            // (el botón publicado sigue siendo válido si el operador lo toca:
            // la capability es independiente de este archivo).
            logger('[vault-cut] no se pudo persistir la propuesta pendiente: se escala a needs-human');
            return failClosed({ causa: 'estado_indeterminado', issue: issueNum });
        }

        audit({
            issue: issueNum, gate: 'operacional', clase: CUT_ACTION,
            actor: 'kernel:absence-policy', decision: 'fail-closed',
            reason: 'propuesta de corte publicada: esperando confirmacion del operador',
            timestamp: new Date(publishedAt).toISOString(),
            extra: { conserva_fallback: true, esperando_confirmacion: true },
        });

        logger(`[vault-cut] propuesta publicada para #${issueNum}: esperando confirmación del operador`);
        return {
            status: OUTCOME.PROPUESTA_PUBLICADA,
            issue: issueNum,
            deadline_ms: publishedAt + timeoutMs,
        };
    }

    return {
        runProposalTick,
        readPending,
        clearPending,
        buildProposalKeyboard,
        buildProposalMessage,
        paths: Object.freeze({ statePath, signalPath }),
        timeoutMs,
        runbook,
    };
}

module.exports = {
    createVaultCutProposal,
    buildProposalKeyboard,
    buildProposalMessage,
    normalizeProposalTimeoutMs,
    CUT_ACTION,
    CUT_BUTTON_TEXT,
    OUTCOME,
    PROPOSAL_STATE_FILE,
    ABSENCE_SIGNAL_FILE,
    DEFAULT_PROPOSAL_TIMEOUT_MS,
    MIN_PROPOSAL_TIMEOUT_MS,
    MAX_PROPOSAL_TIMEOUT_MS,
};
