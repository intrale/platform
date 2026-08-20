// =============================================================================
// pulpo-liveness-copy.js — Copy al operador de la alerta de margen del
// vigilante del Pulpo (#6146)
//
// Por qué este módulo existe
// --------------------------
// El aviso que llegaba al canal era una métrica cruda con vocabulario interno:
// nombres de claves de configuración, "umbral efectivo", "pico de ciclo" y una
// receta de edición de archivo como acción sugerida. Feedback textual del
// operador (19/08): "el mensaje me parece extremadamente técnico, no le llega
// al operador; si no pido una aclaración, no se entiende".
//
// Este módulo es la ÚNICA superficie que construye ese texto. Es puro: no lee
// disco, no lee configuración, no encola nada, no persiste estado. Se puede
// requerir desde un test sin efectos, que es lo que hace implementable el
// guardián de copy (CA-8).
//
// Contención estructural de CA-2 (decisión de diseño, no preferencia)
// ------------------------------------------------------------------
// `buildMarginAlert` recibe SOLO `{ marginSeconds, prevAlertTs, now }`. No
// recibe el umbral efectivo, ni el origen del umbral, ni la cantidad de
// muestras, ni el porcentaje consumido, ni el objeto de configuración. Con esa
// firma el módulo NO PUEDE filtrar vocabulario interno aunque alguien edite el
// copy con descuido: el dato simplemente no está a su alcance.
//
//   >> Ampliar esta firma "por comodidad" es la forma de reabrir el agujero.
//   >> Si hace falta un dato más para diagnóstico, va al log del runner, que no
//   >> es superficie del operador — nunca acá.
//
// Contrato de texto
// -----------------
// Las cuatro cadenas de `message`/`action` son el entregable literal de la fase
// de definición (agente `ux`, comentario de `criterios` del issue #6146). No se
// reescriben ni se "mejoran": ese texto ES el contrato. Lo mismo vale para las
// claves del detalle, que se renderizan al operador tal cual y por eso van en
// lenguaje llano, minúscula, con espacios y tildes — nunca en snake_case.
// =============================================================================

'use strict';

/** Los dos niveles de urgencia distinguibles por el operador (CA-4/CA-5). */
const URGENCY = { INMINENTE: 'inminente', ATENCION: 'atencion' };

/**
 * Corte entre los dos niveles (D-1). Es por SEGUNDOS de margen y no por
 * porcentaje a propósito: el operador dimensiona "quedan 6 segundos", no
 * dimensiona "queda el 2%".
 */
const INMINENTE_MAX_SECONDS = 30;

/**
 * D-1: elige el nivel de urgencia. Un margen no finito (dato ausente, estado
 * corrupto) cae en ATENCION — nunca se omite el aviso por falta de dato.
 * Un margen negativo (el pico ya cruzó el umbral) es finito y <= 30, así que
 * cae en INMINENTE, que es exactamente lo correcto.
 *
 * @param {number} marginSeconds
 * @returns {string}
 */
function urgencyFor(marginSeconds) {
  return Number.isFinite(marginSeconds) && marginSeconds <= INMINENTE_MAX_SECONDS
    ? URGENCY.INMINENTE
    : URGENCY.ATENCION;
}

/**
 * Redacta hace cuánto que la situación sigue igual (CA-6).
 *
 * D-3/SEC-4: devuelve `null` en vez de degradar. Si el intervalo no es finito y
 * positivo (primera alerta de la vida, estado ausente o corrupto, reloj hacia
 * atrás) la línea se OMITE entera. Nunca "sigue igual desde hace 0 minutos" ni
 * "hace NaN minutos": un dato erróneo en el canal es peor que un dato ausente.
 *
 * Tabla de intervalos entregada por `ux`:
 *   < 1 min      -> se omite
 *   1–59 min     -> "hace {N} minutos"
 *   60–119 min   -> "hace una hora"
 *   2–23 h       -> "hace {N} horas"
 *   >= 24 h      -> "hace {N} días"
 *
 * @param {number} deltaMs
 * @returns {string|null}
 */
function formatPersistence(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 60 * 1000) return null;
  const min = Math.floor(deltaMs / 60000);
  if (min < 60) return 'hace ' + min + ' minutos';
  const h = Math.floor(min / 60);
  if (h === 1) return 'hace una hora';
  if (h < 24) return 'hace ' + h + ' horas';
  return 'hace ' + Math.floor(h / 24) + ' días';
}

/**
 * Construye el aviso completo al operador.
 *
 * @param {object} params
 * @param {number} params.marginSeconds  segundos de tolerancia que quedan
 * @param {number} params.prevAlertTs    epoch ms de la alerta ANTERIOR — se
 *   captura antes de marcar la nueva, que lo pisa con `now` (H-2)
 * @param {number} params.now            epoch ms actual
 * @returns {{message: string, action: string, context: object, urgency: string}}
 */
function buildMarginAlert({ marginSeconds, prevAlertTs, now } = {}) {
  const urgency = urgencyFor(marginSeconds);
  const inminente = urgency === URGENCY.INMINENTE;

  const message = inminente
    ? 'El vigilante está por reiniciar el Pulpo aunque está trabajando bien. ' +
      'Si lo reinicia, lo que vas a ver es que el Commander deja de responder.'
    : 'El vigilante se está acercando al punto en el que reiniciaría el Pulpo ' +
      'aunque esté trabajando bien. Si llega, lo que vas a ver es que el ' +
      'Commander deja de responder.';

  const action = inminente
    ? 'Podemos darle más tolerancia al vigilante para que no reinicie el Pulpo ' +
      'por ciclos lentos. Si estás de acuerdo, avisá y el pipeline aplica el cambio.'
    : 'Conviene resolverlo antes de que llegue al límite: podemos darle más ' +
      'tolerancia al vigilante. Si estás de acuerdo, avisá y el pipeline aplica el cambio.';

  const context = {};

  // D-1/D-3: si el margen no es un número finito la clave se omite en vez de
  // imprimir un valor vacío. El aviso igual sale.
  if (Number.isFinite(marginSeconds)) {
    context['cuánto falta'] = inminente
      ? 'muy poco: quedan ' + marginSeconds +
        ' segundos de tolerancia, puede pasar en cualquier momento'
      : 'todavía hay aire: quedan ' + marginSeconds +
        ' segundos de tolerancia, pero se viene achicando';
  }

  // CA-6: la persistencia se expresa en lenguaje llano, no como un contador.
  const desde =
    Number.isFinite(prevAlertTs) && prevAlertTs > 0 && Number.isFinite(now)
      ? formatPersistence(now - prevAlertTs)
      : null;
  if (desde) context['desde cuándo'] = 'viene igual desde ' + desde;

  return { message, action, context, urgency };
}

module.exports = {
  buildMarginAlert,
  formatPersistence,
  urgencyFor,
  URGENCY,
  INMINENTE_MAX_SECONDS,
};
