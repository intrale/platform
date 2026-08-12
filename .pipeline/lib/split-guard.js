// =============================================================================
// split-guard.js — Issue #5837
//
// Frenos verificables del split de historias. Nace de un patrón observado en la
// ola 9.4: los splits salían casi siempre en 3 partes (#5440 → #5791-5793 →
// #5794-5805, y todavía más hondo: #5793 → #5800 → #5803/#5805). El 3 no venía
// de ningún criterio: era el default implícito del modelo, reforzado porque
// `.pipeline/roles/planner.md` decía literalmente "dividí en 2-3 historias".
//
// Este módulo NO decide cómo cortar — eso sigue siendo juicio del planner. Lo
// que hace es convertir en verificable lo que antes era doctrina suelta:
//
//   SG-1  El corte se declara: criterio (uno de los 5 canónicos) + por qué N.
//   SG-2  Un plan cuyas partes comparten módulo, capa y flujo no es un corte:
//         es el mismo issue escrito N veces → se rechaza sin crear nada.
//   SG-3  Un issue que ya es hijo de un split no se re-parte sin `--force`
//         + justificación escrita. Así se corta la cascada padre→hijo→nieto.
//   SG-4  Un hijo que sale L/XL es un defecto del corte del PADRE, no una
//         invitación a partir de nuevo: se reporta hacia arriba.
//   SG-5  El registro del corte en el body del padre es idempotente: re-correr
//         el split actualiza el bloque, no apila bloques contradictorios.
//
// Detección de hijo (SG-3): ÚNICO criterio robusto = el título canónico
// `^[Split de #N]`. El label `split` NO sirve para esto por dos razones
// verificadas sobre GitHub:
//   a) está aplicado de forma inconsistente — #5800 lo tiene, #5803 y #5805 no,
//      y son justo los nietos, el caso que más duele;
//   b) en `pulpo.js#isSplitParent` el label marca al PADRE paraguas, así que
//      usarlo para detectar hijos es un falso positivo invertido.
// Por eso se reusa el MISMO patrón ya validado y testeado en
// `split-orphan-reconciler.js` (SPLIT_TITLE_RE) en vez de rodar uno nuevo.
//
// Módulo PURO: sin red, sin filesystem, sin estado. Todo entra por parámetro.
//
// Ejecutar sus tests:
//   node --test .pipeline/lib/__tests__/split-guard.test.js
// =============================================================================

'use strict';

// Reuso deliberado del patrón canónico del reconciler (#5516) en vez de
// duplicarlo: si algún día cambia el formato del título, cambia en un solo lado.
const { SPLIT_TITLE_RE } = require('./split-orphan-reconciler');

// -----------------------------------------------------------------------------
// SG-1 — Catálogo de criterios de corte
// -----------------------------------------------------------------------------
// Son los mismos 5 que ya listaba `/planner split` (SP3). Acá quedan con `id`
// legible para poder validarlos por nombre. Se escriben SIEMPRE por nombre
// ("por capa"), nunca por número ("criterio 3"): el número obliga a volver al
// skill para entender qué se decidió.
const CUT_CRITERIA = Object.freeze([
    Object.freeze({
        id: 'por-modulo',
        nombre: 'por módulo',
        descripcion: 'separar backend de app, o módulos independientes (backend, users, app)',
    }),
    Object.freeze({
        id: 'por-funcionalidad',
        nombre: 'por funcionalidad entregable',
        descripcion: 'cada sub-historia tiene valor por sí misma',
    }),
    Object.freeze({
        id: 'por-capa',
        nombre: 'por capa',
        descripcion: 'el issue abarca UI + backend y se separa por capa',
    }),
    Object.freeze({
        id: 'por-flujo',
        nombre: 'por flujo',
        descripcion: 'múltiples flujos de usuario, uno por historia',
    }),
    Object.freeze({
        id: 'por-tamano',
        nombre: 'por tamaño objetivo',
        descripcion: 'cortar para que cada parte quede en S o M',
    }),
]);

