'use strict';

// =============================================================================
// gate1-notify.js — Armado del aviso de GATE 1 · Firma de Definición (#6192,
// parte 3 del split de #6173).
//
// POR QUÉ ES UN MÓDULO Y NO CÓDIGO INLINE EN pulpo.js
// ---------------------------------------------------
// Los CA de #6192 exigen tests sobre el aviso: que el tipo `firma` no lleve
// NINGUNA opción recomendada, que "sin firmante autorizado" salga
// `indeterminado` con `opciones: []`, que el texto no emita metacaracteres de
// Markdown (contrato anti-#5421) y que, con `buildDecisionCard` reventando, el
// issue siga retenido y salga igual un aviso degradado. Nada de eso se puede
// testear inline dentro del barrido de `pulpo.js`, que necesita GitHub, config
// y filesystem para llegar a la línea. Acá es una función pura con `nowMs` y
// `buildDecisionCard` inyectables.
//
// CONTRATO DE COPY: SE CONSUME, NO SE REDACTA (dependencia de #6190)
// ------------------------------------------------------------------
// Todo el texto sale de `decision-card.js` (qué está frenado, por qué, qué se
// decide, opciones, costo de no decidir) y lo dibuja `decision-card-render.js`.
// Este módulo NO escribe copy propio: sólo elige el TIPO de ficha y arma el
// `raw` que la alimenta. La única excepción es la tercera red de fallback (ver
// abajo), que existe para que el operador se entere aunque los dos módulos de
// copy estén rotos.
//
// LA `reason` DEL GATE NO SE INTERPOLA EN EL TEXTO (R1 / #5421)
// -------------------------------------------------------------
// Hoy los tres avisos interpolan `opGateResult.reason` crudo dentro de un
// mensaje que viaja con `parse_mode: 'Markdown'`. Un `_` o un `*` en el motivo
// —o en el nombre de un firmante no autorizado, que es input externo— hace que
// Telegram devuelva HTTP 400 y la alerta se pierda sin rastro. Acá la `reason`
// se usa SÓLO para clasificar la ficha; el detalle técnico queda en el log del
// pulpo, que es donde se diagnostica. El texto que sale es el de la ficha, que
// ya pasa por el saneador de `decision-card` y viaja `{ plain: true }`.
//
// BOTONES: SÓLO CUANDO HAY ALGO FIRMABLE
// --------------------------------------
// `ofreceBotones` es `true` únicamente para el tipo `firma`. Un aviso
// `indeterminado` —no hay firmante autorizado configurado, no se pudo leer el
// issue, el gate reventó— NO lleva botones: ninguna firma sería válida o no se
// sabe qué se estaría firmando, y un botón que no puede cumplir lo que promete
// es peor que no tenerlo. Es el mismo criterio que `opciones: []` en la ficha.
// =============================================================================

const decisionCardDefault = require('./decision-card');
const cardRender = require('./decision-card-render');

// Los tres momentos en los que GATE 1 retiene y avisa. El caso decide el TIPO
// de ficha: sólo `block` puede pedir una firma; los otros dos son estados en
// los que el pipeline no sabe qué se firmaría.
const CASOS = Object.freeze(['block', 'load-error', 'gate-error']);

/**
 * Arma el aviso de una retención de GATE 1.
 *
 * @param {object} input
 * @param {number} input.issue
 * @param {string} [input.titulo]                título del issue (input externo).
 * @param {string} [input.reason]                motivo del gate — clasifica, NO se imprime.
 * @param {string} [input.caso]                  'block' | 'load-error' | 'gate-error'.
 * @param {number} [input.firmantesAutorizados]  tamaño del allowlist resuelto server-side.
 * @param {boolean}[input.capacidadFirma]        ¿se pudo emitir la capability de firma?
 *   `false` EXPLÍCITO reclasifica la ficha a `indeterminado`; `undefined`/`null`
 *   = no se preguntó y el comportamiento no cambia.
 * @param {boolean}[input.firmaVencida]          firmó, pero los criterios cambiaron (anti-TOCTOU).
 * @param {string} [input.blockedAt]             ISO del momento en que se detectó la retención.
 * @param {string} [input.fechaCorta]            fecha legible de esa detección.
 * @param {number} [nowMs]
 * @param {object} [deps]  `{ buildDecisionCard, render }` — inyectables para test.
 * @returns {{texto:string, tipo:string, ofreceBotones:boolean, degradado:boolean}}
 */
