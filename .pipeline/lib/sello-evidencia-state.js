// #6498 — Resolver puro del estado del sello de evidencia de QA para el badge
// del dashboard V3 y para la ficha de decision.
//
// CONTEXTO (split de #6475, parte 3 de 5)
// --------------------------------------
// El sellado de la evidencia de QA (#6495) y la caducidad del veredicto en
// delivery (#6496) producen cuatro estados observables. Este modulo es la
// FUENTE UNICA del mapeo estado -> icono -> copy -> clase CSS, y la unica
// autoridad sobre que se considera un estado valido.
//
// La regla dura del issue: el ROJO (--danger + ic-estado-needs-human) queda
// reservado EXCLUSIVAMENTE al escalado tras agotar los reintentos. Todo el
// camino de reparacion automatica se comunica en ambar de reintento, porque
// "caduco" NO es un error: es una auto-reparacion exitosa. Si se pinta igual
// que `needs-human`, el operador sigue interviniendo a mano donde el pipeline
// se cura solo — que es, literalmente, el defecto que esta historia cierra.
//
// MODULO PURO
// -----------
// Sin `fs`, sin `path`, sin require del dashboard ni del pulpo. El I/O
// (readSealRetries / hasOpenRequeue de `qa-evidence-seal.js`, y la lectura del
// bloque `sello:` del dropfile) lo hace el llamador y le pasa el resultado ya
// leido. Asi el resolver se testea con `node --test` aislado y `decision-card.js`
// (modulo puro por contrato) puede importarlo sin arrastrarse dependencias.
//
// DIRECCION DEL REQUIRE (obligatoria, R-6 de la receta):
//   decision-card.js  ->  sello-evidencia-state.js
// NUNCA al reves: invertirlo crea un ciclo y le mete al dashboard la superficie
// de Telegram.

'use strict';

/**
 * Allowlist CERRADA de estados (CA-1). Cualquier valor fuera de esta lista no
 * se renderiza: `resolveSelloEvidenciaState` devuelve `null`, nunca hace
 * passthrough del valor leido del YAML.
 */
const SELLO_ESTADOS = Object.freeze(['sellado', 'caduco', 're-sellando', 'escalado']);

/**
 * Estado -> nombre del simbolo del sprite (SIN el prefijo `ic-`, que lo agrega
 * el helper `ic()` del dashboard).
 *
 * Nota `caduco` -> `estado-stale`: es lo que pide CA-2 verbatim. UX-G4 declaro
 * como PREFERENCIA no bloqueante usar `ic-retry-clock` para evitar dos relojes
 * adyacentes en la misma fila, y dejo explicito que "mantener ic-estado-stale
 * es una implementacion aceptable y no debe ser motivo de rebote". Se elige el
 * criterio vinculante (CA-2) y se documenta la decision para que sea consciente
 * y no un descuido. El glifo se comparte con el badge de inactividad; lo que
 * NO se comparte es el color ni el copy (R-1): clase propia `.lc-state-sello-*`.
 *
 * Esta tabla es documental/testeable: el renderer usa un `switch` con literales
 * y `default: return ''`, porque `ic()` interpola su argumento CRUDO en
 * `href="#ic-${name}"` y un nombre derivado por concatenacion seria un sink de
 * inyeccion (SEC-2 / CA-9 / R-3).
 */
const SELLO_ICONOS = Object.freeze({
  'sellado': 'info',
  'caduco': 'estado-stale',
  're-sellando': 'estado-retrying',
  'escalado': 'estado-needs-human',
});

/**
 * Estado -> slug de clase CSS. `re-sellando` lleva guion, que no se interpola
 * crudo en `class=`: se normaliza aca.
 */
const SELLO_CSS_KEYS = Object.freeze({
  'sellado': 'sellado',
  'caduco': 'caduco',
  're-sellando': 'resellando',
  'escalado': 'escalado',
});

/**
 * Copy COMPLETO (UX-G3): es el que emite `aria-label` (lo que oye un lector de
 * pantalla), el que emite `title` (el tooltip) y el que va entero a la ficha de
 * decision, donde hay espacio. Verbatim del PO (CA-2 / CA-3 / CA-4).
 *
 * `sellado-descarte` es la VARIANTE de SEC-1: no es un quinto estado (el
 * contrato con #6495/#6496 se queda en 4 valores cerrados), se deriva del
 * booleano `hashDeclaradoDescartado`. Mismo token y mismo icono que `sellado`
 * — el rojo sigue reservado al escalado —; la senal es el COPY, que es lo que
 * SEC-1 pide: distinguible y auditable.
 */
