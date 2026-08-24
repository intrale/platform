// =============================================================================
// render.js — Renderer de REFERENCIA del aviso de respuesta perdida (#6440, UX)
//
// Traduce una decisión YA TOMADA por el detector (este pedido se ejecutó y su
// entrega no está confirmada) en (a) el texto exacto que lee el operador y
// (b) el dropfile que se encola en la cola de filesystem de Telegram.
//
// Este archivo es el contrato de UX: si el texto que emite producción difiere
// del que emite este renderer, el que está mal es producción.
//
// Propiedades que NO se negocian:
//   - PURA: sin I/O, sin `Date.now()` adentro. El reloj entra por parámetro.
//     La única excepción es `buildDropfile`, que sólo arma un objeto.
//   - Vocabulario cerrado: todo string visible sale de `copy.json` (UX-4).
//     Lo único que este módulo produce es el formato de fecha/hora/lapso.
//   - Fail-closed de enums: un aviso desconocido NO se degrada a un texto
//     genérico — tira error. Un aviso mudo es mejor que un aviso equivocado.
//   - NUNCA se interpola contenido del pedido ni de la respuesta: sólo el
//     identificador de la sesión y sus marcas de tiempo (UX-4.3 / #3951).
//
// Uso desde producción:
//   const COPY = require('../../assets/copy/orphan-turn/copy.json');
//   ...y portar esta lógica, o requerir este módulo directamente.
// =============================================================================

'use strict';

const COPY = require('./copy.json');

const AVISOS = Object.freeze([
    'H1_respuesta_perdida',
    'H2_entrega_no_verificable',
    'H3_varias_respuestas_perdidas',
]);

const MS_MINUTO = 60000;
const MS_HORA = 3600000;
const MS_DIA = 86400000;

// Lookup fail-closed: nunca hereda de Object.prototype.
function pick(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

// --- Formato de tiempo -------------------------------------------------------

function dosDigitos(n) {
    return String(n).padStart(2, '0');
}

/**
 * "DD/MM HH:MM" en la hora local del proceso — que es la del operador, porque
 * el Pulpo corre en su máquina. NO se muestra la zona: agregar "-03" no le
 * aporta nada a quien lee y le da al mensaje textura de log.
 */
function formatFechaHora(ms) {
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) throw new Error('formatFechaHora: marca de tiempo inválida');
    return `${dosDigitos(d.getDate())}/${dosDigitos(d.getMonth() + 1)} `
        + `${dosDigitos(d.getHours())}:${dosDigitos(d.getMinutes())}`;
}

/** "HH:MM" — el titular sólo necesita la hora; la fecha completa va abajo. */
function formatHora(ms) {
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) throw new Error('formatHora: marca de tiempo inválida');
    return `${dosDigitos(d.getHours())}:${dosDigitos(d.getMinutes())}`;
}

/**
 * Lapso transcurrido, con el contrato de `copy.json → antiguedad`.
 * Un lapso redondo se dice "hace 6 h", no "hace 6 h 0 min".
 */
function formatAntiguedad(ms) {
    const A = COPY.antiguedad;
    const delta = Number(ms);
    if (!Number.isFinite(delta) || delta < MS_MINUTO) return A.menos_de_un_minuto;
    if (delta < MS_HORA) return A.minutos.replace('{N}', String(Math.floor(delta / MS_MINUTO)));
    if (delta < MS_DIA) {
        const h = Math.floor(delta / MS_HORA);
        const m = Math.floor((delta % MS_HORA) / MS_MINUTO);
        return m > 0
            ? A.horas.replace('{H}', String(h)).replace('{M}', dosDigitos(m))
            : A.horas_exactas.replace('{H}', String(h));
    }
    const d = Math.floor(delta / MS_DIA);
    const h = Math.floor((delta % MS_DIA) / MS_HORA);
    return A.dias.replace('{D}', String(d)).replace('{H}', String(h));
}

// --- Identificador de sesión -------------------------------------------------

/**
 * El identificador viaja CRUDO. Lo único que se valida es la forma: si no
 * matchea, no se emite el aviso — un identificador inventado o adulterado
 * manda al operador a buscar un registro que no existe, y de paso es el vector
 * de forja que SEC-1 describe. Fail-closed.
 */
const SESION_RE = /^[A-Za-z0-9_-]{1,64}$/;

function assertSesion(sesion) {
    if (typeof sesion !== 'string' || !SESION_RE.test(sesion)) {
        throw new Error(`render: identificador de sesión inválido (${String(sesion).slice(0, 32)})`);
    }
    return sesion;
}

