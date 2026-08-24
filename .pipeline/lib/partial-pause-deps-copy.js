'use strict';

// =============================================================================
// partial-pause-deps-copy.js — Fuente única del copy de la alerta de
// dependencias faltantes en la superficie de Telegram (#6118).
//
// POR QUÉ EXISTE ESTE MÓDULO
// --------------------------
// La alerta se titulaba "⚠️ Pausa parcial trabada" y hablaba de "allowlist".
// Dos problemas: (a) la pausa parcial dejó de ser un estado excepcional —en el
// modelo de olas es el modo normal de operar—, así que titular con ese nombre
// anuncia una anomalía que no existe; (b) el sujeto del bloqueo estaba mal: lo
// que no puede avanzar no es el pipeline, es UN issue puntual que depende de
// otro que quedó fuera de la selección.
//
// El texto vivía repartido en cuatro lugares distintos (template inline del
// Pulpo, labels del teclado, `PP_META[].consequence` del doble tap y los `msg`
// de `partial-pause-resolution`). Cuatro copias del mismo vocabulario es como
// se desincronizan: arreglás el título y la confirmación sigue diciendo
// "allowlist". Acá vive el QUÉ decir; cada superficie decide CÓMO dibujarlo.
//
// Precedente directo: `desync-copy.js` (#5724), creado por el mismo motivo.
//
// CONTRATO
// --------
// Módulo PURO: sin filesystem, sin red, sin `require` de estado del pipeline.
// Es seguro requerirlo desde el Pulpo, desde el hook de callbacks o desde un
// test. No arma markup de Telegram ni teclados: devuelve strings.
//
// FRONTERA DE LA PROHIBICIÓN DE JERGA (H-5)
// -----------------------------------------
// El test anti-jerga (CA-8) corre SOBRE ESTE MÓDULO, no sobre todo el código de
// pausa parcial. En el dashboard "allowlist" es vocabulario legítimo y no se
// toca (CA-14). Por eso `partial-pause-resolution.js` devuelve `msg` (interno,
// dashboard) Y `operatorMsg` (Telegram, de acá): son dos audiencias distintas.
//
// SEGURIDAD (REQ-SEC-6)
// ---------------------
// Todo lo que se interpola en un mensaje con `parse_mode: Markdown` pasa por
// `issueRef()`, que sólo deja salir `#<entero>`. NUNCA se interpola el título
// de un issue: cualquiera que abra un issue controla ese texto y podría inyectar
// markup o links en el mensaje del operador (mismo criterio que #5889 y #5398).
// =============================================================================

// Ventana de silencio por default: 24 h. El valor REAL viene de
// `partial_pause_deps.mute_ttl_ms` en config (CA-13); esto es sólo el piso para
// cuando el caller no lo pasa. El copy NUNCA hardcodea "24 h" en un literal:
// se deriva con `formatWindow()`, así que si mañana el TTL baja a 6 h el texto
// del botón acompaña solo (UX-D-2 / PO-R2).
const DEFAULT_MUTE_TTL_MS = 24 * 60 * 60 * 1000;

// Las tres acciones que ofrece la alerta. `include-deps-for-issue` es el
// endpoint nuevo y acotado al issue de ESTA alerta; el viejo `include-deps`
// (alcance global) sigue sirviendo al banner del dashboard y no se nombra acá.
const ACTIONS = Object.freeze(['include-deps-for-issue', 'keep-original', 'mute-alert']);

// -----------------------------------------------------------------------------
// Glosario prohibido (CA-1 / CA-8).
//
// Estos términos describen el mecanismo interno, no lo que le pasa al operador.
// El test del CA-8 barre el texto RENDERIZADO final de las cuatro superficies
// contra esta expresión; si alguien reintroduce jerga, el test falla antes del
// merge. La lista incluye los cinco del glosario mínimo de UX más los que
// aparecían en el copy viejo.
//
// Reemplazos acordados:
//   pausa parcial → (no se nombra; se habla del issue)
//   allowlist     → "habilitado en esta ola" / "los issues habilitados"
//   dispatch      → "avanzar" / "arrancar"
//   marker/state  → (no se nombra)
//   deps          → "dependencias" (nunca abreviado)
//   cooldown      → la ventana concreta ("por 24 h")
// -----------------------------------------------------------------------------
const FORBIDDEN_TERMS = Object.freeze([
    /pausa\s+parcial/i,
    /allowlist/i,
    /dispatch/i,
    /despach\w*/i,
    /\bmarkers?\b/i,
    /cooldown/i,
    /\bdeps\b/i,
    /\bflags?\b/i,
]);

