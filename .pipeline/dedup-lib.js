// dedup-lib.js — Heurística de deduplicación de issues por título.
//
// Fuente única de verdad para matching de títulos similares de issues
// qa:dependency. Usada por:
//   - pulpo.js (intake de issues nuevos → cerrar duplicados)
//   - rejection-report.js (vincular rechazo a dep issue existente)
//
// Si ambos lados no comparten la misma lógica, un issue que se consideró
// único en intake puede ser incorrectamente marcado como duplicado en
// rejection-report (o viceversa).

function normalizeTitleForDedup(title) {
  return (title || '').toLowerCase()
    .replace(/^(?:fix|feat|infra|bug|dep):\s*/i, '')
    .replace(/\b(el|la|los|las|un|una|de|del|en|que|con|por|al|se|no|es|a)\b/g, '')
    .replace(/[—\-:()#\d]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function extractSignificantWords(title) {
  return normalizeTitleForDedup(title).split(' ').filter(w => w.length > 3);
}

// Retorna true si los dos títulos son duplicados bajo la heurística canónica.
// Criterios (cualquiera dispara match):
//   - Substring match exacto tras normalización (ej: "X: foo" vs "foo")
//   - Overlap de palabras significativas ≥ 60% Y mínimo 2 palabras compartidas
function isDuplicateTitle(titleA, titleB) {
  const normA = normalizeTitleForDedup(titleA);
  const normB = normalizeTitleForDedup(titleB);
  if (!normA || !normB) return false;

  if (normA.includes(normB) || normB.includes(normA)) return true;

  const wordsA = extractSignificantWords(titleA);
  const wordsB = extractSignificantWords(titleB);
  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const shared = wordsA.filter(w => wordsB.some(wb => wb.includes(w) || w.includes(wb)));
  const overlapRatio = shared.length / Math.max(Math.min(wordsA.length, wordsB.length), 1);
  return shared.length >= 2 && overlapRatio >= 0.6;
}

// Busca en `openIssues` (array de {number, title, ...}) el primer match
// de `candidateTitle`. Retorna el issue completo o null.
function findDuplicate(candidateTitle, openIssues) {
  if (!candidateTitle || !Array.isArray(openIssues) || openIssues.length === 0) return null;
  for (const it of openIssues) {
    if (isDuplicateTitle(candidateTitle, it.title)) return it;
  }
  return null;
}

module.exports = {
  normalizeTitleForDedup,
  extractSignificantWords,
  isDuplicateTitle,
  findDuplicate,
};