const SELLO_COPY = Object.freeze({
  'sellado': 'Evidencia sellada por el pipeline',
  'sellado-descarte': 'El sello declarado no coincidía con el archivo — se usó el archivo real',
  'caduco': 'Evidencia desactualizada — se repite la verificación',
  're-sellando': 'Reintentando el sellado ({intento} de {max})',
  'escalado': 'No se pudo sellar la evidencia — necesita revisión',
});

/**
 * Registro CORTO (UX-G3, vinculante): lo unico que se pinta como texto visible
 * del pill. La fila `.lc-state-row` esta normalizada en <= 11 caracteres
 * visibles (`CROSS N`, `rebote N`, `needs-human`, `Nm`); un pill de 52 chars
 * empuja al resto a una segunda linea y rompe la lectura de un vistazo.
 *
 * Los cinco registros son distinguibles entre si SIN percibir color, que es lo
 * que protege CA-5/UX-2: en deuteranopia `--retry` y `--danger` colapsan a
 * 1.44:1, o sea el mismo color. Para ese operador el icono y esta etiqueta no
 * son refuerzo: son la unica senal existente.
 */
const SELLO_COPY_CORTO = Object.freeze({
  'sellado': 'sellada',
  'sellado-descarte': 'sello corregido',
  'caduco': 'se repite',
  're-sellando': 'resellando {intento}/{max}',
  'escalado': 'sin sello',
});

/**
 * Capa secundaria del tooltip, en LENGUAJE DE OPERADOR.
 *
 * El bloque `sello:` real del dropfile es jerga pura (`head`, `sha256`,
 * `artefactos`) y el `title` del badge ES superficie primaria: lo lee el
 * operador al pasar el mouse y lo anuncian varios lectores de pantalla. Por eso
 * el detalle se REDACTA, nunca se serializa el bloque (CA-6 / CA-10 / SEC-3).
 * Sin rutas, sin hashes, sin URLs: nada que pueda filtrar informacion del host.
 */
const SELLO_DETALLE = Object.freeze({
  'sellado': 'El pipeline verificó la evidencia contra el archivo real antes de dar por buena la revisión.',
  'sellado-descarte': 'Lo que el agente declaró no coincidía con el archivo entregado; se tomó el archivo real y quedó registrado.',
  'caduco': 'La revisión anterior habla de una versión del código que ya cambió. El pipeline la repite solo: no hace falta intervenir.',
  're-sellando': 'El pipeline ya pidió repetir la revisión y está esperando el resultado. Intento {intento} de {max}.',
  'escalado': 'Se agotaron los {max} intentos automáticos. Hace falta que alguien mire por qué la revisión no queda firme.',
});

/**
 * Tope de reintentos por defecto. Espeja `MAX_SEAL_REQUEUES` de
 * `qa-evidence-seal.js` (=== 2). El llamador PASA el valor real en
 * `selloState.maxIntentos` para que no puedan divergir; este default sólo
 * cubre el caso de que el módulo emisor no esté disponible.
 */
const MAX_INTENTOS_DEFAULT = 2;

/** Términos de jerga prohibidos en la superficie primaria (CA-6). Exportado para el test. */
const JERGA_PROHIBIDA = Object.freeze(['sha256', 'dropfile', 'head', 'seal', 'manifest', 'freshness']);

/** Interpola SÓLO enteros ya validados. Un placeholder sin dato colapsa a vacío. */
function interp(tpl, vars) {
  return String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars ? vars[k] : undefined;
    return Number.isInteger(v) ? String(v) : '';
  });
}

function esEnteroNoNegativo(v) {
  return Number.isInteger(v) && v >= 0;
}

/**
 * ¿Algún dropfile terminal del issue trae el bloque `sello:` de #6495?
 *
 * Recibe la MISMA estructura que el dashboard guarda en
 * `state.issueMatrix[issue].fases`: mapa `${pipeline}/${fase}` -> array de
 * entries. El scanner del dashboard expone campos DERIVADOS del bloque
 * (`entry.sello = { presente, descartes }`), nunca el objeto crudo: así ni la
 * ruta ni el hash llegan a esta capa y CA-10/SEC-3 se cumple por construcción.
 *
 * @returns {{presente: boolean, descartes: number}|null}
 */
function selloPersistido(fasesByKey) {
  if (!fasesByKey || typeof fasesByKey !== 'object') return null;
  let presente = false;
  let descartes = 0;
  for (const entries of Object.values(fasesByKey)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const s = entry && entry.sello;
      if (!s || typeof s !== 'object' || s.presente !== true) continue;
      presente = true;
      if (esEnteroNoNegativo(s.descartes) && s.descartes > descartes) descartes = s.descartes;
    }
  }
  return presente ? { presente: true, descartes } : null;
}

