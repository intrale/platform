'use strict';

// =============================================================================
// worktree-prefix.js — Fuente de verdad única de la DERIVACIÓN del prefijo de
// worktree y de la validación de paths/refs asociada (issue #4694, Workstream B
// del split de #4685 · Ola Puente — self-hosting del kernel).
//
// **Por qué existe** (CA-B2 / CA-SEC-5):
//   Antes, el string crudo `platform.agent-` estaba re-duplicado en el launcher,
//   el resolver y los 6 consumidores de cleanup. Cada uno derivaba el prefijo por
//   su cuenta. Un consumidor desincronizado que opere destructivamente
//   (`git worktree remove --force` / `fs.rmSync`) sobre un prefijo mal derivado
//   borra el worktree equivocado. Este módulo centraliza la derivación para que
//   TODOS obtengan exactamente la misma cadena, y aloja la validación de path
//   (anti path-traversal) para que los consumidores destructivos la hereden.
//
// **Contrato de manifiesto** (CA-B1):
//   El prefijo y la base ref derivan del manifiesto (`pipeline.config.json`):
//     - `projectId`              -> prefijo de worktree (via deriveRepoBase).
//     - `repos.default_base_ref` -> ref base de creacion (via repo-target.js).
//   NO se hardcodean los literales `platform.` / `origin/main`.
//
// **Paridad hacia atras** (CA-B4):
//   Con `projectId === 'intrale-platform'` (default actual) la derivacion produce
//   EXACTAMENTE `platform.agent-<issue>-<skill>` -- identico al literal historico
//   -- para no romper la resolucion de worktrees vivos (regresion #3733).
//
// Helper PURO y testeable con `node --test`: todas las funciones aceptan un
// `configOverride` opcional para inyectar fixtures sin tocar disco.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

// -----------------------------------------------------------------------------
// SEC-1 -- allowlist estricta para la base derivada del prefijo. Sin `/`, sin
// separadores de path, sin nul-byte: rechaza traversal ANTES de componer el path.
const ALLOWED_PREFIX = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// SEC-2 -- formato de ref git valido. Rechaza espacios, `;`, `$()`, backtick, etc.
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

// Validaciones espejo de worktree-launcher.validateInputs (defense-in-depth).
const ISSUE_RE = /^\d+$/;
const SKILL_RE = /^[a-z][a-z0-9-]{0,40}$/;

const DEFAULT_PROJECT_ID = 'intrale-platform';

// pipeline.config.json vive en la raiz del repo (../../ desde .pipeline/lib/).
const CONFIG_PATH = path.join(__dirname, '..', '..', 'pipeline.config.json');

// Lee `projectId` del manifiesto. Fail-closed al default historico si falta o
// esta corrupto (nunca crash-open, nunca allow-all).
function loadProjectId(configOverride) {
  if (configOverride && typeof configOverride === 'object') {
    return (typeof configOverride.projectId === 'string' && configOverride.projectId)
      ? configOverride.projectId
      : DEFAULT_PROJECT_ID;
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return (typeof cfg.projectId === 'string' && cfg.projectId)
      ? cfg.projectId
      : DEFAULT_PROJECT_ID;
  } catch {
    return DEFAULT_PROJECT_ID;
  }
}

// CA-B4 -- `intrale-platform` => base `platform` (paridad historica). Cualquier
// otro projectId se usa tal cual, pero SIEMPRE pasa el allowlist SEC-1 antes de
// componerse en un path.
function deriveRepoBase(projectId, configOverride) {
  const pid = (projectId == null || projectId === '')
    ? loadProjectId(configOverride)
    : String(projectId);
  const base = pid === DEFAULT_PROJECT_ID ? 'platform' : pid;
  if (!ALLOWED_PREFIX.test(base)) {
    throw new Error(
      `worktree-prefix: base de repo invalida "${base}" (projectId="${pid}") -- ` +
      `no cumple ${ALLOWED_PREFIX} (posible path-traversal)`,
    );
  }
  return base;
}

// Prefijo del worktree del agente: `platform.agent-` para intrale-platform.
function deriveWorktreePrefix(projectId, configOverride) {
  return `${deriveRepoBase(projectId, configOverride)}.agent-`;
}

// Prefijo de confinamiento sibling: `platform.` (worktrees `<repo>.<sufijo>`).
// Usado por los guards anti-suicidio de cleanup (ghostbusters).
function deriveSiblingPrefix(projectId, configOverride) {
  return `${deriveRepoBase(projectId, configOverride)}.`;
}

// Needle de busqueda del worktree de un issue: `platform.agent-<issue>-`.
function worktreeNeedle(issue, projectId, configOverride) {
  if (!ISSUE_RE.test(String(issue))) {
    throw new Error(`worktree-prefix: issue no numerico "${issue}"`);
  }
  return `${deriveWorktreePrefix(projectId, configOverride)}${issue}-`;
}

