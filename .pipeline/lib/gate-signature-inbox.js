'use strict';

// =============================================================================
// gate-signature-inbox.js — Read model PURO de la bandeja "Esperando tu firma"
// (#6208 · parte 3 del split de #6199).
//
// QUÉ RESUELVE
// ------------
// Hasta #6208 `dashboard.js:1822` leía `waitingOperator.listWaitingOperator()`
// —markers del filesystem— así que la bandeja estaba SIEMPRE vacía de firmas
// reales: nadie mostraba el depósito común del kernel (`approval-channel`).
// Este módulo compone lo que el operador ve, a partir de tres fuentes:
//
//   (a) `approval-channel.listPending()` — los pendientes REALES del kernel.
//       Son los únicos FIRMABLES: traen ficha, ancla server-derived y opciones.
//   (b) `gate-signature/{pendiente,despachado}/` — en qué estado quedó la
//       decisión que el operador ya tocó (CA-10). Se deriva del FILESYSTEM, no
//       de la memoria del navegador: persiste al refresco.
//   (c) `waiting-operator.listWaitingOperator()` — los markers de GATE 3 y
//       compañía. Se UNEN, no reemplazan (§8 de la receta / H-UX-6199-3):
//       reemplazar la fuente haría desaparecer GATE 3 de la bandeja sin que
//       ningún CA lo pida. NO son firmables desde acá (UX §7).
//
// POR QUÉ ES UN MÓDULO Y NO CÓDIGO INLINE EN dashboard.js
// -------------------------------------------------------
// Los estados de D-1/CA-10 tienen que persistir al refresco y ser testeables
// sin levantar el dashboard. Inline en `dashboard.js` la composición no se
// puede testear y arrastra el bug de siempre. Módulo puro, sin red, `nowMs`
// inyectable — mismo contrato que `decision-card.js`.
//
// CA-2 — LA FICHA SE CONSUME, NO SE REIMPLEMENTA
// ----------------------------------------------
// La redacción de la antigüedad sale de `decision-card` (#6190), que ya produce
// `hace 3 h 20 min`. Acá NO hay una segunda tabla de edad ni un segundo copy de
// la ficha: los campos que se muestran son los que el kernel ya armó en el
// depósito (`title`, `question`, `anchor`, `evidence`, `presented`, `options`).
//
// CA-4 — el `anchor` es SERVER-DERIVED: sale del depósito, donde lo escribió
// `approval-channel.computeAnchor`. Nunca se deriva del texto del issue ni
// llega del cliente.
//
// REQ-SEC-6208-1 — este módulo NO re-ejecuta el detector de inyección: LEE la
// señal que el kernel ya dejó (`presentation_safe` / `presentation_alert`).
// Recalcularla podría divergir del veredicto con el que se emitió el pedido.
// El escape por contexto es responsabilidad de la vista y es innegociable.
// =============================================================================

const fsDefault = require('fs');
const path = require('path');

const approvalChannelDefault = require('./approval-channel');
const waitingOperatorDefault = require('./waiting-operator');
const gateSignatureRequest = require('./gate-signature-request');
const decisionCard = require('./decision-card');

// -----------------------------------------------------------------------------
// Copy de los tres vacíos (UX §5) y de los momentos del ciclo (UX §6 + D-4).
//
// Es DATO congelado, no lógica: la vista lo pinta, no lo redacta. Una segunda
// redacción del mismo estado en la vista es exactamente lo que CA-2 prohíbe.
// -----------------------------------------------------------------------------

/**
 * UX §5 — "el verde se gana leyendo la lista completa". Sólo el primer caso
 * puede ser verde; un depósito ilegible NUNCA se pinta como "está todo firmado".
 */
const VACIOS = Object.freeze({
    limpio: Object.freeze({
        tono: 'ok',
        icono: '✓',
        titulo: 'Nada esperando tu firma',
        lineas: Object.freeze([
            'Ningún gate está reteniendo un trabajo.',
            'Leí la lista entera y estaba vacía.',
        ]),
        chip: 'LISTA LEÍDA COMPLETA',
    }),
    degradado: Object.freeze({
        tono: 'warn',
        icono: '⚠',
        titulo: 'No pude leer la lista de firmas pendientes',
        lineas: Object.freeze([
            'Esto no quiere decir que esté todo firmado.',
            'Freno lo que dependa de una firma y te aviso.',
        ]),
        chip: 'RETENIDO · REVISAR EL DEPÓSITO',
    }),
});

