// =============================================================================
// render.js — Renderer de REFERENCIA del aviso de vencimiento de sesión
//             (#6239, UX)
//
// Traduce una decisión ya tomada por el chequeo periódico en (a) el payload
// exacto que se le pasa a `notifyTelegram` y (b) la línea de sesión del
// dashboard. Este archivo es el contrato de UX: si el texto que emite
// producción difiere del que emite este renderer, el que está mal es
// producción.
//
// Propiedades que NO se negocian:
//   - PURA: sin I/O de red, sin lectura de credenciales, sin `Date.now()`
//     adentro. La vigencia entra por parámetro. La única excepción está
//     acotada y documentada en `buildFinalMessage`, que NO es producción.
//   - Vocabulario cerrado: todo string visible sale de `copy.json` (UX-5).
//     Nada de texto hardcodeado acá. Lo único que este módulo produce es el
//     lapso formateado que se interpola en el único slot del mensaje (UX-6.3).
//   - Fail-closed de enums: un `aviso` desconocido NO se inventa ni se degrada
//     a un texto genérico: tira error. Un aviso mudo es mejor que un aviso
//     equivocado (UX-4).
//   - Nunca se agrega `payload.context` (UX-6.4).
//
// Uso desde producción:
//   const COPY = require('../../assets/copy/oauth-session-expiry/copy.json');
//   ...y portar esta lógica, o requerir este módulo directamente.
// =============================================================================

'use strict';

const os = require('os');
const COPY = require('./copy.json');

const AVISOS = [
    'A1_por_vencer',
    'A2_urgente',
    'A3_chequeo_sin_datos',
    'A4_chequeo_recuperado',
    'A5_renovada',
];

// Orden de lectura del dashboard, de más sano a menos (UX-8).
const ESTADOS_DASHBOARD = ['vigente', 'por_vencer', 'urgente', 'vencida', 'sin_datos'];

// Umbrales de UX-8. Están acá y no en `copy.json` porque son comportamiento,
// no texto: el copy describe qué se dice, no cuándo se dice.
const MIN_POR_VENCER = 30;
const MIN_URGENTE = 10;

// Espejo de EMOJI_BY_LEVEL de `.pipeline/lib/notify-telegram.js:92`. Se usa
// SÓLO en `buildFinalMessage`, para auditar el texto final; el copy nunca lo
// repite (UX-6.2).
const EMOJI_BY_LEVEL = Object.freeze({
    error: '\u{1F6A8}',            // emoji de error
    warn: '\u{26A0}\u{FE0F}',      // emoji de advertencia
    info: '\u{2139}\u{FE0F}',      // emoji informativo
});

const MS_POR_MINUTO = 60000;

// Lookup fail-closed: nunca hereda de Object.prototype.
function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, String(key == null ? '' : key));
}

/**
 * Duración legible en español.
 *
 * COPIA FIEL de `formatDurationEs` de `.pipeline/lib/wave-stall-watchdog.js:137`
 * (incluido el `padStart(2, '0')` de los minutos en el tramo h+m).
 *
 * La implementación de PRODUCCIÓN **debe reusar la del pipeline**, no esta
 * copia: UX-12 pide una sola redacción para la misma magnitud en toda la
 * pantalla, y dos implementaciones divergen en el primer retoque. Acá está
 * duplicada únicamente para que este renderer de referencia sea autocontenido
 * y testeable sin arrastrar el watchdog entero.
 *
 * @param {number} ms
 * @returns {string} '8 min' / '27 min' / '3 h' / '5 h 20 min'
 */
function formatDurationEs(ms) {
    const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
    if (total < 60) return `${total} s`;
    const mins = Math.floor(total / 60);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    // Minutos con cero a la izquierda en el tramo h+m ("3 h 05 min"): alinea las
    // duraciones en columna y evita que "3 h 5 min" se lea como un dato a medio
    // escribir. Sin horas, el minuto va pelado ("12 min").
    return m > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
}

// Minutos -> texto. Los minutos negativos (sesión ya vencida) no llegan acá por
// contrato: ese caso es silencio en Telegram (`silencios.ya_vencida`) y estado
// `vencida` sin slot en el dashboard.
function lapsoDeMinutos(min) {
    return formatDurationEs(Math.max(0, Number(min)) * MS_POR_MINUTO);
}

/**
 * Payload de Telegram para un aviso.
 *
 * @param {string} aviso  'A1_por_vencer' | 'A2_urgente' | 'A3_chequeo_sin_datos'
 *                        | 'A4_chequeo_recuperado' | 'A5_renovada'
 * @param {object} datos  { minutesLeft } para los avisos con {RESTANTE},
 *                        { ageMinutes } para el de {ANTIGUEDAD}.
 * @returns {{level:string, component:string, message:string, action:string}}
 *          Listo para `notifyTelegram(payload)`. Sin `context` — nunca (UX-6.4).
 */
