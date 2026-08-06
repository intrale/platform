#!/usr/bin/env node
// =============================================================================
// vault-shadow-status.js — estado de la ventana sombra del vault, para operar
// (#5449 · entrega 2/3 del split de #5427)
// =============================================================================
//
// Qué resuelve
// ------------
// #5448 dejó el núcleo que decide, con evidencia, si se puede retirar la vía
// vieja de resolución de credenciales. Este comando es la única superficie
// pensada para que una persona o un job de CI lea esa decisión sin abrir un
// JSONL de auditoría:
//
//   $ node .pipeline/vault-shadow-status.js ; echo "exit=$?"
//
// Frontera: ADAPTADOR, no evaluador (CA-1)
// ----------------------------------------
// Todo el criterio vive en `lib/vault-shadow-metrics.js`. Acá NO se lee ni se
// reinterpreta `vault-resolution.jsonl`, ni t0, ni el sidecar `.integrity`, ni
// se reconstruye la regla de ventana. Este archivo sólo traduce el resultado
// estructurado de `evaluate()` a texto y a un exit code. Dos implementaciones de
// la misma regla divergen en silencio, y la evidencia que sostiene el retiro del
// fallback no admite una segunda opinión.
//
// Sí se leen dos entradas que `evaluate()` recibe POR PARÁMETRO y no sabe
// obtener por su cuenta: `ENV_DESCRIPTORS` (símbolo público de `credentials.js`,
// denominador de secretos) y `vault.shadow_window` de `config.yaml` por la vía
// estándar del pipeline (`config-resolver`). Leerlas no es reinterpretar la
// evidencia: sin ellas `evaluate()` devuelve `descriptores_ausentes` /
// `hosts_activos_no_array` siempre.
//
// Efectos de `evaluate()` — el comando no muta nada, el núcleo sí (CA-10)
// ----------------------------------------------------------------------
// Este comando no agrega ninguna escritura propia, no abre red, no publica y no
// levanta servidor. Pero `evaluate()` del núcleo NO es de sólo lectura y hay que
// saberlo antes de correrlo en un host nuevo:
//
//   - si falta `vault-resolution.t0.json`, lo CREA: correr el comando en un host
//     sin t0 ARRANCA la ventana. Esa misma evaluación devuelve `t0_reiniciado` y
//     nunca aprueba, y un t0 válido jamás se mueve;
//   - `purgar()` reescribe el JSONL por retención, con un límite que nunca
//     supera t0 (no puede borrar evidencia de la ventana vigente).
//
// Fail-closed (CA-4) — la razón por la que el default no es "todo bien"
// ---------------------------------------------------------------------
// El veredicto sale de una ALLOWLIST de un solo elemento: únicamente el estado
// explícito `cumple` produce `CUMPLE` y exit code 0. Cobertura incompleta,
// configuración inválida, t0 reiniciado, integridad comprometida, un estado que
// este comando no conoce y cualquier excepción producen `NO CUMPLE` y código
// distinto de cero. `no_verificado` NO es "no hay datos, todo bien": es bloqueo.
// El costo de los dos errores no es simétrico — un falso `CUMPLE` habilita
// retirar el fallback de credenciales y deja secretos sin resolver en producción.
//
// Seguridad de la salida (CA-8 / CA-9)
// ------------------------------------
// Se renderiza por ALLOWLIST de campos (nombres lógicos, hosts, vías, conteos y
// timestamps — lo que CA-15 ya autoriza). Nunca se serializa el resultado
// completo, ni filas crudas, ni `process.env`, ni `error.stack`, ni el contenido
// del sidecar de integridad. Todo texto visible pasa por `textoSeguro()`, que
// escapa controles C0/C1, DEL, CR/LF y separadores/bidi Unicode: un `host` o un
// motivo con `\r\n` podría FALSIFICAR una línea `CUMPLE` en un log de CI, y una
// secuencia ESC podría borrar líneas o pintar la salida. Las excepciones se
// reportan por categoría estable (`name/code` con forma validada), nunca por
// mensaje.
//
// La salida no depende del color ni de la posicion del cursor: `stdout` lleva el
// reporte automatizable, `stderr` queda para la falla operativa, y el exit code
// es parte del contrato. Sin ANSI, sin spinners, sin emojis. El unico caracter
// no-ASCII que se emite es el guion largo del separador `CUMPLE - motivo`, que
// los criterios piden literal.
//
// Exit codes
// ----------
//   0 — CUMPLE (estado explícito `cumple`)
//   1 — NO CUMPLE (cualquier otro estado del núcleo, incluido uno desconocido)
//   2 — NO CUMPLE por falla al evaluar (excepción) o resultado no utilizable
// =============================================================================

