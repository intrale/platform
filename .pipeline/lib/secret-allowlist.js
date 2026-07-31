'use strict';

const fs = require('fs');
const SENTINEL = '\0';
const OVERBROAD = new Set(['*', '**', '**/*', '*/**', '**/**', '/**']);
const CONTROL_PATHS = [
  '.pipeline/lib/precommit-secret-scan.js',
  '.pipeline/lib/secret-allowlist.js',
  '.pipeline/lib/secret-scan-lint.js',
  '.pipeline/secret-scan-allowlist.json',
  '.pipeline/sanitizer.js',
  '.claude/hooks/telegram-sanitizer.js',
  '.github/workflows/security-sast.yml',
  '.husky/pre-commit',
];

// #5244 rev-3 — los paths de control no admiten NINGÚN mecanismo de escape:
// ni allowlist (ya bloqueado en `loadAllowlist`) ni la marca por línea
// `secret-scan:ignore`. Es el mismo criterio: el gate no puede apagarse a sí
// mismo, y sobre estos archivos no hay review humana garantizada.
function isControlPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return CONTROL_PATHS.includes(normalized);
}

function globToRe(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  const source = escaped.replace(/\*\*/g, SENTINEL)
    .replace(/\*/g, '[^/]*').split(SENTINEL).join('.*');
  return new RegExp(`^${source}$`);
}

function loadAllowlist(file, opts = {}) {
  if (!file) return { paths: new Set(), globs: [], entries: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = (parsed.globs || []).map((glob) => {
    if (opts.strict && OVERBROAD.has(glob)) {
      throw new Error(`allowlist: glob sobre-amplio "${glob}"; usá uno específico`);
    }
    const re = globToRe(glob);
    if (opts.strict && CONTROL_PATHS.some((control) => re.test(control))) {
      throw new Error(`allowlist: glob "${glob}" alcanza un path de control`);
    }
    return { src: glob, re };
  });
  const paths = new Set(parsed.paths || []);
  if (opts.strict) {
    for (const control of CONTROL_PATHS) {
      if (paths.has(control)) throw new Error(`allowlist: path de control "${control}" no permitido`);
    }
  }
  return { paths, globs: entries.map(({ re }) => re), entries };
}

function whichAllowlistEntry(filePath, allowlist) {
  if (allowlist.paths.has(filePath)) return `path:${filePath}`;
  const hit = (allowlist.entries || []).find(({ re }) => re.test(filePath));
  if (hit) return `glob:${hit.src}`;
  if ((allowlist.globs || []).some((re) => re.test(filePath))) return 'glob:legacy';
  return null;
}

function isAllowlisted(filePath, allowlist) {
  return whichAllowlistEntry(filePath, allowlist) !== null;
}

module.exports = {
  CONTROL_PATHS, globToRe, isAllowlisted, isControlPath, loadAllowlist, whichAllowlistEntry,
};