/** UX §5, tercer caso: banda ARRIBA de la lista; convive con filas. */
function bandaCorrupta(ilegibles, visibles) {
    return {
        tono: 'warn',
        icono: '⚠',
        titulo: `Hay ${ilegibles} pedido${ilegibles === 1 ? '' : 's'} que no pude leer`,
        lineas: [
            `Te muestro los ${visibles} que sí puedo leer.`,
            `Los otros ${ilegibles} no desaparecieron: no los puedo mostrar.`,
        ],
        chip: `${visibles} VISIBLES · ${ilegibles} ILEGIBLES`,
    };
}

/**
 * UX §6 + D-4 (#6208) — los momentos del ciclo. Mientras `dispatchToCarrier` sea
 * `null` (#6207 abierta) el copy nombra EL ESTADO REAL, no el medio: prometer
 * "te lo mando a Telegram" sin Telegram conectado es la misma mentira con otro
 * texto. El nombre del medio, cuando exista, sale del retorno del carrier.
 */
const ESTADOS = Object.freeze({
    pendiente: Object.freeze({
        tono: 'info',
        titulo: 'Espera tu firma',
        detalle: 'Elegí una opción y la anoto para que se confirme por el canal con identidad.',
    }),
    encolado: Object.freeze({
        tono: 'warn',
        titulo: 'Anotada tu decisión — falta confirmarla',
        detalle: 'Todavía no está firmada. Te la voy a pedir por el canal con identidad cuando esté conectado.',
    }),
    // UX §7 — ningún `msg` del servidor se muestra crudo: cuando el pedido no se
    // pudo anotar, el operador lee QUÉ pasó y QUÉ sigue, en el mismo idioma.
    // Fuente única: el adaptador web lo lee de acá, no lo redacta de nuevo.
    error: Object.freeze({
        tono: 'err',
        titulo: 'No pude anotar tu decisión',
        detalle: 'Nada cambió: el gate sigue reteniendo el trabajo. Probá de nuevo en un momento.',
    }),
});

/** Momento 2 (UX §6): el medio sale del carrier, NUNCA hardcodeado (D-4). */
function estadoDespachado(carrier, edad) {
    const medio = typeof carrier === 'string' && carrier.trim() !== '' ? carrier.trim() : 'el canal con identidad';
    return {
        tono: 'info',
        titulo: edad ? `Te lo mandé a ${medio} ${edad}` : `Te lo mandé a ${medio}`,
        detalle: 'Queda firmado cuando lo confirmes ahí. Hasta entonces la fila se queda acá.',
    };
}

// -----------------------------------------------------------------------------
// El ancla, en castellano (UX §3)
// -----------------------------------------------------------------------------

/** Encabezado fijo del bloque de ancla. Siempre el mismo. */
const ANCHOR_TITULO = 'Contra qué queda atada tu firma';
const ANCHOR_CHIP = 'DATO DEL SISTEMA · NO SALE DEL ISSUE';
const ANCHOR_CONSECUENCIA = 'Si alguien edita esos criterios después de que firmes, '
    + 'la firma se anula sola y te la vuelvo a pedir. Nadie cambia lo aprobado sin que se note.';

/** Quita el prefijo `sha256:` del digest: el operador no lee nombres técnicos. */
function hexOf(value) {
    const s = String(value == null ? '' : value);
    const i = s.indexOf(':');
    return i === -1 ? s : s.slice(i + 1);
}

/**
 * UX §3 — traduce el ancla a una línea en castellano. **Prohibido** que
 * `body-hash`, `commit-sha`, `anchor` o `digest` aparezcan en la cara del
 * operador: el valor se muestra abreviado y como dato, nunca como nombre
 * técnico del tipo.
 *
 * @param {{kind:string,value:string}} anchor
 * @param {number} issue
 * @returns {{titulo:string, chip:string, linea:string, consecuencia:string}|null}
 */
