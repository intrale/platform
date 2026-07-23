// =============================================================================
// ux-android-actual-lookup.js — Lookup del "Estado actual" para issues Android
// Issue #3408 · CA-3 + CA-S1 + CA-S6 + CA-UX-10
//
// Qué hace:
//   Recibe `(pantalla, flavor)` y devuelve el path absoluto de la imagen más
//   reciente que represente el "Estado actual" de esa pantalla en el flavor
//   pedido. Prioriza, en este orden:
//
//     1. docs/app-screenshots-reference/<pantalla>/<archivo>.png — librería
//        curada por UX (creada por #3407).
//     2. qa/evidence/<issue-anterior>/ux-mockup-actual-*.png — mockups
//        previos del mismo flujo.
//     3. qa/evidence/<issue-anterior>/screenshot-*.png — screenshots de QA
//        real ya ejecutado.
//
//   Si no encuentra nada → devuelve `null` (no lanza).
//
// Seguridad (CA-S1 — path traversal):
//   - `pantalla` debe matchear `^[a-z0-9-]{1,40}$`. Si no, se devuelve `null`.
//   - `flavor` debe ser uno de `client|business|delivery|null`. Otros valores
//     se ignoran y se devuelve `null`.
//   - Todo path candidato pasa por `path.resolve` + prefix-check estricto
//     contra los dos roots permitidos (`docs/app-screenshots-reference/` y
//     `qa/evidence/`).
//   - Symlinks que escapen del root permitido se descartan vía `realpathSync`.
//
// Aliases (CA-S6 — alias map cerrado):
//   - El mapa de aliases es una constante JS en este archivo. NO se lee de
//     archivos externos en runtime. Para agregar un alias hay que commitear
//     este archivo, revisar y mergear.
//   - Aliases canónicos (pares iniciales obligatorios — CA-3):
//        signin ↔ login, signup ↔ register, home ↔ dashboard,
//        cart ↔ carrito, checkout ↔ pago, orders ↔ pedidos,
//        profile ↔ perfil, settings ↔ configuracion.
//
// Tests: lib/__tests__/ux-android-actual-lookup.test.js
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

const PANTALLA_RE = /^[a-z0-9-]{1,40}$/;
const FLAVORS_VALIDOS = new Set(['client', 'business', 'delivery']);

const ROOT_DOCS = path.join('docs', 'app-screenshots-reference');
const ROOT_QA_EVIDENCE = path.join('qa', 'evidence');

// Patterns canónicos a buscar dentro de un directorio de issue de qa/evidence/
// (en orden de preferencia).
const QA_EVIDENCE_PATTERNS = [
  /^ux-mockup-actual-.*\.png$/i,
  /^ux-mockup-esperado-.*\.png$/i, // si solo hubo esperado generado, sirve como ancla
  /^screenshot-.*\.png$/i,
];

// CA-S6 — mapa de aliases cerrado. Bidireccional. Si querés agregar uno
// nuevo: commit + review + merge.
const ALIAS_MAP = Object.freeze({
  signin: 'login',
  login: 'signin',
  signup: 'register',
  register: 'signup',
  home: 'dashboard',
  dashboard: 'home',
  cart: 'carrito',
  carrito: 'cart',
  checkout: 'pago',
  pago: 'checkout',
  orders: 'pedidos',
  pedidos: 'orders',
  profile: 'perfil',
  perfil: 'profile',
  settings: 'configuracion',
  configuracion: 'settings',
});

// -----------------------------------------------------------------------------
// Helpers internos
// -----------------------------------------------------------------------------

/**
 * Verifica que `candidate` (absoluto, resuelto) esté contenido dentro de
 * `root` (absoluto, resuelto). Bloquea `..`, paths absolutos arbitrarios y
 * symlinks que salgan del root.
 *
 * @param {string} candidateAbs
 * @param {string} rootAbs
 * @returns {boolean}
 */
