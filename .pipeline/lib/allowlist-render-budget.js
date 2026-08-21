// =============================================================================
// allowlist-render-budget.js — El render de `/allowlist` entra SIEMPRE en un
// saliente de Telegram, y cuando no entra lo dice (#5176).
//
// EL DEFECTO QUE CIERRA
// ---------------------
// El handler de `/allowlist` mapeaba TODOS los issues autorizados a una fila
// cada uno, sin cota. Con el marker real de producción (139 `allowed_issues`) el
// render medía 4652 chars y el transporte lo recortaba a 4000: 16 issues se
// perdían SIN ningún indicador, el pie del mensaje desaparecía y el corte caía a
// mitad de token MarkdownV2.
//
// Eso contradice el objetivo del propio comando (SEC-5 / A-1): que el operador
// NO lea un estado incompleto de la allowlist. Leer "vacía" con 139 autorizados
// y leer "123 de 139, sin avisar" llevan al mismo lugar — el operador concluye
// que se perdió estado y re-autoriza a mano, que es el camino del dispatch
// masivo de #5060.
//
// LA ESTRATEGIA: DEGRADAR POR DENSIDAD, NO POR CORTE
// --------------------------------------------------
// Antes de descartar issues se cambia la DENSIDAD de la vista, porque la vista
// detallada cuesta ~35 chars por issue y la compacta ~9:
//
//   1. `detailed` — una fila por issue. La más legible; sólo para listas chicas.
//   2. `compact`  — `\#5176 · \#5179 · …` en línea corrida. A escala de
//      producción (139 autorizados ≈ 1250 chars) entra ENTERA: cero pérdida.
//   3. `compact` acotado — sólo si ni la compacta entra (miles de issues). Acá
//      sí se descartan filas, pero el truncado es EXPLÍCITO: el template rinde
//      "y N más de los M autorizados" con el total real.
//
// La elección NO se hace por una fórmula de largo estimado: se RENDERIZA y se
// MIDE el string final. Un cambio futuro en `allowlist.md` (una línea nueva, un
// campo más largo) no puede desalinear la cota, porque no hay aritmética que
// mantener sincronizada con el template.
// =============================================================================
'use strict';

const { escapeMarkdownV2 } = require('./commander/fill-template');
const { HANDLER_TEXT_BUDGET, safeTruncate } = require('./telegram-text-budget');

// Máximo de filas del modo detallado. Por encima de esto la vista pasa a
// compacta aunque entrara en el presupuesto: 20 filas ya son ~15 líneas de
// scroll en el cliente móvil y la lista compacta se lee mejor.
const MAX_DETAILED_ROWS = 20;

// Cotas de los campos de largo variable que vienen del marker (no del código):
// `created_at` y `allowed_skills` los escribe otro proceso y podrían llegar
// arbitrariamente largos. Se acotan en origen para que la degradación por
// issues no tenga que compensar un campo desbordado.
const MAX_LAST_MODIFIED_CHARS = 40;
const MAX_SKILLS_DISPLAY_CHARS = 200;

/**
 * Lista compacta de issues, ya escapada para MarkdownV2.
 * `#5176` → `\#5176` (6 chars) + separador (3) ≈ 9 chars por issue, contra los
 * ~35 de una fila detallada.
 * @param {Array<number|string>} numbers
 * @returns {string}
 */
function compactIssueList(numbers) {
    return numbers.map((n) => escapeMarkdownV2(`#${n}`)).join(' · ');
}

/**
 * Display de skills acotado, con remanente explícito.
 * @param {string[]} skills
 * @param {number} [maxChars=MAX_SKILLS_DISPLAY_CHARS]
 * @returns {string}
 */
function clampSkillsDisplay(skills, maxChars = MAX_SKILLS_DISPLAY_CHARS) {
    const list = Array.isArray(skills) ? skills.map((s) => String(s)) : [];
    if (list.length === 0) return '';
    const shown = [];
    let used = 0;
    for (const skill of list) {
        const cost = shown.length === 0 ? skill.length : skill.length + 2;
        if (used + cost > maxChars && shown.length > 0) break;
        shown.push(skill);
        used += cost;
    }
    if (shown.length === list.length) return shown.join(', ');
    const hidden = list.length - shown.length;
    return `${shown.join(', ')} +${hidden} más`;
}