// Basename completo del worktree: `platform.agent-<issue>-<skill>`.
function worktreeBasename(issue, skill, projectId, configOverride) {
  if (!ISSUE_RE.test(String(issue))) {
    throw new Error(`worktree-prefix: issue no numerico "${issue}"`);
  }
  if (!SKILL_RE.test(String(skill))) {
    throw new Error(`worktree-prefix: skill invalido "${skill}"`);
  }
  return `${deriveWorktreePrefix(projectId, configOverride)}${issue}-${skill}`;
}

// Reescribe una rama `agent/<issue>-<skill>` a su basename de worktree
// `platform.agent-<issue>-<skill>` (reemplaza worktree-resolver.js:434).
function branchToWorktreeBase(branchName, projectId, configOverride) {
  return String(branchName).replace(/^agent\//, deriveWorktreePrefix(projectId, configOverride));
}

// Regex que extrae el issue de un path de worktree del agente:
// `platform.agent-(\d+)-` (reemplaza el literal de ghostbusters.js:396).
function agentWorktreeRegex(projectId, configOverride) {
  const base = deriveRepoBase(projectId, configOverride);
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}\\.agent-(\\d+)-`);
}

// -----------------------------------------------------------------------------
// SEC-2 -- Valida la base ref ANTES de pasarla a `git`. Rechaza:
//   - no-string / vacio
//   - leading `-` (argument-injection tipo `--upload-pack=`)
//   - metacaracteres de shell (`;`, `$(...)`, backtick, espacios) via GIT_REF
// Aun con execFileSync(shell:false), un ref con leading `-` seria interpretado
// como flag por git -> rechazo explicito.
// -----------------------------------------------------------------------------
function validateBaseRef(ref) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.startsWith('-') || !GIT_REF.test(ref)) {
    throw new Error(
      `worktree-prefix: base ref invalido (posible argument/command-injection): ${JSON.stringify(ref)}`,
    );
  }
  return ref;
}

// -----------------------------------------------------------------------------
// SEC-1/SEC-5 -- Contencion canonica del path del worktree dentro del parent
// esperado. Rechaza `..`, separadores embebidos, paths absolutos embebidos y
// symlinks/junctions que escapen del parent (realpath del parent + del target).
//
// Devuelve el path resuelto (canonico) si es seguro; lanza si no.
// -----------------------------------------------------------------------------
function assertContained(worktreePath, expectedParent, fsImpl = fs) {
  const base = path.basename(String(worktreePath));
  // El basename derivado nunca contiene separadores, whitespace ni nul-byte; si
  // los contiene, es traversal / input malformado.
  const SEP = String.fromCharCode(47);   // '/'
  const BACKSLASH = String.fromCharCode(92); // backslash
  const NUL = String.fromCharCode(0);
  const badChar =
    base.indexOf(SEP) !== -1 ||
    base.indexOf(BACKSLASH) !== -1 ||
    base.indexOf(NUL) !== -1 ||
    /\s/.test(base);
  if (!base || base === '.' || base === '..' || badChar) {
    throw new Error(`worktree-prefix: basename invalido "${base}" en "${worktreePath}" (path-traversal)`);
  }

  let parentReal;
  try {
    parentReal = path.resolve(fsImpl.realpathSync(expectedParent));
  } catch (e) {
    throw new Error(`worktree-prefix: parent no resoluble "${expectedParent}": ${e.message}`);
  }

  const resolved = path.resolve(parentReal, base);
  if (path.dirname(resolved) !== parentReal) {
    throw new Error(`worktree-prefix: path-traversal "${worktreePath}" escapa de "${parentReal}"`);
  }

  // Si el target ya existe y es symlink/junction que apunta afuera del parent,
  // rechazarlo (un cleanup destructivo lo seguiria hacia el destino equivocado).
  try {
    const targetReal = path.resolve(fsImpl.realpathSync(resolved));
    if (path.dirname(targetReal) !== parentReal) {
      throw new Error(`worktree-prefix: symlink "${worktreePath}" escapa a "${targetReal}"`);
    }
  } catch (e) {
    // ENOENT = todavia no existe (se creara) -> OK. Cualquier otro error se propaga.
    if (e && e.code !== 'ENOENT') throw e;
  }

  return resolved;
}

module.exports = {
  deriveRepoBase,
  deriveWorktreePrefix,
  deriveSiblingPrefix,
  worktreeNeedle,
  worktreeBasename,
  branchToWorktreeBase,
  agentWorktreeRegex,
  validateBaseRef,
  assertContained,
  // Exportados para tests de frontera:
  _internals: { ALLOWED_PREFIX, GIT_REF, DEFAULT_PROJECT_ID, loadProjectId, CONFIG_PATH },
};
