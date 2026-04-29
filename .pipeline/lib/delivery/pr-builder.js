// pr-builder.js — Construye el body del PR desde el payload del issue.
//
// Lee el comentario marcado en el issue (delivery-payload) y extrae la sección
// pr-body. Si no existe, cae a un template determinístico.
//
// Output: { body, source }
// source: 'issue-payload' | 'fallback'

function parseDeliveryPayload(issueBodyOrComment) {
  if (!issueBodyOrComment) return null;
  const match = issueBodyOrComment.match(
    /<!--\s*delivery-payload\s*-->[\s\S]*?##\s*pr-body\s*\n([\s\S]*?)\n##\s/
  );
  if (!match) return null;
  return match[1].trim();
}

// Template fallback cuando no hay payload de issue.
// Usa los cambios (diff stat) y la descripción para construir un body estructurado.
function buildFallbackBody({
  description = null,
  filesChanged = 0,
  insertions = 0,
  deletions = 0,
  issueNumber = null,
} = {}) {
  let body = '## Resumen\n\n';

  if (description) {
    body += `${description}\n\n`;
  } else {
    body += 'Actualización del sistema de entrega.\n\n';
  }

  if (filesChanged > 0) {
    body += '## Cambios\n\n';
    body += `- ${filesChanged} archivo(s) modificado(s)\n`;
    body += `- ${insertions} línea(s) agregada(s) (+)\n`;
    body += `- ${deletions} línea(s) removida(s) (-)\n\n`;
  }

  // Footer estándar
  body += '---\n\n';
  body += '🤖 Generado con [Claude Code](https://claude.ai/claude-code)\n';

  // Agregar Closes si hay issue
  if (issueNumber) {
    body += `\nCloses #${issueNumber}\n`;
  }

  return body;
}

// API principal. Lee el issue, extrae el payload o cae a fallback.
//
// Retorna { body, source }
function build({
  issueBody = null,
  issueComments = [],
  description = null,
  diffStat = { files: 0, insertions: 0, deletions: 0 },
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
        body: payload,
        source: 'issue-payload',
      };
    }
  }

  // Fallback: buscar en el body del issue
  if (issueBody) {
    const payload = parseDeliveryPayload(issueBody);
    if (payload) {
      return {
        body: payload,
        source: 'issue-payload',
      };
    }
  }

  // Template fallback
  return {
    body: buildFallbackBody({
      description,
      filesChanged: diffStat.files,
      insertions: diffStat.insertions,
      deletions: diffStat.deletions,
      issueNumber,
    }),
    source: 'fallback',
  };
}

module.exports = {
  build,
  parseDeliveryPayload,
  buildFallbackBody,
  // exports para tests
  _internals: { parseDeliveryPayload, buildFallbackBody },
};
