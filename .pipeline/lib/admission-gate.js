// =============================================================================
// admission-gate.js — Gate de admisión para issues/PRs sin label de pipeline
// Issue #3175
//
// Contexto: cualquier creación de issue/PR puede olvidarse de aplicar
// `needs-definition` o `Ready`. Sin uno de los dos, el Pulpo nunca los procesa
// y quedan huérfanos. Caso testigo: PR #3129 bloqueó 5 días a #3086.
//
// Responsabilidad:
//   - Decisión pura: ¿este artefacto tiene label de admisión? (isAdmitted)
//   - Texto literal del comentario auto-aplicado (issue / PR).
//   - Texto literal de la alerta Telegram (sweep normal / bootstrap).
//   - Cap defensivo de bootstrap (CA-5).
//
// Diseño:
//   - Stateless. Cero I/O. Cero dependencias salvo redact.js para sanitizar
//     títulos antes de pegarlos en la alerta de Telegram (CA-S4 / CA-UX3).
//   - Las constantes ADMISSION_COMMENT_* son TEXTO LITERAL. CA-S6 / CA-UX1:
//     `verificacion` debe poder hacer `grep` en este módulo y encontrar la
//     copy exacta sin interpolación de input del usuario.
//   - El comentario y la alerta NO incluyen body, diff, user.login, ni
//     cualquier otro campo proveniente del creador del artefacto.
//
// Reuso:
//   - GitHub Actions workflow (`.github/workflows/admission-gate.yml`) lo
//     consume vía `actions/github-script` con un `require()` relativo.
//   - `servicio-reconciler.js` lo consume directamente con require.
//
// Tests: `lib/__tests__/admission-gate.test.js`.
// =============================================================================

'use strict';

const { redactSensitive } = require('./redact');

// -----------------------------------------------------------------------------
// Configuración
// -----------------------------------------------------------------------------

// Labels que cuentan como "admisión" — el Pulpo procesa cualquiera de estos.
// Mantener sincronizado con `intake:` de `.pipeline/config.yaml` (líneas 66-72).
// Si la config cambia, este array debe seguirla — duplicación intencional para
// que el módulo sea independiente y testeable sin parsear YAML.
const ADMISSION_LABELS = Object.freeze(['needs-definition', 'Ready']);

// Label que se aplica por default cuando un artefacto entra sin admisión.
// `needs-definition` porque "pecar de exceso de definición" es más seguro que
// saltar a implementación sin scope (decisión documentada en el issue #3175).
const DEFAULT_ADMISSION_LABEL = 'needs-definition';

// Cap de huérfanos a aplicar por sweep del reconciler (CA-5). El primer
// barrido post-deploy puede encontrar muchos huérfanos históricos; aplicar
// masivamente sin revisión humana es peligroso. Si N>10, se aplica a los
// 10 primeros + alerta especial.
const BOOTSTRAP_CAP = 10;

// Truncado del título en alertas Telegram (CA-UX2 + CA-S4): defensa contra
// títulos que puedan filtrar secrets pegados por accidente.
const TELEGRAM_TITLE_MAX = 80;

// -----------------------------------------------------------------------------
// Texto literal del comentario auto-aplicado (CA-3 / CA-S6 / CA-UX1)
// -----------------------------------------------------------------------------
//
// REGLAS INQUEBRANTABLES:
//   - 100% estático. Cero interpolación de input del creador del artefacto.
//   - `verificacion` puede hacer `grep "auto-etiquetado" admission-gate.js`.
//   - Si la doc canónica del Pulpo cambia, actualizar el LINK literal acá.
//   - Sin emojis (consistente con comentarios del Pulpo/reconciler vigentes).

const ADMISSION_COMMENT_ISSUE =
    'Este issue fue auto-etiquetado con `needs-definition` porque fue creado sin label de admisión.\n' +
    '\n' +
    'El Pulpo (orquestador del pipeline) sólo procesa artefactos con `needs-definition` o `Ready`. ' +
    'Sin uno de los dos, el issue queda huérfano y no avanza.\n' +
    '\n' +
    '**¿Querés saltar definición y arrancar implementación directa?**\n' +
    'Cambiá el label a `Ready` manualmente. El gate no vuelve a intervenir.\n' +
    '\n' +
    '**¿Por qué pasa esto?**\n' +
    'Cualquier creación (manual, vía `gh`, agentes, hooks) puede olvidarse del label. ' +
    'Este gate cierra esa brecha automáticamente. ' +
    'Más detalle: [docs/pipeline-v2-diseno.md](https://github.com/intrale/platform/blob/main/docs/pipeline-v2-diseno.md).';

