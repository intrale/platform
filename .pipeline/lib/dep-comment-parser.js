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
// SOLO SE DECLARA LO QUE ESTÁ DECLARADO (#6902)
// ---------------------------------------------
// Hasta #6902 el bloque se parseaba entero con un `matchAll(/#(\d+)/g)`: toda
// mención narrativa que viviera debajo de los bullets — que es justo donde el
// autor escribe el "por qué" y cita a la historia madre, a un hermano o a un
// issue absorbido — entraba como dependencia dura. Eso cerró ciclos madre-hija
// irrompibles (#6173 → #6191 → #6173, #6199 → #6207 → #6199) que congelaron
// seis issues de la ola 9.4 sin que ningún watchdog los levantara: "esperando
// una dependencia abierta" es un estado sano, así que el deadlock era invisible.
//
// Regla vigente: una dependencia se declara como ITEM DE LISTA con la
// referencia AL INICIO del item. Todo lo demás — prosa suelta, y también las
// menciones que aparecen DENTRO de la descripción de un bullet — se ignora.
// Ese matiz importa: el `#6199` que envenenó a #6207 estaba dentro del texto
// del bullet, no en un párrafo aparte.
//
//   - #6190 — descripción libre que puede citar #9999 sin consecuencias  → [6190]
//   - #100, #200 y #300 — varias referencias contiguas al inicio         → [100,200,300]
//   1. #4242 — lista numerada                                            → [4242]
//   #4243 — referencia sin bullet, al inicio de línea                    → [4243]
//   Esta historia espera a #6190 porque la madre #6173 lo pide           → []  (prosa)
//
// Las referencias descartadas NO se tiran: `analyzeDependencyBlock` las
// devuelve en `ignored` para que el brazo pueda loguearlas y el reporte de
// markers históricos (`.pipeline/scripts/report-prose-deps.js`) las liste.
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
//   parseDependencyCommentDetailed(comments, selfIssue)
//     returns   : {deps: number[]|null, ignored: Array<{lineNo,line,numbers}>}
//                 Mismo veredicto que `parseDependencyComment` + las
//                 referencias descartadas por no estar declaradas.
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

// -----------------------------------------------------------------------------
// #6902 — Reconocimiento de LÍNEAS DE DECLARACIÓN
// -----------------------------------------------------------------------------
// Todos los regex de abajo son anclados y sin quantifiers anidados: el matcheo
// avanza consumiendo prefijo, por lo que el recorrido de una línea es O(n)
// (CA-8 anti-ReDoS se mantiene).

// Prefijo de item de lista: `- `, `* `, `+ `, `1. `, `2) `, con indentación
// opcional y con checkbox opcional (`- [ ] #N`). El grupo entero es opcional:
// una línea que arranca directamente con `#N` también es una declaración.
const LIST_ITEM_PREFIX_REGEX = /^[ \t]*(?:(?:[-*+]|\d{1,4}[.)])[ \t]+)?(?:\[[ xX]\][ \t]+)?/;