function buildGate1Notice(input, nowMs, deps = {}) {
    const i = input && typeof input === 'object' ? input : {};
    const caso = CASOS.includes(i.caso) ? i.caso : 'block';
    const build = typeof deps.buildDecisionCard === 'function'
        ? deps.buildDecisionCard
        : decisionCardDefault.buildDecisionCard;
    const render = typeof deps.render === 'function'
        ? deps.render
        : cardRender.renderDecisionCardsPlain;
    const renderFallback = typeof deps.renderFallback === 'function'
        ? deps.renderFallback
        : cardRender.renderFallbackAviso;

    const tipo = tipoDeFicha(caso, i);
    const raw = rawDeAviso(caso, tipo, i);

    try {
        const card = build(raw, nowMs);
        const texto = render([card], undefined, { encabezado: false });
        if (!texto || !String(texto).trim()) {
            // Render vacío es una falla silenciosa, no un éxito: se degrada.
            throw new Error('la ficha se renderizó vacía');
        }
        return {
            texto,
            // El tipo EFECTIVO lo dice la ficha construida, no el que pedimos:
            // si `decision-card` reclasifica, manda su veredicto (los botones
            // dependen de esto y no pueden salir de una suposición nuestra).
            tipo: card && card.tipo ? card.tipo : tipo,
            ofreceBotones: !!card && card.tipo === 'firma',
            degradado: false,
        };
    } catch (e) {
        // Fail-closed: el issue YA quedó retenido por el caller antes de llegar
        // acá. Si la ficha revienta, el aviso se degrada — nunca se silencia, y
        // nunca se levanta la retención.
        avisarStderr(`ficha de decisión falló, se emite el aviso degradado: ${msg(e)}`);
        try {
            const texto = renderFallback([raw], nowMs);
            if (!texto || !String(texto).trim()) throw new Error('fallback vacío');
            return { texto, tipo, ofreceBotones: false, degradado: true };
        } catch (e2) {
            // Tercera red. Copy propio a propósito y sólo acá: los dos módulos
            // de copy ya fallaron, y el silencio de un gate que retiene trabajo
            // es peor que un aviso feo.
            avisarStderr(`aviso degradado también falló: ${msg(e2)}`);
            const ref = Number.isInteger(Number(i.issue)) && Number(i.issue) > 0
                ? `#${Number(i.issue)}` : 'Un trabajo sin número';
            return {
                texto: `⚠️ ${ref} está retenido esperando tu firma y no pude armar el aviso. Sigue frenado: mirá el tablero.`,
                tipo,
                ofreceBotones: false,
                degradado: true,
            };
        }
    }
}

/**
 * Tipo de ficha del aviso.
 *
 * CA de #6192: "el gate retiene porque no hay firmante autorizado configurado"
 * NO es una ficha de `firma` sino `indeterminado` — pedirle al operador que
 * firme cuando ninguna firma sería válida es ofrecerle una opción inejecutable.
 * Lo mismo vale cuando no se pudo leer el issue o el gate reventó: no se sabe
 * qué se estaría firmando.
 */
function tipoDeFicha(caso, i) {
    if (caso !== 'block') return 'indeterminado';
    const firmantes = Number(i.firmantesAutorizados);
    if (Number.isFinite(firmantes) && firmantes === 0) return 'indeterminado';
    // #6192 — El tipo `firma` es el ÚNICO que ofrece los botones. Si el
    // pipeline no pudo emitir la capability, una ficha `firma` pediría firmar
    // sin dar con qué: misma opción inejecutable que "no hay firmante", por
    // otra causa. Sólo el `false` explícito reclasifica — `undefined` es "no se
    // preguntó", y tratarlo como indisponible degradaría avisos sanos.
    if (i.capacidadFirma === false) return 'indeterminado';
    return 'firma';
}

/** `raw` que alimenta la ficha. Ver `decision-card.js::normalizar`. */
function rawDeAviso(caso, tipo, i) {
    const raw = {
        issue: Number(i.issue),
        titulo: i.titulo == null ? '' : String(i.titulo),
        // El tipo va EXPLÍCITO: el clasificador por texto no puede ver la
        // diferencia entre "falta la firma" y "no hay quien firme", que es
        // justamente la distinción que piden los CA.
        tipo,
        reason: i.reason == null ? '' : String(i.reason),
        // Se pasa siempre: `faltaDe()` lo usa como PRIMERA condición para decir
        // "no hay ningún firmante autorizado configurado".
        firmantes_autorizados: Number.isFinite(Number(i.firmantesAutorizados))
            ? Number(i.firmantesAutorizados) : null,
        firma_vencida: i.firmaVencida === true,
        // Se pasa junto a `firmantes_autorizados` porque alimenta la MISMA
        // decisión en `decision-card` (clasificación + qué dato falta): el
        // clasificador tiene que poder ver las dos causas de "no hay firma
        // posible", no una sola.
        capacidad_firma_disponible: i.capacidadFirma === undefined ? null : i.capacidadFirma,
        blocked_at: i.blockedAt || null,
        fecha_corta: i.fechaCorta || '',
        skill: 'operador',
        phase: 'definicion',
    };
    if (caso !== 'block') {
        // `unknown` es la categoría con la que `decision-card` dice "el motivo
        // llegó y no lo puedo interpretar" (falta_ilegible). Es exactamente lo
        // que pasa cuando el gate no pudo leer el issue o reventó.
        raw.reason_category = 'unknown';
    }
    return raw;
}

function msg(e) {
    return e && e.message ? e.message : String(e);
}

function avisarStderr(texto) {
    try {
        process.stderr.write(`[gate1-notify] ${texto}\n`);
    } catch (_) {
        /* stderr cerrado: no puede tumbar el aviso */
    }
}

module.exports = {
    buildGate1Notice,
    CASOS,
    // Exportados para test.
    tipoDeFicha,
    rawDeAviso,
};