function describeAnchor(anchor, issue) {
    if (!anchor || typeof anchor !== 'object') return null;
    const hex = hexOf(anchor.value);
    let linea;
    if (anchor.kind === 'body-hash') {
        if (hex.length < 12) return null;
        linea = `Los criterios escritos hoy en #${issue} — huella ${hex.slice(0, 8)}…${hex.slice(-4)}`;
    } else if (anchor.kind === 'commit-sha') {
        if (hex.length < 7) return null;
        linea = `El commit entregado en #${issue} — ${hex.slice(0, 7)} de la rama del PR`;
    } else {
        return null;
    }
    return { titulo: ANCHOR_TITULO, chip: ANCHOR_CHIP, linea, consecuencia: ANCHOR_CONSECUENCIA };
}

// -----------------------------------------------------------------------------
// Estado de la decisión (CA-10) — derivado del FILESYSTEM, no de memoria
// -----------------------------------------------------------------------------

/** Clave de idempotencia del canal: `(issue, gate)`. */
function key(issue, gate) {
    return `${Number(issue)}-${gate}`;
}

/**
 * Lee `gate-signature/pendiente/` y `gate-signature/despachado/` y devuelve el
 * estado de cada `(issue, gate)`. Fail-open: una carpeta ausente es "todavía
 * nadie tocó nada", no un error (las carpetas se crean al primer pedido).
 *
 * @returns {Map<string,{estado:'encolado'|'despachado', verdict:?string, carrier:?string, at:?number}>}
 */
function readDecisionState(queueDir, dispatchedDir, _fs) {
    const out = new Map();

    // 1 · Encolados (el dashboard anotó, el drenador todavía no despachó).
    let pend = [];
    try { pend = _fs.readdirSync(queueDir); } catch { pend = []; }
    for (const name of Array.isArray(pend) ? pend : []) {
        if (!/\.json$/i.test(name)) continue;
        let rec;
        try { rec = JSON.parse(_fs.readFileSync(path.join(queueDir, name), 'utf8')); } catch { continue; }
        if (!rec || rec.type !== 'gate_signature_request') continue;
        if (!approvalChannelDefault.isValidIssueId(rec.issue)) continue;
        const g = approvalChannelDefault.resolveGate(rec.gate);
        if (!g.ok) continue;
        const verdict = gateSignatureRequest.normalizeVerdict(g.spec, rec.verdict != null ? rec.verdict : rec.decision);
        if (verdict === null) continue;
        const k = key(rec.issue, g.spec.gate);
        const at = Number(rec.created_at);
        const prev = out.get(k);
        // El más reciente manda: es la última intención del operador.
        if (!prev || (Number.isFinite(at) && at > (prev.at || 0))) {
            out.set(k, { estado: 'encolado', verdict, carrier: null, at: Number.isFinite(at) ? at : null });
        }
    }

    // 2 · Despachados (pisan al encolado: es un estado posterior del mismo pedido).
    let disp = [];
    try { disp = _fs.readdirSync(dispatchedDir); } catch { disp = []; }
    for (const name of Array.isArray(disp) ? disp : []) {
        if (!/\.json$/i.test(name)) continue;
        let rec;
        try { rec = JSON.parse(_fs.readFileSync(path.join(dispatchedDir, name), 'utf8')); } catch { continue; }
        if (!rec || rec.type !== 'gate_signature_dispatch') continue;
        if (!approvalChannelDefault.isValidIssueId(rec.issue)) continue;
        const g = approvalChannelDefault.resolveGate(rec.gate);
        if (!g.ok) continue;
        const verdict = gateSignatureRequest.normalizeVerdict(g.spec, rec.verdict);
        const at = Number(rec.dispatched_at);
        out.set(key(rec.issue, g.spec.gate), {
            estado: 'despachado',
            verdict,
            carrier: rec.carrier == null ? null : String(rec.carrier),
            at: Number.isFinite(at) ? at : null,
        });
    }

    return out;
}

/**
 * Edad legible. CA-2/CA-3 — la redacción sale de `decision-card` (#6190), que ya
 * produce `hace 3 h 20 min`. Acá NO hay una segunda tabla.
 */
function edadDesde(tsMs, nowMs) {
    if (!Number.isFinite(tsMs) || !Number.isFinite(nowMs)) return '';
    return decisionCard.edadDesdeMinutos((nowMs - tsMs) / 60000);
}

/**
 * CA-2 — la ficha de decisión de #6190 se CONSUME. Se le pasa el pendiente del
 * depósito mapeado a la forma `raw` que espera `buildDecisionCard`; lo que se
 * usa de vuelta es su redacción (antigüedad y clasificación), no una copia.
 *
 * No atrapa hacia afuera: si `buildDecisionCard` lanza, se degrada a la
 * antigüedad calculada con el mismo módulo (`edadDesdeMinutos`), nunca a una
 * tabla propia.
 */
