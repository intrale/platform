'use strict';
const { patch } = require('./patch');

patch('.pipeline/lib/commander/request-classify.js', [
  [
`// Enum cerrado de resultado. Congelado para que no se mute en runtime.
const RESULTADOS = Object.freeze(['ok', 'ajustada', 'fallback', 'error']);`,
`// Enum cerrado de resultado. Congelado para que no se mute en runtime.
//
// #6459 — quinto valor \`huerfano\`: el turno se ejecutó ENTERO y su respuesta
// nunca se confirmó como entregada. NO es \`error\`: el pedido no falló, se perdió
// la respuesta. Confundirlos le haría leer al operador "falló" donde dice "se
// hizo y no te enteraste" — el malentendido opuesto al que #6440 viene a cerrar.
// R-7: el valor va SIN tilde porque la clase CSS sale de acá
// (\`cmd-result-\${resultado}\`, result-badge.js); la tilde vive sólo en el label y
// el tooltip.
const RESULTADOS = Object.freeze(['ok', 'ajustada', 'fallback', 'error', 'huerfano']);`],

  [
` * Precedencia (de mayor a menor): \`error > ajustada > fallback > ok\`.`,
` * Precedencia (de mayor a menor): \`error > huerfano > ajustada > fallback > ok\`.`],

  [
` *   - \`ok\`       ← caso base.`,
` *   - \`huerfano\` ← \`deliveryUnconfirmed === true\` y NINGUNA condición de error
 *                  (#6459): el turno corrió entero pero su respuesta nunca se
 *                  confirmó como entregada.
 *   - \`ok\`       ← caso base.`],

  [
` * @param {boolean} [args.emptyResponse]      la respuesta final fue vacía.`,
` * @param {boolean} [args.emptyResponse]      la respuesta final fue vacía.
 * @param {boolean} [args.deliveryUnconfirmed] #6459 — el turno produjo respuesta
 *   pero su entrega NUNCA se confirmó. Default \`false\` ⇒ back-compat total: sin
 *   el flag la clasificación es idéntica a la de antes de #6459.`],

  [
` *   resultado: 'ok'|'ajustada'|'fallback'|'error',`,
` *   resultado: 'ok'|'ajustada'|'fallback'|'error'|'huerfano',`],

  [
`    emptyResponse = false,
    _providerOpts = undefined,`,
`    emptyResponse = false,
    // #6459 — input nuevo, default false (back-compat total).
    deliveryUnconfirmed = false,
    _providerOpts = undefined,`],

  [
`  let resultado;
  if (hadError === true || emptyResponse === true || isErrorDisclaimer) {
    resultado = 'error';
  } else if (sherlockVerdict && sherlockVerdict.verdict === 'rechazado') {`,
`  // #6459 — \`error\` GANA a \`huerfano\`. Un turno que falló Y no entregó es
  // \`error\`: el operador necesita saber que falló. \`huerfano\` describe "se
  // ejecutó entero y la respuesta se perdió", que es semánticamente distinto —
  // la misma razón por la que UX-3 prohíbe reusar \`--danger\` para el badge.
  //
  // La receta del arquitecto acota la guarda a \`hadError !== true\`; acá se
  // extiende a TODAS las condiciones de error (\`emptyResponse\` y el disclaimer
  // F-5/F-6 también son "falló"), que es lo que dice su propia justificación.
  // Con el caller real de \`pulpo.js\` los dos textos coinciden: \`emptyResponse\`
  // implica que no hubo respuesta que entregar, así que \`deliveryUnconfirmed\`
  // llega \`false\`. La diferencia sólo se observa desde el clasificador puro, y
  // ahí la versión estricta es la que respeta la precedencia declarada.
  const hayCondicionDeError = hadError === true || emptyResponse === true || isErrorDisclaimer;

  let resultado;
  if (hayCondicionDeError) {
    resultado = 'error';
  } else if (deliveryUnconfirmed === true) {
    resultado = 'huerfano';
  } else if (sherlockVerdict && sherlockVerdict.verdict === 'rechazado') {`],
]);