'use strict';

const path = require('path');

const { ESTADO } = require('./lib/vault-shadow-metrics');

const EXIT = Object.freeze({ CUMPLE: 0, NO_CUMPLE: 1, ERROR: 2 });

/** Literal exigido por CA-6. No se reformula ni se traduce. */
const LEYENDA = 'resoluciones = evaluaciones de precedencia, no usos';

const SIN_DATO = '(sin dato)';
const LARGO_MAX = 200;

// -----------------------------------------------------------------------------
// Render seguro de texto — CA-8
// -----------------------------------------------------------------------------

// Controles y caracteres invisibles que pueden falsificar lineas, mover el
// cursor o reordenar visualmente lo escrito. Tanto la tabla como la clase se
// escriben con notacion escapada A PROPOSITO: un control LITERAL en el fuente
// es invisible al leer el diff y no sobrevive a un copiado.
//
//   U+0000-U+001F  C0 (incluye NUL, TAB, CR, LF y ESC)
//   U+007F         DEL
//   U+0080-U+009F  C1 (incluye NEL y el CSI de 8 bits)
//   U+00AD         soft hyphen (invisible)
//   U+061C         arabic letter mark (bidi)
//   U+200B-U+200F  espacios de ancho cero y marcas LRM/RLM
//   U+2028-U+2029  separadores de linea y de parrafo (rompen la linea en JS y
//                  en varios visores de logs)
//   U+202A-U+202E  overrides bidi (reordenan la linea a la vista)
//   U+2060-U+2064  invisibles de formato
//   U+2066-U+2069  aislantes bidi
//   U+FEFF         BOM / zero-width no-break space
const CONTROLES_RE = new RegExp(
  '[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028\u2029'
  + '\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]',
  'g',
);

// Forma admitida para una categoría de error. Deliberadamente ESTRECHA: cubre
// todo `err.name` y `err.code` que Node produce (`TypeError`, `ENOENT`,
// `ERR_INVALID_ARG_TYPE`, `MODULE_NOT_FOUND`) y deja afuera separadores,
// puntuación y largos que son típicos de un valor de secreto. No es una
// garantía absoluta —un secreto alfanumérico corto pasaría—, pero `name`/`code`
// los pone el runtime, no el payload: el vector real es `message`/`stack`, y
// esos no se leen nunca. Mismo criterio que `errorSeguro` del núcleo (#5448).
const CATEGORIA_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/**
 * Representación de un control como escape VISIBLE de una sola línea.
 * El resultado es ASCII imprimible: no puede reactivar nada.
 */
