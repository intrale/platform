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

// Colapsa a UNA sola línea y recorta al máximo declarado.
//
// No es cosmética: `justificacionN` y `criterio` son prosa libre que nace de un
// issue de un repo PÚBLICO (cualquiera puede escribir el título/body que el
// planner después parafrasea). Si un salto de línea sobrevive hasta el body del
// padre, el texto puede abrir un `## Encabezado` propio; como `upsertSplitRegistro`
// delimita su bloque con el próximo `## ` (blockRe), ese encabezado se vuelve la
// nueva frontera y todo lo que venga detrás queda FUERA de la zona reescribible:
// ningún re-split posterior lo saca nunca más. Por diseño del propio campo esto
// es UNA línea, así que colapsar es también lo semánticamente correcto.
function oneLine(value, max = MAX_JUSTIFICACION_N_CHARS) {
    const flat = normalizeText(value).replace(/\s+/g, ' ');
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

// ¿El texto trae saltos de línea o un encabezado markdown? Se usa para RECHAZAR
// en validación (camino temprano) además de colapsar en el render (defensa en
// profundidad): el que escribe se entera de por qué su campo no sirve.
function hasMultilineOrHeading(value) {
    const raw = typeof value === 'string' ? value : '';
    return /[\r\n]/.test(raw) || /(^|\s)#{1,6}\s/.test(raw);
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
    // Fail-closed ante entrada malformada. El guard existe para FRENAR: si no
    // puede leer el issue (undefined, null, un string, un objeto sin título),
    // no sabe si es hijo de un split — y "no sé" nunca puede significar "dale".
    if (!issue || typeof issue !== 'object' || typeof issue.title !== 'string') {
        return {
            allowed: false,
            isChild: false,
            parent: null,
            reason: 'entrada-invalida',
            message: [
                '⛔ No se pudo evaluar el freno de cascada: el issue llegó sin `title` legible.',
                'Pasá el JSON de `gh issue view <N> --json number,title,labels` tal cual, sin recortar campos.',
            ].join('\n'),
        };
    }

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
    if (hasMultilineOrHeading(plan.criterio)) {
        errors.push(
            '⛔ El criterio de corte trae saltos de línea o un encabezado markdown (`#`). Es un nombre de una línea: elegí uno del catálogo.',
        );
    }
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
    if (hasMultilineOrHeading(plan.justificacionN)) {
        // Este campo termina embebido en el body del issue padre. Un salto de
        // línea con `## ` abre un encabezado que corre la frontera del bloque y
        // deja el texto colado fuera del alcance de todo re-split (rompe el CA-5).
        errors.push(
            '⛔ La justificación del N trae saltos de línea o un encabezado markdown (`#`). Es un campo de auditoría de UNA línea: reescribila sin saltos ni `#`.',
        );
    }
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

    // --- El N declarado tiene que coincidir con las partes reales -------------
    // El N registrado en el padre ES el entregable de CA-1/CA-5: es lo que permite
    // revisar a posteriori si el patrón "siempre 3" persiste. Antes `plan.n` se
    // ignoraba acá y se creía a ciegas en el render, así que un plan de 2 partes
    // podía declarar `n: 3` y quedar registrado como 3 sin que nada lo notara —
    // una auditoría que puede mentir no sirve para nada.
    if (plan.n !== undefined && plan.n !== null && plan.n !== '') {
        const declarado = toPositiveInt(plan.n);
        if (!declarado) {
            errors.push(
                `⛔ El N declarado ("${String(plan.n)}") no es un entero positivo. El N es un dato de auditoría: escribilo como número.`,
            );
        } else if (declarado !== n) {
            errors.push(
                `⛔ El N declarado (${declarado}) no coincide con las partes del plan (${n}). ` +
                    'El N registrado en el padre tiene que describir el corte que realmente se hizo: corregí el N o completá las partes que faltan.',
            );
        }
    }

    // --- SG-2: partes indistinguibles ----------------------------------------
    // Si TODAS las partes comparten módulo, capa y flujo, no hay corte: es el
    // mismo issue escrito N veces. Se rechaza sin crear ninguna sub-historia.
    if (n >= MIN_PARTS) {
        const ejes = ['modulo', 'capa', 'flujo'];
        const firma = (parte) => ejes.map((eje) => comparableText(parte && parte[eje])).join('|');
        const firmas = partes.map(firma);
        const algunEjeDeclarado = ejes.some((eje) => partes.some((p) => comparableText(p && p[eje])));

        // Se rechaza CUALQUIER par de partes indistinguibles, no sólo el caso en que
        // todas lo son. Chequear "todas iguales" cumplía la letra del CA-2 pero no su
        // espíritu: un plan de 3 partes con 2 idénticas pasaba limpio, y esas 2 son
        // exactamente el mismo issue escrito dos veces — el N sale inflado igual.
        const grupos = new Map();
        firmas.forEach((f, i) => {
            if (!grupos.has(f)) grupos.set(f, []);
            grupos.get(f).push(i + 1);
        });
        const duplicados = [...grupos.values()].filter((idxs) => idxs.length > 1);

        if (!algunEjeDeclarado) {
            errors.push(
                '⛔ Las partes no declaran módulo/capa/flujo, así que el corte no se puede auditar. Completá esos ejes en cada parte.',
            );
        } else if (duplicados.length && duplicados[0].length === n) {
            errors.push(
                '⛔ Corte no justificado: las partes comparten módulo, capa y flujo — es el mismo issue escrito ' +
                    `${n} veces. Rehacé el corte con otro criterio o dejá el issue entero. No se crea ninguna sub-historia.`,
            );
        } else if (duplicados.length) {
            const detalle = duplicados.map((idxs) => `partes ${idxs.join(' y ')}`).join('; ');
            errors.push(
                `⛔ Corte no justificado: hay partes indistinguibles entre sí (${detalle}) — comparten módulo, capa y flujo. ` +
                    'Fusionalas o cortalas por otro eje. No se crea ninguna sub-historia.',
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
 * El N NO se toma del campo `n` a ciegas: se DERIVA del corte que realmente se
 * hizo (las partes del plan, o las hijas creadas), y `n` queda como último
 * recurso. La razón es el propósito del bloque: es el registro de auditoría que
 * permite revisar si el patrón "siempre 3" persiste. Si el número que se escribe
 * puede diferir de las hijas que figuran dos líneas más abajo, la auditoría
 * miente y no sirve. `validateSplitPlan` rechaza el mismatch antes de llegar acá;
 * si alguien igual llega con datos contradictorios, se registra la discrepancia
 * en vez de tapar el número real.
 *
 * @param {{criterio: string, n?: number, justificacionN: string, partes?: Array, hijas?: Array<number|string>}} data
 * @returns {string}
 */
function renderSplitRegistro({ criterio, n, justificacionN, partes, hijas = [] } = {}) {
    const resuelto = resolveCutCriterion(criterio);
    // El fallback (criterio libre, no canónico) también se colapsa: es texto que
    // no pasó por el catálogo y por lo tanto puede traer cualquier cosa.
    const nombre = resuelto ? resuelto.nombre : oneLine(criterio, 80) || 'sin declarar';

    const ids = (Array.isArray(hijas) ? hijas : [])
        .map((h) => toPositiveInt(h))
        .filter(Boolean)
        .map((h) => `#${h}`);

    // Prioridad de la evidencia: partes del plan > hijas creadas > n declarado.
    const porPartes = Array.isArray(partes) && partes.length ? partes.length : null;
    const porHijas = ids.length || null;
    const declarado = toPositiveInt(n);
    const cantidad = porPartes || porHijas || declarado || 0;

    const lines = [
        REGISTRO_HEADING,
        '',
        `- **Criterio de corte**: ${nombre}`,
        `- **N elegido**: ${cantidad}`,
        `- **Por qué ${cantidad} y no ${Math.max(cantidad - 1, 1)}/${cantidad + 1}**: ${oneLine(justificacionN) || 'sin declarar'}`,
    ];
    if (ids.length) lines.push(`- **Sub-historias**: ${ids.join(', ')}`);
    if (declarado && declarado !== cantidad) {
        lines.push(
            `- **⚠️ N declarado inconsistente**: el plan decía ${declarado} pero el corte real tiene ${cantidad}. Revisar el split.`,
        );
    }

    return lines.join('\n');
}

// Apertura/cierre de un bloque de código markdown: ``` o ~~~, con hasta 3 espacios
// de indentación (4+ ya sería bloque indentado, no fence).
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

// Cualquier encabezado ATX, de h1 a h6. La frontera del registro NO puede ser sólo
// `^##\s`: después de `##` en `### ` viene `#`, no whitespace, así que un `### `
// no matcheaba y toda subsección h3+ colgada del registro se borraba en silencio.
const HEADING_RE = /^ {0,3}#{1,6}\s/;

// Línea que ES exactamente el encabezado del registro (no una mención dentro de prosa).
const REGISTRO_HEADING_LINE_RE = new RegExp(
    `^ {0,3}${REGISTRO_HEADING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
);

/**
 * Ubica los bloques `## Registro del split` del body, respetando bloques de código.
 *
 * Se hace por escaneo de líneas y no por regex sobre el texto entero por dos razones
 * verificadas empíricamente (rebote de `aprobacion`, #5837):
 *
 *   a) La frontera correcta es "el próximo encabezado de CUALQUIER nivel", y un regex
 *      `^##\s` no matchea `### `. Con esa frontera, un `### Detalle del corte` colgado
 *      del registro quedaba DENTRO del rango reemplazado y desaparecía sin aviso.
 *   b) Un fence (` ```markdown `) puede contener el propio formato documentado del
 *      registro. Sin tracking de fences el upsert entraba al bloque de código, lo
 *      reescribía y dejaba el ``` de cierre huérfano — markdown roto en el issue.
 *
 * Un heading que vive DENTRO de un fence es documentación, no el registro real: se
 * ignora, y si no hay ninguno afuera el bloque se agrega al final del body.
 *
 * @param {string[]} lines
 * @returns {Array<{start: number, end: number}>} rangos [start, end) de líneas
 */
function findRegistroBlocks(lines) {
    const blocks = [];
    let fenceChar = null;
    let fenceLen = 0;
    let openStart = -1;

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];

        const fence = FENCE_RE.exec(line);
        if (fence) {
            const char = fence[1][0];
            const len = fence[1].length;
            if (fenceChar === null) {
                fenceChar = char;
                fenceLen = len;
            } else if (char === fenceChar && len >= fenceLen) {
                fenceChar = null;
                fenceLen = 0;
            }
            continue; // una línea de fence nunca es encabezado
        }

        if (fenceChar !== null) continue; // adentro de un bloque de código: intocable

        if (REGISTRO_HEADING_LINE_RE.test(line)) {
            // Dos registros seguidos (corrida vieja pre-idempotencia): cierra el anterior.
            if (openStart >= 0) blocks.push({ start: openStart, end: i });
            openStart = i;
            continue;
        }

        if (openStart >= 0 && HEADING_RE.test(line)) {
            blocks.push({ start: openStart, end: i });
            openStart = -1;
        }
    }

    if (openStart >= 0) blocks.push({ start: openStart, end: lines.length });
    return blocks;
}

/**
 * Inserta o ACTUALIZA el bloque `## Registro del split` dentro del body del padre.
 *
 * Idempotente por pedido explícito de UX: re-ejecutar el split reemplaza el
 * bloque existente en vez de apilar bloques contradictorios. Un body con tres
 * registros que se contradicen es peor que ninguno.
 *
 * Nunca pisa el body original: lo único que se reescribe es el rango que va desde
 * el encabezado del registro hasta el próximo encabezado de cualquier nivel fuera
 * de un bloque de código. Si no encuentra el bloque, lo agrega al final.
 *
 * @param {string} body — body actual del issue padre
 * @param {object} data — mismo shape que renderSplitRegistro
 * @returns {string} body nuevo
 */
function upsertSplitRegistro(body, data) {
    const original = typeof body === 'string' ? body : '';
    const bloque = renderSplitRegistro(data);
    const lines = original.split('\n');
    const blocks = findRegistroBlocks(lines);

    if (!blocks.length) {
        const base = original.trimEnd();
        return (base ? `${base}\n\n---\n\n` : '') + bloque + '\n';
    }

    // El primer bloque se reemplaza; los duplicados de corridas viejas se podan.
    const out = [];
    let cursor = 0;
    blocks.forEach((block, idx) => {
        out.push(...lines.slice(cursor, block.start));
        if (idx === 0) out.push(...bloque.split('\n'), '');
        cursor = block.end;
    });
    out.push(...lines.slice(cursor));

    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
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
