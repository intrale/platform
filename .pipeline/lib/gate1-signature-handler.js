'use strict';

// =============================================================================
// gate1-signature-handler.js — #6207 · Camino de ESCRITURA de la firma de GATE 1.
//
// QUÉ RESUELVE
// ------------
// El operador toca ✅ Aprobar en el aviso de GATE 1 y hasta ahora el click caía
// en `operator-gate.handleSignature()`, que ejecuta `applyTransition()` — el
// ejecutor de GATE 0/2, que mueve work-files de `waiting-operator/`. GATE 1 no
// tiene work-file: su efecto es una FIRMA en el audit hash-chain de
// `operator-signoff-gate`, y la escribe el kernel `approval-channel`. Dos gates
// que comparten el vocabulario de acciones (`GATE_ACTIONS`) y no comparten
// ejecutor: eso es un confused deputy, y este módulo es el lado correcto.
//
// INVARIANTES (no negociables)
// ----------------------------
// - NUNCA invoca `applyTransition()` (CA-SEC-1). Ni por fallback, ni por error.
// - NUNCA invoca `recordDefinitionSignature()` directo (CA-SEC-4): la única
//   escritura de la firma es `approval-channel.submitSignature()`. Saltearse el
//   kernel sería que el adaptador escriba en el audit chain del gate por su
//   cuenta, que es lo contrario del invariante "el adaptador pide, el kernel
//   ejecuta".
// - NUNCA persiste el token del canal (CA-SEC-2). Se emite en memoria en el
//   click y se consume en el acto.
// - NUNCA loguea el `callback_data` completo, el token ni el body (CA-SEC-8).
//
// ORDEN DE CONSUMO DE LOS DOS NONCES (CA-SEC-5)
// ----------------------------------------------
// Asimétrico A PROPÓSITO. El binding (nonce del botón) se resuelve SIN
// consumir; la autorización se valida ANTES de quemar nada; el token del canal
// se emite recién cuando ya se sabe que la firma va a intentarse de verdad. Así
// un `from.id` no autorizado no puede quemar la capability del operador legítimo
// con un toque, y un fallo del kernel deja el binding vivo para reintentar.
//
// Si `submitSignature` sale bien y la revocación posterior falla, el nonce del
// token ya está gastado y el reintento falla igual: fail-safe, sin doble firma.
//
// FAIL-CLOSED EN LA LECTURA DEL BODY
// -----------------------------------
// No poder leer el issue NO es "firmá igual": es `unavailable`, sin consumir el
// binding. El operador reintenta cuando GitHub responde.
//
// LAS DEPENDENCIAS ENTRAN POR PARÁMETRO
// --------------------------------------
// Mismo criterio que `gate1-signature-keyboard.js` (#6192): el test ejercita LA
// MISMA función que corre en producción y sólo cambia de dónde salen el gate, el
// kernel y el lector del issue. Un test que replica la secuencia no prueba el
// camino real — ese fue exactamente el defecto que dejó el teclado devolviendo
// `null` en todos los barridos con la suite en verde.
// =============================================================================

const { execSync } = require('child_process');
const path = require('path');

const trace = require('./traceability');

/** Acción del botón → verdict del gate `definicion` (enum del kernel). */
const VERDICT_POR_ACCION = Object.freeze({
    approve: 'signed',
    reject: 'rejected',
    'adjust-definicion': 're-definition',
});

/** Timeout de la lectura del issue. El click corre en el loop del listener. */
const READ_ISSUE_TIMEOUT_MS = 8000;

/**
 * Copy terminal del toast. Nunca incluye token, `callback_data`, body ni paths:
 * el toast se muestra en Telegram y queda en el chat.
 */