function escaparControles(texto) {
  return texto.replace(CONTROLES_RE, (ch) => `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Todo texto que llega a stdout/stderr pasa por acá.
 *
 * Escapa antes de truncar, no al revés: truncar primero podría cortar una
 * secuencia a la mitad y dejar el resto activo en la terminal.
 *
 * @param {*} valor
 * @param {number} [maxLen]
 * @returns {string} una sola línea, ASCII-safe, nunca vacía.
 */
function textoSeguro(valor, maxLen = LARGO_MAX) {
  if (typeof valor === 'number' && Number.isFinite(valor)) return String(valor);
  if (typeof valor !== 'string' || valor.length === 0) return SIN_DATO;

  let t = escaparControles(valor);
  if (t.length > maxLen) {
    t = t.slice(0, maxLen);
    // Un corte puede dejar media pareja subrogada suelta: se descarta el resto
    // en vez de emitir un carácter mal formado.
    if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1);
    t += '...[truncado]';
  }
  return t;
}

/** Número visible. Un valor no finito no se muestra como `NaN`/`Infinity`. */
function numeroSeguro(valor, decimales = 0) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return SIN_DATO;
  return Number.isInteger(n) ? String(n) : n.toFixed(decimales > 0 ? decimales : 2);
}

/** Comparación ORDINAL: el orden no puede depender del locale (CA-5). */
function ordinal(a, b) {
  const x = typeof a === 'string' ? a : '';
  const y = typeof b === 'string' ? b : '';
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Lista de entrada: cualquier cosa que no sea array se trata como vacía. */
function comoLista(v) {
  return Array.isArray(v) ? v.filter((e) => e && typeof e === 'object') : [];
}

// -----------------------------------------------------------------------------
// Traducción de motivos — CA-2
// -----------------------------------------------------------------------------
//
// Los `motivo` del núcleo son SLUGS estables (identificadores), no texto para
// una persona. Se traducen por tabla cerrada; un slug que este comando no
// conoce cae en el default y NO se lo trata como benigno.

const MOTIVOS = Object.freeze({
  cobertura_completa: 'cobertura completa en la ventana: cada secreto resolvio por vault en cada host activo, sin evidencia de fallback',
  cobertura_incompleta: 'hay pares (secreto, host) sin ninguna resolucion por vault dentro de la ventana',
  evidencia_negativa: 'hubo al menos una resolucion por fallback dentro de la ventana, asi que la ventana se reinicio',
  ventana_en_curso: 'la cobertura esta completa pero la ventana todavia no cumplio la duracion configurada',
  integridad_comprometida: 'existe el sidecar de integridad: se perdio evidencia negativa y la ventana no puede cerrar',
  t0_reiniciado: 'no habia un inicio de ventana legible, asi que la ventana arranca de nuevo y esta evaluacion no aprueba',
  descriptores_ausentes: 'no se pudo derivar el denominador de secretos de ENV_DESCRIPTORS',
  hosts_activos_no_array: '`vault.shadow_window.hosts_activos` no es una lista en config.yaml',
  hosts_activos_vacio: '`vault.shadow_window.hosts_activos` esta vacia en config.yaml',
  hosts_activos_invalido: '`vault.shadow_window.hosts_activos` tiene un valor que no es un identificador de host valido',
});

const PROXIMOS_PASOS = Object.freeze({
  cobertura_incompleta: 'ejecutar el pipeline en los hosts listados hasta que cada par resuelva por vault, o corregir `vault.shadow_window.hosts_activos` si alguno ya no opera',
  evidencia_negativa: 'revisar por que esos secretos cayeron al fallback antes de volver a esperar la ventana',
  ventana_en_curso: 'esperar a que transcurra la duracion configurada y volver a ejecutar este comando',
  integridad_comprometida: 'auditar `.pipeline/audit/` y recien despues borrar el sidecar de integridad a mano',
  t0_reiniciado: 'volver a ejecutar este comando cuando haya corrido el pipeline: la ventana ya quedo iniciada',
  descriptores_ausentes: 'revisar `ENV_DESCRIPTORS` en `.pipeline/lib/credentials.js`',
  hosts_activos_no_array: 'enumerar en config.yaml los hosts que realmente bootean el pipeline',
  hosts_activos_vacio: 'enumerar en config.yaml los hosts que realmente bootean el pipeline',
  hosts_activos_invalido: 'corregir en config.yaml el host invalido (solo letras, numeros, punto, guion y guion bajo)',
});

const PASO_POR_DEFECTO = 'revisar el estado del nucleo de metricas de la ventana sombra (`.pipeline/lib/vault-shadow-metrics.js`)';

/** Motivo legible. Un slug desconocido se nombra, saneado, sin inventarle sentido. */
function motivoLegible(result) {
  const slug = result && typeof result.motivo === 'string' ? result.motivo : '';
  if (Object.prototype.hasOwnProperty.call(MOTIVOS, slug)) return MOTIVOS[slug];
  const estado = textoSeguro(result && result.estado, 60);
  const motivo = slug ? textoSeguro(slug, 60) : SIN_DATO;
  return `estado no reconocido por este comando (estado=${estado}, motivo=${motivo})`;
}

function proximoPaso(result) {
  const slug = result && typeof result.motivo === 'string' ? result.motivo : '';
  return PROXIMOS_PASOS[slug] || PASO_POR_DEFECTO;
}

/**
 * Categoría estable de una excepción. Nunca el mensaje ni el stack: ahí es
 * donde una excepción arrastra payloads y valores.
 */
function categoriaError(err) {
  if (!err || typeof err !== 'object') return 'error';
  const name = typeof err.name === 'string' && CATEGORIA_RE.test(err.name) ? err.name : 'Error';
  const code = typeof err.code === 'string' && CATEGORIA_RE.test(err.code) ? err.code : null;
  return code ? `${name}/${code}` : name;
}

// -----------------------------------------------------------------------------
// exitCodeFor — CA-3 / CA-4
// -----------------------------------------------------------------------------

/**
 * ALLOWLIST de un solo elemento. Todo lo demás falla cerrado.
 * No usar `!==` contra una lista de estados malos: un estado NUEVO del núcleo
 * entraría por el hueco y se convertiria en exito.
 *
 * @param {object} result resultado de `evaluate()`.
 * @returns {number} 0 sólo para `cumple`.
 */
function exitCodeFor(result) {
  // Un array pasa `typeof === 'object'` y no es un resultado: caeria en
  // NO_CUMPLE (1) haciendo pasar por veredicto lo que en realidad es un
  // contrato roto. Se distingue a proposito del codigo 2.
  if (!result || typeof result !== 'object' || Array.isArray(result)) return EXIT.ERROR;
  return result.estado === ESTADO.CUMPLE ? EXIT.CUMPLE : EXIT.NO_CUMPLE;
}

// -----------------------------------------------------------------------------
// renderStatus — CA-2 / CA-5 / CA-6 / CA-7
// -----------------------------------------------------------------------------

/**
 * Reporte completo, en orden fijo: veredicto y motivo, proximo paso, detalle,
 * pares pendientes, evidencia negativa, datos de ventana, conteos y leyenda.
 *
 * Función PURA: no lee archivos, no escribe, no consulta el reloj. Recibe el
 * resultado de `evaluate()` y devuelve el texto.
 *
 * @param {object} result
 * @returns {string} sin salto de línea final.
 */
function renderStatus(result) {
  const cumple = !!result && result.estado === ESTADO.CUMPLE;
  const lineas = [];

  // 1 · veredicto + motivo, siempre primero y en la misma línea (CA-2).
  lineas.push(`${cumple ? 'CUMPLE' : 'NO CUMPLE'} — ${textoSeguro(motivoLegible(result), 300)}`);
  if (!cumple) lineas.push(`Proximo paso: ${textoSeguro(proximoPaso(result), 300)}`);
  if (result && typeof result.error === 'string' && result.error.length > 0) {
    lineas.push(`Detalle: ${textoSeguro(result.error, 300)}`);
  }

  // 2 · pares pendientes, orden ordinal explícito (CA-5).
  const pendientes = comoLista(result && result.no_verificados)
    .map((p) => ({ name: p.name, host: p.host }))
    .sort((a, b) => ordinal(a.name, b.name) || ordinal(a.host, b.host));
  lineas.push('');
  lineas.push(`Pares (secreto, host) sin resolucion por vault: ${pendientes.length}`);
  if (pendientes.length === 0) lineas.push('  ninguno');
  for (const p of pendientes) {
    lineas.push(`  secreto=${textoSeguro(p.name)} host=${textoSeguro(p.host)}`);
  }

  // 3 · evidencia negativa: es lo que reinicia la ventana, así que el operador
  // necesita verla nombrada, no deducirla del motivo.
  const negativos = comoLista(result && result.negativos)
    .map((n) => ({ name: n.name, host: n.host, via: n.via, ts: n.ts }))
    .sort((a, b) => ordinal(a.name, b.name) || ordinal(a.host, b.host)
      || ordinal(a.via, b.via) || ordinal(a.ts, b.ts));
  lineas.push('');
  lineas.push(`Resoluciones por fallback dentro de la ventana: ${negativos.length}`);
  if (negativos.length === 0) lineas.push('  ninguna');
  for (const n of negativos) {
    lineas.push(`  secreto=${textoSeguro(n.name)} host=${textoSeguro(n.host)} `
      + `via=${textoSeguro(n.via, 40)} ts=${textoSeguro(n.ts, 40)}`);
  }

  // 4 · datos de ventana con unidad y formato explícitos (CA-6).
  const t0 = result && typeof result.t0 === 'string' && result.t0.length > 0
    ? `${textoSeguro(result.t0, 40)} (UTC, ISO-8601)`
    : '(sin inicio de ventana registrado)';
  lineas.push('');
  lineas.push('Ventana');
  lineas.push(`  inicio t0: ${t0}`);
  lineas.push(`  duracion configurada: ${numeroSeguro(result && result.ventana_horas)} h`);
  lineas.push(`  transcurrido desde t0: ${numeroSeguro(result && result.horas_transcurridas, 2)} h`);
  lineas.push(`  secretos en el denominador: ${numeroSeguro(result && result.secretos)}`);

  // 5 · conteos + leyenda, juntos y en ese orden (CA-7 / CA-6). La leyenda sola
  // queda huerfana: si no hay bloque de conteos, no hay leyenda.
  const conteos = comoLista(result && result.conteos)
    .map((c) => ({ name: c.name, host: c.host, via: c.via, resoluciones: c.resoluciones }))
    .sort((a, b) => ordinal(a.name, b.name) || ordinal(a.host, b.host) || ordinal(a.via, b.via));
  lineas.push('');
  lineas.push(`Resoluciones por (secreto, host, via): ${conteos.length}`);
  if (conteos.length === 0) lineas.push('  ninguna');
  for (const c of conteos) {
    lineas.push(`  secreto=${textoSeguro(c.name)} host=${textoSeguro(c.host)} `
      + `via=${textoSeguro(c.via, 40)} resoluciones=${numeroSeguro(c.resoluciones)}`);
  }
  lineas.push(`  ${LEYENDA}`);

  return lineas.join('\n');
}

/** Reporte mínimo cuando ni siquiera hubo resultado. Sin conteos, sin leyenda. */
function renderFallaDeEvaluacion(categoria) {
  return [
    `NO CUMPLE — no se pudo evaluar la ventana sombra (${textoSeguro(categoria, 80)})`,
    'Proximo paso: revisar `vault.shadow_window` en .pipeline/config.yaml y los permisos de .pipeline/audit/',
    '',
    'Sin datos de ventana: la evaluacion no llego a producir un resultado.',
  ].join('\n');
}

// -----------------------------------------------------------------------------
// Evaluador por defecto — las dos entradas que `evaluate()` recibe por parámetro
// -----------------------------------------------------------------------------

/**
 * Arma la llamada real a `evaluate()`. Se importa perezosamente para que los
 * tests de la capa pura no tengan que cargar `credentials.js` ni resolver la
 * configuración del repo.
 *
 * Cualquier falla de lectura PROPAGA: `main()` la convierte en NO CUMPLE con
 * código distinto de cero. Un `catch` con default acá seria fail-open.
 */
function evaluarPorDefecto(opts = {}) {
  const { createVaultShadowMetrics } = require('./lib/vault-shadow-metrics');
  const { ENV_DESCRIPTORS } = require('./lib/credentials');
  const stderr = opts.stderr || process.stderr;
  const pipelineDir = opts.pipelineDir ? path.resolve(opts.pipelineDir) : __dirname;

  const cfg = require('./lib/config-resolver').resolve({ pipelineDir });
  const sw = (cfg && cfg.vault && cfg.vault.shadow_window
    && typeof cfg.vault.shadow_window === 'object' && !Array.isArray(cfg.vault.shadow_window))
    ? cfg.vault.shadow_window
    : {};

  // `createVaultShadowMetrics` y no el singleton `getVaultShadowMetrics`: este
  // comando es una lectura de una sola vez y necesita imponer SU logger. El del
  // nucleo escribe por `console.log`, o sea stdout, donde acá vive el reporte
  // automatizable — una linea de log antes del veredicto rompe CA-2 y le mete
  // ruido a cualquier parser. `autoFlushOnExit: false` porque no se registra
  // nada: no hay buffer que volcar y no corresponde instalar un hook de salida.
  const metrics = createVaultShadowMetrics({
    notify: require('./lib/notify-telegram').notifyTelegram,
    logger: (linea) => {
      try { stderr.write(`${textoSeguro(linea, 600)}
`); } catch (e) { /* best-effort */ }
    },
    autoFlushOnExit: false,
  });

  return metrics.evaluate({
    descriptors: ENV_DESCRIPTORS,
    hostsActivos: sw.hosts_activos,
    durationHours: sw.duration_hours,
    retentionDays: sw.retention_days,
  });
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

/**
 * Ejecuta el reporte y DEVUELVE el exit code. No llama a `process.exit()`: si lo
 * hiciera, importar este módulo desde un test mataría al runner, y una escritura
 * a stdout todavía en vuelo podría perderse.
 *
 * @param {object} [deps]
 * @param {function} [deps.evaluate] evaluador inyectable (tests).
 * @param {{write:function}} [deps.stdout]
 * @param {{write:function}} [deps.stderr]
 * @returns {number} exit code.
 */
function main(deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const evaluate = typeof deps.evaluate === 'function' ? deps.evaluate : evaluarPorDefecto;

  let result;
  try {
    // El evaluador real necesita `stderr` para no ensuciar stdout con sus logs;
    // un evaluador inyectado por un test simplemente ignora el argumento.
    result = evaluate({ stdout, stderr });
  } catch (e) {
    const categoria = categoriaError(e);
    stdout.write(`${renderFallaDeEvaluacion(categoria)}\n`);
    stderr.write(`[vault-shadow-status] ERROR: no se pudo evaluar la ventana sombra (${textoSeguro(categoria, 80)}). `
      + 'Impacto: no hay veredicto de cobertura, asi que se responde NO CUMPLE con codigo 2 (fail-closed) '
      + 'y no se habilita retirar el fallback de credenciales. '
      + 'Proximo paso: revisar `vault.shadow_window` en .pipeline/config.yaml y los permisos de .pipeline/audit/\n');
    return EXIT.ERROR;
  }

  try {
    stdout.write(`${renderStatus(result)}\n`);
  } catch (e) {
    // Un resultado hostil (getters que explotan, formas inesperadas) no puede
    // dejar al comando sin veredicto: se degrada al reporte mínimo y falla.
    const categoria = categoriaError(e);
    stdout.write(`${renderFallaDeEvaluacion(categoria)}\n`);
    stderr.write(`[vault-shadow-status] ERROR: no se pudo renderizar el estado de la ventana sombra (${textoSeguro(categoria, 80)}). `
      + 'Impacto: no hay veredicto legible, asi que se responde NO CUMPLE con codigo 2 (fail-closed). '
      + 'Proximo paso: revisar el contrato de `evaluate()` en .pipeline/lib/vault-shadow-metrics.js\n');
    return EXIT.ERROR;
  }

  return exitCodeFor(result);
}

// Entry point: sólo cuando se ejecuta como comando. `process.exitCode` en vez de
// `process.exit()` para que Node vacie stdout antes de terminar.
if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  main,
  renderStatus,
  renderFallaDeEvaluacion,
  exitCodeFor,
  evaluarPorDefecto,
  textoSeguro,
  categoriaError,
  motivoLegible,
  EXIT,
  LEYENDA,
};
