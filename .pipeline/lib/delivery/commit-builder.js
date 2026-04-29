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

// API principal. Lee el issue, extrae el payload o cae a fallback.
//
// `issue` puede ser:
// - null/undefined: usa fallback
// - { body, comments: [{ body, ... }, ...] }: búsqueda en comments
//
// Retorna { message, source }
function build({
  issueBody = null,
  issueComments = [],
  type = null,
  description = null,
} = {}) {
  // Buscar payload en comments (orden reverso: el último gana)
  for (let i = issueComments.length - 1; i >= 0; i--) {
    const commentText = typeof issueComments[i] === 'string'
      ? issueComments[i]
      : issueComments[i]?.body;
    const payload = parseDeliveryPayload(commentText);
    if (payload) {
      return {
        message: payload,
        source: 'issue-payload',
      };
    }
  }

  // Fallback: buscar en el body del issue
  if (issueBody) {
    const payload = parseDeliveryPayload(issueBody);
    if (payload) {
      return {
        message: payload,
        source: 'issue-payload',
      };
    }
  }

  // Template fallback
  return {
    message: buildFallbackMessage(type, description),
    source: 'fallback',
  };
}

module.exports = {
  build,
  parseDeliveryPayload,
  buildFallbackMessage,
  // exports para tests
  _internals: { parseDeliveryPayload, buildFallbackMessage },
};