function toastDeRechazo(reason) {
    switch (reason) {
        case 'unknown-id': return 'Acción inválida o expirada';
        case 'unauthorized': return '🔒 No autorizado para firmar este issue';
        case 'unavailable': return '⚠️ No pude leer el issue ahora; probá de nuevo en un minuto';
        case 'stale': return '♻️ El issue cambió desde que pedí la firma; te vuelvo a avisar con el texto nuevo';
        case 'rejected-by-kernel': return '⚠️ El gate no aceptó la firma; el botón sigue válido para reintentar';
        default: return 'Acción inválida';
    }
}

/** Copy del toast de éxito, por verdict. */
function toastDeExito(verdict, issue) {
    if (verdict === 'signed') return `✅ Firmado — #${issue} avanza a desarrollo`;
    if (verdict === 'rejected') return `❌ Rechazado — #${issue} queda en definición`;
    return `✏️ #${issue} vuelve a definición para ajuste`;
}

/** Texto del comentario que se encola en el issue cuando NO se aprueba (D-5). */
function comentarioDeVeredicto(verdict) {
    if (verdict === 'rejected') {
        return 'GATE 1 · El operador **rechazó** la definición desde Telegram. '
            + 'El issue queda retenido en `definicion` y no se promueve a `desarrollo`. '
            + 'La firma quedó registrada en el audit chain del gate.';
    }
    return 'GATE 1 · El operador marcó **re-definición** desde Telegram. '
        + 'Hay que ajustar los criterios de aceptación antes de volver a pedir la firma. '
        + 'El issue queda retenido en `definicion`. La firma quedó registrada en el audit chain del gate.';
}

/**
 * Lector por default del body del issue: `gh issue view --json body`.
 *
 * Síncrono y acotado (`timeout` + `windowsHide`, mismo criterio que
 * `pulpo.js`). Corre SÓLO en el click humano, nunca en el poll. Devuelve `null`
 * ante cualquier fallo — el handler lo trata como `unavailable` (fail-closed).
 */
function defaultReadIssueBody(issue) {
    try {
        const ghBin = process.env.GH_BIN || 'gh';
        const raw = execSync(`${ghBin} issue view ${Number(issue)} --json body`, {
            cwd: trace.REPO_ROOT,
            encoding: 'utf8',
            timeout: READ_ISSUE_TIMEOUT_MS,
            windowsHide: true,
        });
        const parsed = JSON.parse(raw);
        return typeof parsed.body === 'string' ? parsed.body : null;
    } catch (_) {
        return null;
    }
}

/**
 * Encolador por default del comentario: dropfile en la cola del servicio-github,
 * el mismo camino que usa el pulpo (`encolarOrdenGithub`). Best-effort: la firma
 * ya está persistida en el audit chain, y perder el comentario no la invalida.
 */
function defaultEnqueueGithub(payload, deps = {}) {
    const fsImpl = deps.fsImpl || require('fs');
    const dir = deps.githubQueueDir
        || path.join(trace.REPO_ROOT, '.pipeline', 'servicios', 'github', 'pendiente');
    const dropfileWriter = require('./dropfile-writer');
    fsImpl.mkdirSync(dir, { recursive: true });
    dropfileWriter.writeUniqueFileSync({
        dir,
        filename: `${Number(payload.issue)}-gate1-verdict-${Date.now()}.json`,
        data: JSON.stringify(payload),
    });
}

/**
 * Crea el handler de firma de GATE 1.
 *
 * @param {object} [deps]
 * @param {function} [deps.gateFactory]   → instancia de `operator-gate`.
 * @param {object}   [deps.approvalImpl]  → kernel `approval-channel`.
 * @param {function} [deps.readIssueBody] `(issue) => string|null`.
 * @param {function} [deps.enqueueGithub] `(payload) => void`.
 * @param {object}   [deps.depositImpl]   → `gate1-signature-deposit`.
 * @param {object}   [deps.channelDeps]   → seam de inyección del kernel.
 * @param {function} [deps.log]           `(mensaje) => void`.
 * @returns {{handleGate1Signature: function}}
 */
