// =============================================================================
// dep-resolver.js — Orquestador de detección de dependencias multi-fuente
// (issue #3193).
//
// CONTEXTO
// --------
// El `brazoDesbloqueo` del Pulpo destraba issues con label
// `blocked:dependencies` cuando todas sus deps están CLOSED. Hasta #3193 sólo
// detectaba el marker en comentarios (`parseDependencyComment`). Los issues
// creados manualmente vía `gh issue create` con la sección en el body quedaban
// trabados aunque sus deps estuvieran cerradas (caso real: #3176/#3177 en la
// ola multi-provider 2026-05-14).
//
// Este módulo compone sobre `dep-comment-parser` agregando 3 patrones de body
// con prioridad explícita y unión de fuentes:
//
//   1. Comentario con marker canónico  (fuente preferida, fail-closed clásico)
//   2. Body con la misma sección canónica `## Dependencias detectadas por el
//      pipeline` o sección genérica `## Dependencias` (sólo si las líneas son
//      bullets puros `- #N`/`#N`, sin texto narrativo adicional)
//   3. Body con verbos GitHub-nativos `Depends on #N` / `Blocked by #N`
//      (anclados a inicio de línea, una dep por línea)
//
// Si se detectan en varias fuentes, la salida es la UNIÓN de las deps
// (no exclusiva). El campo `source` registra `'comment' | 'body' | 'both'`.
//
// FAIL-CLOSED (CA-5)
// ------------------
// Si ninguna fuente produce un marker válido → `{ deps: null, source: null }`.
// El caller debe interpretar `null` como "no toques los labels": semántica
// idéntica al `parseDependencyComment` original.
//
// SEGURIDAD (CA-7..CA-12)
// -----------------------
// - Regex line-based, anclados con `^`, complejidad O(n). Anti-ReDoS.
// - Code fences (triple-backtick) excluidos vía state machine line-based.
// - Issue numbers validados: `0 < n < 1_000_000`.
// - Referencias negadas (`does NOT depend on #N`) NO se parsean — el regex
//   exige verbo literal al inicio de línea sin negación previa.
// - Cap de 20 deps por fuente y en la unión final (consistente con
//   `parseDependenciesFromComment` de #3167).
// - Helper `sanitizeForLog` para evitar log-injection.
//
// API PÚBLICA
// -----------
//   resolveDependencies({ body, comments, selfIssue })
//     body      : string | null | undefined  (body del issue paraguas)
//     comments  : Array<{body, createdAt, author?}>
//     selfIssue : number | string | null
//     returns   : { deps: number[] | null, source: 'comment' | 'body' | 'both' | null }
//
//   parseBodyDependencies(body, selfIssue)
//     body      : string
//     selfIssue : number | string | null
//     returns   : number[]   (deduplicado, ordenado asc, cap 20)
//
//   buildAutoPromoteComment(deps)
//     deps      : number[]
//     returns   : string   (markdown del comentario canónico con disclaimer)
//
//   sanitizeForLog(text, maxLen=200)
//     text      : string
//     maxLen    : number
//     returns   : string  (sin control chars, single-line, truncado)
//
// =============================================================================

'use strict';

const {
    parseDependencyComment,
    extractDependencyBlock,
    extractIssueNumbers,
} = require('./dep-comment-parser');

// Cap consistente con `parseDependenciesFromComment` (#3167). Aplicado por
// fuente y en la unión final, después de dedup y antes de iterar `gh issue
// view` por cada dep en el brazoDesbloqueo.
const MAX_DEPS = 20;

// Validación numérica de issue numbers — evita parsear `#0`, negativos o
// números absurdos que igual disparan llamadas a `gh issue view` y consumen
// cuota.
const MAX_ISSUE_NUM = 1_000_000;

function isValidIssueNum(n) {
    return Number.isFinite(n) && n > 0 && n < MAX_ISSUE_NUM;
}

