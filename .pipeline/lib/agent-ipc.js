// =============================================================================
// agent-ipc.js — Canal de mensajes operador→agente (issue #3605)
//
// Mantiene un registro en memoria de los procesos agente activos con stdin
// pipe abierto y los expone vía API neutral pensada para múltiples canales
// (dashboard, telegram commander, hooks — preparación para #3611).
//
// El canal underlying es `child.stdin.write()`, envolviendo el mensaje del
// operador en delimitadores XML-like (`<operator-message>...</operator-message>`)
// para que el LLM lo trate como sugerencia narrativa, NO como instrucción
// autoritativa del sistema (CA-B8/B9, defensa anti prompt-injection).
//
// **API pública neutral** (diseño abierto para #3611):
//
//   registerAgent(issueId, skill, fase, childStdin, opts?) → void
//     Registra el stdin del proceso del agente. opts.pid se usa para
//     verificación posterior con `pidAlive()`. Idempotente si se llama
//     dos veces con la misma key (last-write-wins).
//
//   sendMessage(issueId, skill, fase, message, opts?) → Promise<{
//     status: 'queued' | 'sent',
//     queued_at: ISO8601,
//     message_id: UUID v4
//   }>
//     Encola el mensaje en la cola FIFO del agente. Resuelve cuando se
//     escribió al stdin (`drain` event). Rechaza con error tipado si:
//       - 'NO_AGENT': no hay agente registrado para esa key.
//       - 'AGENT_DEAD': el PID ya no vive en el OS.
//       - 'QUEUE_FULL': la cola alcanzó el cap (default 100).
//       - 'PIPE_BROKEN': EPIPE/ERR_STREAM_DESTROYED al escribir (caller
//         debe responder 410 al cliente y unregister implícito).
//
//   isAgentAlive(issueId, skill, fase) → boolean
//     Verifica que (a) hay registro en memoria, (b) `child.stdin` no está
//     destroyed, (c) el PID asociado vive (via `pid-discovery.pidAlive`).
//
//   unregisterAgent(issueId, skill, fase) → void
//     Limpia el registro. Llamar desde `child.on('exit')`. Idempotente.
//
//   listActiveAgents() → Array<{issueId, skill, fase, pid, queueLength}>
//     Para debug/diagnostics.
//
// **Invariantes**:
//   I1: una sola cola FIFO por agente; los writes NO se entrelazan aunque
//       el operador mande mensajes en ráfaga. El bombeo de la cola está
//       serializado: hasta que termina el write actual, el siguiente espera.
//   I2: cap de 100 mensajes pendientes en la cola; saturación → QUEUE_FULL.
//   I3: el framing XML se construye server-side; el caller NO puede pasar
//       delimitadores a través de `message` (se sanitizan en el caller del
//       endpoint con `slice(0,2000)+strip ctrl chars`, doble defensa).
//   I4: cero deps npm; usa core node (crypto.randomUUID, util).
//   I5: el módulo NUNCA crashea el dashboard si `child.stdin` muere. Captura
//       EPIPE/ERR_STREAM_DESTROYED y devuelve error tipado al caller.
// =============================================================================

'use strict';

const { randomUUID } = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { pidAlive } = require('./pid-discovery');

// Cap default por agente. Saturación → 429 con reason "agente saturado".
// Configurable en runtime via constructor opts (no hace falta para el caller
// estándar, pero los tests lo override-an para verificar el cap).
const DEFAULT_QUEUE_CAP = 100;

// Cap de tamaño del mensaje individual antes del framing (defensa adicional;
// el endpoint ya hace slice(0, 2000) — esto es safety net contra callers
// directos del módulo).
const MAX_MESSAGE_BYTES = 8 * 1024; // 8KB tras framing

// Ventana de gracia para heartbeat. El hook `activity-logger.js` escribe el
// heartbeat cada 60s (HEARTBEAT_INTERVAL_MS); dejamos 2× como margen para
// agentes con throughput bajo y mitigamos el TOCTOU borderline señalado por
// security en el análisis previo (issue #3721).
const HEARTBEAT_GRACE_MS = 120 * 1000;

// Enums para validación CA-SEC-1 (path-traversal hardening).
const VALID_FASES = [
    'analisis', 'criterios', 'validacion',
    'dev', 'build', 'verificacion', 'aprobacion',
    'entrega', 'linteo',
];
const VALID_PIPELINES = ['desarrollo', 'definicion'];

