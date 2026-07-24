// =============================================================================
// rewind-messages.js — Copy del Commander para eventos de rewind (#3416)
// =============================================================================
//
// Implementa las guidelines G-UX-1, G-UX-4, G-UX-5, G-UX-6, G-UX-7:
//   - Mensajes Telegram naturales, variados (≥3 variantes por evento),
//     contextuales al pedido, en español rioplatense informal.
//   - Errores accionables (tabla canónica G-UX-7) con sugerencia de cómo
//     arreglar.
//   - Sin pegar listas internas (deny-list, mapping completo) que actúen
//     como manual de bypass.
//
// El módulo NO envía nada por Telegram — devuelve strings que el caller
// (pulpo / commander) decide cómo entregar.
//
// =============================================================================
'use strict';

const phaseMapping = require('./pipeline-phase-mapping');

function pick(arr, rng) {
    const r = (rng || Math.random)();
    return arr[Math.floor(r * arr.length) % arr.length];
}

function ghIssueLink(issue) {
    return `https://github.com/intrale/platform/issues/${issue}`;
}

// -----------------------------------------------------------------------------
// G-UX-1 — éxito del rewind
// -----------------------------------------------------------------------------

function buildSuccessMessage({ issue, target, fromPipeline, fromFase, rng }) {
    const targetPath = `${target.pipeline}/${target.fase}/${target.skill}`;
    const fromPath = (fromPipeline && fromFase) ? `${fromPipeline}/${fromFase}` : 'la fase actual';
    const link = ghIssueLink(issue);
    const variants = [
        `Listo, rebobiné #${issue} a \`${targetPath}\`. El agente arranca de nuevo con tu feedback.\n${link}`,
        `Rewind hecho: #${issue} → \`${targetPath}\`. Ya está en cola del ${target.skill} con tu motivo adjunto.\n${link}`,
        `Volví #${issue} a \`${targetPath}\` (venía de ${fromPath}). Tu motivo quedó como input del próximo run.\n${link}`,
    ];
    return pick(variants, rng);
}

// -----------------------------------------------------------------------------
// G-UX-4 — motivo truncado a 2KB
// -----------------------------------------------------------------------------

function buildTruncateMessage({ issue, originalBytes, rng }) {
    const link = ghIssueLink(issue);
    const kb = (originalBytes / 1024).toFixed(1);
    const variants = [
        `Tu rechazo de #${issue} entró pero el motivo pesaba ${kb} KB (cap 2 KB). Trunqué a 2 KB y conservé los primeros bytes. Si querés dar más detalle al agente, dejá un comentario en el issue antes de que arranque.\n${link}`,
        `OK #${issue} con motivo de ${kb} KB — corté a 2 KB. Si querés mandarle más contexto al agente, escribilo como comentario del issue.\n${link}`,
        `Rebobiné #${issue} pero el motivo era largo (${kb} KB). Conservé los primeros 2 KB. Para extender, comentario en el issue antes de que arranque el agente.\n${link}`,
    ];
    return pick(variants, rng);
}

// -----------------------------------------------------------------------------
// G-UX-5 — bloqueado por deny-list de prompt injection
// -----------------------------------------------------------------------------

function buildInjectionBlockedMessage({ issue, matchedDescription, rng }) {
    const description = matchedDescription || 'un patrón de inyección';
    const variants = [
        `Rebobinado de #${issue} bloqueado. Detecté ${description} en tu motivo (mitigación prompt injection). Reformulá sin esa frase y volvé a intentar — o si querés escaparlo literal, ponelo entre comillas dobles.`,
        `No pude rebobinar #${issue}: el motivo tenía ${description}. Reescribilo descriptivo (sin imperativos para el agente) y mandalo de vuelta.`,
        `Bloqueé el rewind de #${issue} por ${description} en el motivo. Reformulá como descripción de qué falló, no como instrucción al agente.`,
    ];
    return pick(variants, rng);
}

// -----------------------------------------------------------------------------
// G-UX-6 — rate limit suave (≥10 rewinds/hora)
// -----------------------------------------------------------------------------

function buildRateLimitWarning({ issue, recentCount, target, rng }) {
    const link = ghIssueLink(issue);
    const tip = (target && target.skill)
        ? `Si querés bajar a otra fase upstream, probá \`/rechazar ${issue} criterios-${target.skill}\` para forzar el de definición.`
        : `Probá un alias explícito (ej. \`criterios-ux\` o \`validacion-po\`) para bajar a otra fase upstream.`;
    const variants = [
        `Detecté ${recentCount} rebobinados de #${issue} en la última hora. ¿Posible que el agente no esté entendiendo el feedback? Mirá los últimos comentarios del issue para ver si hay un patrón. ${tip}\n${link}`,
        `#${issue} lleva ${recentCount} rewinds en la última hora. Si el agente sigue sin entender, capaz conviene cambiar el ángulo del motivo o ir a otra fase. ${tip}\n${link}`,
        `Heads up: ${recentCount} rebobinados de #${issue} en la última hora. No te bloqueo, pero capaz vale revisar si el agente está bien instruido. ${tip}\n${link}`,
    ];
    return pick(variants, rng);
}