/**
 * Devuelve los términos prohibidos que aparecen en un texto. Array vacío = limpio.
 * Se exporta para que el test del CA-8 reporte QUÉ término reapareció, no sólo
 * que algo falló.
 *
 * @param {string} text
 * @returns {string[]} los matches concretos encontrados
 */
function findForbiddenTerms(text) {
    const s = String(text == null ? '' : text);
    const hits = [];
    for (const re of FORBIDDEN_TERMS) {
        const m = s.match(re);
        if (m) hits.push(m[0]);
    }
    return hits;
}

// -----------------------------------------------------------------------------
// Normalización de entradas. Todo lo que llega puede venir de un callback de
// Telegram (o sea: del cliente), así que nada se usa crudo.
// -----------------------------------------------------------------------------

/** Entero positivo o `null`. Rechaza strings raros, floats, negativos y NaN. */
function toIssueNumber(raw) {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 && n <= 9_999_999 ? n : null;
}

/** `#<entero>` validado. Si no es un entero válido devuelve `null` (REQ-SEC-6). */
function issueRef(raw) {
    const n = toIssueNumber(raw);
    return n === null ? null : `#${n}`;
}

/** Lista de deps normalizada: enteros positivos, únicos, en orden de llegada. */
function normalizeDeps(raw) {
    const seen = new Set();
    const out = [];
    for (const d of Array.isArray(raw) ? raw : []) {
        const n = toIssueNumber(d);
        if (n !== null && !seen.has(n)) { seen.add(n); out.push(n); }
    }
    return out;
}

/**
 * Enumeración en castellano: comas y `y` antes del último, sin coma de Oxford.
 *   [6032]                   → "#6032"
 *   [6032, 6031]             → "#6032 y #6031"
 *   [6032, 6031, 6030]       → "#6032, #6031 y #6030"
 */
function enumerateRefs(deps) {
    const refs = normalizeDeps(deps).map(d => `#${d}`);
    if (refs.length === 0) return '';
    if (refs.length === 1) return refs[0];
    return `${refs.slice(0, -1).join(', ')} y ${refs[refs.length - 1]}`;
}

/**
 * Ventana de silencio en unidad legible (UX-D-2). Nunca milisegundos.
 *   < 1 h  → minutos enteros ("30 min")
 *   >= 1 h → horas enteras ("24 h")
 * Sin decimales: "1,5 h" en un botón es ruido, y "5400000 ms" es jerga.
 *
 * @param {number} ms
 * @returns {string}
 */
function formatWindow(ms) {
    const n = Number(ms);
    const safe = Number.isFinite(n) && n > 0 ? n : DEFAULT_MUTE_TTL_MS;
    if (safe < 60 * 60 * 1000) {
        return `${Math.max(1, Math.round(safe / 60000))} min`;
    }
    return `${Math.max(1, Math.round(safe / (60 * 60 * 1000)))} h`;
}

// -----------------------------------------------------------------------------
// 1 · Mensaje de la alerta (CA-2 / CA-3)
// -----------------------------------------------------------------------------

/**
 * Cuerpo del aviso que emite el Pulpo.
 *
 * El título nombra al issue frenado y afirma que ESE issue no puede avanzar —no
 * que el pipeline esté trabado (CA-2). El cuerpo enumera las dependencias que
 * faltan y explica por qué frenan (CA-3), con concordancia de número.
 *
 * @param {object} args
 * @param {number|string} args.issue
 * @param {Array<number|string>} args.deps
 * @returns {string} Markdown listo para `sendTelegramWithMarkup`
 */