// Regex de validación de input — explicit y conservadoras.
const RE_ISSUE = /^\d+$/;
const RE_SKILL = /^[a-z0-9-]{1,32}$/;

// Substrings prohibidos en el cuerpo del mensaje (CA-SEC-2): rechazar
// intentos de delimiter injection. Comparación case-insensitive vía
// `String.prototype.toLowerCase()` antes de `.includes()`.
const FORBIDDEN_DELIMITERS = ['<operator-message>', '</operator-message>'];

/**
 * Construye una key compuesta para identificar un agente activo.
 * @private
 */
function _agentKey(issueId, skill, fase) {
    return `${String(issueId)}::${String(skill)}::${String(fase || '')}`;
}

/**
 * Envuelve el mensaje del operador en delimitadores XML-like para defensa
 * anti prompt-injection (CA-B8). El system prompt del skill instruye al
 * LLM a tratar el contenido como narrativa/sugerencia, NO como override.
 *
 * @private
 */
function _frameMessage(messageId, issueId, message) {
    const timestamp = new Date().toISOString();
    // Doble defensa: el endpoint sanitiza ctrl chars + cap a 2000 antes de
    // llegar acá. Por si un caller directo se saltea esa capa, también
    // capamos acá.
    const safe = String(message || '')
        .slice(0, MAX_MESSAGE_BYTES)
        // strip control chars excepto \n y \t (multiline legítimo)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    // CA-SEC-2 (issue #3721): rechazar mensajes que contengan los
    // delimitadores `<operator-message>` o `</operator-message>` (case
    // insensitive). La decisión es **rechazar** (no escapar): el
    // delimitador en el body del operador es señal clara de intento de
    // delimiter-injection / role hijack. Devolvemos `null` y el caller
    // (`sendMessage`) lo propaga como `code='OPERATOR_DELIMITER_INJECTION'`.
    const lower = safe.toLowerCase();
    for (const tok of FORBIDDEN_DELIMITERS) {
        if (lower.includes(tok)) return null;
    }
    return [
        `<operator-message timestamp="${timestamp}" issue="${String(issueId)}" message-id="${messageId}">`,
        safe,
        '</operator-message>',
        '', // newline final → trigger del agente CLI para procesar el chunk
    ].join('\n');
}

/**
 * Singleton de registro de agentes activos.
 * Key: `${issueId}::${skill}::${fase}` → entrada con stdin, pid, cola FIFO.
 */
class AgentIpcRegistry {
    constructor(opts) {
        const cfg = opts || {};
        this._agents = new Map();
        this._queueCap = Number.isInteger(cfg.queueCap) && cfg.queueCap > 0
            ? cfg.queueCap
            : DEFAULT_QUEUE_CAP;
        // Inyectables para tests.
        this._pidAlive = (typeof cfg.pidAliveImpl === 'function') ? cfg.pidAliveImpl : pidAlive;
        this._fsImpl = cfg.fsImpl || nodeFs;
        this._nowImpl = (typeof cfg.nowImpl === 'function') ? cfg.nowImpl : Date.now;
        // RepoRoot por default: dos niveles arriba de este archivo
        // (`.pipeline/lib/agent-ipc.js` → root del repo).
        this._repoRoot = cfg.repoRootImpl
            ? cfg.repoRootImpl
            : nodePath.resolve(__dirname, '..', '..');
    }

