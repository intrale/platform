// =============================================================================
// dep-comment-parser.js — Parser del marker "Dependencias detectadas por
// el pipeline" usado por el brazo de desbloqueo del Pulpo (issue #3002).
//
// CONTEXTO DEL BUG ORIGINAL (#3002)
// ---------------------------------
// El parser inline en `pulpo.js:7296` usaba la regex
//
//   /Dependencias detectadas por el pipeline[\s\S]*?(?=\n\n|\Z)/
//
// que tenía DOS defectos:
//
//  1. El lookahead no-greedy `(?=\n\n)` corta inmediatamente después del
//     heading porque los writers meten un `\n\n` ANTES del primer bullet.
//     Resultado: `match[0]` contiene SOLO el heading, sin las deps.
//
//  2. `\Z` no existe en JavaScript regex — se interpreta como literal `Z`,
//     un anchor de fin-de-input estilo Perl/Ruby. La disyunción `|\Z` no
//     hace nada salvo generar falsos positivos si alguien menciona la
//     letra Z en su texto.
//
// Cuando el parser fallaba, el código caía a un fallback "todos los `#N`
// del body+comments" que arrastraba menciones fantasma (justificaciones de
// sizing, históricos, follow-ups) y bloqueaba paraguas indefinidamente.
//
// CA-12 OPERACIONAL — POST MERGE
// -------------------------------
// Hay que borrar `.pipeline/blocked-issues.json` y/o
// `.pipeline/state/blocked-issues.json` para forzar la reconstrucción
// limpia del mapa: los paraguas históricos contaminados con deps fantasma
// se reevalúan correctamente en el siguiente ciclo del brazo (~60s).
//
// FORMATOS SOPORTADOS
// -------------------
// El marker lo escriben hoy dos lugares con formatos distintos:
//
//   1) `.pipeline/roles/planner.md` — heading sin emoji + bullets `- #N`
//      o líneas planas `#N`:
//
//        ## Dependencias detectadas por el pipeline
//
//        - #2974
//        - #2975
//        - #2976
//
//   2) `.pipeline/rejection-report.js:1857` — heading con emoji 🔗 +
//      sub-heading `**Issues creados automáticamente:**` + bullets
//      `- #N — título`:
//
//        ## 🔗 Dependencias detectadas por el pipeline
//
//        **Issues creados automáticamente:**
//        - #2458 — fix: ...
//
//        Este issue queda bloqueado hasta que se resuelvan las dependencias listadas.
//
// El parser maneja ambos sin perder fidelidad.
//
// FAIL-CLOSED (CA-6)
// ------------------
// Si NINGÚN comentario del issue contiene un bloque parseable se devuelve
// `null`. El caller debe interpretar `null` como "no toques los labels":
// preferimos intervención manual ocasional a desbloquear un paraguas con
// deps reales abiertas.
//
// SEGURIDAD / ANTI-ReDoS (CA-8)
// -----------------------------
// Parsing line-based, sin regex con quantifiers anidados ni alternaciones
// con backtracking exponencial. Complejidad lineal O(n) sobre el texto.
//
// API PÚBLICA
// -----------
//   parseDependencyComment(comments, selfIssue)
//     comments  : Array<{body, createdAt, author?}>
//     selfIssue : number | string  (issue paraguas, se excluye del output)
//     returns   : number[] | null
//                 - number[] si se encontró un marker parseable
//                 - null     si no había marker en ningún comentario
//
// =============================================================================

'use strict';

// Heading "Dependencias detectadas por el pipeline" precedido por 1-4 `#`,
// opcionalmente con emoji o cualquier secuencia no-espacio entre el `#` y
// la palabra "Dependencias". El `m` flag permite anclar al inicio de línea.
//
// Ejemplos válidos:
//   ## Dependencias detectadas por el pipeline
//   ## 🔗 Dependencias detectadas por el pipeline
//   ### Dependencias detectadas por el pipeline
//
// Inválidos (no matchea):
//   Dependencias detectadas por el pipeline   (sin `#`)
//   ##Dependencias detectadas por el pipeline (sin espacio)
//   # Las Dependencias detectadas por el pipeline (texto antes)
const HEADING_LINE_REGEX =
    /^(#{1,4})\s+(?:[^\s#]+\s+)?Dependencias detectadas por el pipeline\s*$/;

// Heading genérico (cualquier nivel) — usado para detectar el FIN del bloque.
const ANY_HEADING_REGEX = /^#{1,6}\s+\S/;

// Horizontal rule en Markdown: `---`, `***`, `___` (3+ chars).
const HR_REGEX = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Detecta si una línea es el heading del marker.
 * Exportada para tests unitarios; no usar fuera del módulo.
 */
function isMarkerHeading(line) {
    return HEADING_LINE_REGEX.test(line);
}

/**
 * Extrae el texto entre el heading "Dependencias detectadas por el pipeline"
 * y el primer terminador (otro heading, horizontal rule, o EOF).
 *
 * @param {string} body — body completo del comentario.
 * @returns {string|null} — texto del bloque (sin el heading), o null si el
 *                          comentario no contiene el marker.
 */
function extractDependencyBlock(body) {
    if (typeof body !== 'string' || body.length === 0) return null;

    // Normalizar line endings para parser consistente cross-platform
    // (GitHub puede devolver CRLF en algunos casos).
    const lines = body.replace(/\r\n/g, '\n').split('\n');

    let inBlock = false;
    const collected = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (!inBlock) {
            if (isMarkerHeading(line)) inBlock = true;
            continue;
        }

        // Terminadores del bloque: cualquier nuevo heading o un HR.
        // NO terminar en `\n\n` (esa era la causa raíz del bug original).
        if (ANY_HEADING_REGEX.test(line)) break;
        if (HR_REGEX.test(line)) break;

        collected.push(line);
    }

    if (!inBlock) return null;
    return collected.join('\n');
}