/**
 * Lista de sesiones para el aviso consolidado. Muestra hasta
 * `max_items_listados` y resume el resto — el operador no lee una columna de
 * 12 identificadores, y un mensaje que hay que scrollear se ignora entero.
 */
function formatListaSesiones(pedidos) {
    const I = COPY.identificador;
    const items = pedidos.map((p) => I.item
        .replace('{SESION}', assertSesion(p.sesion))
        .replace('{FECHA_HORA}', formatFechaHora(p.iniciadoEn)));
    const visibles = items.slice(0, I.max_items_listados);
    const sobran = items.length - visibles.length;
    let texto = visibles.join(I.separador);
    if (sobran > 0) texto += I.resto.replace('{N}', String(sobran));
    return `${texto}.`;
}

// --- Render ------------------------------------------------------------------

/**
 * Texto visible del aviso.
 *
 * @param {string} aviso  uno de AVISOS
 * @param {object} datos
 *   H1/H2: { sesion, iniciadoEn (ms) }
 *   H3:    { pedidos: [{ sesion, iniciadoEn }] }  (2 o más)
 * @param {object} opts   { now } — reloj inyectado, obligatorio (pureza)
 * @returns {string}
 */
function renderAviso(aviso, datos, opts) {
    const def = pick(COPY.avisos, aviso);
    if (!def) throw new Error(`render: aviso desconocido (${String(aviso)})`);

    const now = opts && Number.isFinite(opts.now) ? opts.now : null;
    if (now == null) throw new Error('render: falta `now` — el renderer es puro');

    const marcador = pick(COPY.marcadores, def.marcador);
    if (!marcador) throw new Error(`render: marcador desconocido (${String(def.marcador)})`);

    const plantilla = pick(COPY.plantillas, def.plantilla);
    if (!plantilla) throw new Error(`render: plantilla desconocida (${String(def.plantilla)})`);

    let titular = def.titular;
    let identificador = def.identificador;

    if (aviso === 'H3_varias_respuestas_perdidas') {
        const pedidos = Array.isArray(datos && datos.pedidos) ? datos.pedidos : [];
        if (pedidos.length < 2) {
            throw new Error('render: el aviso consolidado exige 2 pedidos o más');
        }
        titular = titular.replace('{CANTIDAD}', String(pedidos.length));
        identificador = identificador.replace('{LISTA_SESIONES}', formatListaSesiones(pedidos));
    } else {
        const sesion = assertSesion(datos && datos.sesion);
        const iniciadoEn = Number(datos && datos.iniciadoEn);
        titular = titular.replace('{HORA}', formatHora(iniciadoEn));
        identificador = identificador
            .replace('{SESION}', sesion)
            .replace('{FECHA_HORA}', formatFechaHora(iniciadoEn))
            .replace('{ANTIGUEDAD}', formatAntiguedad(now - iniciadoEn));
    }

    return plantilla
        .replace('{MARCADOR}', marcador)
        .replace('{TITULAR}', titular)
        .replace('{CONSECUENCIA}', def.consecuencia)
        .replace('{DONDE_MIRAR}', def.donde_mirar || '')
        .replace('{IDENTIFICADOR}', identificador);
}

/**
 * Dropfile para la cola de filesystem de Telegram.
 *
 * Se usa el MISMO camino que cualquier respuesta del Commander
 * (`servicios/telegram/pendiente`, dropfile `-cmd.json`), no el de las alertas
 * de operación: `notifyTelegram` antepone "componente: " y agrega una línea de
 * emisor con pid/host/ts. Ese encuadre lee como una falla interna del sistema
 * y es jerga explícitamente prohibida por CA-12 — además de que su destino
 * está anclado a un único chat, incompatible con CA-13.
 *
 * `plain: true` es explícito (no la ausencia de `parse_mode`): el servicio de
 * Telegram hace `data.parse_mode || 'Markdown'`, así que omitirlo reinyecta
 * Markdown y el identificador con guiones bajos rompería el envío.
 *
 * @param {string} texto    salida de renderAviso
 * @param {string} chatId   destino YA resuelto y validado por el caller (CA-13)
 */
function buildDropfile(texto, chatId) {
    if (typeof texto !== 'string' || texto.length === 0) {
        throw new Error('buildDropfile: texto vacío');
    }
    if (typeof chatId !== 'string' || !/^-?[1-9]\d*$/.test(chatId)) {
        throw new Error('buildDropfile: destino inválido — sin destino no se encola');
    }
    return { text: texto, plain: true, chat_id: chatId };
}

module.exports = {
    COPY,
    AVISOS,
    renderAviso,
    buildDropfile,
    formatAntiguedad,
    formatFechaHora,
    formatHora,
    formatListaSesiones,
    SESION_RE,
};
