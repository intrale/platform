'use strict';

// =============================================================================
// gate1-notify-dedup.js — Dedupe PERSISTENTE del aviso de GATE 1 (#6192, parte
// 3 del split de #6173).
//
// QUÉ RESUELVE (R-GATE de #6192)
// ------------------------------
// El bloque `if (opGateResult.decision === 'block')` de `pulpo.js` no tenía
// ninguna guarda de "ya notificado": el issue queda retenido, el barrido
// siguiente lo vuelve a evaluar, vuelve a bloquear y vuelve a avisar. Con
// `operator_signoff.gate_mode: enforce` eso es un aviso por issue por barrido,
// para siempre, hasta que el operador firme. El operador aprende a ignorar el
// canal, que es la peor falla posible de un gate.
//
// El dedupe es por `(issue, hash)`, NO por `issue` a secas: si cambia lo que
// hay que firmar —los criterios del body, o el motivo por el que el gate
// retiene— el aviso VUELVE a salir. Un dedupe por issue solo silenciaría para
// siempre un pedido de firma que cambió de contenido.
//
// PERSISTENTE, no en memoria: el pulpo se reinicia (watchdog, `/restart`,
// crash) y un dedupe en RAM se resetea con él, devolviendo exactamente el
// comportamiento que este módulo viene a cerrar. Estado en
// `.pipeline/gate1-notify-state.json`.
//
// EL ESTADO GUARDA SÓLO EL HASH, NUNCA EL BODY (CA de #6192)
// ----------------------------------------------------------
// La forma es `{ "<issue>": { hash: "<sha256 hex>", ts: "<ISO>" } }` y no hay
// ninguna otra clave. El body de un issue es texto de terceros que puede traer
// secretos pegados por error; un archivo de estado del pipeline no es lugar
// para conservarlo. Por eso este módulo NUNCA recibe el body: recibe el hash ya
// calculado (o las partes, vía `computeHash`, que las consume y descarta).
//
// ORDEN DE OPERACIONES: EMITIR PRIMERO, REGISTRAR DESPUÉS
// -------------------------------------------------------
// `notifyOnce()` sella el aviso SÓLO si el emisor no lanzó. Al revés (sellar y
// después emitir) un fallo de envío deja el aviso marcado como entregado y la
// alerta se pierde sin rastro hasta que cambie el hash — que es la regresión
// #5421 con otro disfraz. Si el sellado falla, el peor caso es un aviso
// repetido: exactamente el comportamiento de hoy, nunca peor.
//
// FAIL-SAFE HACIA EL OPERADOR
// ---------------------------
// Estado ausente, ilegible o corrupto => se notifica. La alerta de un gate que
// retiene trabajo vale más que el ruido de un duplicado.
// =============================================================================

const crypto = require('crypto');
const path = require('path');

const trace = require('./traceability');
const atomicJson = require('./atomic-json');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');
const DEFAULT_STATE_FILE = path.join(PIPELINE_DIR, 'gate1-notify-state.json');

// Retención de las entradas. Un issue firmado (o cerrado) deja de barrerse y su
// entrada queda huérfana: sin poda el archivo crece sin techo. 30 días es el
// mismo horizonte que usa el handoff (`handoff.retention_days`).
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Techo duro de entradas, por si el reloj vuelve para atrás y la poda por TTL
// no alcanza. Se conservan las más recientes.
const MAX_ENTRIES = 1000;

// #6207 (CA-B2 / SEC-10) — CADENCIA DEL RECORDATORIO.
//
// El dedupe original era "una vez por `(issue, hash)`, para siempre": si el
// operador no llegaba a ver el aviso —notificaciones silenciadas, chat scrolleado,
// se fue el fin de semana— el pedido de firma no volvía a aparecer NUNCA, porque
// el hash no cambia mientras nadie edite el issue. Un issue retenido en silencio
// permanente es peor que un issue que avisa de más: el trabajo queda frenado y no
// hay ninguna señal de que lo esté.
//
// Por eso la regla pasa a ser "una vez por hash **o** cada `reminderMs` mientras
// SIGA pendiente". La supresión permanente queda prohibida; lo que se acota es la
// frecuencia. 6 horas es el punto medio deliberado: espacia lo suficiente como
// para no entrenar al operador a ignorar el canal (que es la peor falla de un
// gate) y garantiza que en una jornada de trabajo el pedido reaparece.
//
// Es constante del módulo A PROPÓSITO: no se agrega ninguna clave a la sección
// `operator_signoff:` de `config.yaml`, que es alcance de otra historia.
const DEFAULT_REMINDER_MS = 6 * 60 * 60 * 1000;