const ADMISSION_COMMENT_PR =
    'Este PR fue auto-etiquetado con `needs-definition` porque fue creado sin label de admisión.\n' +
    '\n' +
    'El Pulpo (orquestador del pipeline) sólo procesa artefactos con `needs-definition` o `Ready`. ' +
    'Sin uno de los dos, el PR queda huérfano y no avanza.\n' +
    '\n' +
    '**¿Querés saltar definición y arrancar implementación directa?**\n' +
    'Cambiá el label a `Ready` manualmente. El gate no vuelve a intervenir.\n' +
    '\n' +
    '**¿Por qué pasa esto?**\n' +
    'Cualquier creación (manual, vía `gh`, agentes, hooks) puede olvidarse del label. ' +
    'Este gate cierra esa brecha automáticamente. ' +
    'Más detalle: [docs/pipeline-v2-diseno.md](https://github.com/intrale/platform/blob/main/docs/pipeline-v2-diseno.md).';

// Prefijo único usado por idempotencia: si el comentario ya existe en el
// artefacto, no duplicar (regla operativa de UX edge case #4).
const ADMISSION_COMMENT_PREFIX_ISSUE = 'Este issue fue auto-etiquetado con `needs-definition`';
const ADMISSION_COMMENT_PREFIX_PR = 'Este PR fue auto-etiquetado con `needs-definition`';

// -----------------------------------------------------------------------------
// Decisión pura: ¿está admitido?
// -----------------------------------------------------------------------------

/**
 * Normaliza un array de labels (objetos `{name}` o strings) a array de strings.
 * @param {Array<string|{name?: string}>} labels
 * @returns {string[]}
 */
function normalizeLabels(labels) {
    if (!Array.isArray(labels)) return [];
    return labels.map((l) => {
        if (typeof l === 'string') return l;
        if (l && typeof l === 'object' && typeof l.name === 'string') return l.name;
        return '';
    }).filter(Boolean);
}

/**
 * ¿El artefacto tiene al menos un label de admisión?
 *
 * Match exacto, case-sensitive. `Ready` con R mayúscula match; `ready` no.
 * Esto es intencional: el repo usa `Ready` (canónico de config.yaml) y
 * tolerar variaciones abriría la puerta a typo-silenciosos.
 *
 * @param {Array<string|{name?: string}>} labels
 * @returns {boolean}
 */
function isAdmitted(labels) {
    const names = normalizeLabels(labels);
    for (const n of names) {
        if (ADMISSION_LABELS.includes(n)) return true;
    }
    return false;
}

/**
 * Lista de huérfanos que requieren admisión, dado el resultado de
 * `gh issue list --state open --json number,labels,title,url`.
 *
 * Devuelve solo lo necesario para alerta + apply: no propaga body ni
 * usuario (CA-S4). El título viene tal cual; el formateador de Telegram
 * lo trunca y redacta antes de ponerlo en el mensaje.
 *
 * @param {Array<object>} ghItems — items con shape {number, labels, title, url}
 * @returns {Array<{number: number, title: string, url: string}>}
 */
function filterOrphans(ghItems) {
    if (!Array.isArray(ghItems)) return [];
    const out = [];
    for (const item of ghItems) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.number !== 'number') continue;
        if (isAdmitted(item.labels)) continue;
        out.push({
            number: item.number,
            title: typeof item.title === 'string' ? item.title : '',
            url: typeof item.url === 'string' ? item.url : '',
        });
    }
    return out;
}

// -----------------------------------------------------------------------------
// Decisión de bootstrap (CA-5)
// -----------------------------------------------------------------------------

/**
 * Aplica cap de bootstrap sobre la lista de huérfanos del sweep.
 * Si N > BOOTSTRAP_CAP, retorna {apply: primeros 10, deferred: resto, bootstrap: true}.
 * Si N <= BOOTSTRAP_CAP, retorna {apply: todos, deferred: [], bootstrap: false}.
 *
 * El reconciler usa esto para:
 *   - bootstrap=true → alerta 🔴 + accion REQUERIDA
 *   - bootstrap=false → alerta 🟡 normal
 *
 * @param {Array<{number, title, url}>} orphans
 * @returns {{apply: Array, deferred: Array, bootstrap: boolean}}
 */
function applyBootstrapCap(orphans) {
    if (!Array.isArray(orphans)) return { apply: [], deferred: [], bootstrap: false };
    if (orphans.length <= BOOTSTRAP_CAP) {
        return { apply: orphans.slice(), deferred: [], bootstrap: false };
    }
    return {
        apply: orphans.slice(0, BOOTSTRAP_CAP),
        deferred: orphans.slice(BOOTSTRAP_CAP),
        bootstrap: true,
    };
}

// -----------------------------------------------------------------------------
// Texto de alerta Telegram (CA-4 / CA-S4 / CA-UX4)
// -----------------------------------------------------------------------------