/**
 * Valor de "última modificación" acotado (viene del marker).
 * @param {*} value
 * @returns {string}
 */
function clampLastModified(value) {
    if (typeof value !== 'string' || value.length === 0) return 'desconocida';
    return safeTruncate(value, MAX_LAST_MODIFIED_CHARS);
}

/**
 * Elige la vista más informativa de `/allowlist` que entra en el presupuesto.
 *
 * Contrato:
 *  - el `text` devuelto mide SIEMPRE <= `budget` (verificado midiendo, no
 *    estimando);
 *  - si se omitió algún issue, `truncated` es `true` y el render lo declara;
 *  - nunca lanza: si `renderWith` explota, degrada al escalón siguiente.
 *
 * @param {object} params
 * @param {Array<{number:number}>} params.rows filas de issues (orden preservado)
 * @param {(view:object)=>string} params.renderWith rinde el template con la vista
 * @param {number} [params.budget=HANDLER_TEXT_BUDGET]
 * @param {number} [params.maxDetailed=MAX_DETAILED_ROWS]
 * @returns {{text:string, mode:string, shown:number, hidden:number, truncated:boolean}}
 */
function fitAllowlistRender({ rows, renderWith, budget = HANDLER_TEXT_BUDGET, maxDetailed = MAX_DETAILED_ROWS }) {
    const list = Array.isArray(rows) ? rows : [];
    const total = list.length;
    const cap = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : HANDLER_TEXT_BUDGET;

    const viewFor = (mode, shown) => {
        const visible = list.slice(0, shown);
        return {
            'list-mode': mode,
            compact: mode === 'compact',
            issues: mode === 'detailed' ? visible : [],
            'compact-list': mode === 'compact' ? compactIssueList(visible.map((r) => r.number)) : '',
            truncated: shown < total,
            shown,
            'hidden-count': total - shown,
        };
    };

    const tryRender = (view) => {
        try {
            const text = renderWith(view);
            return typeof text === 'string' ? text : null;
        } catch (_) {
            return null;
        }
    };

    const result = (text, mode, shown) => ({
        text,
        mode,
        shown,
        hidden: total - shown,
        truncated: shown < total,
    });

    // 1. Vista detallada completa — sólo para listas chicas.
    if (total > 0 && total <= maxDetailed) {
        const text = tryRender(viewFor('detailed', total));
        if (text !== null && text.length <= cap) return result(text, 'detailed', total);
    }

    // 2. Vista compacta completa. Es la que salva el caso de producción: 139
    //    issues entran sin descartar ninguno.
    const compactAll = tryRender(viewFor('compact', total));
    if (compactAll !== null && compactAll.length <= cap) return result(compactAll, 'compact', total);

    // 3. Vista compacta acotada: mayor cantidad de issues que entra, con
    //    truncado explícito. Búsqueda binaria sobre el largo REAL del render.
    let lo = 0;
    let hi = Math.max(total - 1, 0);
    let best = null;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const text = tryRender(viewFor('compact', mid));
        if (text !== null && text.length <= cap) {
            best = { text, shown: mid };
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (best) return result(best.text, 'compact', best.shown);

    // 4. Red de seguridad: ni con cero issues entra (sólo alcanzable si el
    //    template crece más que el presupuesto). Recorte seguro por token, para
    //    no emitir un MarkdownV2 partido al medio.
    const zero = tryRender(viewFor('compact', 0));
    return result(safeTruncate(zero || '', cap), 'overflow', 0);
}

module.exports = {
    MAX_DETAILED_ROWS,
    MAX_LAST_MODIFIED_CHARS,
    MAX_SKILLS_DISPLAY_CHARS,
    compactIssueList,
    clampSkillsDisplay,
    clampLastModified,
    fitAllowlistRender,
};
