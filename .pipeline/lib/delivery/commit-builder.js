// commit-builder.js — Construye el mensaje de commit desde el payload del issue.
//
// Lee el comentario marcado en el issue (delivery-payload) y extrae la sección
// commit-message. Si no existe, cae a un template determinístico.
//
// Output: { message, source }
// source: 'issue-payload' | 'fallback'

function parseDeliveryPayload(issueBodyOrComment) {
  if (!issueBodyOrComment) return null;
  const match = issueBodyOrComment.match(
    /<!--\s*delivery-payload\s*-->[\s\S]*?##\s*commit-message\s*\n([\s\S]*?)\n##\s/
  );
  if (!match) return null;
  return match[1].trim();
}

// Template fallback cuando no hay payload de issue.
// Usa el tipo inferido y la descripción para construir un commit convencional.
function buildFallbackMessage(type, description) {
  if (!type || !description) {
    return 'chore: actualizar estado del delivery';
  }
  // Garantizar que el type es válido y esté en minúsculas
  const validTypes = ['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'perf', 'style', 'build', 'ci'];
  const normalizedType = validTypes.includes(type.toLowerCase()) ? type.toLowerCase() : 'chore';

  // Primer párrafo como subject.
  // El total "type: subject" debe ser <= 72 caracteres.
  const lines = description.split('\n');
  const prefix = `${normalizedType}: `;
  const maxSubjectLen = Math.max(20, 72 - prefix.length); // mínimo 20 chars para el subject
  const subject = lines[0].slice(0, maxSubjectLen);
  const body = lines.slice(1).filter(l => l.trim()).join('\n');

  let message = `${prefix}${subject}`;
  if (body) {
    message += `\n\n${body}`;
  }
  return message;
}

// Garantiza que el mensaje de commit referencie "Closes #N" (#4080).
//
// El linter determinístico (static-checks.checkClosesIssue) evalúa SOLO los
// mensajes de commit — no el body del PR — por lo que la referencia tiene que
// vivir en el commit para que GitHub cierre el issue al mergear y el warning
// `pr:missing-closes` deje de dispararse en el flujo normal.
//
// Es idempotente: si el mensaje ya referencia el issue con
// closes/fixes/resolves #N (mismo patrón que usa el linter), no agrega nada.
// El número se deriva del contexto de la fase (rama `agent/<issue>-<slug>`),
// así que la inyección es determinística y confiable sin depender del LLM.
function ensureClosesReference(message, issueNumber) {
  if (!issueNumber) return message;
  const issue = String(issueNumber).trim().replace(/^#/, '');
  if (!/^\d+$/.test(issue)) return message;

  // Mismo patrón que static-checks.checkClosesIssue: evita doble inyección.
  const rx = new RegExp(`\\b(?:closes|fixes|resolves)\\s+#${issue}\\b`, 'i');
  if (rx.test(message)) return message;

  const base = (message || '').replace(/\s+$/, '');
  if (!base) return `Closes #${issue}`;
  return `${base}\n\nCloses #${issue}`;
}

// API principal. Lee el issue, extrae el payload o cae a fallback.
//
// `issue` puede ser:
// - null/undefined: usa fallback
// - { body, comments: [{ body, ... }, ...] }: búsqueda en comments
//
// `issueNumber`: cuando está presente, garantiza que el mensaje final
// referencie "Closes #N" (idempotente). Aplica tanto al payload como al
// fallback, para que el PR cierre el issue al mergear (#4080).
//
// Retorna { message, source }
function build({
  issueBody = null,
  issueComments = [],
  type = null,
  description = null,
  issueNumber = null,
} = {}) {
  // Buscar payload en comments (orden reverso: el último gana)
  for (let i = issueComments.length - 1; i >= 0; i--) {
    const commentText = typeof issueComments[i] === 'string'
      ? issueComments[i]
      : issueComments[i]?.body;
    const payload = parseDeliveryPayload(commentText);
    if (payload) {
      return {
        message: ensureClosesReference(payload, issueNumber),
        source: 'issue-payload',
      };
    }
  }

  // Fallback: buscar en el body del issue
  if (issueBody) {
    const payload = parseDeliveryPayload(issueBody);
    if (payload) {
      return {
        message: ensureClosesReference(payload, issueNumber),
        source: 'issue-payload',
      };
    }
  }

  // Template fallback
  return {
    message: ensureClosesReference(buildFallbackMessage(type, description), issueNumber),
    source: 'fallback',
  };
}

module.exports = {
  build,
  parseDeliveryPayload,
  buildFallbackMessage,
  ensureClosesReference,
  // exports para tests
  _internals: { parseDeliveryPayload, buildFallbackMessage, ensureClosesReference },
};
