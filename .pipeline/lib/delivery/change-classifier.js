// change-classifier.js — Clasifica un cambio en su tipo Conventional Commit.
//
// Reemplaza el Paso 3 del SKILL.md ("Basándote en el diff, clasificá:")
// con reglas determinísticas sobre paths, contenido del diff y subjects
// de los commits ya hechos en el branch.
//
// Output: 'feat' | 'fix' | 'refactor' | 'test' | 'docs' | 'chore' | null
//
// Política: si las señales son ambiguas, devolver null y que el caller
// decida (ej: leer el delivery-payload del issue, o caer a 'chore').

// Reglas en orden de prioridad. Primera que matchea, gana.
const RULES = [
  // Si TODO lo cambiado son tests → 'test'
  {
    type: 'test',
    when: ({ files }) => files.length > 0 && files.every(isTestFile),
  },
  // Si TODO lo cambiado es docs → 'docs'
  {
    type: 'docs',
    when: ({ files }) => files.length > 0 && files.every(isDocFile),
  },
  // Subject del primer commit lo dice explícitamente
  {
    type: ({ commits }) => firstSubjectType(commits),
    when: ({ commits }) => firstSubjectType(commits) != null,
  },
  // Cambios solo en config/build/CI/infra → 'chore'
  {
    type: 'chore',
    when: ({ files }) => files.length > 0 && files.every(isChoreFile),
  },
  // Cambios que tocan código de producción + tests → probablemente 'feat' o 'fix'.
  // Si hay archivos NUEVOS de producción → 'feat'. Si solo modifican → 'fix'.
  // (Heurística simple; el caller puede pisarlo con `--type` o el payload del issue.)
  {
    type: ({ status }) => statusBasedType(status),
    when: ({ status }) => statusBasedType(status) != null,
  },
];

const TEST_PATTERNS = [
  /(^|\/)__tests__\//,
  /(^|\/)test\//,
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /Test\.kts?$/,
  /Tests\.kts?$/,
];

const DOC_PATTERNS = [
  /^docs\//,
  /\.md$/i,
  /^README/i,
  /^CHANGELOG/i,
];

const CHORE_PATTERNS = [
  /^\.github\//,
  /^\.gitignore$/,
  /^\.gitattributes$/,
  /^\.editorconfig$/,
  /^\.pipeline\/(config\.yaml|.+\.json)$/,
  /^\.claude\//,
  /^buildSrc\//,
  /(^|\/)build\.gradle(\.kts)?$/,
  /(^|\/)settings\.gradle(\.kts)?$/,
  /^gradle\//,
  /(^|\/)package(-lock)?\.json$/,
  /^renovate\.json$/,
];

function isTestFile(filePath) {
  return TEST_PATTERNS.some((p) => p.test(filePath));
}

function isDocFile(filePath) {
  // .claude/ es config del harness, no docs (aunque tenga .md)
  if (filePath.startsWith('.claude/')) return false;
  return DOC_PATTERNS.some((p) => p.test(filePath));
}

function isChoreFile(filePath) {
  // Tests ganan sobre chore (un .test.js en .github/ sigue siendo test)
  if (isTestFile(filePath)) return false;
  // Docs ganan también, pero `isDocFile` ya excluye .claude/, así que un
  // SKILL.md bajo .claude/ entra como chore correctamente.
  if (isDocFile(filePath)) return false;
  return CHORE_PATTERNS.some((p) => p.test(filePath));
}

// Si el subject del primer commit del branch tiene prefijo conventional,
// se respeta como source of truth. Es lo que el dev intencionalmente puso.
function firstSubjectType(commits) {
  if (!commits || commits.length === 0) return null;
  // El primer commit cronológicamente del branch (último del array, que viene
  // ordenado por log con HEAD primero).
  const first = commits[commits.length - 1];
  return parseConventionalType(first.subject);
}

// Parsea "fix(scope): texto" o "feat: texto" → "fix" / "feat" / null.
function parseConventionalType(subject) {
  if (!subject) return null;
  const m = subject.match(/^(feat|fix|refactor|test|docs|chore|perf|style|build|ci)(\([^)]+\))?!?:/i);
  return m ? m[1].toLowerCase() : null;
}

// Heurística sobre `git status --porcelain`: si hay archivos NUEVOS (A o ??)
// que no son chore/doc/test, asumimos 'feat'. Si solo hay modificados, 'fix'.
function statusBasedType(status) {
  if (!status || status.length === 0) return null;
  const productionEntries = status.filter((s) => {
    const p = s.path;
    return !isTestFile(p) && !isDocFile(p) && !isChoreFile(p);
  });
  if (productionEntries.length === 0) return null;
  const hasNew = productionEntries.some((s) => /^(A |\?\?)/.test(s.code) || s.code.trim() === 'A');
  return hasNew ? 'feat' : 'fix';
}

// API principal. Recibe el snapshot de git-context y devuelve el tipo.
//
// Acepta también un override (por ejemplo, viniendo del CLI con --type, o
// del delivery-payload de un issue).
function classify({ files = [], commits = [], status = [], override = null } = {}) {
  if (override && parseConventionalType(`${override}: x`)) return override.toLowerCase();
  for (const rule of RULES) {
    if (rule.when({ files, commits, status })) {
      return typeof rule.type === 'function' ? rule.type({ files, commits, status }) : rule.type;
    }
  }
  return null;
}

module.exports = {
  classify,
  parseConventionalType,
  isTestFile,
  isDocFile,
  isChoreFile,
  // exports para tests
  _internals: { firstSubjectType, statusBasedType, RULES },
};