function renderTelegram(aviso, datos) {
    if (!AVISOS.includes(aviso) || !has(COPY.telegram, aviso)) {
        // Fail-closed: no hay texto genérico al que caer. Un aviso desconocido
        // es un bug del llamador, no una variante a improvisar.
        throw new Error(`aviso desconocido: ${aviso}`);
    }
    const entrada = COPY.telegram[aviso];
    const d = datos || {};

    let message = entrada.message;
    if (message.includes('{RESTANTE}')) {
        if (!Number.isFinite(d.minutesLeft)) {
            throw new Error(`${aviso} necesita minutesLeft para resolver {RESTANTE}`);
        }
        message = message.replace('{RESTANTE}', lapsoDeMinutos(d.minutesLeft));
    }
    if (message.includes('{ANTIGUEDAD}')) {
        if (!Number.isFinite(d.ageMinutes)) {
            throw new Error(`${aviso} necesita ageMinutes para resolver {ANTIGUEDAD}`);
        }
        message = message.replace('{ANTIGUEDAD}', lapsoDeMinutos(d.ageMinutes));
    }

    // `action` no lleva slots (UX-6.3): se devuelve tal cual está en el copy.
    return {
        level: entrada.level,
        component: COPY.telegram.component,
        message,
        action: entrada.action,
    };
}

/**
 * Línea de sesión del dashboard (clase `prov-session`, UX-9). Nunca se oculta:
 * la ausencia de dato también es un estado (UX-8).
 *
 * @param {object} lectura { available: boolean, minutesLeft: number }
 * @returns {{estado:string, texto:string, tono:string, title:string}}
 */
function renderDashboard(lectura) {
    const l = lectura || {};
    const min = Number(l.minutesLeft);

    // Umbrales de UX-8, en orden. `available:false` gana siempre: sin lectura no
    // se puede afirmar nada sobre la vigencia, ni buena ni mala.
    let estado;
    if (l.available === false || !Number.isFinite(min)) estado = 'sin_datos';
    else if (min <= 0) estado = 'vencida';
    else if (min <= MIN_URGENTE) estado = 'urgente';
    else if (min <= MIN_POR_VENCER) estado = 'por_vencer';
    else estado = 'vigente';

    const def = COPY.dashboard.estados[estado];
    const texto = def.texto.includes('{RESTANTE}')
        ? def.texto.replace('{RESTANTE}', lapsoDeMinutos(min))
        : def.texto;

    return { estado, texto, tono: def.tono, title: COPY.dashboard.titles[estado] };
}

/**
 * Reproduce el texto FINAL que ve el operador, tal como lo compone
 * `buildMessage` de `.pipeline/lib/notify-telegram.js:168` para un payload sin
 * `context`, sin `diag` y sin `detail`:
 *
 *     <emoji> <component>: <message>
 *     (línea en blanco)
 *     emisor: pid=... host=... ts=...
 *     (línea en blanco)
 *     <action>
 *
 * Existe SÓLO para inspección y validación: permite auditar el resultado
 * completo (largo real, emoji único, ausencia de `clave: valor` de contexto).
 * NO es para producción — producción llama a `notifyTelegram(payload)` y deja
 * que el canal arme el texto. Es la única función impura del módulo, y su
 * impureza (pid/host/ts) es inyectable para poder testearla.
 *
 * @param {object} payload salida de `renderTelegram`
 * @param {object} [opts]  { pid, hostname, ts } para congelar el emisor
 * @returns {string}
 */
function buildFinalMessage(payload, opts) {
    const p = payload || {};
    const o = opts || {};
    const level = p.level || 'info';
    const emoji = has(EMOJI_BY_LEVEL, level) ? EMOJI_BY_LEVEL[level] : EMOJI_BY_LEVEL.info;
    const pid = o.pid != null ? o.pid : process.pid;
    const host = o.hostname != null ? o.hostname : os.hostname();
    const ts = o.ts != null ? o.ts : new Date().toISOString();

    const lines = [];
    lines.push(`${emoji} ${p.component || 'pipeline'}: ${p.message || '(sin descripción)'}`);
    lines.push('');
    lines.push(`emisor: pid=${pid} host=${host} ts=${ts}`);
    lines.push('');
    if (p.action) {
        lines.push(p.action);
        lines.push(''); // `buildMessage` deja esta línea vacía; se replica igual.
    }
    return lines.join('\n');
}

module.exports = {
    formatDurationEs,
    renderTelegram,
    renderDashboard,
    buildFinalMessage,
    AVISOS,
    ESTADOS_DASHBOARD,
    MIN_POR_VENCER,
    MIN_URGENTE,
    EMOJI_BY_LEVEL,
    COPY,
};