/**
 * Trunca + redacta un título para safe-include en alerta Telegram.
 * Doble defensa: redact primero, luego truncar (preserva al menos algo
 * del título si tenía un email/secret al inicio).
 *
 * @param {string} title
 * @returns {string}
 */
function safeTitle(title) {
    if (typeof title !== 'string') return '';
    const redacted = redactSensitive(title);
    const str = typeof redacted === 'string' ? redacted : String(redacted);
    if (str.length <= TELEGRAM_TITLE_MAX) return str;
    return str.slice(0, TELEGRAM_TITLE_MAX - 1) + '…';
}

/**
 * Formatea la alerta Telegram para el sweep del reconciler.
 *
 * Reglas (CA-UX4 / CA-S4):
 *   - N=0 → null (modo silencioso, NO publicar nada).
 *   - bootstrap=false → emoji 🟡, header "N huérfanos detectados y etiquetados".
 *   - bootstrap=true  → emoji 🔴, header "N huérfanos preexistentes (cap N aplicado)".
 *   - Cada huérfano: `[#NNNN](url) — Título — labels:[applied]` en una línea.
 *   - NO incluye body, comments, diff, user.login (CA-S4).
 *   - Título pasa por redactSensitive() como capa defensiva.
 *
 * @param {object} result — output de applyBootstrapCap()
 * @param {{labelApplied?: string}} [opts]
 * @returns {string|null} mensaje markdown, o null si N=0.
 */
function formatTelegramAlert(result, opts) {
    if (!result || !Array.isArray(result.apply)) return null;
    if (result.apply.length === 0 && (!result.deferred || result.deferred.length === 0)) {
        return null; // CA-UX5: modo silencioso
    }
    const _opts = opts || {};
    const labelApplied = _opts.labelApplied || DEFAULT_ADMISSION_LABEL;
    const isBootstrap = !!result.bootstrap;
    const totalDetected = result.apply.length + (result.deferred ? result.deferred.length : 0);

    const lines = [];
    if (isBootstrap) {
        lines.push(`🔴 Admission gate — ${totalDetected} huérfanos preexistentes (cap ${BOOTSTRAP_CAP} aplicado)`);
        lines.push('');
        lines.push(`Aplicado a los primeros ${BOOTSTRAP_CAP}. Resto en cola para próximo barrido.`);
        lines.push('');
    } else {
        lines.push(`🟡 Admission gate — ${result.apply.length} huérfanos detectados y etiquetados`);
        lines.push('');
    }

    for (const o of result.apply) {
        const url = typeof o.url === 'string' && o.url ? o.url : `#${o.number}`;
        const title = safeTitle(o.title);
        lines.push(`[#${o.number}](${url}) — ${title} — labels:[${labelApplied}]`);
    }

    lines.push('');
    if (isBootstrap) {
        lines.push('Acción REQUERIDA: confirmar si proceder con el resto o investigar causa raíz.');
    } else {
        lines.push(`Acción: revisar si alguno requiere \`Ready\` directo en vez de \`${labelApplied}\`.`);
    }

    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Comentario para issue/pr — selector + idempotencia
// -----------------------------------------------------------------------------

/**
 * Devuelve el texto literal del comentario según el tipo de artefacto.
 * @param {'issue'|'pr'} kind
 * @returns {string}
 */
function getAdmissionComment(kind) {
    if (kind === 'pr') return ADMISSION_COMMENT_PR;
    return ADMISSION_COMMENT_ISSUE;
}

/**
 * ¿Ya existe un comentario del gate en este artefacto? (idempotencia)
 * Recibe el array de comments con shape `[{body}]` y verifica que ninguno
 * arranque con el prefijo conocido.
 *
 * @param {Array<{body?: string}>} comments
 * @param {'issue'|'pr'} kind
 * @returns {boolean}
 */
function alreadyCommented(comments, kind) {
    if (!Array.isArray(comments)) return false;
    const prefix = kind === 'pr'
        ? ADMISSION_COMMENT_PREFIX_PR
        : ADMISSION_COMMENT_PREFIX_ISSUE;
    for (const c of comments) {
        if (!c || typeof c.body !== 'string') continue;
        if (c.body.startsWith(prefix)) return true;
    }
    return false;
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    // constantes
    ADMISSION_LABELS,
    DEFAULT_ADMISSION_LABEL,
    BOOTSTRAP_CAP,
    TELEGRAM_TITLE_MAX,
    ADMISSION_COMMENT_ISSUE,
    ADMISSION_COMMENT_PR,
    ADMISSION_COMMENT_PREFIX_ISSUE,
    ADMISSION_COMMENT_PREFIX_PR,
    // decisión
    isAdmitted,
    normalizeLabels,
    filterOrphans,
    applyBootstrapCap,
    // formatos
    formatTelegramAlert,
    safeTitle,
    getAdmissionComment,
    alreadyCommented,
};