const CUT_CRITERIA_IDS = Object.freeze(CUT_CRITERIA.map((c) => c.id));
const CUT_CRITERIA_NOMBRES = Object.freeze(CUT_CRITERIA.map((c) => c.nombre));

// Tamaños que, en un hijo recién creado, delatan que el corte del padre estuvo mal.
const OVERSIZED_SIZES = Object.freeze(['L', 'XL']);

// Mínimo de partes para que "split" signifique algo. Partir en 1 no es partir.
const MIN_PARTS = 2;

// Largo máximo del "por qué N y no N±1". Es un campo de auditoría que alguien va
// a leer en diagonal sobre doce issues: una línea, no un párrafo.
const MAX_JUSTIFICACION_N_CHARS = 240;

// Encabezado EXACTO del bloque que se inyecta en el body del padre (SG-5).
// Es la ancla de la idempotencia: para actualizar hay que reconocerlo.
const REGISTRO_HEADING = '## Registro del split';

// -----------------------------------------------------------------------------
// Helpers internos
// -----------------------------------------------------------------------------

function toPositiveInt(value) {
    const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

// Normaliza para COMPARAR (no para mostrar): minúsculas, sin tildes, sin espacios
// redundantes. Sirve tanto para matchear el criterio de corte escrito a mano como
// para detectar partes indistinguibles ("Backend " vs "backend").
function comparableText(value) {
    return normalizeText(value)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/\s+/g, ' ');
}

/**
 * Resuelve un criterio de corte escrito por el agente (id, nombre con o sin
 * tildes, "modulo", "por capa"…) contra el catálogo canónico.
 *
 * @param {string} value
 * @returns {{id: string, nombre: string, descripcion: string}|null}
 */
function resolveCutCriterion(value) {
    const needle = comparableText(value);
    if (!needle) return null;

    // Un número suelto ("3", "criterio 3") se rechaza a propósito: el criterio se
    // nombra, no se numera (guideline UX del issue).
    if (/^(criterio\s*)?\d+$/.test(needle)) return null;

    const bare = needle.replace(/^por\s+/, '');
    return (
        CUT_CRITERIA.find((c) => {
            const id = comparableText(c.id).replace(/-/g, ' ');
            const nombre = comparableText(c.nombre);
            return (
                needle === id ||
                needle === nombre ||
                bare === id.replace(/^por\s+/, '') ||
                bare === nombre.replace(/^por\s+/, '')
            );
        }) || null
    );
}

// -----------------------------------------------------------------------------
// SG-3 — ¿Este issue ya es hijo de un split?
// -----------------------------------------------------------------------------

/**
 * Extrae el número del padre declarado en el título canónico `[Split de #N]`.
 *
 * @param {string} title
 * @returns {number|null} número del padre, o null si el título no es canónico
 */
function parseSplitParent(title) {
    const m = SPLIT_TITLE_RE.exec(normalizeText(title));
    if (!m) return null;
    return toPositiveInt(m[1]);
}

/**
 * Clasifica un issue como hijo de split o no.
 *
 * El label `split` se acepta como señal SECUNDARIA sólo cuando viene acompañado
 * de `blocked:dependencies` (así lo redactó el CA-3 del issue), pero en ese caso
 * no hay padre conocido — y se deja constancia de que la señal es débil, porque
 * ese mismo label marca al padre paraguas en `pulpo.js#isSplitParent`.
 *
 * @param {{number?: number|string, title?: string, labels?: Array}} issue
 * @returns {{isChild: boolean, parent: number|null, source: 'titulo'|'labels'|null}}
 */
