'use strict';

const fs = require('fs');
const SENTINEL = '\0';
const OVERBROAD = new Set(['*', '**', '**/*', '*/**', '**/**', '/**']);
const CONTROL_PATHS = [
  // #5244 rev-4 — `.gitattributes` puede apagar el gate desde adentro: con
  // `* -diff` git reporta todo como binario y el scanner descartaba el diff.
  // El agujero se cierra por contenido en el scanner; acá se le saca además
  // todo mecanismo de escape, igual que a cualquier otro archivo de control.
  '.gitattributes',
  '.pipeline/lib/precommit-secret-scan.js',
  '.pipeline/lib/secret-allowlist.js',
  '.pipeline/lib/secret-scan-lint.js',
  // Desde la integracion con #6111 el scanner deriva de aca su inventario de
  // paths sensibles: vaciarlo apaga la capa 1 igual que neutralizar el scanner.
  '.pipeline/lib/sensitive-paths.js',
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
  // Un `.gitattributes` de subdirectorio tiene el mismo poder que el de la raíz
  // sobre los paths que cuelgan de él: también es archivo de control.
  if (normalized.endsWith('/.gitattributes')) return true;
  return CONTROL_PATHS.includes(normalized);
}

// #5244 rev-9 — el strict de `loadAllowlist` comparaba sólo contra la lista
// literal `CONTROL_PATHS`, mientras `isControlPath` trata como control a
// CUALQUIER `*/.gitattributes`. Con las dos definiciones desalineadas,
// `paths: ["app/.gitattributes"]` pasaba la validación aunque el scanner
// después lo considerara archivo de control. Hoy no era explotable (el scanner
// consulta `isControlPath`, que es la definición más amplia, así que el path
// igual quedaba fuera de la allowlist en runtime), pero dos definiciones de
// "path de control" que no coinciden es una divergencia esperando a que alguien
// se apoye en la equivocada. Ahora la única definición es `isControlPath`, y
// los globs se prueban además contra sondas de `.gitattributes` anidados.
const CONTROL_PROBES = [...CONTROL_PATHS, 'sub/.gitattributes', 'a/b/c/.gitattributes'];

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
    if (opts.strict && CONTROL_PROBES.some((control) => re.test(control))) {
      throw new Error(`allowlist: glob "${glob}" alcanza un path de control`);
    }
    return { src: glob, re };
  });
  const paths = new Set(parsed.paths || []);
  if (opts.strict) {
    for (const candidate of paths) {
      if (isControlPath(candidate)) throw new Error(`allowlist: path de control "${candidate}" no permitido`);
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
  CONTROL_PATHS, CONTROL_PROBES, globToRe, isAllowlisted, isControlPath, loadAllowlist, whichAllowlistEntry,
};