const HASH_RE = /^[a-f0-9]{64}$/;

// Separador de partes: `\x1f` (unit separator). Con un separador vacío
// ['ab','c'] y ['a','bc'] darían el mismo digest.
const SEP = '\u001f'; // unit separator

/**
 * Hash de dominio de las partes que definen "de qué se está avisando".
 *
 * El prefijo de dominio evita que el digest colisione con el de otro subsistema
 * que hashee el mismo texto.
 *
 * @param {Array<*>} parts — partes del aviso (hash de criterios, motivo, caso…).
 * @returns {string} sha256 hex.
 */
function computeHash(parts) {
    const list = Array.isArray(parts) ? parts : [parts];
    const material = list.map((p) => (p == null ? '' : String(p))).join(SEP);
    return crypto.createHash('sha256')
        .update('gate1-notify|v1|', 'utf8')
        .update(material, 'utf8')
        .digest('hex');
}

/** Clave de estado válida: entero positivo (número de issue). */
function issueKey(issue) {
    const n = Number(issue);
    if (!Number.isInteger(n) || n <= 0) return null;
    return String(n);
}

/**
 * Crea una instancia del dedupe con dependencias inyectables (tests herméticos).
 *
 * @param {object} [opts]
 * @param {string}   [opts.stateFile]   ruta del JSON de estado.
 * @param {function} [opts.now]         clock inyectable (ms).
 * @param {number}   [opts.retentionMs] TTL de las entradas.
 * @param {number}   [opts.reminderMs]  #6207 — cada cuánto se re-emite el aviso
 *                                      de un pendiente que sigue sin firmar.
 * @param {object}   [opts.jsonImpl]    `{ readJsonSafe, writeJsonAtomic }`.
 */