function fichaDe(pending, nowMs) {
    const createdMs = Date.parse(pending.created_at);
    try {
        const card = decisionCard.buildDecisionCard({
            tipo: 'firma',
            issue: pending.issue,
            titulo: pending.title,
            question: pending.question,
            blocked_at: pending.created_at,
        }, nowMs);
        return { card, edad: (card && card.que_esta_frenado && card.que_esta_frenado.desde) || edadDesde(createdMs, nowMs) };
    } catch {
        return { card: null, edad: edadDesde(createdMs, nowMs) };
    }
}

/** Severidad por antigüedad — misma escala que ya usa el dashboard (UX §2). */
function severityOfMinutes(min) {
    if (!Number.isFinite(min) || min < 0) return 'info';
    const h = min / 60;
    if (h >= 24) return 'danger';
    if (h >= 4) return 'warning';
    return 'info';
}

/**
 * Mapea un pendiente del depósito a una fila FIRMABLE de la bandeja.
 * Los ocho campos de UX §2 y nada más.
 */
function rowFromPending(pending, estado, nowMs) {
    const issue = Number(pending.issue);
    const createdMs = Date.parse(pending.created_at);
    const { edad } = fichaDe(pending, nowMs);
    const ageMinutes = Number.isFinite(createdMs) && Number.isFinite(nowMs)
        ? (nowMs - createdMs) / 60000
        : NaN;

    let estadoCopy;
    if (!estado) estadoCopy = ESTADOS.pendiente;
    else if (estado.estado === 'despachado') estadoCopy = estadoDespachado(estado.carrier, edadDesde(estado.at, nowMs));
    else estadoCopy = ESTADOS.encolado;

    return {
        kind: 'firma',
        firmable: true,
        issue,
        gate: pending.gate,
        // El título ya viene armado y recortado por el kernel: no se recorta de
        // nuevo ni se le agrega prefijo (UX §2, campo 3).
        title: String(pending.title == null ? '' : pending.title),
        question: String(pending.question == null ? '' : pending.question),
        // CA-4 — ancla SERVER-DERIVED: sale del depósito, jamás del texto del issue.
        anchor: pending.anchor || null,
        anchorView: describeAnchor(pending.anchor, issue),
        evidence: Array.isArray(pending.evidence) ? pending.evidence : [],
        presented: pending.presented || null,
        // REQ-SEC-6208-1 — la señal se LEE del depósito; no se recalcula acá.
        presentation_safe: pending.presentation_safe !== false,
        presentation_alert: pending.presentation_alert || null,
        // UX §2 campo 8 — un botón por opción, con el `label` del kernel. El
        // adaptador NO inventa el label ni lo deriva de la clave interna.
        options: Array.isArray(pending.options) ? pending.options : [],
        created_at: pending.created_at || null,
        edad,
        age_minutes: Number.isFinite(ageMinutes) ? ageMinutes : null,
        severity: severityOfMinutes(ageMinutes),
        estado: estado ? estado.estado : 'pendiente',
        estado_verdict: estado ? estado.verdict : null,
        estado_carrier: estado ? estado.carrier : null,
        estado_copy: estadoCopy,
        // Retro-compat con el filtro por producto de #4778: los pendientes del
        // depósito son del producto único mientras el kernel no los tipe.
        productId: null,
    };
}

/**
 * §8 — Mapea un marker de `waiting-operator` a una fila NO firmable. Conserva
 * los campos que la vista ya sabía pintar (origen, evidencia, sugerencia,
 * antigüedad, producto) para no perder nada de #4580/#4778.
 */
function rowFromMarker(m) {
    return {
        ...m,
        kind: 'marker',
        firmable: false,
        options: [],
        // UX §7 — "no te pongo un botón de firmar que el sistema va a rechazar".
        no_firmable_copy: {
            titulo: 'Esto no se firma desde la bandeja',
            lineas: [
                'No es una firma tuya: es una acción que el pipeline te está avisando.',
                'Te dejo el link para que la mires.',
            ],
        },
    };
}