function isInsideRoot(candidateAbs, rootAbs) {
  if (typeof candidateAbs !== 'string' || typeof rootAbs !== 'string') return false;
  const cand = path.resolve(candidateAbs);
  const root = path.resolve(rootAbs);
  // Agregamos separator para que /docs/app-screenshots-reference-fake no
  // matchee a /docs/app-screenshots-reference.
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (cand === root) return true;
  return cand.startsWith(rootWithSep);
}

/**
 * Devuelve el archivo más reciente del directorio que matchee `extRe`
 * (default: cualquier .png), ordenado por mtime descendente. Si el directorio
 * no existe → null.
 *
 * @param {string} dirAbs
 * @param {RegExp} [extRe=/\.png$/i]
 * @returns {string|null} path absoluto del archivo o null
 */
function latestFileInDir(dirAbs, extRe = /\.png$/i) {
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries
    .filter((e) => e.isFile() && extRe.test(e.name))
    .map((e) => {
      const full = path.join(dirAbs, e.name);
      try {
        const st = fs.statSync(full);
        return { full, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.length > 0 ? files[0].full : null;
}

/**
 * Resuelve el path real (siguiendo symlinks). Si el target no existe o
 * la resolución falla → devuelve null.
 *
 * @param {string} p
 * @returns {string|null}
 */
function realpathSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Lookup en docs/app-screenshots-reference/<pantalla>/. Si el flavor está
 * presente y existe un archivo cuyo nombre incluye `-<flavor>-`, se prefiere.
 *
 * @param {string} repoRoot
 * @param {string} pantallaSafe
 * @param {string|null} flavorSafe
 * @returns {{path:string, source:'docs'}|null}
 */
function lookupInDocs(repoRoot, pantallaSafe, flavorSafe) {
  const rootDocsAbs = path.resolve(repoRoot, ROOT_DOCS);
  const dirAbs = path.resolve(rootDocsAbs, pantallaSafe);
  if (!isInsideRoot(dirAbs, rootDocsAbs)) return null;

  // 1) Si hay flavor, intentar primero archivos que lo mencionen.
  if (flavorSafe) {
    const flavorRe = new RegExp(`-${flavorSafe}-.*\\.png$`, 'i');
    const flavored = latestFileInDir(dirAbs, flavorRe);
    if (flavored) {
      const real = realpathSafe(flavored);
      if (real && isInsideRoot(real, rootDocsAbs)) {
        return { path: real, source: 'docs' };
      }
    }
  }
  // 2) Fallback: cualquier .png del directorio.
  const any = latestFileInDir(dirAbs, /\.png$/i);
  if (any) {
    const real = realpathSafe(any);
    if (real && isInsideRoot(real, rootDocsAbs)) {
      return { path: real, source: 'docs' };
    }
  }
  return null;
}

/**
 * Lookup en qa/evidence/<issue>/. Recorre los subdirs (issues anteriores)
 * ordenados por mtime descendente, y dentro de cada uno aplica
 * `QA_EVIDENCE_PATTERNS` en orden.
 *
 * Se busca un match cuyo filename incluya la pantalla (case insensitive).
 *
 * @param {string} repoRoot
 * @param {string} pantallaSafe
 * @returns {{path:string, source:'qa-evidence'}|null}
 */
function lookupInQaEvidence(repoRoot, pantallaSafe) {
  const rootQaAbs = path.resolve(repoRoot, ROOT_QA_EVIDENCE);
  let issueDirs;
  try {
    issueDirs = fs.readdirSync(rootQaAbs, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = issueDirs
    .filter((e) => e.isDirectory())
    .map((e) => {
      const full = path.join(rootQaAbs, e.name);
      try {
        return { full, mtimeMs: fs.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const pantallaLower = pantallaSafe.toLowerCase();
  for (const dir of candidates) {
    if (!isInsideRoot(dir.full, rootQaAbs)) continue;
    for (const pat of QA_EVIDENCE_PATTERNS) {
      const matchRe = new RegExp(pat.source.replace(/^\^/, '^').replace(/\$$/, ''), pat.flags);
      // Filtrar archivos del directorio cuyo nombre matchea el pattern Y
      // contiene la pantalla.
      let entries;
      try {
        entries = fs.readdirSync(dir.full, { withFileTypes: true });
      } catch {
        continue;
      }
      const matched = entries
        .filter((e) => e.isFile()
          && matchRe.test(e.name)
          && e.name.toLowerCase().includes(pantallaLower))
        .map((e) => {
          const full = path.join(dir.full, e.name);
          try {
            return { full, mtimeMs: fs.statSync(full).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (matched.length > 0) {
        const real = realpathSafe(matched[0].full);
        if (real && isInsideRoot(real, rootQaAbs)) {
          return { path: real, source: 'qa-evidence' };
        }
      }
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// API principal
// -----------------------------------------------------------------------------

/**
 * Busca la referencia visual de "Estado actual" para una pantalla Android.
 *
 * @param {string} pantalla — nombre canónico de la pantalla, ej. `login`.
 * @param {string|null} [flavor] — `client|business|delivery` o null.
 * @param {Object} [opts]
 * @param {string} [opts.repoRoot] — root del repo (default: process.cwd())
 * @returns {{path:string, source:'docs'|'qa-evidence', alias?:{from:string,to:string}} | null}
 *   - `path`: absoluto, dentro de uno de los roots permitidos.
 *   - `source`: de dónde salió.
 *   - `alias` (opcional): si se resolvió vía alias map, info del par.
 *   Devuelve `null` si no se encuentra nada (NO lanza error).
 */
function lookup(pantalla, flavor, opts) {
  // CA-S1 — validación estricta. Cualquier desvío → null silencioso.
  if (typeof pantalla !== 'string' || !PANTALLA_RE.test(pantalla)) {
    return null;
  }
  let flavorSafe = null;
  if (flavor !== undefined && flavor !== null && flavor !== '') {
    if (typeof flavor !== 'string' || !FLAVORS_VALIDOS.has(flavor)) {
      // Flavor inválido → ignorar (no romper) y seguir como si no se hubiera
      // pasado. Esto permite que el caller no tenga que validar a priori.
      flavorSafe = null;
    } else {
      flavorSafe = flavor;
    }
  }
  const repoRoot = (opts && typeof opts.repoRoot === 'string') ? opts.repoRoot : process.cwd();

  // 1) Match exacto en docs/app-screenshots-reference/<pantalla>/.
  const docsHit = lookupInDocs(repoRoot, pantalla, flavorSafe);
  if (docsHit) return docsHit;

  // 2) Match en docs/ vía alias (CA-3 + CA-S6).
  const aliased = ALIAS_MAP[pantalla];
  if (aliased) {
    const aliasHit = lookupInDocs(repoRoot, aliased, flavorSafe);
    if (aliasHit) {
      return { ...aliasHit, alias: { from: pantalla, to: aliased } };
    }
  }

  // 3) Fallback: qa/evidence/<issue-anterior>/.
  const qaHit = lookupInQaEvidence(repoRoot, pantalla);
  if (qaHit) return qaHit;

  // 4) Fallback con alias contra qa/evidence/.
  if (aliased) {
    const qaAliasHit = lookupInQaEvidence(repoRoot, aliased);
    if (qaAliasHit) {
      return { ...qaAliasHit, alias: { from: pantalla, to: aliased } };
    }
  }

  // Sin evidencia previa.
  return null;
}

/**
 * Helper textual para el campo `actual_source` del bloque ux-meta (CA-6).
 *
 * @param {ReturnType<typeof lookup>} hit
 * @returns {string}
 */
function describeSource(hit) {
  if (!hit) return 'none';
  if (hit.alias) {
    return `${hit.source} (alias ${hit.alias.from}->${hit.alias.to})`;
  }
  return hit.source;
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
  // API principal
  lookup,
  describeSource,
  // Constantes exportadas para tests
  PANTALLA_RE,
  FLAVORS_VALIDOS,
  ALIAS_MAP,
  ROOT_DOCS,
  ROOT_QA_EVIDENCE,
  QA_EVIDENCE_PATTERNS,
  // Helpers internos exportados para tests
  isInsideRoot,
  latestFileInDir,
};