// Heading genérico `## Dependencias` (sin "detectadas por el pipeline"). Lo
// usamos sólo como fallback cuando el bloque tiene exclusivamente bullets
// puros `- #N` / `#N` — si hay texto narrativo invalidamos el bloque entero.
const GENERIC_HEADING_REGEX = /^(#{1,4})\s+Dependencias\s*$/;

// Verbos GitHub-nativos: `Depends on #N` / `Blocked by #N`. Anclados a inicio
// de línea, case-insensitive. UNA dep por línea — NO matchAll global sobre el
// body (ReDoS-safe). Trailing comments (`Depends on #N — explicación`) NO
// se aceptan: exigimos la línea exactamente con el verbo + número.
const DEPENDS_LINE_REGEX = /^(?:depends on|blocked by)\s+#(\d+)\s*$/i;

// Bullets puros: `- #N` o `#N` (con opcional `*`/`+` como bullet marker).
// Aceptamos espacios alrededor pero NO texto adicional en la línea — eso
// es lo que distingue una sección de manifest pura vs. narrativa.
const PURE_BULLET_REGEX = /^\s*(?:[-*+]\s+)?#(\d+)\s*$/;

// Línea en blanco (ignorada para detectar pureza del bloque).
const BLANK_LINE_REGEX = /^\s*$/;

// Inicio/fin de code fence (triple-backtick, con o sin lenguaje).
const CODE_FENCE_REGEX = /^\s*```/;

// Cualquier heading markdown (terminador de bloque cuando estamos dentro).
const ANY_HEADING_REGEX = /^#{1,6}\s+\S/;

// Horizontal rule (terminador de bloque).
const HR_REGEX = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Splitea un body en líneas normalizando CRLF→LF.
 */
function toLines(body) {
    if (typeof body !== 'string' || body.length === 0) return [];
    return body.replace(/\r\n/g, '\n').split('\n');
}

/**
 * Recorre las líneas detectando code fences y emite sólo las que NO están
 * dentro de un fence. Generator para mantener O(n) y evitar arrays intermedios
 * grandes.
 *
 * @yields {{lineNo: number, text: string}}
 */
function* nonFencedLines(lines) {
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (CODE_FENCE_REGEX.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        yield { lineNo: i, text: line };
    }
}

/**
 * B1 — Detecta deps usando la sección canónica `## Dependencias detectadas
 * por el pipeline` directamente en el body del issue.
 *
 * Reutiliza `extractDependencyBlock` del parser (cero duplicación de lógica).
 * El parser ya maneja CRLF, terminadores correctos y heading con/sin emoji.
 *
 * NOTA: `extractDependencyBlock` no excluye code fences porque originalmente
 * opera sobre comentarios del pulpo (controlados). Para el body lo
 * pre-filtramos quitando líneas dentro de fences ANTES de pasarlo al parser.
 *
 * @returns {number[]} — issue numbers válidos (sin cap aún, sin dedup global).
 */
function parseCanonicalBlock(body, selfIssue) {
    if (typeof body !== 'string' || body.length === 0) return [];
    const fencedFreeLines = [];
    for (const { text } of nonFencedLines(toLines(body))) fencedFreeLines.push(text);
    const fencedFreeBody = fencedFreeLines.join('\n');
    const block = extractDependencyBlock(fencedFreeBody);
    if (block === null) return [];
    const nums = extractIssueNumbers(block, selfIssue);
    return nums.filter(isValidIssueNum);
}

/**
 * B2 — Detecta deps en sección genérica `## Dependencias`.
 *
 * Sólo acepta el bloque si TODAS las líneas no-blank son bullets puros
 * (`- #N` o `#N`). Si encuentra cualquier línea con texto adicional, descarta
 * el bloque (señal de sección narrativa, no manifest).
 *
 * @returns {number[]} — issue numbers válidos.
 */
function parseGenericSection(body, selfIssue) {
    if (typeof body !== 'string' || body.length === 0) return [];
    const lines = toLines(body);

    // Excluir líneas dentro de code fences antes de buscar el heading.
    const filtered = [];
    for (const { text } of nonFencedLines(lines)) filtered.push(text);

    let inBlock = false;
    let blockIsPure = true;
    const collected = [];

    for (let i = 0; i < filtered.length; i++) {
        const line = filtered[i];

        if (!inBlock) {
            if (GENERIC_HEADING_REGEX.test(line)) {
                inBlock = true;
            }
            continue;
        }

        // Terminadores del bloque.
        if (ANY_HEADING_REGEX.test(line)) break;
        if (HR_REGEX.test(line)) break;

        // Blank lines no rompen el bloque ni afectan la pureza.
        if (BLANK_LINE_REGEX.test(line)) continue;

        const m = PURE_BULLET_REGEX.exec(line);
        if (m) {
            collected.push(parseInt(m[1], 10));
        } else {
            // Línea con texto no-bullet → bloque narrativo, abortar.
            blockIsPure = false;
            break;
        }
    }

    if (!inBlock || !blockIsPure) return [];

    const selfNum = selfIssue == null ? null : Number(selfIssue);
    const seen = new Set();
    const out = [];
    for (const n of collected) {
        if (!isValidIssueNum(n)) continue;
        if (selfNum !== null && n === selfNum) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(n);
    }
    return out;
}

/**
 * B3 — Detecta deps con verbos GitHub-nativos: `Depends on #N` / `Blocked
 * by #N`. Una dep por línea, anclado a inicio de línea, case-insensitive.
 *
 * Excluye:
 *  - Líneas dentro de code fences (state machine).
 *  - Referencias negadas — el regex exige verbo literal al inicio de línea
 *    sin negación previa (la línea "does NOT depend on #N" arranca con
 *    "does NOT", no con "depends on", así que no matchea por anclaje `^`).
 *
 * @returns {number[]} — issue numbers válidos.
 */
function parseDependsLines(body, selfIssue) {
    if (typeof body !== 'string' || body.length === 0) return [];
    const selfNum = selfIssue == null ? null : Number(selfIssue);
    const seen = new Set();
    const out = [];

    for (const { text } of nonFencedLines(toLines(body))) {
        const m = DEPENDS_LINE_REGEX.exec(text);
        if (!m) continue;
        const n = parseInt(m[1], 10);
        if (!isValidIssueNum(n)) continue;
        if (selfNum !== null && n === selfNum) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(n);
    }
    return out;
}

/**
 * Une múltiples arrays de issue numbers preservando orden de aparición,
 * deduplica y aplica cap. Resultado ordenado ASCENDENTE para output
 * determinístico (consistente con `parseDependenciesFromComment`).
 *
 * @param {number[][]} arrays
 * @param {number} cap
 * @returns {number[]}
 */
function mergeAndCap(arrays, cap) {
    const seen = new Set();
    const merged = [];
    for (const arr of arrays) {
        for (const n of arr) {
            if (seen.has(n)) continue;
            seen.add(n);
            merged.push(n);
        }
    }
    merged.sort((a, b) => a - b);
    return merged.slice(0, cap);
}

/**
 * Detecta deps en el body usando los 3 patrones B1/B2/B3 con unión interna.
 * Cap aplicado al final del merge.
 *
 * @param {string} body
 * @param {number|string|null} selfIssue
 * @returns {number[]} — deps deduplicadas, ordenadas asc, cap 20.
 */
function parseBodyDependencies(body, selfIssue) {
    if (typeof body !== 'string' || body.length === 0) return [];
    const b1 = parseCanonicalBlock(body, selfIssue);
    const b2 = parseGenericSection(body, selfIssue);
    const b3 = parseDependsLines(body, selfIssue);
    return mergeAndCap([b1, b2, b3], MAX_DEPS);
}

/**
 * Orquestador principal — combina comentarios y body con prioridad explícita
 * y unión de fuentes.
 *
 * Semántica:
 *  - Si el comentario canónico devuelve `number[]` Y el body produce deps →
 *    `source: 'both'`, deps = unión cappeada.
 *  - Si SÓLO el comentario canónico tiene deps → `source: 'comment'`, deps
 *    del comentario (cappeadas).
 *  - Si SÓLO el body tiene deps → `source: 'body'`, deps del body (ya
 *    cappeadas por `parseBodyDependencies`).
 *  - Si ninguna fuente produce deps → `{ deps: null, source: null }`
 *    (fail-closed, semántica idéntica a `parseDependencyComment`).
 *
 * @param {{body?: string, comments?: Array, selfIssue?: number|string}} input
 * @returns {{deps: number[]|null, source: 'comment'|'body'|'both'|null}}
 */
function resolveDependencies({ body, comments, selfIssue } = {}) {
    const fromComment = parseDependencyComment(
        Array.isArray(comments) ? comments : [],
        selfIssue
    );
    const fromBody = parseBodyDependencies(body, selfIssue);

    const hasComment = Array.isArray(fromComment);
    const hasBody = fromBody.length > 0;

    if (!hasComment && !hasBody) {
        return { deps: null, source: null };
    }

    if (hasComment && hasBody) {
        // Filtrar a issue numbers válidos también el comment (defensa en
        // profundidad — el parser actual no aplica MAX_ISSUE_NUM).
        const validComment = fromComment.filter(isValidIssueNum);
        const merged = mergeAndCap([validComment, fromBody], MAX_DEPS);
        return { deps: merged, source: 'both' };
    }

    if (hasComment) {
        const validComment = fromComment.filter(isValidIssueNum);
        const merged = mergeAndCap([validComment], MAX_DEPS);
        return { deps: merged, source: 'comment' };
    }

    // hasBody
    return { deps: fromBody, source: 'body' };
}

/**
 * Construye el comentario canónico auto-promovido del body. Debe ser
 * idempotente con respecto al parser: re-aplicar `parseDependencyComment` al
 * comentario generado debe devolver exactamente las mismas deps.
 *
 * @param {number[]} deps
 * @returns {string}
 */
function buildAutoPromoteComment(deps) {
    const list = (Array.isArray(deps) ? deps : []).filter(isValidIssueNum);
    const bullets = list.map(n => `- #${n}`).join('\n');
    return [
        '## Dependencias detectadas por el pipeline',
        '',
        bullets,
        '',
        '_⚙️ Auto-promovido del body por el brazo de desbloqueo (compatibilidad con issues creados manualmente). A partir de este comentario el body deja de ser fuente de verdad._',
    ].join('\n');
}

/**
 * Sanitiza texto user-controlled para loguear con seguridad. Elimina
 * caracteres de control (incluyendo newlines) y trunca a `maxLen`.
 *
 * Anti log-injection: un body con `\n✅ Approved\n` no debe poder inyectar
 * líneas falsas en `logs/desbloqueo.log`.
 *
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function sanitizeForLog(text, maxLen = 200) {
    if (typeof text !== 'string') return '';
    // Reemplazar todos los caracteres de control (incluyendo \r\n\t) por espacio.
    // eslint-disable-next-line no-control-regex
    const cleaned = text.replace(/[\x00-\x1F\x7F]/g, ' ');
    if (cleaned.length <= maxLen) return cleaned;
    return cleaned.slice(0, maxLen) + '…';
}

module.exports = {
    resolveDependencies,
    parseBodyDependencies,
    buildAutoPromoteComment,
    sanitizeForLog,
    // Helpers exportados para tests unitarios — NO consumir fuera del módulo.
    parseCanonicalBlock,
    parseGenericSection,
    parseDependsLines,
    isValidIssueNum,
    MAX_DEPS,
    MAX_ISSUE_NUM,
};
