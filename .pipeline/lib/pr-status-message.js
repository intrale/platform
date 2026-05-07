// =============================================================================
// pr-status-message.js — Construcción del mensaje Telegram de fin de pipeline.
//
// Issue #3030 — el pulpo mandaba SIEMPRE "completó el pipeline. Listo para
// merge." al cerrar la última fase del pipeline de desarrollo. Engañoso porque
// muchos issues ya están mergeados, otros tienen checks pendientes, otros
// fueron cerrados sin merge.
//
// Este módulo es PURO: recibe `prInfo` ya parseado (o null/error) y devuelve
// `{ text, replyMarkup }` listos para `sendTelegramWithMarkup`. Sin invocar
// `gh`, sin tocar filesystem — testeable sin stubs externos.
//
// Decisiones:
//   - Sin parse_mode: cumplir CA-13 (security) sin escape de MarkdownV2.
//     Telegram autodetecta URLs aunque el mensaje vaya en texto plano.
//   - Botón inline "Ver PR" cuando hay url disponible (CA-UX-3, CA-13).
//   - Iconografía consistente con el pulpo (CA-UX-1):
//       ✅ terminal exitoso, 🟡 esperando externo, ⚠️ atención, ℹ️ info, ❓ no verificable.
//   - Líneas cortas (≤ 80 chars) para preview mobile (CA-UX-4).
// =============================================================================
'use strict';

/**
 * Construye el mensaje de cierre de pipeline para enviar por Telegram.
 *
 * @param {number|string} issue Número del issue (solo se usa para el texto).
 * @param {object|null} prInfo Estado del PR ya parseado, o null si no hay PR
 *   detectable, o `{ error: true }` para indicar fallo de gh / JSON malformado.
 *   Estructura esperada cuando hay datos:
 *     {
 *       state: 'MERGED' | 'OPEN' | 'CLOSED',
 *       mergedAt: string|null,
 *       mergeCommit: { oid: string }|null,
 *       url: string,
 *       statusCheckRollup: Array<{ status?, state?, conclusion? }>,
 *       reviewDecision: 'APPROVED'|'CHANGES_REQUESTED'|'REVIEW_REQUIRED'|null,
 *     }
 * @returns {{ text: string, replyMarkup: object|null }}
 */
function buildCompletionMessage(issue, prInfo) {
  const issueTag = `#${issue}`;

  // CA-7 — fallback explícito por error/timeout/JSON malformado.
  if (prInfo && prInfo.error) {
    return {
      text: `❓ ${issueTag} completó el pipeline de desarrollo. (estado del PR no verificable)`,
      replyMarkup: null,
    };
  }

  // CA-6 — sin PR detectado (gh devolvió lista vacía).
  if (!prInfo) {
    return {
      text: `ℹ️ ${issueTag} completó el pipeline — no detecté PR asociado.`,
      replyMarkup: null,
    };
  }

  const replyMarkup = prInfo.url
    ? { inline_keyboard: [[{ text: 'Ver PR', url: prInfo.url }]] }
    : null;

  const state = prInfo.state;

  // CA-1 — PR mergeado.
  if (state === 'MERGED') {
    const sha = prInfo.mergeCommit && prInfo.mergeCommit.oid
      ? String(prInfo.mergeCommit.oid).slice(0, 7)
      : null;
    let text = `✅ ${issueTag} mergeado a main — pipeline cerrado.`;
    if (sha) text += `\nmerge: ${sha}`;
    return { text, replyMarkup };
  }

  // CA-5 — PR cerrado sin mergear.
  if (state === 'CLOSED') {
    return {
      text: `⚠️ ${issueTag} completó el pipeline pero el PR fue cerrado sin mergear.`,
      replyMarkup,
    };
  }

  // PR abierto: distinguir entre listo / pendiente / falla.
  if (state === 'OPEN') {
    const checks = Array.isArray(prInfo.statusCheckRollup) ? prInfo.statusCheckRollup : [];
    const rollup = classifyRollup(checks);

    if (rollup === 'FAILURE') {
      // CA-4 — checks rojos.
      return {
        text: `⚠️ ${issueTag} terminó pero hay checks en rojo — requiere atención.`,
        replyMarkup,
      };
    }
    if (rollup === 'PENDING') {
      // CA-3 — checks pendientes.
      return {
        text: `🟡 ${issueTag} terminó el pipeline — esperando checks de CI/QA externos.`,
        replyMarkup,
      };
    }
    // rollup === 'SUCCESS' o sin checks declarados → listo para merge.
    // CA-2.
    return {
      text: `✅ ${issueTag} listo para mergear — todos los gates verdes.`,
      replyMarkup,
    };
  }

  // Estado no contemplado (defensivo): tratar como no verificable.
  return {
    text: `❓ ${issueTag} completó el pipeline de desarrollo. (estado del PR no verificable)`,
    replyMarkup: null,
  };
}