// -----------------------------------------------------------------------------
// G-UX-7 — errores de validación accionables
// -----------------------------------------------------------------------------

const ERROR_BUILDERS = Object.freeze({
    ALIAS_NOT_IN_WHITELIST: ({ alias, normalizedAlias }) => {
        const aliasesShown = phaseMapping.listAliases().join(', ');
        const used = normalizedAlias || alias || '(vacío)';
        return `El alias \`${used}\` no está en mi tabla. Aliases válidos: ${aliasesShown}. ¿Qué fase querías rebobinar?`;
    },
    ALIAS_EMPTY: () => {
        const aliasesShown = phaseMapping.listAliases().join(', ');
        return `Falta el alias de la fase. Aliases válidos: ${aliasesShown}.`;
    },
    AMBIGUOUS_ALIAS_NEEDS_POSITION: ({ alias }) => (
        `El alias \`${alias}\` es ambiguo y no pude resolver la fase actual del issue. Probá con un alias explícito (ej. \`validacion-${alias}\` o \`criterios-${alias}\`).`
    ),
    SKILL_NOT_FOUND_UPSTREAM: ({ alias, fromPipeline, fromFase }) => (
        `El skill del alias \`${alias}\` no participa en ninguna fase upstream del issue (posición actual: ${fromPipeline}/${fromFase}). Revisá si el alias corresponde al pipeline del issue.`
    ),
    FUTURE_PHASE: ({ issue, target, fromPipeline, fromFase }) => (
        `No puedo rebobinar #${issue} a \`${target.pipeline}/${target.fase}\` porque esa fase todavía no se ejecutó (issue actualmente en \`${fromPipeline}/${fromFase}\`). Solo se puede ir hacia atrás.`
    ),
    NO_RETURN_STATE: ({ issue }) => (
        `#${issue} ya está en un punto de no retorno. Para revertir desde acá necesitás abrir un issue nuevo o usar el flow de hotfix manual.`
    ),
    ISSUE_NOT_IN_PIPELINE: ({ issue }) => (
        `#${issue} no está en el pipeline (puede estar cerrado o nunca haber entrado). El rebobinado no aplica.`
    ),
    ISSUE_REQUIRED: () => (
        `Falta el número de issue. Uso: \`/rechazar <issue> <alias>\`.`
    ),
    ISSUE_INVALID: ({ issue }) => (
        `El número de issue \`${issue}\` no parece válido. ¿Querías rebobinar otro?`
    ),
    SOURCE_NOT_AUTHORIZED: ({ source }) => (
        `Source \`${source || '(vacío)'}\` no autorizado. Solo se aceptan eventos de \`telegram-commander\` o \`cli-local\`. Si esto te parece raro, avisá por el canal.`
    ),
    OPERATOR_ID_REQUIRED: () => (
        `Tu identidad de operador no está adjunta al evento. Si esto te parece raro, avisá por el canal.`
    ),
    AGENT_KILL_FAILED: ({ issue, target, killGraceMs }) => (
        `El agente \`${target ? target.skill : '?'}\` de #${issue} no respondió al kill en ${Math.round((killGraceMs || 30000)/1000)}s. Aborté el rewind para no corromper estado. Probá de nuevo en un minuto, o cerralo manualmente desde \`/agents\`.`
    ),
    MOVE_FAILED: ({ issue, error }) => (
        `No pude mover los archivos para rebobinar #${issue}: ${error || 'error desconocido'}. Probá de nuevo o avisá si persiste.`
    ),
    AUDIT_FAILED: ({ issue }) => (
        `Audit log del rewind de #${issue} falló — aborté para no perder trazabilidad. Avisá en el canal así reviso.`
    ),
});

/**
 * Construye el mensaje de error para el operador a partir del `code` que
 * devolvió `rewindIssueToPhase`. Cubre G-UX-7 (tabla canónica de errores).
 *
 * Si el código no tiene builder, devuelve un mensaje genérico con el code
 * en literal para que sea grep-able en logs.
 */
function buildErrorMessage(code, ctx) {
    const builder = ERROR_BUILDERS[code];
    if (builder) return builder(ctx || {});
    return `No pude rebobinar (\`${code || 'UNKNOWN'}\`): ${(ctx && ctx.message) || 'error inesperado'}.`;
}

module.exports = {
    buildSuccessMessage,
    buildTruncateMessage,
    buildInjectionBlockedMessage,
    buildRateLimitWarning,
    buildErrorMessage,
    ERROR_BUILDERS,
};