function buildAlertMessage({ issue, deps } = {}) {
    const ref = issueRef(issue);
    const list = normalizeDeps(deps);
    // Sin issue válido no hay mensaje que valga: mejor un texto genérico y
    // honesto que uno que interpole `#undefined`.
    if (!ref) {
        return '⚠️ *Hay un issue que no puede avanzar*\n\nDepende de otros issues que no están habilitados en esta ola.\n\n¿Cómo querés continuar?';
    }
    if (list.length === 0) {
        return `⚠️ *${ref} no puede avanzar*\n\nDepende de otros issues que no están habilitados en esta ola.\n\n¿Cómo querés continuar?`;
    }
    const verb = list.length === 1 ? 'que no está habilitado' : 'que no están habilitados';
    return `⚠️ *${ref} no puede avanzar*\n\nDepende de ${enumerateRefs(list)}, ${verb} en esta ola.\n\n¿Cómo querés continuar?`;
}

// -----------------------------------------------------------------------------
// 2 · Labels de los botones (CA-4 / CA-5)
// -----------------------------------------------------------------------------

/**
 * Los tres labels del teclado. Cada uno declara su efecto REAL, verificable
 * contra el código:
 *
 *  - habilitar: con una sola dependencia la nombra; con varias dice la cantidad
 *    (CA-5). La acción toca SÓLO las dependencias de este issue.
 *  - seguir: NO dice "bloqueado". `markDepRiskAccepted` mergea un flag y no
 *    filtra nada, así que el issue sigue avanzando; prometer lo contrario
 *    reproduciría, en el mismo commit, el defecto que este issue vino a
 *    corregir (D-2 / UX-D-1 / PO-R1).
 *  - silenciar: declara su vencimiento. El silencio tiene TTL acotado por
 *    seguridad, así que "no volver a avisar" sería otra promesa falsa
 *    (UX-D-2 / PO-R2).
 *
 * @param {object} args
 * @param {number|string} args.issue
 * @param {Array<number|string>} args.deps
 * @param {number} [args.muteTtlMs]
 * @returns {{'include-deps-for-issue':string, 'keep-original':string, 'mute-alert':string}}
 */
function buildButtonLabels({ issue, deps, muteTtlMs } = {}) {
    const list = normalizeDeps(deps);
    const enable = list.length === 1
        ? `✅ Habilitar #${list[0]} y continuar`
        : `✅ Habilitar las ${list.length} dependencias`;
    return {
        'include-deps-for-issue': list.length === 0
            ? '✅ Habilitar las dependencias y continuar'
            : enable,
        'keep-original': '🎯 Seguir sin las dependencias',
        'mute-alert': `🔕 No avisarme por ${formatWindow(muteTtlMs)}`,
    };
}

// -----------------------------------------------------------------------------
// 3 · Consecuencia del doble tap (CA-1 sobre la 4ta superficie)
// -----------------------------------------------------------------------------

/**
 * Texto que el operador ve ANTES de confirmar una acción de alto impacto, y que
 * también queda escrito en el mensaje editado. Es texto visible en Telegram, así
 * que le aplica la prohibición de jerga igual que al resto.
 *
 * El fallback genérico NO es opcional: `PP_META` es un objeto congelado y
 * estático, sin `issue` ni `deps` a mano. Si el handler no puede interpolar el
 * contexto, el texto que se muestra igual tiene que estar libre de jerga y
 * hablar del issue en abstracto. Prohibido caer al `consequence` viejo.
 *
 * @param {object} args
 * @param {string} args.action
 * @param {number|string} [args.issue]
 * @param {Array<number|string>} [args.deps]
 * @param {number} [args.muteTtlMs]
 * @returns {string}
 */
function buildConsequence({ action, issue, deps, muteTtlMs } = {}) {
    const ref = issueRef(issue);
    const list = normalizeDeps(deps);
    const hasCtx = !!ref && list.length > 0;
    const depList = enumerateRefs(list);
    const window = formatWindow(muteTtlMs);

    switch (action) {
        case 'include-deps-for-issue':
            return hasCtx
                ? `Vas a habilitar ${depList} en esta ola para que ${ref} pueda avanzar.`
                : 'Vas a habilitar las dependencias que faltan para que el issue pueda avanzar.';
        case 'keep-original':
            return hasCtx
                ? `Vas a dejar que ${ref} avance sin esperar a ${depList}, asumiendo el riesgo.`
                : 'Vas a dejar que el issue avance sin esperar a sus dependencias, asumiendo el riesgo.';
        case 'mute-alert':
            return hasCtx
                ? `Vas a dejar de recibir este aviso por ${window}. ${ref} sigue frenado igual.`
                : `Vas a dejar de recibir este aviso por ${window}. El issue sigue frenado igual.`;
        default:
            return 'Vas a aplicar esta decisión sobre el issue frenado.';
    }
}