function createGate1SignatureHandler(deps = {}) {
    const gateFactory = typeof deps.gateFactory === 'function'
        ? deps.gateFactory
        : () => require('./operator-gate').getDefault();
    const approval = deps.approvalImpl || require('./approval-channel');
    const deposit = deps.depositImpl || require('./gate1-signature-deposit');
    const readIssueBody = typeof deps.readIssueBody === 'function'
        ? deps.readIssueBody
        : defaultReadIssueBody;
    const enqueueGithub = typeof deps.enqueueGithub === 'function'
        ? deps.enqueueGithub
        : (payload) => defaultEnqueueGithub(payload, deps);
    const channelDeps = deps.channelDeps || {};
    const log = typeof deps.log === 'function' ? deps.log : () => {};

    /** Salida uniforme de rechazo. NUNCA `editMessage`: el botón sigue vivo. */
    function rechazo(reason, extra = {}) {
        return { ok: false, toast: toastDeRechazo(reason), editMessage: false, reason, ...extra };
    }

    /**
     * Procesa el click de un botón de firma de GATE 1.
     *
     * @param {{operatorId: string|number, callbackData: string}} p
     * @returns {{ok, toast, editMessage, reason?, issue?, verdict?, action?}}
     *   SIEMPRE devuelve `toast` para que el listener corte el spinner en todos
     *   los caminos (CA-9).
     */
    function handleGate1Signature({ operatorId, callbackData } = {}) {
        let gate;
        try {
            gate = gateFactory();
        } catch (e) {
            log(`GATE 1 firma: el canal de firma no está disponible (${e && e.code ? e.code : 'unknown'})`);
            return rechazo('unavailable');
        }
        if (!gate || typeof gate.resolve !== 'function') return rechazo('unavailable');

        // 1 · Binding server-side, SIN consumir. El `callback_data` es
        //     client-controlled: lo único que se hace con él es un lookup.
        const entry = gate.resolve(callbackData);
        if (!entry) return rechazo('unknown-id');

        // Guarda de pertenencia: este handler firma GATE 1 y NADA más. Un
        // binding de lifecycle (sin `channel_gate`) o de otro gate del canal se
        // rechaza sin consumir — su camino es otro.
        if (entry.channel_gate !== 'definicion') return rechazo('unknown-id');

        const verdict = VERDICT_POR_ACCION[entry.action];
        if (!verdict) return rechazo('unknown-id');
        const issue = Number(entry.issue);
        if (!Number.isInteger(issue) || issue <= 0) return rechazo('unknown-id');

        // 2 · Autorización re-resolviendo la allowlist AHORA (A01), sin
        //     consumir nada. Fail-closed: sin allowlist configurada, ninguna
        //     firma es válida (CA-B4). Un no-operador NO puede quemar la
        //     capability del operador legítimo (CA-SEC-5.a).
        const autorizado = typeof gate.isAuthorizedOperatorNow === 'function'
            ? gate.isAuthorizedOperatorNow(operatorId, entry.tenant)
            : false;
        if (!autorizado) {
            log(`#${issue} GATE 1 firma: intento no autorizado (from.id no está en la allowlist)`);
            return rechazo('unauthorized', { issue });
        }

        // 3 · Body ACTUAL del issue + ancla del depósito.
        //     `presented.digest` NO alcanza (D-2.b): es el digest del texto
        //     TRUNCADO a `PRESENTATION_MAX_CHARS`, así que una edición posterior
        //     a ese corte lo dejaría intacto y el operador firmaría contenido
        //     que no vio. `anchor.value` es el sha256 del body COMPLETO y cubre
        //     los dos casos con una sola comparación.
        let body;
        try {
            body = readIssueBody(issue);
        } catch (_) {
            body = null;
        }
        if (typeof body !== 'string' || body.trim() === '') {
            log(`#${issue} GATE 1 firma: no pude leer el issue — no firmo (binding intacto)`);
            return rechazo('unavailable', { issue });
        }

        const pendiente = deposit.readGate1Deposit(issue, { approvalImpl: approval, channelDeps });
        const ahora = approval.computeAnchor('definicion', { body });
        if (!pendiente || !pendiente.anchor || !ahora.ok
            || pendiente.anchor.value !== ahora.anchor.value) {
            log(`#${issue} GATE 1 firma: lo que se firmaría cambió respecto del pedido — no firmo`);
            return rechazo('stale', { issue });
        }

        // 4 · Token del canal EN MEMORIA (D-2). Se emite acá y se consume en el
        //     paso siguiente; no toca el disco en ningún momento. El pedido se
        //     re-emite con el MISMO body que se acaba de anclar, así que el
        //     depósito no cambia de contenido.
        const req = approval.requestSignature({ gate: 'definicion', issue, body }, channelDeps);
        if (!req.ok || !req.request || typeof req.request.token !== 'string') {
            log(`#${issue} GATE 1 firma: el canal no emitió el pedido — no firmo`);
            return rechazo('unavailable', { issue });
        }

        // 5 · ÚNICO camino de escritura de la firma. El kernel revalida gate,
        //     issue, ancla, verdict, autoridad del firmante y rate-limit; acá no
        //     se duplica ninguna de esas decisiones.
        let out;
        try {
            out = approval.submitSignature({
                gate: 'definicion',
                issue,
                token: req.request.token,
                verdict,
                signedBy: String(operatorId),
                body,
                origen: 'telegram',
                actor: String(operatorId),
            }, channelDeps);
        } catch (e) {
            log(`#${issue} GATE 1 firma: el kernel lanzó al registrar la firma — binding intacto`);
            return rechazo('rejected-by-kernel', { issue });
        }
        if (!out || out.ok !== true) {
            // El binding SIGUE VIVO: el operador reintenta (CA-SEC-5.b).
            log(`#${issue} GATE 1 firma: el kernel rechazó la firma (${(out && out.reason) || 'sin motivo'})`);
            return rechazo('rejected-by-kernel', { issue });
        }

        // 6 · Recién ahora se queman los TRES bindings del episodio: la firma
        //     ya está persistida, y los otros dos botones del mismo mensaje no
        //     pueden emitir un segundo veredicto sobre lo mismo.
        try {
            gate.revokeFor({ issue, channelGate: 'definicion' });
        } catch (e) {
            // Fail-safe: el nonce del token ya se gastó, así que un reintento
            // sobre un binding sobreviviente falla igual en el paso 5.
            log(`#${issue} GATE 1 firma: firma registrada, pero no pude revocar los botones`);
        }

        // 7 · Efecto sobre el issue.
        //     `signed`  → el barrido siguiente deja de retener y el issue se
        //                 promueve a `desarrollo`; no hay nada que encolar acá.
        //     `rejected` / `re-definition` → el gate sigue bloqueando con su
        //                 `route` diferenciado y se deja constancia en el issue.
        //     NO se re-encolan work-files a `criterios`: el issue nunca salió de
        //     `definicion` (D-5).
        if (verdict !== 'signed') {
            try {
                enqueueGithub({ action: 'comment', issue, body: comentarioDeVeredicto(verdict) });
            } catch (e) {
                log(`#${issue} GATE 1 firma: firma registrada, pero no pude encolar el comentario del veredicto`);
            }
        }

        log(`#${issue} GATE 1 firma registrada desde Telegram (verdict=${verdict})`);
        return {
            ok: true,
            toast: toastDeExito(verdict, issue),
            editMessage: true,
            issue,
            verdict,
            action: entry.action,
        };
    }

    return { handleGate1Signature };
}

// Singleton perezoso (producción).
let _default = null;
function getDefault() {
    if (!_default) _default = createGate1SignatureHandler();
    return _default;
}

module.exports = {
    createGate1SignatureHandler,
    getDefault,
    VERDICT_POR_ACCION,
    READ_ISSUE_TIMEOUT_MS,
};