/**
 * Compone la bandeja completa.
 *
 * @param {object} [opts]
 *   @param {number} [opts.nowMs] — "ahora" inyectado (determinismo en tests).
 *   @param {string} [opts.queueDir] @param {string} [opts.dispatchedDir]
 * @param {object} [deps] — { fsImpl, approvalImpl, waitingImpl, approvalDeps }
 * @returns {{items:Array, degraded:boolean, alert:?string, corrupt:Array,
 *           corruptCount:number, visibleCount:number, firmables:number,
 *           vacio:?object, banda:?object}}
 */
function listInbox(opts = {}, deps = {}) {
    const _fs = deps.fsImpl || fsDefault;
    const approval = deps.approvalImpl || approvalChannelDefault;
    const waiting = deps.waitingImpl || waitingOperatorDefault;
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const queueDir = opts.queueDir || gateSignatureRequest.DEFAULT_QUEUE_DIR;
    const dispatchedDir = opts.dispatchedDir || gateSignatureRequest.DEFAULT_DISPATCHED_DIR;

    // (a) Pendientes REALES del kernel. Fail-closed: si esto explota, la bandeja
    // queda degradada — nunca "vacía y verde" (H-UX-6208-1).
    let listed;
    try {
        listed = approval.listPending({}, deps.approvalDeps || {});
    } catch (e) {
        listed = {
            ok: false, pending: [], corrupt: [], degraded: true,
            alert: `No pude leer el depósito de pendientes de firma (${e.message}). Retengo y aviso.`,
        };
    }
    const degraded = !listed || listed.ok !== true || listed.degraded === true;
    const corrupt = (listed && Array.isArray(listed.corrupt)) ? listed.corrupt : [];
    const pending = (listed && Array.isArray(listed.pending)) ? listed.pending : [];

    // (b) Estado de lo que el operador ya decidió (CA-10 · del filesystem).
    let estados;
    try { estados = readDecisionState(queueDir, dispatchedDir, _fs); } catch { estados = new Map(); }

    const items = [];
    const vistos = new Set();
    for (const p of pending) {
        if (!p || !approval.isValidIssueId(p.issue)) continue;
        const g = approval.resolveGate(p.gate);
        if (!g.ok) continue;
        const k = key(p.issue, g.spec.gate);
        if (vistos.has(k)) continue;
        vistos.add(k);
        items.push(rowFromPending(p, estados.get(k) || null, nowMs));
    }

    // (c) Markers: se UNEN, no reemplazan (§8). Sin ellos GATE 3 desaparecería
    // de la bandeja sin que ningún CA lo pida.
    let markers = [];
    try { markers = waiting.listWaitingOperator(deps.waitingDeps || {}) || []; } catch { markers = []; }
    for (const m of markers) {
        if (!m || !approval.isValidIssueId(m.issue)) continue;
        // Dedupe por `(issue, gate)`: el marker de GATE 1/2 del mismo issue que
        // ya tiene pendiente en el depósito no se duplica — manda el firmable.
        const gateDelMarker = m.origen === 'waiting-operator-def' ? 'definicion'
            : m.origen === 'waiting-operator-acc' ? 'aceptacion'
                : null;
        if (gateDelMarker && vistos.has(key(m.issue, gateDelMarker))) continue;
        items.push(rowFromMarker(m));
    }

    const firmables = items.filter(i => i.firmable).length;
    const corruptCount = corrupt.length;

    return {
        items,
        degraded,
        alert: (listed && listed.alert) || null,
        corrupt,
        corruptCount,
        visibleCount: items.length,
        firmables,
        // UX §5 — SÓLO el primer caso puede ser verde. Un depósito que no se
        // pudo leer nunca se pinta como "está todo firmado".
        vacio: items.length === 0 ? (degraded ? VACIOS.degradado : VACIOS.limpio) : null,
        // El tercer caso convive con filas: es una banda ARRIBA de la lista.
        banda: corruptCount > 0 ? bandaCorrupta(corruptCount, items.length) : null,
    };
}

module.exports = {
    listInbox,
    // Helpers exportados para tests.
    describeAnchor,
    readDecisionState,
    rowFromPending,
    rowFromMarker,
    severityOfMinutes,
    edadDesde,
    fichaDe,
    bandaCorrupta,
    key,
    VACIOS,
    ESTADOS,
    estadoDespachado,
    ANCHOR_TITULO,
    ANCHOR_CHIP,
    ANCHOR_CONSECUENCIA,
};