// -----------------------------------------------------------------------------
// 4 · Confirmaciones post-acción (CA-7)
// -----------------------------------------------------------------------------

/**
 * Toast que recibe el operador DESPUÉS de que la acción se aplicó. Habla del
 * issue y de sus dependencias, nunca del estado interno.
 *
 * La última frase de `mute-alert` es obligatoria: silenciar no destraba nada, y
 * el operador tiene que salir del tap sabiéndolo. Es la diferencia entre un
 * silencio informado y un punto ciego (REQ-SEC-4).
 *
 * @param {object} args
 * @param {string} args.action
 * @param {number|string} args.issue
 * @param {Array<number|string>} args.deps
 * @param {number} [args.muteTtlMs]
 * @returns {string}
 */
function buildConfirmation({ action, issue, deps, muteTtlMs } = {}) {
    const ref = issueRef(issue);
    const list = normalizeDeps(deps);
    const depList = enumerateRefs(list);
    const window = formatWindow(muteTtlMs);
    const subject = ref || 'El issue';

    switch (action) {
        case 'include-deps-for-issue': {
            if (!depList) return `Listo: las dependencias quedaron habilitadas en esta ola. ${subject} ya puede avanzar.`;
            const verb = list.length === 1 ? 'quedó habilitado' : 'quedaron habilitados';
            return `Listo: ${depList} ${verb} en esta ola. ${subject} ya puede avanzar.`;
        }
        case 'keep-original':
            return depList
                ? `${subject} va a seguir avanzando sin esperar a ${depList}. El riesgo queda asumido.`
                : `${subject} va a seguir avanzando sin esperar a sus dependencias. El riesgo queda asumido.`;
        case 'mute-alert': {
            // La segunda oración es obligatoria: distingue silencio informado
            // de punto ciego. Silenciar NO destraba (CA-7 / REQ-SEC-4).
            const who = ref || 'ese issue';
            const still = ref || 'el issue';
            return `No te aviso más por ${who} durante las próximas ${window}. No cambió nada: ${still} sigue frenado.`;
        }
        default:
            return 'Decisión aplicada.';
    }
}

// -----------------------------------------------------------------------------
// 5 · Errores visibles en Telegram
//
// Estos textos ya existían y también tenían jerga ("no está en partial_pause",
// "la pausa parcial ya no está activa"). No estaban listados en los CA
// originales, pero son la misma superficie y el mismo operador.
// -----------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {'not-blocked'|'stale'|'forbidden'|'unknown'} args.kind
 * @param {number|string} [args.issue]
 * @returns {string}
 */
function buildErrorMessage({ kind, issue } = {}) {
    const ref = issueRef(issue);
    switch (kind) {
        case 'not-blocked':
            return ref
                ? `${ref} ya no está esperando dependencias; no hay nada que decidir.`
                : 'Ese issue ya no está esperando dependencias; no hay nada que decidir.';
        case 'stale':
            return 'Esa decisión perdió sentido: la selección de la ola cambió.';
        case 'forbidden':
            return 'No pude aplicar el cambio: la autorización fue rechazada.';
        default:
            return 'No pude aplicar el cambio.';
    }
}

module.exports = {
    ACTIONS,
    DEFAULT_MUTE_TTL_MS,
    FORBIDDEN_TERMS,
    findForbiddenTerms,
    formatWindow,
    enumerateRefs,
    normalizeDeps,
    issueRef,
    toIssueNumber,
    buildAlertMessage,
    buildButtonLabels,
    buildConsequence,
    buildConfirmation,
    buildErrorMessage,
};
