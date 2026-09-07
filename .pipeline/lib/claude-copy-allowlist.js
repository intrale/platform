// =============================================================================
// claude-copy-allowlist.js — Allowlist deny-by-default para copiar `.claude/`
// hacia un worktree nuevo (issue #5220, CA-2.c).
//
// ⚠️ DEFENSA EN PROFUNDIDAD, NO evidencia de CA-2.
// Está verificado que el `cpSync` de `scripts/cli-branch.js` NO se ejecuta:
// `.claude/` es un árbol trackeado (266 archivos), así que tras el
// `git worktree add` el destino YA existe y el guard `if (!fs.existsSync(dst))`
// nunca deja pasar (G1). El productor real de las copias con credenciales es
// `C:\Workspaces\bin\claude-session:62` — vive fuera de este repo y sin
// versionar, por eso #5220 cierra por la vía CA-2.d (detección garantizada) y
// la prevención en el origen queda en #5264 / #5226.
//
// Criterio: se enumera qué SE COPIA (allowlist), no qué se excluye, y se filtra
// DURANTE la copia en vez de post-borrar: así el secreto no llega a tocar el
// disco del destino ni por un instante.
//
// Fuente única de verdad de estas listas. `scripts/dev-functions.sh` espeja el
// mismo criterio en bash (ver comentario allá).
// =============================================================================

'use strict';

const path = require('path');

// Qué se copia. Todo lo demás queda afuera por default.
const ALLOWLIST = Object.freeze([
  'settings.json',
  'permissions-baseline.json',
  'dashboard-server.js',
  'skills',
  'icons',
  'hooks',
]);

// Excepciones dentro de lo permitido. El deny gana siempre sobre el allow.
const DENY = Object.freeze([
  // Corte de recursión: sin esto, copiar `.claude` mete copias de copias.
  'worktrees', 'sessions', 'sessions-archive', 'tmp',
  // Secretos: el archivo que originó #5220.
  'hooks/telegram-config.json',
  // Overrides locales de la máquina de origen.
  'settings.local.json',
]);

// Estado de runtime que no tiene sentido replicar (logs, locks, heartbeats).
const DENY_RE = Object.freeze([
  // El archivo de secretos que originó #5220, por FORMA y no por ruta exacta.
  // El deny de `DENY` es un path literal (`hooks/telegram-config.json`), pero
  // `hooks/` está allowlisteado en bloque: sin esta regex, un
  // `hooks/telegram-config.json.bak` o un `hooks/tests/telegram-config.json`
  // se copiaban al destino. Hoy no existe ninguno de esos archivos, pero la
  // allowlist tiene que resistir que aparezcan.
  /(^|\/)telegram-config[^/]*$/,
  /\.jsonl$/,
  /\.pid$/,
  /\.heartbeat(\.stale)?$/,
  /\.lock$/,
]);

/**
 * ¿Se copia este path relativo (posix, respecto de la raíz de `.claude/`)?
 * @param {string} rel
 * @returns {boolean}
 */
function isAllowed(rel) {
  const clean = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
  if (clean === '' || clean === '.') return true;                 // la raíz misma
  if (DENY.some((d) => clean === d || clean.startsWith(d + '/'))) return false;
  if (DENY_RE.some((re) => re.test(clean))) return false;
  return ALLOWLIST.includes(clean.split('/')[0]);                 // deny-by-default
}

/**
 * Filtro listo para `fs.cpSync(src, dst, { recursive: true, filter })`.
 * @param {string} srcRoot raíz del `.claude/` de origen
 * @returns {(src: string) => boolean}
 */
function claudeCopyFilter(srcRoot) {
  return (src) => isAllowed(path.relative(srcRoot, src));
}

module.exports = { isAllowed, claudeCopyFilter, ALLOWLIST, DENY, DENY_RE };