    /**
     * Registra el stdin de un agente. Idempotente (last-write-wins).
     * Llamar desde pulpo.js justo después de `child = launchAgent(...)`.
     *
     * @param {string|number} issueId
     * @param {string} skill
     * @param {string} fase
     * @param {NodeJS.WritableStream} childStdin
     * @param {object} [opts]
     * @param {number} [opts.pid] PID del proceso; si se omite, `isAgentAlive`
     *   solo chequea el stream (menos preciso).
     */
    registerAgent(issueId, skill, fase, childStdin, opts) {
        if (!childStdin || typeof childStdin.write !== 'function') {
            throw new Error('[agent-ipc] registerAgent requiere childStdin con .write()');
        }
        const key = _agentKey(issueId, skill, fase);
        const entry = {
            key,
            issueId: String(issueId),
            skill: String(skill),
            fase: String(fase || ''),
            stdin: childStdin,
            pid: (opts && Number.isInteger(opts.pid)) ? opts.pid : null,
            queue: [],          // FIFO de { messageId, framed, resolve, reject }
            draining: false,    // flag de "ya hay un write en curso"
            registeredAt: new Date().toISOString(),
        };
        this._agents.set(key, entry);

        // Si el stream se rompe (agente murió), drenamos la cola con
        // PIPE_BROKEN para no dejar promesas colgadas. Importante:
        // capturar 'error' EVITA crash del dashboard ante EPIPE
        // ('Unhandled stream error' en Windows).
        const onError = (err) => {
            this._failQueue(entry, 'PIPE_BROKEN', err && err.message);
            // No desregistramos acá; el `child.on('exit')` del pulpo lo hace.
        };
        const onClose = () => {
            this._failQueue(entry, 'PIPE_BROKEN', 'stdin closed');
        };
        try {
            childStdin.once('error', onError);
            childStdin.once('close', onClose);
        } catch (_) { /* algunos streams (fakes en tests) no emiten — best effort */ }
    }

    /**
     * Envía un mensaje al agente. Ver descripción en cabecera.
     *
     * @param {string|number} issueId
     * @param {string} skill
     * @param {string} fase
     * @param {string} message
     * @param {object} [opts]
     * @returns {Promise<{status, queued_at, message_id}>}
     */
    sendMessage(issueId, skill, fase, message, opts) {
        const key = _agentKey(issueId, skill, fase);
        const entry = this._agents.get(key);
        if (!entry) {
            return Promise.reject(this._err('NO_AGENT', `Sin agente registrado para ${key}`));
        }
        // Verificación de proceso vivo. EPERM lo tratamos como vivo (semántica
        // de pid-discovery).
        if (entry.pid != null && !this._pidAlive(entry.pid)) {
            return Promise.reject(this._err('AGENT_DEAD', `PID ${entry.pid} no vive`));
        }
        if (entry.stdin.destroyed || entry.stdin.writableEnded) {
            return Promise.reject(this._err('AGENT_DEAD', 'stdin destroyed/ended'));
        }
        if (entry.queue.length >= this._queueCap) {
            return Promise.reject(this._err('QUEUE_FULL', `cola saturada (${this._queueCap})`));
        }

        const messageId = (opts && opts.messageId) || randomUUID();
        const framed = _frameMessage(messageId, entry.issueId, message);
        // CA-SEC-2 (issue #3721): si _frameMessage devolvió null, el body
        // del mensaje contenía un delimitador `<operator-message>` o
        // `</operator-message>` — intento de delimiter-injection. Rechazar
        // con code tipado para que el handler lo mapee a HTTP 400.
        if (framed === null) {
            return Promise.reject(this._err(
                'OPERATOR_DELIMITER_INJECTION',
                'mensaje contiene delimitadores reservados',
            ));
        }
        const queuedAt = new Date().toISOString();

        return new Promise((resolve, reject) => {
            entry.queue.push({
                messageId,
                framed,
                queuedAt,
                resolve,
                reject,
            });
            // Disparamos el bombeo si nadie lo está procesando ahora mismo.
            this._pump(entry);
        });
    }