/**
 * Clasifica el rollup de checks en 'SUCCESS' | 'PENDING' | 'FAILURE'.
 *
 * `gh pr list --json statusCheckRollup` devuelve un array heterogéneo:
 *   - CheckRun: tiene `status` ("QUEUED"|"IN_PROGRESS"|"COMPLETED") y
 *     `conclusion` ("SUCCESS"|"FAILURE"|...).
 *   - StatusContext (commit status legacy): tiene `state` ("SUCCESS"|"PENDING"|
 *     "FAILURE"|"ERROR").
 *
 * Reglas:
 *   - Cualquier FAILURE/ERROR/CANCELLED/TIMED_OUT/ACTION_REQUIRED → FAILURE.
 *   - Si no hay falla, cualquier check no terminado → PENDING.
 *   - En otro caso (todo SUCCESS o array vacío) → SUCCESS.
 */
function classifyRollup(checks) {
  let hasFailure = false;
  let hasPending = false;

  for (const c of checks) {
    if (!c || typeof c !== 'object') continue;
    const status = c.status || null;
    const state = c.state || null;
    const conclusion = c.conclusion || null;

    const isFailure =
      conclusion === 'FAILURE' ||
      conclusion === 'CANCELLED' ||
      conclusion === 'TIMED_OUT' ||
      conclusion === 'ACTION_REQUIRED' ||
      conclusion === 'STARTUP_FAILURE' ||
      state === 'FAILURE' ||
      state === 'ERROR';
    if (isFailure) {
      hasFailure = true;
      continue;
    }

    const isPending =
      status === 'QUEUED' ||
      status === 'IN_PROGRESS' ||
      status === 'PENDING' ||
      status === 'WAITING' ||
      state === 'PENDING';
    if (isPending) {
      hasPending = true;
      continue;
    }

    // CheckRun terminado: status COMPLETED + conclusion vacía o success/skipped/neutral
    // → contado como success (no fuerza pending).
  }

  if (hasFailure) return 'FAILURE';
  if (hasPending) return 'PENDING';
  return 'SUCCESS';
}

/**
 * Resumen breve de prInfo para loggear sin filtrar tokens/headers/body completo.
 * Cumple CA-10 (logging trazable) y CA-security (sin info sensible).
 *
 * @param {object|null} prInfo
 * @returns {{ prState: string, rollupState: string, prUrl: string|null }}
 */
function summarizePrInfoForLog(prInfo) {
  if (!prInfo) return { prState: 'NO_PR', rollupState: 'N_A', prUrl: null };
  if (prInfo.error) return { prState: 'UNKNOWN', rollupState: 'N_A', prUrl: null };

  const state = prInfo.state || 'UNKNOWN';
  let rollup = 'N_A';
  if (state === 'OPEN') {
    const checks = Array.isArray(prInfo.statusCheckRollup) ? prInfo.statusCheckRollup : [];
    rollup = classifyRollup(checks);
  }
  return {
    prState: state,
    rollupState: rollup,
    prUrl: prInfo.url || null,
  };
}

module.exports = {
  buildCompletionMessage,
  summarizePrInfoForLog,
  // Exportado para tests directos del clasificador.
  __classifyRollup: classifyRollup,
};