function isSplitChild(issue) {
    const none = { isChild: false, parent: null, source: null };
    if (!issue || typeof issue !== 'object') return none;

    const self = toPositiveInt(issue.number);
    const parent = parseSplitParent(issue.title);

    // Un issue titulado "[Split de #X]" que apunta a sí mismo es basura, no un hijo.
    if (parent && parent !== self) {
        return { isChild: true, parent, source: 'titulo' };
    }

    const labels = Array.isArray(issue.labels)
        ? issue.labels
              .map((l) => comparableText(typeof l === 'string' ? l : l && l.name))
              .filter(Boolean)
        : [];

    if (labels.includes('split') && labels.includes('blocked:dependencies')) {
        return { isChild: true, parent: null, source: 'labels' };
    }

    return none;
}

/**
 * SG-3 — Decide si se permite partir un issue que ya es hijo de un split.
 *
 * @param {object} params
 * @param {object} params.issue          — `{ number, title, labels }`
 * @param {boolean} [params.force]       — se pasó `--force`
 * @param {string} [params.justificacion] — justificación escrita que acompaña al `--force`
 * @returns {{allowed: boolean, isChild: boolean, parent: number|null, reason: string|null, message: string|null}}
 */
function checkResplit({ issue, force = false, justificacion = '' } = {}) {
    const child = isSplitChild(issue);
    const number = toPositiveInt(issue && issue.number);

    if (!child.isChild) {
        return { allowed: true, isChild: false, parent: null, reason: null, message: null };
    }

    const padre = child.parent ? `#${child.parent}` : 'un split previo';
    const self = number ? `#${number}` : '<N>';

    if (!force) {
        return {
            allowed: false,
            isChild: true,
            parent: child.parent,
            reason: 'hijo-de-split-sin-force',
            message: [
                `⛔ Issue ${self} ya es hijo del split de ${padre} — no se re-parte automáticamente.`,
                `Si el corte del padre quedó mal, reportalo sobre ${padre}.`,
                `Para partir igual: /planner split ${number || '<N>'} --force "<justificación escrita>"`,
            ].join('\n'),
        };
    }

    if (!normalizeText(justificacion)) {
        return {
            allowed: false,
            isChild: true,
            parent: child.parent,
            reason: 'force-sin-justificacion',
            message: [
                `⛔ Issue ${self} es hijo del split de ${padre} y \`--force\` vino sin justificación escrita.`,
                'El freno de cascada exige decir por qué este hijo se parte igual.',
                `Reintentá: /planner split ${number || '<N>'} --force "<justificación escrita>"`,
            ].join('\n'),
        };
    }

    return {
        allowed: true,
        isChild: true,
        parent: child.parent,
        reason: 'force-justificado',
        message: `⚠️ Issue ${self} es hijo del split de ${padre}; se parte igual por \`--force\`: ${normalizeText(justificacion)}`,
    };
}

// -----------------------------------------------------------------------------
// SG-4 — Un hijo L/XL es defecto del corte del padre
// -----------------------------------------------------------------------------

/**
 * @param {object} params
 * @param {number|string} params.issue  — el hijo
 * @param {number|string} [params.parent]
 * @param {string} params.size          — S / M / L / XL
 * @returns {{oversized: boolean, message: string|null}}
 */
function reportOversizedChild({ issue, parent, size } = {}) {
    const normalized = normalizeText(size).toUpperCase();
    if (!OVERSIZED_SIZES.includes(normalized)) {
        return { oversized: false, message: null };
    }

    const self = toPositiveInt(issue) ? `#${toPositiveInt(issue)}` : '<hijo>';
    const padre = toPositiveInt(parent) ? `#${toPositiveInt(parent)}` : 'su padre';

    return {
        oversized: true,
        message: [
            `⚠️ El hijo ${self} quedó clasificado ${normalized} — el corte del split de ${padre} estuvo mal.`,
            `Esto NO se resuelve partiendo ${self} de nuevo: se reporta como defecto sobre ${padre} para rehacer el corte.`,
        ].join('\n'),
    };
}

// -----------------------------------------------------------------------------
// SG-1 + SG-2 — Validación del plan de split
// -----------------------------------------------------------------------------