    /**
     * Cascada de detección de vida + comunicabilidad del agente (issue #3721).
     *
     * Devuelve `{ alive, communicable, reason }` donde:
     *   - `alive`: true si el agente está vivo según cualquiera de las fuentes
     *     (registro in-memory canónico, heartbeat reciente en FS, carrier en FS).
     *   - `communicable`: true SOLO si hay registro en memoria con stdin sano y
     *     PID vivo. Es la única vía para mandar mensajes (canal IPC abierto).
     *   - `reason`: string técnico que viaja al cliente para el tri-state
     *     visual del Log Viewer (#3715). Valores posibles:
     *       'registered' — caso canónico: hay registro IPC + stdin + PID vivos.
     *       'agent_alive_pulpo_restarted_or_no_interactive' — heartbeat reciente
     *         + carrier en `<pipeline>/<fase>/trabajando/` pero sin registro IPC.
     *       'orphan_heartbeat' — heartbeat reciente sin carrier.
     *       'heartbeat_expired' — heartbeat ausente o mtime > HEARTBEAT_GRACE_MS.
     *       'invalid_params' — args fallaron validación CA-SEC-1 (NO toca FS).
     *
     * @param {string|number} issueId
     * @param {string} skill
     * @param {string} fase
     * @param {object} [opts]
     * @param {string} [opts.pipeline='desarrollo']
     * @returns {{ alive: boolean, communicable: boolean, reason: string }}
     */
    getAgentAliveDetails(issueId, skill, fase, opts) {
        const pipeline = (opts && opts.pipeline) || 'desarrollo';

        // CA-SEC-1 (issue #3721): validación estricta ANTES de tocar FS para
        // evitar path traversal. `fs.existsSync`/`fs.statSync` confirman
        // existencia de archivos arbitrarios → info disclosure. Hard regex +
        // enums.
        const issueStr = String(issueId == null ? '' : issueId);
        const skillStr = String(skill == null ? '' : skill);
        const faseStr = String(fase == null ? '' : fase);
        if (!RE_ISSUE.test(issueStr)) {
            return { alive: false, communicable: false, reason: 'invalid_params' };
        }
        if (!RE_SKILL.test(skillStr)) {
            return { alive: false, communicable: false, reason: 'invalid_params' };
        }
        if (!VALID_FASES.includes(faseStr)) {
            return { alive: false, communicable: false, reason: 'invalid_params' };
        }
        if (!VALID_PIPELINES.includes(pipeline)) {
            return { alive: false, communicable: false, reason: 'invalid_params' };
        }

        // Cascada 1: registry in-memory (canónico cuando interactive_supported=true).
        const entry = this._agents.get(_agentKey(issueStr, skillStr, faseStr));
        if (entry
            && !entry.stdin.destroyed
            && !entry.stdin.writableEnded) {
            if (entry.pid == null || this._pidAlive(entry.pid)) {
                return { alive: true, communicable: true, reason: 'registered' };
            }
        }

        // Cascada 2-4: filesystem (heartbeat + carrier). Lectura defensiva,
        // cualquier error de FS se trata como "no fresh".
        const fs = this._fsImpl;
        const now = this._nowImpl();
        const hbFile = nodePath.join(
            this._repoRoot, '.claude', 'hooks',
            `agent-${issueStr}.heartbeat`,
        );
        const carrierFile = nodePath.join(
            this._repoRoot, '.pipeline',
            pipeline, faseStr, 'trabajando',
            `${issueStr}.${skillStr}`,
        );
        let hbFresh = false;
        try {
            if (fs.existsSync(hbFile)) {
                const stat = fs.statSync(hbFile);
                hbFresh = (now - stat.mtimeMs) < HEARTBEAT_GRACE_MS;
            }
        } catch (_) { /* FS error → no fresh */ }

        if (!hbFresh) {
            return { alive: false, communicable: false, reason: 'heartbeat_expired' };
        }
        let hasCarrier = false;
        try {
            hasCarrier = fs.existsSync(carrierFile);
        } catch (_) { hasCarrier = false; }
        if (hasCarrier) {
            return {
                alive: true,
                communicable: false,
                reason: 'agent_alive_pulpo_restarted_or_no_interactive',
            };
        }
        return { alive: true, communicable: false, reason: 'orphan_heartbeat' };
    }

    /**
     * Verifica que el agente está vivo. Wrapper backward-compat sobre
     * `getAgentAliveDetails`: el caller existente recibe boolean truthy
     * sin cambios.
     *
     * NOTA: el chequeo de comunicabilidad (mandar mensaje vs solo "vivo")
     * lo discrimina ahora `agent-chat-handler.js` con `getAgentAliveDetails`,
     * que devuelve `communicable: true` SOLO si el registry in-memory tiene
     * el agente con stdin sano. Tests legacy (`isAgentAlive('1','guru','dev')`)
     * siguen funcionando porque cuando hay registro + stdin + PID vivo, el
     * `reason` es `'registered'` y `alive=true`.
     */
    isAgentAlive(issueId, skill, fase, opts) {
        return !!this.getAgentAliveDetails(issueId, skill, fase, opts).alive;
    }

    /**
     * Quita el agente del registro. Idempotente.
     */
    unregisterAgent(issueId, skill, fase) {
        const key = _agentKey(issueId, skill, fase);
        const entry = this._agents.get(key);
        if (!entry) return;
        this._failQueue(entry, 'AGENT_DEAD', 'unregister');
        this._agents.delete(key);
    }

