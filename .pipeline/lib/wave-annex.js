// =============================================================================
// wave-annex.js — Anexo de estado de ola para el camino LLM (#5835).
//
// CONTEXTO
// --------
// #4089 estableció una invariante que sigue vigente: la tabla de estado de la
// ola la produce SIEMPRE el handler determinístico `wave` (vía `wave-renderer`).
// Nadie la reescribe, la resume ni la reconstruye a mano.
//
// #5835 corrige el efecto colateral: una pregunta ANALÍTICA que apenas menciona
// la ola ahora rutea al LLM para que se responda (`classify()` marca
// `waveMentioned`). Este módulo resuelve el otro lado del problema: no perder el
// dato de estado cuando el ruteo va al LLM.
//
// INVARIANTES QUE ESTE MÓDULO SOSTIENE
// ------------------------------------
//  1. El bloque de estado se obtiene TEXTUAL del handler `wave`. Ni una porción
//     proviene del LLM (CA-3 / CA-5).
//  2. Va como MENSAJE(S) SEPARADO(S) con `parseMode: 'MarkdownV2'` — nunca
//     concatenado al texto del LLM, que sale en 'Markdown' (default, #4130).
//     Concatenar mostraría los escapes literales (`\.`, `\-`) dentro del cuadro.
//     Como bonus, siendo otro mensaje el LLM no puede tocarlo por construcción.
//  3. Se reenvían los `extraMessages` del paginado: una ola grande no se trunca
//     (invariante de #4075).
//  4. NO arrastra `audioText`: el operador pidió una opinión, no que le narren
//     la tabla. Si hay audio en ese camino, narra la respuesta a la pregunta.
//  5. Render en modo `readOnly`: obtener el anexo NO agrega un punto a la serie
//     de progreso (`wave-progress.appendSnapshot`). Preguntar no es avanzar.
//  6. Marcador de encuadre fijo (texto del CÓDIGO, no del LLM): el anexo se lee
//     como contexto, no como la respuesta.
// =============================================================================

'use strict';

// Marcador de encuadre (UX-1). Simétrico al "📝 Aclaración del Commander:" que
// ya usa el camino de #4089. Va pre-escapado en MarkdownV2 porque el anexo se
// envía con ese dialecto: en MarkdownV2 los paréntesis son caracteres
// reservados y sin escapar rompen el render del mensaje ENTERO (incluido el
// cuadro). Es texto FIJO del código: no lo produce ni lo toca el LLM.
const WAVE_ANNEX_MARKER = '📊 Estado de la ola \\(contexto\\):';

// Fallback fijo (CA-5) para el caso patológico en que el LLM respondió SÓLO con
// una tabla: al sanitizar no queda nada que enviar como respuesta. Preferimos
// una frase fija del código antes que dejar pasar una tabla apócrifa.
const WAVE_TABLE_ONLY_FALLBACK = 'Te paso el estado de la ola tal cual lo emite el handler oficial 👇';

// Una fila de tabla "real" tiene al menos 2 pipes. Mismo criterio que ya usa
// `sanitizeWaveClarification` en pulpo.js (#4089), que es código probado.
const TABLE_ROW_PIPES = 2;

/**
 * CA-5 — Ningún camino permite que el LLM produzca una tabla de estado de ola
 * propia. Cuando el mensaje mencionaba la ola, la respuesta de texto libre pasa
 * por acá: se descartan code-fences y filas tipo tabla.
 *
 * A diferencia de `sanitizeWaveClarification` (#4089) NO recorta a 600 chars:
 * acá el texto es la RESPUESTA a la pregunta del operador, no un bloque
 * complementario. Truncarla reintroduciría el bug por otra puerta.
 *
 * @param {string} raw texto crudo devuelto por el LLM.
 * @returns {string} texto sin tablas ni code-fences (puede quedar vacío).
 */
function stripLlmWaveTable(raw) {
    let out = String(raw || '');
    if (!out.trim()) return '';
    // Code-fences: el LLM a veces mete la "tabla" dentro de ``` para preservar
    // el alineado monoespaciado. Se descartan enteros.
    out = out.replace(/```[\s\S]*?```/g, '\n').replace(/```/g, ' ');
    // Filas tipo tabla (2+ pipes), incluidos los separadores `|---|---|`.
    out = out
        .split('\n')
        .filter((line) => (line.match(/\|/g) || []).length < TABLE_ROW_PIPES)
        .join('\n');
    // Colapsar el hueco que dejó el filtrado, sin tocar el resto del texto.
    out = out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    return out;
}

/**
 * Texto de salida definitivo del camino LLM cuando el mensaje mencionaba la ola.
 * Si al sanitizar no queda nada (el LLM respondió sólo con una tabla), devuelve
 * el fallback fijo del código en vez de la tabla apócrifa.
 *
 * @param {string} raw respuesta cruda del LLM.
 * @returns {string}
 */
function safeLlmAnswer(raw) {
    return stripLlmWaveTable(raw) || WAVE_TABLE_ONLY_FALLBACK;
}

/**
 * Construye los mensajes del anexo de estado de ola, TEXTUALES del handler.
 *
 * @param {object} opts
 * @param {string} opts.pipelineRoot
 * @param {function} [opts.handler] inyectable para tests; por defecto
 *        `commander-deterministic._waveInternal.handleWaveStatus`.
 * @returns {Promise<{messages: string[], parseMode: string}>} `messages` vacío
 *          si el handler no produjo nada (el caller no envía nada y ya).
 */
async function buildWaveAnnex({ pipelineRoot, handler } = {}) {
    const impl = typeof handler === 'function'
        ? handler
        : require('./commander-deterministic')._waveInternal.handleWaveStatus;

    // `audio: false` + `readOnly: true` — invariantes 4 y 5.
    const res = await impl({ pipelineRoot, audio: false, readOnly: true });

    const messages = [];
    const reply = res && typeof res.reply === 'string' ? res.reply : '';
    if (reply.trim()) {
        // El marcador va como primera línea del PRIMER mensaje: el cuadro llega
        // encuadrado sin gastar un mensaje extra de Telegram.
        messages.push(`${WAVE_ANNEX_MARKER}\n${reply}`);
    }
    // Paginado (#4075): la ola se lista COMPLETA, sin "+N más".
    const extras = res && Array.isArray(res.extraMessages) ? res.extraMessages : [];
    for (const extra of extras) {
        if (typeof extra === 'string' && extra.trim()) messages.push(extra);
    }
    // Invariante 4: `res.audioText` se descarta DELIBERADAMENTE acá. No se
    // propaga al caller para que no pueda colarse al TTS por accidente.
    return { messages, parseMode: 'MarkdownV2' };
}

module.exports = {
    buildWaveAnnex,
    stripLlmWaveTable,
    safeLlmAnswer,
    WAVE_ANNEX_MARKER,
    WAVE_TABLE_ONLY_FALLBACK,
};
