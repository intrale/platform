// git-context.js — Lectura pura del estado git para el delivery
//
// Reemplaza el Paso 2 del SKILL.md (que pedía al LLM correr 4 comandos y
// parsear los outputs). Acá lo hacemos con spawnSync determinístico.
//
// Toda la API devuelve estructuras planas, sin side effects. Si querés
// que falle algo, lo decide el caller.

const { spawnSync } = require('child_process');

function git(args, cwd, opts = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
    windowsHide: true,
    ...opts,
  });
  // OJO: solo strippeamos whitespace TRAILING, NO leading. `git status
  // --porcelain` usa espacios significativos al inicio de cada línea.
  const trimRight = (s) => (s || '').replace(/\s+$/, '');
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: trimRight(result.stdout),
    stderr: trimRight(result.stderr),
  };
}

// Branch actual del worktree.
function currentBranch(cwd) {
  const r = git(['branch', '--show-current'], cwd);
  return r.ok ? r.stdout : null;
}

// Lista de commits que separan HEAD de la base. Devuelve array de
// { sha, subject } en orden cronológico inverso (HEAD primero).
function commitsAhead(cwd, base = 'origin/main') {
  const r = git(['log', `${base}..HEAD`, '--oneline'], cwd);
  if (!r.ok) return [];
  return r.stdout.split('\n').filter(Boolean).map((line) => {
    const idx = line.indexOf(' ');
    if (idx < 0) return { sha: line, subject: '' };
    return { sha: line.slice(0, idx), subject: line.slice(idx + 1) };
  });
}

// Cantidad de commits adelante del base.
function aheadCount(cwd, base = 'origin/main') {
  const r = git(['rev-list', '--count', `${base}..HEAD`], cwd);
  return r.ok ? Number(r.stdout) || 0 : 0;
}

// Cantidad de commits que el base está adelante (necesitamos rebase si > 0).
function behindCount(cwd, base = 'origin/main') {
  const r = git(['rev-list', '--count', `HEAD..${base}`], cwd);
  return r.ok ? Number(r.stdout) || 0 : 0;
}

// `git status --porcelain` parseado. Devuelve array de { code, path }.
// code es el código de status de 2 caracteres (ej: " M", "??", "A ").
function statusPorcelain(cwd) {
  const r = git(['status', '--porcelain'], cwd);
  if (!r.ok) return [];
  return r.stdout.split('\n').filter(Boolean).map((line) => ({
    code: line.slice(0, 2),
    path: line.slice(3),
  }));
}

// Lista de archivos cambiados entre base y HEAD (commits ya hechos).
function filesChanged(cwd, base = 'origin/main') {
  const r = git(['diff', '--name-only', `${base}...HEAD`], cwd);
  return r.ok ? r.stdout.split('\n').filter(Boolean) : [];
}

// Stat de cambios entre base y HEAD: { files, insertions, deletions }.
function diffStat(cwd, base = 'origin/main') {
  const r = git(['diff', '--shortstat', `${base}...HEAD`], cwd);
  if (!r.ok || !r.stdout) return { files: 0, insertions: 0, deletions: 0 };
  const m = r.stdout.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  if (!m) return { files: 0, insertions: 0, deletions: 0 };
  return {
    files: Number(m[1]) || 0,
    insertions: Number(m[2]) || 0,
    deletions: Number(m[3]) || 0,
  };
}

// Diff completo (texto) entre base y HEAD. Útil para input al LLM cuando
// hace falta redactar commit/PR body. La truncación es a nivel de string
// ya capturado, no a nivel de spawn (sino el proceso falla cuando el diff
// excede el buffer en lugar de truncar).
function diffText(cwd, base = 'origin/main', maxBytes = 200000) {
  // maxBuffer generoso para que el spawn nunca aborte por tamaño.
  const r = git(['diff', `${base}...HEAD`], cwd, { maxBuffer: 64 * 1024 * 1024 });
  if (!r.ok) return '';
  return r.stdout.length > maxBytes ? r.stdout.slice(0, maxBytes) + '\n...[truncated]' : r.stdout;
}

// Fetch de origen/base. Retorna ok/error.
function fetchOrigin(cwd, branch = 'main') {
  const r = git(['fetch', 'origin', branch], cwd);
  return { ok: r.ok, error: r.ok ? null : r.stderr };
}

// Snapshot agregado de contexto que necesita el delivery para decidir cosas.
function snapshot(cwd, base = 'origin/main') {
  return {
    cwd,
    base,
    branch: currentBranch(cwd),
    ahead: aheadCount(cwd, base),
    behind: behindCount(cwd, base),
    commits: commitsAhead(cwd, base),
    status: statusPorcelain(cwd),
    files: filesChanged(cwd, base),
    stat: diffStat(cwd, base),
  };
}

module.exports = {
  git,
  currentBranch,
  commitsAhead,
  aheadCount,
  behindCount,
  statusPorcelain,
  filesChanged,
  diffStat,
  diffText,
  fetchOrigin,
  snapshot,
};