/**
 * Valida un plan de split ANTES de crear un solo issue.
 *
 * @param {object} plan
 * @param {string} plan.criterio          — criterio de corte, por nombre
 * @param {string} plan.justificacionN    — por qué N y no N±1, en una línea
 * @param {Array<{titulo?: string, modulo?: string, capa?: string, flujo?: string}>} plan.partes
 * @returns {{ok: boolean, errors: string[], criterio: object|null, n: number}}
 */
function validateSplitPlan(plan = {}) {
    const errors = [];
    const partes = Array.isArray(plan.partes) ? plan.partes : [];
    const n = partes.length;

    // --- SG-1: el criterio de corte se declara y es uno de los canónicos ------
    const criterio = resolveCutCriterion(plan.criterio);
    if (!normalizeText(plan.criterio)) {
        errors.push(
            `⛔ Falta declarar el criterio de corte. Elegí uno por nombre: ${CUT_CRITERIA_NOMBRES.join(', ')}.`,
        );
    } else if (!criterio) {
        errors.push(
            `⛔ Criterio de corte no reconocido: "${normalizeText(plan.criterio)}". Escribilo por nombre, no por número: ${CUT_CRITERIA_NOMBRES.join(', ')}.`,
        );
    }

    // --- SG-1: por qué N y no N±1 --------------------------------------------
    const justificacionN = normalizeText(plan.justificacionN);
    if (!justificacionN) {
        errors.push(
            `⛔ Falta la justificación del N: por qué ${n || 'N'} partes y no ${n ? n - 1 : 'N-1'} ni ${n ? n + 1 : 'N+1'}. Una línea alcanza.`,
        );
    } else if (justificacionN.length > MAX_JUSTIFICACION_N_CHARS) {
        errors.push(
            `⛔ La justificación del N tiene ${justificacionN.length} caracteres: es un campo de auditoría, resumila en ${MAX_JUSTIFICACION_N_CHARS} o menos.`,
        );
    } else if (/\bpor\s+default\b|\bpor\s+defecto\b|\bcomo\s+siempre\b|\bt[ií]picamente\b/i.test(justificacionN)) {
        // El issue lo pide explícito: prohibido elegir la cantidad "por default".
        errors.push(
            '⛔ La justificación del N invoca un default ("por default" / "como siempre"). El N tiene que salir del criterio de corte, no de la costumbre.',
        );
    }

    // --- Cantidad de partes ---------------------------------------------------
    if (n < MIN_PARTS) {
        errors.push(
            `⛔ Un split necesita al menos ${MIN_PARTS} partes; el plan trae ${n}. Si no hay corte posible, dejá el issue entero.`,
        );
    }

    // --- SG-2: partes indistinguibles ----------------------------------------
    // Si TODAS las partes comparten módulo, capa y flujo, no hay corte: es el
    // mismo issue escrito N veces. Se rechaza sin crear ninguna sub-historia.
    if (n >= MIN_PARTS) {
        const ejes = ['modulo', 'capa', 'flujo'];
        const firma = (parte) => ejes.map((eje) => comparableText(parte && parte[eje])).join('|');
        const primeras = firma(partes[0]);
        const todasIguales = partes.every((p) => firma(p) === primeras);
        const algunEjeDeclarado = ejes.some((eje) => partes.some((p) => comparableText(p && p[eje])));

        if (todasIguales && algunEjeDeclarado) {
            errors.push(
                '⛔ Corte no justificado: las partes comparten módulo, capa y flujo — es el mismo issue escrito ' +
                    `${n} veces. Rehacé el corte con otro criterio o dejá el issue entero. No se crea ninguna sub-historia.`,
            );
        } else if (!algunEjeDeclarado) {
            errors.push(
                '⛔ Las partes no declaran módulo/capa/flujo, así que el corte no se puede auditar. Completá esos ejes en cada parte.',
            );
        }
    }

    return { ok: errors.length === 0, errors, criterio: criterio || null, n };
}