function createGate1NotifyDedup(opts = {}) {
    const stateFile = opts.stateFile || DEFAULT_STATE_FILE;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const retentionMs = Number.isFinite(opts.retentionMs) && opts.retentionMs > 0
        ? opts.retentionMs : RETENTION_MS;
    // #6207 — un `reminderMs` no positivo o no finito cae al default. Aceptar un
    // `0` como "recordar siempre" convertiría un valor mal pasado en el aviso por
    // barrido que este módulo vino a cerrar; e `Infinity` sería la supresión
    // permanente que CA-B2 prohíbe.
    const reminderMs = Number.isFinite(opts.reminderMs) && opts.reminderMs > 0
        ? opts.reminderMs : DEFAULT_REMINDER_MS;
    const json = opts.jsonImpl || atomicJson;

    /**
     * Lee el estado normalizado. Cualquier problema (ausente, corrupto, forma
     * inesperada) degrada a `{}` => se vuelve a notificar. Nunca lanza.
     */
    function read() {
        let raw;
        try {
            raw = json.readJsonSafe(stateFile, {});
        } catch (_) {
            // `readJsonSafe` ya es fail-soft, pero un `jsonImpl` inyectado
            // podría no serlo. Un dedupe roto NO puede tumbar al pulpo.
            return {};
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const out = {};
        for (const [k, v] of Object.entries(raw)) {
            if (!issueKey(k)) continue;
            if (!v || typeof v !== 'object') continue;
            const hash = typeof v.hash === 'string' && HASH_RE.test(v.hash) ? v.hash : null;
            if (!hash) continue; // entrada sin hash usable: como si no estuviera.
            out[k] = { hash, ts: typeof v.ts === 'string' ? v.ts : '' };
        }
        return out;
    }

    /** Poda por TTL y por techo de entradas. Devuelve un objeto nuevo. */
    function prune(state) {
        const limite = now() - retentionMs;
        const vivos = Object.entries(state).filter(([, v]) => {
            const t = Date.parse(v.ts);
            // Sin `ts` parseable no se puede fechar: se conserva (fail-safe
            // hacia el silencio del aviso ya emitido) y el techo de entradas la
            // barre si el archivo creciera igual.
            return !Number.isFinite(t) || t >= limite;
        });
        if (vivos.length <= MAX_ENTRIES) return Object.fromEntries(vivos);
        vivos.sort((a, b) => (Date.parse(b[1].ts) || 0) - (Date.parse(a[1].ts) || 0));
        return Object.fromEntries(vivos.slice(0, MAX_ENTRIES));
    }

    function write(state) {
        try {
            return json.writeJsonAtomic(stateFile, state, { indent: 0 }) === true;
        } catch (_) {
            return false;
        }
    }

    /**
     * ¿Hay que avisar? `true` si nunca se avisó de este issue, si el hash cambió
     * (cambió lo que hay que firmar / por qué se retiene), o si pasó
     * `reminderMs` desde el último aviso y el issue SIGUE pendiente (#6207,
     * CA-B2). Nunca devuelve `false` para siempre: la supresión permanente está
     * prohibida.
     */
    function shouldNotify(issue, hash) {
        const k = issueKey(issue);
        // Sin número de issue no hay clave de dedupe posible: se avisa. Perder
        // el aviso sería peor que repetirlo.
        if (!k) return true;
        if (typeof hash !== 'string' || !HASH_RE.test(hash)) return true;
        const prev = read()[k];
        if (!prev) return true;
        if (prev.hash !== hash) return true;   // cambió lo que hay que firmar.
        // #6207 — recordatorio acotado. Una entrada sin fecha usable no se puede
        // fechar, y ante la duda se avisa: el fail-safe del módulo apunta al
        // duplicado, nunca al silencio.
        const t = Date.parse(prev.ts);
        if (!Number.isFinite(t)) return true;
        return (now() - t) >= reminderMs;
    }

    /**
     * Sella el aviso emitido. Devuelve `false` si no pudo persistir (el caller
     * DEBE loguearlo: significa que el próximo barrido repetirá el aviso).
     */
    function record(issue, hash) {
        const k = issueKey(issue);
        if (!k) return false;
        if (typeof hash !== 'string' || !HASH_RE.test(hash)) return false;
        const state = prune(read());
        state[k] = { hash, ts: new Date(now()).toISOString() };
        return write(state);
    }

    /**
     * Olvida el issue. Se llama cuando el gate deja de retenerlo (el operador
     * firmó): si más adelante vuelve a retenerlo por lo mismo, el aviso tiene
     * que volver a salir.
     */
    function forget(issue) {
        const k = issueKey(issue);
        if (!k) return false;
        const state = read();
        if (!(k in state)) return false; // nada que borrar: no reescribimos.
        delete state[k];
        return write(prune(state));
    }

    /**
     * Emite una sola vez por `(issue, hash)`.
     *
     * @param {object} p
     * @param {number|string} p.issue
     * @param {string} p.hash — sha256 hex de lo que se está avisando.
     * @param {function} p.emit — emisor; se invoca a lo sumo una vez.
     * @returns {{notified:boolean, reason:string, sealed?:boolean, error?:string}}
     */
    function notifyOnce({ issue, hash, emit } = {}) {
        if (typeof emit !== 'function') {
            return { notified: false, reason: 'sin-emisor' };
        }
        if (!shouldNotify(issue, hash)) {
            return { notified: false, reason: 'ya-notificado' };
        }
        try {
            emit();
        } catch (e) {
            // El aviso NO se sella: si el envío falló, el próximo barrido tiene
            // que volver a intentarlo. Nunca `catch {}` vacío — el caller
            // recibe el error y lo loguea.
            return {
                notified: false,
                reason: 'emisor-fallo',
                error: e && e.message ? e.message : String(e),
            };
        }
        const sealed = record(issue, hash);
        return { notified: true, reason: 'emitido', sealed };
    }

    return {
        computeHash,
        shouldNotify,
        record,
        forget,
        notifyOnce,
        // Expuestos para diagnóstico y tests.
        read,
        stateFile,
        reminderMs,
    };
}

// Singleton perezoso (producción).
let _default = null;
function getDefault() {
    if (!_default) _default = createGate1NotifyDedup();
    return _default;
}

module.exports = {
    createGate1NotifyDedup,
    getDefault,
    computeHash,
    DEFAULT_STATE_FILE,
    RETENTION_MS,
    MAX_ENTRIES,
    DEFAULT_REMINDER_MS,
};
