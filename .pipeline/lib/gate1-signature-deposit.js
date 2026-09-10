'use strict';

// =============================================================================
// gate1-signature-deposit.js — #6207 · Depósito del pedido de firma de GATE 1.
//
// QUÉ HACE
// --------
// Cuando el gate de firma de definición RETIENE un issue, esto deja el pedido
// depositado en el canal de aprobación (`approval-channel.requestSignature`)
// para que los medios lo presenten: Telegram (esta historia) y la bandeja del
// dashboard (#6208). El depósito es el índice de presentación; la autoridad
// sobre si el issue está firmado sigue siendo `operator-signoff-gate.evaluate()`
// leyendo su audit hash-chain.
//
// POR QUÉ NO CUELGA DEL `emit` DEL DEDUPE (D-3)
// ----------------------------------------------
// El aviso de Telegram está deduplicado: de N barridos con el issue retenido,
// se emite uno. Si el depósito colgara del `emit`, el pendiente existiría sólo
// en el barrido en que se avisa — y la bandeja del dashboard, que lee el
// depósito y no el chat, mostraría "no hay nada que firmar" mientras el issue
// está retenido. El depósito va en la rama `block`, ANTES del aviso, y se
// protege de la repetición con idempotencia propia.
//
// IDEMPOTENCIA POR ANCLA, NO POR ISSUE (H-4)
// -------------------------------------------
// La llave es `(issue, gate, anchor)`. Mismo ancla ⇒ el pedido vigente ya
// representa ESTE estado firmable: no se reescribe, no se re-audita, no se
// emite un token nuevo. Ancla distinta ⇒ cambió lo que hay que firmar, y el
// pedido tiene que renovarse. Una idempotencia por issue a secas dejaría vivo
// un pedido que ya no corresponde al body actual; una sin idempotencia
// escribiría una entrada `approval_channel_request` en el audit del canal por
// barrido, para siempre.
//
// EL TOKEN SE DESCARTA ACÁ (D-2 / CA-SEC-2)
// ------------------------------------------
// `requestSignature` devuelve una capability bearer en memoria. Este módulo NO
// la devuelve, NO la loguea y NO la persiste: el depósito es un índice legible,
// y quien lee un token, firma. En el click del operador se re-emite una fresca
// y se consume en el acto (`gate1-signature-handler`).
// =============================================================================

const fs = require('fs');

/** Resuelve las dependencias inyectables. Producción = módulos reales. */
function resolveDeps(deps = {}) {
    return {
        approval: deps.approvalImpl || require('./approval-channel'),
        fsImpl: deps.fsImpl || fs,
        // `channelDeps` viaja tal cual al kernel: es su propio seam de
        // inyección (`depositDir`, `auditFile`, `signer`, `now`…). Se pasa
        // completo para no tener que espejar acá cada opción que agregue.
        channelDeps: deps.channelDeps || {},
        log: typeof deps.log === 'function' ? deps.log : () => {},
    };
}

/**
 * Lee el pendiente depositado de `(issue, 'definicion')`, o `null`.
 *
 * Lectura DIRECTA del índice (no `listPending`): acá interesa un pendiente
 * puntual, y `listPending` parsea el depósito entero en cada barrido. Nunca
 * lanza — un índice ilegible se trata como ausente, que es el caso fail-safe:
 * se vuelve a depositar.
 *
 * **INVARIANTE (CA-A4):** la ausencia de pendiente NO implica firma. Este
 * módulo no deriva ningún veredicto de lo que lee.
 *
 * @param {number|string} issue
 * @param {object} [deps]
 * @returns {object|null} el `SignatureRequest` depositado (sin token).
 */
function readGate1Deposit(issue, deps = {}) {
    const d = resolveDeps(deps);
    try {
        const depositDir = d.channelDeps.depositDir || d.approval.DEFAULT_DEPOSIT_DIR;
        const target = d.approval.depositPathFor(depositDir, issue, 'definicion');
        if (target === null) return null;
        const parsed = JSON.parse(d.fsImpl.readFileSync(target, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch (_) {
        return null;
    }
}

/**
 * Deposita el pedido de firma de GATE 1 para `issue`. Idempotente por ancla.
 *
 * NUNCA lanza: el caller es el barrido del pulpo, y un fallo del depósito no
 * puede tumbarlo ni —mucho menos— levantar la retención. El peor caso es un
 * pendiente que no llega a la bandeja; el issue queda retenido igual.
 *
 * @param {object} p
 * @param {number|string} p.issue
 * @param {string} p.body   — body del issue (material fuente del ancla).
 * @param {string} [p.title]
 * @param {object} [deps]   — `{ approvalImpl, fsImpl, channelDeps, log }`.
 * @returns {{ok:boolean, deposited:boolean, reason?:string, anchor?:string}}
 *   `ok:true, deposited:false` = ya estaba depositado ESTE estado firmable.
 */
function depositGate1Request({ issue, body, title } = {}, deps = {}) {
    const d = resolveDeps(deps);

    try {
        // 1 · Ancla del estado ACTUAL, recalculada por el kernel server-side.
        //     Si no se puede anclar (body vacío/ausente) no hay nada firmable
        //     que depositar: se reporta y se sale sin tocar el depósito.
        const ahora = d.approval.computeAnchor('definicion', { body });
        if (!ahora.ok) return { ok: false, deposited: false, reason: ahora.reason };

        // 2 · Idempotencia por ancla. Un pendiente con el MISMO ancla ya
        //     representa este estado firmable: no se reescribe ni se re-audita.
        const previo = readGate1Deposit(issue, deps);
        if (previo && previo.anchor && previo.anchor.value === ahora.anchor.value) {
            return { ok: true, deposited: false, reason: 'ya-depositado', anchor: ahora.anchor.value };
        }

        // 3 · El kernel PIDE la firma: recalcula el ancla por su cuenta (no
        //     confía en la de arriba), corre `sanitizeForPresentation` y, en
        //     `enforce`, RETIENE sin depositar si el texto es hostil (REQ-SEC-5).
        const res = d.approval.requestSignature(
            { gate: 'definicion', issue, body, titleText: title },
            d.channelDeps,
        );

        // 4 · El token que vino en `res.request` se descarta acá: no se
        //     devuelve, no se loguea, no se persiste (CA-SEC-2). La única
        //     capability que ve el operador es el botón, y su token se emite
        //     fresco en el click.
        if (!res.ok) {
            if (res.retained && res.alert) d.log(res.alert);
            return { ok: false, deposited: false, reason: res.reason, retained: !!res.retained };
        }
        return { ok: true, deposited: true, anchor: ahora.anchor.value };
    } catch (e) {
        // El detalle crudo NO sube al caller: puede arrastrar paths o material
        // del body. Se loguea acotado y se reporta el fallo.
        d.log(`#${issue} GATE 1: no pude depositar el pedido de firma (${e && e.message ? e.message : 'error'})`);
        return { ok: false, deposited: false, reason: 'deposit-failed' };
    }
}

module.exports = {
    depositGate1Request,
    readGate1Deposit,
};