// -----------------------------------------------------------------------------
// SG-5 — Registro idempotente del corte en el body del padre
// -----------------------------------------------------------------------------

/**
 * Renderiza el bloque `## Registro del split` que va al body del issue padre.
 *
 * @param {{criterio: string, n: number, justificacionN: string, hijas?: Array<number|string>}} data
 * @returns {string}
 */
function renderSplitRegistro({ criterio, n, justificacionN, hijas = [] } = {}) {
    const resuelto = resolveCutCriterion(criterio);
    const nombre = resuelto ? resuelto.nombre : normalizeText(criterio) || 'sin declarar';
    const cantidad = toPositiveInt(n) || (Array.isArray(hijas) ? hijas.length : 0);
    const ids = (Array.isArray(hijas) ? hijas : [])
        .map((h) => toPositiveInt(h))
        .filter(Boolean)
        .map((h) => `#${h}`);

    const lines = [
        REGISTRO_HEADING,
        '',
        `- **Criterio de corte**: ${nombre}`,
        `- **N elegido**: ${cantidad}`,
        `- **Por qué ${cantidad} y no ${Math.max(cantidad - 1, 1)}/${cantidad + 1}**: ${normalizeText(justificacionN) || 'sin declarar'}`,
    ];
    if (ids.length) lines.push(`- **Sub-historias**: ${ids.join(', ')}`);

    return lines.join('\n');
}

/**
 * Inserta o ACTUALIZA el bloque `## Registro del split` dentro del body del padre.
 *
 * Idempotente por pedido explícito de UX: re-ejecutar el split reemplaza el
 * bloque existente en vez de apilar bloques contradictorios. Un body con tres
 * registros que se contradicen es peor que ninguno.
 *
 * Nunca pisa el body original: si no encuentra el bloque, lo agrega al final.
 *
 * @param {string} body — body actual del issue padre
 * @param {object} data — mismo shape que renderSplitRegistro
 * @returns {string} body nuevo
 */
function upsertSplitRegistro(body, data) {
    const original = typeof body === 'string' ? body : '';
    const bloque = renderSplitRegistro(data);

    // Reemplaza desde el encabezado hasta el próximo `## ` de nivel 2 (o el final).
    // Sin `g`: se actualiza la PRIMERA aparición y las duplicadas se limpian abajo.
    const heading = REGISTRO_HEADING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blockRe = new RegExp(`^${heading}\\s*$[\\s\\S]*?(?=^##\\s|\\s*$(?![\\s\\S]))`, 'm');

    if (blockRe.test(original)) {
        let out = original.replace(blockRe, `${bloque}\n\n`);
        // Si una corrida vieja (pre-idempotencia) dejó bloques apilados, se podan.
        const dupRe = new RegExp(`^${heading}\\s*$[\\s\\S]*?(?=^##\\s|\\s*$(?![\\s\\S]))`, 'gm');
        let first = true;
        out = out.replace(dupRe, (match) => {
            if (first) {
                first = false;
                return match;
            }
            return '';
        });
        return out.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    }

    const base = original.trimEnd();
    return (base ? `${base}\n\n---\n\n` : '') + bloque + '\n';
}

module.exports = {
    // Catálogo
    CUT_CRITERIA,
    CUT_CRITERIA_IDS,
    CUT_CRITERIA_NOMBRES,
    OVERSIZED_SIZES,
    MIN_PARTS,
    MAX_JUSTIFICACION_N_CHARS,
    REGISTRO_HEADING,
    resolveCutCriterion,
    // SG-3 — freno de cascada
    parseSplitParent,
    isSplitChild,
    checkResplit,
    // SG-4 — hijo sobredimensionado
    reportOversizedChild,
    // SG-1 + SG-2 — validación del plan
    validateSplitPlan,
    // SG-5 — registro idempotente
    renderSplitRegistro,
    upsertSplitRegistro,
};
