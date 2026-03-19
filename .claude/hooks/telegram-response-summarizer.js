// telegram-response-summarizer.js — Resumidor inteligente de respuestas para Telegram
// Preserva: números de issue, estados, emojis, acciones clave
// Elimina: URLs, paths de archivos, nombres de tools, tablas detalladas
"use strict";

const MAX_SUMMARY_CHARS = 1500;
const SHORT_RESPONSE_THRESHOLD = 1500;

/**
 * Retorna true si el texto ya es suficientemente corto para enviarse sin resumir.
 */
function isShort(text) {
    return !text || text.length <= SHORT_RESPONSE_THRESHOLD;
}

/**
 * Aplica reglas de limpieza para eliminar detalles innecesarios:
 * - URLs (http/https/ftp)
 * - Paths de archivos (C:\, /path/, .\, etc.)
 * - Separadores de tablas markdown con muchas columnas
 * - Líneas puramente decorativas (guiones, ═══)
 */
function cleanText(text) {
    let cleaned = text;

    // Eliminar URLs
    cleaned = cleaned.replace(/https?:\/\/[^\s\)\]>]+/g, "");
    cleaned = cleaned.replace(/ftp:\/\/[^\s]+/g, "");

    // Eliminar paths de archivos Windows (C:\...) y relativos (.\, ../)
    cleaned = cleaned.replace(/[A-Za-z]:\[^\s"'<>\n]*/g, "");
    cleaned = cleaned.replace(/\.[\/\][^\s"'<>\n]{3,}/g, "");

    // Filtrar líneas de tablas markdown (separadores |---|---|)
    const filteredLines = cleaned.split("\n").filter(line => {
        const trimmed = line.trim();
        // Eliminar líneas separadoras de tabla
        if (/^\|[-| :]+\|$/.test(trimmed)) return false;
        // Eliminar líneas con muchos pipes sin números de issue
        const pipeCount = (line.match(/\|/g) || []).length;
        if (pipeCount >= 4 && !/#\d{3,}/.test(line) && !/✅|❌|⚠️|🚀/.test(line)) return false;
        // Eliminar líneas puramente decorativas (guiones, ═══)
        if (/^[-─═━=_]{5,}$/.test(trimmed)) return false;
        return true;
    });

    cleaned = filteredLines.join("\n");

    // Colapsar múltiples líneas en blanco consecutivas
    cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

    return cleaned.trim();
}

/**
 * Puntúa las líneas de texto según su relevancia para el resumen.
 * Prioriza líneas con emojis, números de issue, palabras clave de estado.
 */
function scoreLines(lines) {
    const PRIORITY_PATTERNS = [
        { re: /[✅❌⚠️🚀💡📋🔄⏳🟢🔴🟡🆔📊]/, score: 3 },
        { re: /#\d{3,}/, score: 4 },
        { re: /\bSPR-\d+/i, score: 4 },
        { re: /\b(sprint|activo|completado|iniciado|fallido|slots?|cola|agente|pr\s|issue)\b/i, score: 2 },
        { re: /\d+\s*(agentes?|issues?|slots?|ok|error)/i, score: 2 },
    ];

    return lines.map((line, idx) => {
        let score = 0;
        for (const { re, score: s } of PRIORITY_PATTERNS) {
            if (re.test(line)) score += s;
        }
        // Bonificar líneas del principio del texto
        if (idx < 5) score += 3;
        else if (idx < 12) score += 1;
        // Penalizar líneas muy cortas (probablemente ruido)
        if (line.trim().length < 4) score -= 5;
        return { line, score, idx };
    });
}

/**
 * Resume una respuesta larga de forma inteligente.
 * Si el texto ya es corto (<= 1500 chars), lo devuelve sin cambios.
 *
 * @param {string} text  Texto original de la respuesta
 * @returns {string}     Resumen conciso
 */
function summarize(text) {
    if (!text || isShort(text)) return text;

    // Paso 1: limpiar el texto de ruido
    const cleaned = cleanText(text);
    if (cleaned.length <= MAX_SUMMARY_CHARS) return cleaned;

    // Paso 2: puntuar líneas y seleccionar las más relevantes
    const lines = cleaned.split("\n");
    const scored = scoreLines(lines);

    // Ordenar por score descendente (manteniendo orden relativo para iguales)
    const sorted = scored.slice().sort((a, b) =>
        b.score !== a.score ? b.score - a.score : a.idx - b.idx
    );

    // Seleccionar índices hasta llenar el límite de chars
    const selectedIndices = new Set();
    let charCount = 0;
    for (const { idx, line } of sorted) {
        if (charCount + line.length + 1 > MAX_SUMMARY_CHARS) break;
        selectedIndices.add(idx);
        charCount += line.length + 1;
    }

    // Reconstruir en orden original
    const result = lines
        .filter((_, idx) => selectedIndices.has(idx))
        .join("\n")
        .trim();

    if (!result) {
        // Fallback: truncar directamente
        return cleaned.substring(0, MAX_SUMMARY_CHARS - 3) + "...";
    }

    return result;
}

module.exports = { summarize, isShort, cleanText, MAX_SUMMARY_CHARS, SHORT_RESPONSE_THRESHOLD };