// Énfasis markdown pegado a la referencia: `**#123**`, `_#123_`, `` `#123` ``.
const LEADING_EMPHASIS_REGEX = /^(?:\*{1,3}|_{1,3}|`)?/;

// La referencia en sí, anclada al inicio de lo que queda de la línea.
const REF_AT_START_REGEX = /^#(\d+)/;

// Separador entre referencias CONTIGUAS del mismo item (`- #100, #200 y #300`).
// Sólo puntuación de enumeración o espacio en blanco: en cuanto aparece
// cualquier otra cosa (un guion largo, una palabra) empieza la descripción del
// item y lo que venga después ya es prosa.
const REF_SEPARATOR_REGEX = /^(?:[ \t]*(?:,|;|\/|&|\+|\by\b)[ \t]*|[ \t]+)(?:\*{1,3}|_{1,3}|`)?/;

// Fila de tabla markdown: `| 1 de 3 | #5689 | descripción | ... |`. Algunos
// markers históricos declaran así (verificado sobre #5678). Una CELDA cuyo
// contenido es exactamente una referencia es tan declarativa como un bullet;
// una celda con prosa que menciona un issue, no.
const TABLE_ROW_REGEX = /^[ \t]*\|.*\|[ \t]*$/;
const PURE_REF_CELL_REGEX = /^(?:\*{1,3}|_{1,3}|`)?#(\d+)(?:\*{1,3}|_{1,3}|`)?$/;

// Todas las referencias de una línea — se usa sólo para calcular cuáles
// quedaron DESCARTADAS y poder reportarlas.
const ANY_REF_REGEX = /#(\d+)/g;

/**
 * Extrae las referencias DECLARADAS de una única línea: la que abre el item de
 * lista más las contiguas separadas por enumeración. Devuelve `[]` si la línea
 * no es una declaración (prosa).
 *
 * @param {string} line
 * @returns {number[]}
 */
function extractDeclaredRefsFromLine(line) {
    if (typeof line !== 'string' || line.length === 0) return [];

    // Fila de tabla: declara la celda que ES una referencia, nada más.
    if (TABLE_ROW_REGEX.test(line)) {
        const celdas = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
        const refs = [];
        for (const celda of celdas) {
            const m = PURE_REF_CELL_REGEX.exec(celda.trim());
            if (m) refs.push(parseInt(m[1], 10));
        }
        return refs;
    }

    const prefix = LIST_ITEM_PREFIX_REGEX.exec(line);
    let rest = line.slice(prefix ? prefix[0].length : 0);

    const emphasis = LEADING_EMPHASIS_REGEX.exec(rest);
    if (emphasis) rest = rest.slice(emphasis[0].length);

    const first = REF_AT_START_REGEX.exec(rest);
    if (!first) return [];

    const refs = [parseInt(first[1], 10)];
    rest = rest.slice(first[0].length);

    // Referencias contiguas: `#100, #200 y #300`. Se corta apenas aparece algo
    // que no sea separador de enumeración.
    for (;;) {
        const sep = REF_SEPARATOR_REGEX.exec(rest);
        if (!sep) break;
        const afterSep = rest.slice(sep[0].length);
        const next = REF_AT_START_REGEX.exec(afterSep);
        if (!next) break;
        refs.push(parseInt(next[1], 10));
        rest = afterSep.slice(next[0].length);
    }

    return refs;
}

/**
 * #6902 — Analiza el bloque del marker separando lo DECLARADO de lo MENCIONADO.
 *
 * @param {string} text — texto del bloque ya extraído.
 * @param {number|string|null} selfIssue — issue paraguas (excluido del output).
 * @returns {{deps: number[], ignored: Array<{lineNo:number, line:string, numbers:number[]}>}}
 *          - `deps`: referencias declaradas, únicas, en orden de aparición.
 *          - `ignored`: referencias que aparecían en el bloque pero NO estaban
 *            declaradas (prosa suelta o descripción de un bullet), con la línea
 *            donde aparecieron (truncada) para poder reportarlas.
 */
function analyzeDependencyBlock(text, selfIssue) {
    if (typeof text !== 'string' || text.length === 0) return { deps: [], ignored: [] };

    const selfNum = selfIssue == null ? null : Number(selfIssue);
    const seen = new Set();
    const deps = [];
    const ignored = [];

    const lines = text.replace(/\r\n/g, '\n').split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const declared = extractDeclaredRefsFromLine(line);
        const declaredSet = new Set(declared);

        for (const n of declared) {
            if (!Number.isFinite(n) || n <= 0) continue;
            if (selfNum !== null && n === selfNum) continue;
            if (seen.has(n)) continue;
            seen.add(n);
            deps.push(n);
        }

        // Referencias de la línea que NO fueron declaradas.
        ANY_REF_REGEX.lastIndex = 0;
        const extra = [];
        for (const m of line.matchAll(ANY_REF_REGEX)) {
            const n = parseInt(m[1], 10);
            if (!Number.isFinite(n) || n <= 0) continue;
            if (selfNum !== null && n === selfNum) continue;
            if (declaredSet.has(n)) continue;
            if (extra.includes(n)) continue;
            extra.push(n);
        }
        if (extra.length > 0) {
            ignored.push({ lineNo: i, line: line.trim().slice(0, 300), numbers: extra });
        }
    }

    // Una referencia que YA está declarada en otro renglón del bloque y que la
    // prosa repite ("...hasta que #6190 cierre") no es sospechosa: es la misma
    // dependencia contada dos veces. Reportarla sería ruido en el reporte de
    // markers históricos, que es justo lo que lo volvería inservible.
    const declaredAll = new Set(deps);
    const suspicious = [];
    for (const entry of ignored) {
        const numbers = entry.numbers.filter((n) => !declaredAll.has(n));
        if (numbers.length > 0) suspicious.push({ ...entry, numbers });
    }

    return { deps, ignored: suspicious };
}

/**
 * #6902 — Referencias DECLARADAS del bloque (bullets / lista numerada / línea
 * que arranca con la referencia). Reemplaza a `extractIssueNumbers` como
 * extractor de dependencias: aquél sigue existiendo como helper genérico
 * "todos los `#N` de un texto", que ya NO es la semántica del marker.
 *
 * @param {string} text
 * @param {number|string|null} selfIssue
 * @returns {number[]}
 */
function extractDeclaredIssueNumbers(text, selfIssue) {
    return analyzeDependencyBlock(text, selfIssue).deps;
}

/**
 * Extrae issue numbers (`#NNNN`) del texto del bloque, excluye el self-issue
 * y deduplica preservando orden de aparición.
 *
 * Acotado a regex `\d+` para que no matchee fragmentos como `#bug` o `#3.14`.
 * La validación de bounds (issue numbers razonables) se hace en #3005.
 *
 * ⚠️ #6902 — Helper GENÉRICO: devuelve TODAS las referencias del texto, sin
 * distinguir declaración de prosa. Ya NO es el extractor del marker (ver
 * `extractDeclaredIssueNumbers`). Se conserva porque sigue siendo útil para
 * inspeccionar un texto crudo, pero un caller que lo use para decidir
 * dependencias reintroduce el bug de los ciclos madre-hija.
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
    return parseDependencyCommentDetailed(comments, selfIssue).deps;
}

/**
 * #6902 — Igual que `parseDependencyComment` pero devolviendo también las
 * referencias que el bloque menciona SIN declararlas. El brazo de desbloqueo
 * las loguea (observabilidad: hoy el operador no tiene forma de saber que una
 * mención suya no cuenta) y el reporte de markers históricos las lista.
 *
 * @param {Array|string} comments
 * @param {number|string|null} selfIssue
 * @returns {{deps: number[]|null, ignored: Array<{lineNo:number, line:string, numbers:number[]}>, createdAt: string|null}}
 */
function parseDependencyCommentDetailed(comments, selfIssue) {
    // Compat defensivo: si un caller legacy pasa un único string, envolverlo.
    let list;
    const FAIL_CLOSED = { deps: null, ignored: [], createdAt: null };
    if (typeof comments === 'string') {
        list = [{ body: comments, createdAt: null }];
    } else if (Array.isArray(comments)) {
        list = comments;
    } else {
        return FAIL_CLOSED;
    }

    // Filtrar comentarios que contienen el marker.
    const candidates = [];
    for (const c of list) {
        if (!c || typeof c.body !== 'string') continue;
        if (extractDependencyBlock(c.body) !== null) candidates.push(c);
    }
    if (candidates.length === 0) return FAIL_CLOSED;

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
    const analysis = analyzeDependencyBlock(block, selfIssue);
    return {
        deps: analysis.deps,
        ignored: analysis.ignored,
        createdAt: chosen.createdAt == null ? null : String(chosen.createdAt),
    };
}

/**
 * #3167 — Wrapper conveniente para callers que tienen UN único body
 * (no la lista de comments completa) y quieren la lista de números detectados.
 *
 * Devuelve siempre un `number[]` (nunca null). Si el body no contiene el
 * marker, devuelve `[]`. Esto difiere de `parseDependencyComment` que
 * devuelve `null` para que el caller pueda diferenciar "fail-closed" (no
 * tocar labels) de "marker presente pero sin numeros". Para el brazo de
 * desbloqueo se mantiene `parseDependencyComment` con su semántica de null.
 *
 * Reglas adicionales del spec del clasificador:
 *  - Resultado deduplicado y ordenado ascendente.
 *  - Acotado a 20 elementos (MAX_DEPS_PER_BLOCK).
 *
 * @param {string} body — body del comentario.
 * @returns {number[]}
 */
function parseDependenciesFromComment(body) {
    if (typeof body !== 'string' || body.length === 0) return [];
    const block = extractDependencyBlock(body);
    if (block === null) return [];
    // selfIssue=null → no excluimos nada porque no tenemos contexto del paraguas.
    // #6902 — sólo lo DECLARADO: este wrapper alimenta al clasificador de
    // rebotes, así que una mención narrativa acá también terminaba en un
    // `blocked:dependencies` espurio.
    const nums = extractDeclaredIssueNumbers(block, null);
    // Ordenar ascendente + cap a 20.
    const sorted = nums.slice().sort((a, b) => a - b);
    return sorted.slice(0, 20);
}

module.exports = {
    parseDependencyComment,
    parseDependenciesFromComment,
    // #6902 — variante con las referencias descartadas (observabilidad + reporte).
    parseDependencyCommentDetailed,
    analyzeDependencyBlock,
    extractDeclaredIssueNumbers,
    // Helpers exportados para tests unitarios — NO consumir fuera del módulo.
    extractDependencyBlock,
    extractIssueNumbers,
    extractDeclaredRefsFromLine,
    isMarkerHeading,
};