    /**
     * Lista de agentes activos con tamaño de cola para diagnostics.
     */
    listActiveAgents() {
        const out = [];
        for (const entry of this._agents.values()) {
            out.push({
                issueId: entry.issueId,
                skill: entry.skill,
                fase: entry.fase,
                pid: entry.pid,
                queueLength: entry.queue.length,
                registeredAt: entry.registeredAt,
            });
        }
        return out;
    }

    // -------------------------------------------------------------------------
    // Internos
    // -------------------------------------------------------------------------

    /**
     * Bomba serializada: si hay un write en curso, no arranca otro hasta que
     * el actual termine. Garantiza ordering FIFO al stdin (invariante I1).
     */
    _pump(entry) {
        if (entry.draining) return;
        if (entry.queue.length === 0) return;
        entry.draining = true;

        const next = entry.queue[0];
        let ok = false;
        try {
            // child.stdin.write devuelve false si el buffer interno excedió
            // highWaterMark. En ese caso esperamos 'drain' antes del siguiente.
            ok = entry.stdin.write(next.framed, 'utf8', (err) => {
                if (err) {
                    // EPIPE / ERR_STREAM_DESTROYED en Windows típicamente.
                    // Sacamos este mensaje de la cabeza, lo rechazamos y
                    // drenamos el resto con PIPE_BROKEN (invariante I5).
                    entry.queue.shift();
                    try { next.reject(this._err('PIPE_BROKEN', err.message)); } catch {}
                    this._failQueue(entry, 'PIPE_BROKEN', err.message);
                    entry.draining = false;
                    return;
                }
                // Write exitoso: confirmamos al caller y avanzamos.
                entry.queue.shift();
                try {
                    next.resolve({
                        status: 'sent',
                        queued_at: next.queuedAt,
                        message_id: next.messageId,
                    });
                } catch {}
                entry.draining = false;
                // Continuamos con el siguiente si hay.
                this._pump(entry);
            });
        } catch (err) {
            // Write síncrono fallido (stream destroyed before write event).
            entry.queue.shift();
            try { next.reject(this._err('PIPE_BROKEN', err.message)); } catch {}
            this._failQueue(entry, 'PIPE_BROKEN', err.message);
            entry.draining = false;
            return;
        }

        // Si el write devolvió false, esperamos 'drain' antes de continuar.
        // El callback de write() ya nos avisa, pero esta variante extra es
        // defensiva para streams que no respetan el callback contract.
        if (!ok && !entry.draining) {
            try {
                entry.stdin.once('drain', () => {
                    if (!entry.draining) this._pump(entry);
                });
            } catch {}
        }
    }

    /**
     * Rechaza todos los items pendientes de la cola con un código tipado.
     */
    _failQueue(entry, code, msg) {
        const pending = entry.queue.splice(0);
        const err = this._err(code, msg);
        for (const item of pending) {
            try { item.reject(err); } catch {}
        }
        entry.draining = false;
    }

    /**
     * Construye un Error tipado consumible por el caller. El campo `code`
     * es lo que el endpoint mapea a status HTTP (NO_AGENT→404, AGENT_DEAD→410,
     * QUEUE_FULL→429, PIPE_BROKEN→410).
     */
    _err(code, msg) {
        const e = new Error(`[agent-ipc][${code}] ${msg || ''}`.trim());
        e.code = code;
        return e;
    }
}

// Singleton global del proceso. Pulpo invoca `registerAgent` al lanzar,
// dashboard consume `sendMessage`/`isAgentAlive` desde el endpoint.
let _singleton = null;

/**
 * Devuelve el singleton del registro. Para tests, usá `new AgentIpcRegistry()`
 * directo o `__resetSingletonForTesting()` antes/después.
 */
function getRegistry() {
    if (!_singleton) _singleton = new AgentIpcRegistry();
    return _singleton;
}

/** Para tests. */
function __resetSingletonForTesting(opts) {
    _singleton = new AgentIpcRegistry(opts || {});
    return _singleton;
}

module.exports = {
    AgentIpcRegistry,
    getRegistry,
    __resetSingletonForTesting,
    // Helpers expuestos para tests
    _agentKey,
    _frameMessage,
    DEFAULT_QUEUE_CAP,
    HEARTBEAT_GRACE_MS,
    VALID_FASES,
    VALID_PIPELINES,
};