/**
 * Extrae issue numbers (`#NNNN`) del texto del bloque, excluye el self-issue
 * y deduplica preservando orden de aparición.
 *
 * Acotado a regex `\d+` para que no matchee fragmentos como `#bug` o `#3.14`.
 * La validación de bounds (issue numbers razonables) se hace en #3005.
 *
 * @param {string} text — texto del bloque ya extraído.
 * @param {number|string|null} selfIssue — issue paraguas (excluido del output).
 * @returns {number[]} — números de issue únicos en orden de aparición.
 */
function extractIssueNumbers(text, selfIssue) {
    if (typeof text !== 'string' || text.length === 0) return [];

    const selfNum = selfIssue == null ? null : Number(selfIssue);
    const seen = new Set();
    const result = [];

    for (const m of text.matchAll(/#(\d+)/g)) {
        const n = parseInt(m[1], 10);
        if (!Number.isFinite(n) || n <= 0) continue;
        if (selfNum !== null && n === selfNum) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        result.push(n);
    }

    return result;
}

/**
 * Devuelve un timestamp comparable para ordenar comentarios por recencia.
 * Defensive: comentarios sin `createdAt` válido se ordenan al final.
 */
function commentTime(c) {
    if (!c || c.createdAt == null) return -Infinity;
    const t = Date.parse(c.createdAt);
    return Number.isFinite(t) ? t : -Infinity;
}

/**
 * Parser principal — único punto de entrada exportado en producción.
 *
 * @param {Array<{body: string, createdAt?: string, author?: object}>} comments
 *        Lista de comentarios del issue tal como los devuelve `gh issue view
 *        --json comments`. Acepta también un único string para compatibilidad
 *        defensiva (legacy callers).
 * @param {number|string|null} selfIssue
 *        Número del issue paraguas. Se excluye del resultado para evitar
 *        auto-referencias.
 * @returns {number[] | null}
 *        - Array de issue numbers parseados desde el marker más reciente.
 *        - `null` si NO se encontró el marker en ningún comentario
 *          (señal fail-closed: el caller debe NO desbloquear ni auto-cerrar).
 */
function parseDependencyComment(comments, selfIssue) {
    // Compat defensivo: si un caller legacy pasa un único string, envolverlo.
    let list;
    if (typeof comments === 'string') {
        list = [{ body: comments, createdAt: null }];
    } else if (Array.isArray(comments)) {
        list = comments;
    } else {
        return null;
    }

    // Filtrar comentarios que contienen el marker.
    const candidates = [];
    for (const c of list) {
        if (!c || typeof c.body !== 'string') continue;
        if (extractDependencyBlock(c.body) !== null) candidates.push(c);
    }
    if (candidates.length === 0) return null;

    // CA-7: si hay múltiples comentarios con marker, usar el más reciente.
    // Stable sort por timestamp descendente; ties = orden de aparición original.
    let chosen = candidates[0];
    let chosenTime = commentTime(chosen);
    for (let i = 1; i < candidates.length; i++) {
        const t = commentTime(candidates[i]);
        if (t > chosenTime) {
            chosen = candidates[i];
            chosenTime = t;
        }
    }

    const block = extractDependencyBlock(chosen.body);
    return extractIssueNumbers(block, selfIssue);
}

module.exports = {
    parseDependencyComment,
    // Helpers exportados para tests unitarios — NO consumir fuera del módulo.
    extractDependencyBlock,
    extractIssueNumbers,
    isMarkerHeading,
};