/**
 * Estado consolidado del sello de evidencia para un issue.
 *
 * PRIORIDAD (fija, la de la receta del arquitecto):
 *   escalado > re-sellando > caduco > sellado > null
 *
 * `null` significa CERO BADGE: un issue sin sello y sin reintentos no muestra
 * nada. Es el mismo criterio que `resolveArchitectState` (regla 4) y es lo que
 * cumple "cero ruido en el camino feliz" (UX-7 de #6475).
 *
 * @param {Object<string, Array<Object>>} fasesByKey
 *   `state.issueMatrix[issue].fases`. Fuente de lo PERSISTIDO (`sellado`).
 * @param {Object} [selloState]
 *   Estado TRANSITORIO ya leído del filesystem por el llamador:
 *     - `intentos`        {number}  contador de `readSealRetries()`.
 *     - `requeueAbierto`  {boolean} resultado de `hasOpenRequeue()`.
 *     - `maxIntentos`     {number}  `MAX_SEAL_REQUEUES` real del emisor.
 *     - `estado`          {string}  OPCIONAL. Override explícito del emisor.
 *                                   Si viene y no está en la allowlist => null.
 * @returns {{
 *   estado: string, cssKey: string, icono: string, copy: string,
 *   copyCorto: string, detalle: string, variante: string|null,
 *   intento: number|null, maxIntentos: number
 * }|null}
 */
function resolveSelloEvidenciaState(fasesByKey, selloState) {
  const st = (selloState && typeof selloState === 'object' && !Array.isArray(selloState))
    ? selloState
    : {};

  const max = (Number.isInteger(st.maxIntentos) && st.maxIntentos > 0)
    ? st.maxIntentos
    : MAX_INTENTOS_DEFAULT;
  const intentos = esEnteroNoNegativo(st.intentos) ? st.intentos : 0;
  const requeueAbierto = st.requeueAbierto === true;
  const persistido = selloPersistido(fasesByKey);

  let estado = null;
  let intento = null;

  if (st.estado !== undefined && st.estado !== null) {
    // Override explícito del emisor. Fail-closed: un valor fuera de la
    // allowlist NO cae al camino derivado ni se renderiza — se descarta.
    // Nunca passthrough (CA-1 / CA-9): el estado viene de un YAML escrito por
    // un agente y `ic()` no escapa su argumento.
    if (typeof st.estado !== 'string' || !SELLO_ESTADOS.includes(st.estado)) return null;
    estado = st.estado;
    if (estado === 're-sellando') {
      intento = esEnteroNoNegativo(st.intento) && st.intento > 0
        ? Math.min(st.intento, max)
        : Math.min(Math.max(intentos, 1), max);
    }
  } else if (intentos >= max) {
    // Incluye `corrupto: true`, que `readSealRetries` ya devuelve como agotado:
    // un contador que se resetea corrompiéndolo no acota nada.
    estado = 'escalado';
  } else if (intentos > 0 && requeueAbierto) {
    estado = 're-sellando';
    intento = intentos;
  } else if (intentos > 0) {
    // Hubo caducidad y la orden de re-verificación ya fue consumida.
    estado = 'caduco';
  } else if (persistido) {
    estado = 'sellado';
  }

  if (!estado) return null;

  // Variante SEC-1: mismo estado, mismo token, mismo icono — copy distinto.
  const variante = (estado === 'sellado' && persistido && persistido.descartes > 0)
    ? 'descarte'
    : null;
  const clave = variante === 'descarte' ? 'sellado-descarte' : estado;
  const vars = { intento, max };

  return {
    estado,
    cssKey: SELLO_CSS_KEYS[estado],
    icono: SELLO_ICONOS[estado],
    copy: interp(SELLO_COPY[clave], vars),
    copyCorto: interp(SELLO_COPY_CORTO[clave], vars),
    detalle: interp(SELLO_DETALLE[clave], vars),
    variante,
    intento,
    maxIntentos: max,
  };
}

module.exports = {
  resolveSelloEvidenciaState,
  selloPersistido,
  SELLO_ESTADOS,
  SELLO_ICONOS,
  SELLO_CSS_KEYS,
  SELLO_COPY,
  SELLO_COPY_CORTO,
  SELLO_DETALLE,
  MAX_INTENTOS_DEFAULT,
  JERGA_PROHIBIDA,
};
