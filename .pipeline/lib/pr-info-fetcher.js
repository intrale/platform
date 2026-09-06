// =============================================================================
// pr-info-fetcher.js — Helper para consultar el estado del PR vinculado a un
// issue invocando `gh pr list`. Extraído de pulpo.js (#3030) para tener
// pruebas determinísticas con un `runner` inyectable.
//
// Convenciones del proyecto:
//   - Las ramas de agentes son `agent/<issue>-<slug>`. Buscamos por
//     `head:agent/<issue>-` para evitar falsos positivos por número en título
//     (ej. "feat: limita 3030 productos" no debería matchear el issue 3030).
//   - El PR puede estar en cualquier estado (`open`/`merged`/`closed`).
//
// Seguridad (CA-11..CA-14):
//   - Validación de entrada: número entero positivo. Si no lo es → null sin
//     ejecutar `gh`.
//   - spawnSync con array de argumentos (no shell-string), elimina superficie
//     de inyección.
//   - Timeout 5s real (mata el proceso si cuelga). El default `timeout` de
//     spawnSync envía SIGTERM al hijo cuando expira → evita FDs colgados.
//   - JSON.parse en try/catch — JSON malformado o stdout vacío → fallback.
// =============================================================================
'use strict';

const { spawnSync, execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_LIMIT = 5;
const FIELDS = [
  'number',
  'state',
  'mergedAt',
  'mergeCommit',
  'url',
  'statusCheckRollup',
  'reviewDecision',
  'updatedAt',
  'headRefName',
  'title',
  'labels',
  'isCrossRepository',
  'headRepositoryOwner',
  // #5337 CA-3 — estado de merge, para distinguir conflicto real (DIRTY) de
  // review humana exigida por CODEOWNERS/ruleset (BLOCKED). Van en la MISMA
  // llamada que ya se hacía: cero requests extra a GitHub.
  // Ojo: `mergeable` lo calcula GitHub de forma asíncrona y devuelve UNKNOWN
  // mientras tanto — quien lo consuma debe tratar UNKNOWN como "no concluyente",
  // nunca como veredicto (ver human-block-triggers.js, R2).
  'mergeable',
  'mergeStateStatus',
].join(',');

/**
 * Consulta el estado del PR asociado al issue.
 *
 * @param {number|string} issue Número del issue.
 * @param {object} [options]
 * @param {string} [options.ghBin] Path al binario gh. Default: env GH_BIN o 'gh'.
 * @param {string} [options.cwd] Working directory. Default: process.cwd().
 * @param {number} [options.timeoutMs] Timeout en ms para `gh`. Default: 5000.
 * @param {Function} [options.runner] Inyectable para tests; firma idéntica a
 *   `child_process.spawnSync(cmd, args, opts)`. Devuelve `{ status, stdout, stderr, error? }`.
 * @returns {object|null} prInfo parseado, o `null` si no hay PR detectable, o
 *   `{ error: true }` si gh falló / timeout / JSON malformado.
 */
// Args de `gh pr list` compartidos por la versión sync y la async. Buscamos por
// head branch prefix (convención agent/<issue>-<slug>). El guion final evita
// matchear agent/30300-... cuando issue=3030.
function _buildArgs(n) {
  return [
    'pr',
    'list',
    '--search',
    `head:agent/${n}-`,
    '--state',
    'all',
    '--limit',
    String(DEFAULT_LIMIT),
    '--json',
    FIELDS,
  ];
}

// Normaliza un resultado tipo-spawnSync (`{ status, stdout, stderr, error? }`)
// al prInfo parseado. Compartido entre el path sync (spawnSync) y el async
// (execFile, que adapta su callback a esta misma forma). Mantiene los mismos
// códigos de `reason` (CA-14) para no cambiar el contrato observable.
function _parseResult(result, n) {
  if (!result) return { error: true, reason: 'no_result' };
  if (result.error) return { error: true, reason: 'spawn_error', message: result.error.message };
  if (result.status !== 0) {
    return { error: true, reason: 'non_zero_exit', exit: result.status, stderr: (result.stderr || '').slice(0, 200) };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout || '[]');
  } catch (e) {
    return { error: true, reason: 'json_parse_failed', message: e.message };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  // Filtrar matches estrictos por convención de branch (defensa contra futuras
  // queries más laxas) y elegir el más reciente.
  const prefix = `agent/${n}-`;
  const strict = parsed.filter((p) => p && typeof p.headRefName === 'string' && p.headRefName.startsWith(prefix));
  const candidates = strict.length > 0 ? strict : parsed;
  candidates.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return candidates[0];
}

function fetchPrInfoForIssue(issue, options) {
  const opts = options || {};

  // CA-11 — validación de entrada antes de invocar gh.
  const n = Number(issue);
  if (!Number.isInteger(n) || n <= 0) return null;

  const ghBin = opts.ghBin || process.env.GH_BIN || 'gh';
  const cwd = opts.cwd || process.cwd();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const runner = typeof opts.runner === 'function' ? opts.runner : spawnSync;

  let result;
  try {
    result = runner(ghBin, _buildArgs(n), {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      cwd,
    });
  } catch (e) {
    return { error: true, reason: 'spawn_failed', message: e && e.message };
  }

  // CA-14 — timeout real. spawnSync setea result.error.code === 'ETIMEDOUT'
  // (o status null + signal 'SIGTERM') cuando excede el timeout.
  return _parseResult(result, n);
}

function resolvePrForGateWrite(issue, options) {
  const opts = options || {};
  const n = Number(issue);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, reason: 'no_strict_match' };
  const runner = typeof opts.runner === 'function' ? opts.runner : spawnSync;
  let result;
  try {
    result = runner(opts.ghBin || process.env.GH_BIN || 'gh', _buildArgs(n), {
      encoding: 'utf8',
      timeout: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS,
      windowsHide: true,
      cwd: opts.cwd || process.cwd(),
    });
  } catch (e) {
    return { ok: false, reason: 'fetch_failed', detail: e && e.message };
  }
  if (!result || result.error || result.status !== 0) {
    return { ok: false, reason: 'fetch_failed', detail: result && (result.stderr || (result.error && result.error.message)) };
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout || '[]'); }
  catch (e) { return { ok: false, reason: 'fetch_failed', detail: e.message }; }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'fetch_failed', detail: 'respuesta no-array' };
  const prefix = `agent/${n}-`;
  let candidates = parsed.filter((pr) => pr && typeof pr.headRefName === 'string' && pr.headRefName.startsWith(prefix));
  if (candidates.length === 0) return { ok: false, reason: 'no_strict_match' };
  if (candidates.length > 1) {
    const open = candidates.filter((pr) => pr.state === 'OPEN');
    if (open.length !== 1) {
      return { ok: false, reason: 'ambiguous_match', candidates: candidates.map((pr) => pr.number) };
    }
    candidates = open;
  }
  const pr = candidates[0];
  const expectedOwner = String(opts.repo || 'intrale/platform').split('/')[0].toLowerCase();
  const actualOwner = pr.headRepositoryOwner && String(pr.headRepositoryOwner.login || '').toLowerCase();
  if (pr.isCrossRepository === true || !actualOwner || actualOwner !== expectedOwner) {
    return { ok: false, reason: 'cross_repository', candidates: [pr.number] };
  }
  return { ok: true, pr: {
    number: pr.number,
    headRefName: pr.headRefName,
    state: pr.state,
    labels: Array.isArray(pr.labels) ? pr.labels.map((l) => (l && l.name) ? l.name : String(l)).filter(Boolean) : [],
  } };
}

// #4133 — versión ASÍNCRONA de fetchPrInfoForIssue. Idéntica lógica, pero usa
// `execFile` (no bloqueante) en vez de `spawnSync`. El consumidor en el
// dashboard (_schedulePrInfoRefresh) la llamaba envuelta en un Promise.then(),
// lo cual NO la hacía async: spawnSync clavaba el event loop hasta 5s por issue
// (15s/tick con batch 3) → /api/health dejaba de responder y el smoke del
// restart lo leía como caída → rollback falso en loop. Misma pata que #4128
// arregló para los títulos (execSync → _execGhAsync), que quedó sin migrar acá.
// Mantiene args como array (no shell-string) → sin superficie de inyección.
function fetchPrInfoForIssueAsync(issue, options) {
  const opts = options || {};

  // CA-11 — misma validación que la versión sync.
  const n = Number(issue);
  if (!Number.isInteger(n) || n <= 0) return Promise.resolve(null);

  const ghBin = opts.ghBin || process.env.GH_BIN || 'gh';
  const cwd = opts.cwd || process.cwd();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  // Runner async inyectable para tests: firma `(bin, args, opts) => Promise<{ status, stdout, stderr, error? }>`.
  const asyncRunner = typeof opts.asyncRunner === 'function' ? opts.asyncRunner : null;

  if (asyncRunner) {
    return Promise.resolve()
      .then(() => asyncRunner(ghBin, _buildArgs(n), { timeoutMs, cwd }))
      .then((result) => _parseResult(result, n))
      .catch((e) => ({ error: true, reason: 'spawn_failed', message: e && e.message }));
  }

  return new Promise((resolve) => {
    execFile(ghBin, _buildArgs(n), {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      cwd,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      // Adaptamos el callback de execFile a la forma tipo-spawnSync que espera
      // _parseResult. ETIMEDOUT/killed (timeout) y exit != 0 entran como `error`.
      if (err) {
        if (err.killed || err.code === 'ETIMEDOUT') {
          resolve(_parseResult({ status: null, error: err, stderr }, n));
        } else if (typeof err.code === 'number') {
          resolve(_parseResult({ status: err.code, stdout, stderr }, n));
        } else {
          resolve({ error: true, reason: 'spawn_failed', message: err.message });
        }
        return;
      }
      resolve(_parseResult({ status: 0, stdout, stderr }, n));
    });
  });
}

// =============================================================================
// #4966 — Extensión ADITIVA para el watcher de mergeabilidad de PRs.
//
// Todo lo de abajo es API nueva. NO se modifica `FIELDS`, `_buildArgs`,
// `_parseResult`, `fetchPrInfoForIssue` ni `fetchPrInfoForIssueAsync`: tienen
// consumidores en `dashboard.js`, `pulpo.js` y `pipeline-states.js`, y sus 21
// tests corren sin editarse (CA-8).
//
// Por qué parsers nuevos y no reusar `_parseResult`: su
// `candidates.sort(...); return candidates[0]` COLAPSA la ambigüedad eligiendo
// el más reciente. Para el watcher la ambigüedad es justamente lo que hay que
// detectar y tratar como no-op (CA-3), no algo que resolver por heurística.
// =============================================================================

// `owner/name` de GitHub: mismo charset que `rewind-merge-dedupe.REPO_RE`, para
// que un repo que pasa acá pase también la validación del consumidor (#4967).
const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
// `headRefOid`: SHA-1 (40 hex) hoy, SHA-256 (64) el día que GitHub migre.
const OID_RE = /^[0-9a-f]{7,64}$/;

const CANDIDATE_LIMIT_MIN = 1;
const CANDIDATE_LIMIT_MAX = 100;
const DEFAULT_CANDIDATE_LIMIT = 20;

// Campos de mergeabilidad. `mergeable` y `mergeStateStatus` ya viven en FIELDS
// desde #5337, pero `headRefOid` y `baseRefName` no: el contrato viejo no los
// pide y agregarlos ahí cambiaría el payload de todos sus consumidores. Lista
// propia, verificada válida tanto en `gh pr list` como en `gh pr view`.
const MERGEABILITY_FIELDS = [
  'number',
  'state',
  'mergeable',
  'mergeStateStatus',
  'headRefOid',
  'headRefName',
  'baseRefName',
  'headRepositoryOwner',
  'isCrossRepository',
  'updatedAt',
  'url',
].join(',');

// El stderr de `gh` es texto de origen remoto: lo redactamos antes de guardarlo
// en un error tipado que después va a un JSONL de auditoría (CA-5).
const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g, // tokens clásicos de GitHub
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:Bearer|token)\s+[A-Za-z0-9._-]{8,}/gi,
  /\bAuthorization\s*:\s*\S+/gi,
  /\b(?:GH_TOKEN|GITHUB_TOKEN|GH_BIN)\s*=\s*\S+/g,
];

/**
 * Recorta y redacta un texto de origen externo antes de exponerlo como
 * `message`/`stderr` de un error tipado.
 */
function _redact(text, max) {
  let s = typeof text === 'string' ? text : '';
  for (const re of SECRET_PATTERNS) s = s.replace(re, '[REDACTED]');
  return s.slice(0, Number.isFinite(max) ? max : 200);
}

/**
 * Clampea el `--limit` en CÓDIGO, no confiando en el YAML (CA-5/CA-7).
 * Cualquier valor no numérico cae al default.
 */
function _clampCandidateLimit(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_CANDIDATE_LIMIT;
  return Math.min(Math.max(n, CANDIDATE_LIMIT_MIN), CANDIDATE_LIMIT_MAX);
}

/** Valida `owner/name` contra charset ANTES de que llegue a un argv. */
function _isValidRepo(repo) {
  return typeof repo === 'string' && REPO_RE.test(repo);
}

/** Valida un identificador numérico de GitHub (PR o issue). */
function _isValidId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

// argv de `gh pr list` para el universo de candidatos del watcher. Distinto de
// `_buildArgs`: acá el estado es `open` (no `all`), no hay `--search` (barremos
// todo el universo abierto) y el limit es configurable con clamp.
function _buildOpenCandidatesArgs({ repo, limit }) {
  return [
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    String(_clampCandidateLimit(limit)),
    '--json',
    MERGEABILITY_FIELDS,
  ];
}

// argv de `gh pr view <N>`: la segunda pasada que resuelve el `mergeable`
// diferido de GitHub (`pr list` devuelve UNKNOWN y ceba el cálculo).
function _buildViewArgs({ repo, pr }) {
  return ['pr', 'view', String(Number(pr)), '--repo', repo, '--json', MERGEABILITY_FIELDS];
}

/**
 * Clasifica un resultado tipo-spawnSync en error tipado, o `null` si vino OK.
 * Reusa los códigos ya establecidos del módulo y suma `gh_timeout` y
 * `rate_limited`, que el contrato viejo no distinguía.
 */
function _classifyGhFailure(result) {
  if (!result) return { ok: false, reason: 'no_result' };
  if (result.error) {
    const err = result.error;
    if (err.code === 'ETIMEDOUT' || err.killed === true || result.signal === 'SIGTERM') {
      return { ok: false, reason: 'gh_timeout' };
    }
    return { ok: false, reason: 'spawn_error', message: _redact(err.message) };
  }
  if (result.status !== 0) {
    const stderr = _redact(result.stderr);
    if (/rate limit|secondary rate|abuse detection/i.test(stderr)) {
      return { ok: false, reason: 'rate_limited', stderr };
    }
    return { ok: false, reason: 'non_zero_exit', exit: result.status, stderr };
  }
  return null;
}

/**
 * Valida el shape de un PR devuelto por `gh`. Fail-closed: una respuesta
 * parcial (falta `headRefOid`) es `schema_invalid`, nunca un candidato con
 * campos en `undefined`.
 */
function _isValidPrShape(pr) {
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) return false;
  if (!Number.isInteger(pr.number) || pr.number <= 0) return false;
  if (typeof pr.state !== 'string' || pr.state.length === 0) return false;
  if (typeof pr.headRefOid !== 'string' || !OID_RE.test(pr.headRefOid)) return false;
  if (typeof pr.headRefName !== 'string' || pr.headRefName.length === 0) return false;
  if (typeof pr.baseRefName !== 'string' || pr.baseRefName.length === 0) return false;
  if (typeof pr.mergeable !== 'string') return false;
  if (typeof pr.mergeStateStatus !== 'string') return false;
  return true;
}

// Normaliza a un shape propio: sólo los campos que el watcher usa. Nada del
// objeto crudo de GitHub viaja aguas abajo.
function _normalizePr(pr) {
  return {
    number: pr.number,
    state: pr.state,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    headRefOid: pr.headRefOid,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    headRepositoryOwner:
      pr.headRepositoryOwner && typeof pr.headRepositoryOwner.login === 'string'
        ? { login: pr.headRepositoryOwner.login }
        : null,
    isCrossRepository: pr.isCrossRepository === true,
    updatedAt: typeof pr.updatedAt === 'string' ? pr.updatedAt : null,
    url: typeof pr.url === 'string' ? pr.url : null,
  };
}

/**
 * Parser de `gh pr list --json ...` para el watcher.
 *
 * Devuelve la LISTA COMPLETA. A diferencia de `_parseResult`, no ordena ni
 * elige: quién decide qué hacer con 0 o N candidatos es el watcher (CA-3).
 */
function _parseMergeabilityList(result) {
  const failure = _classifyGhFailure(result);
  if (failure) return failure;

  let parsed;
  try {
    parsed = JSON.parse(result.stdout || '[]');
  } catch (e) {
    return { ok: false, reason: 'json_parse_failed', message: _redact(e.message) };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'schema_invalid', message: 'respuesta no-array' };
  }
  // Un elemento con shape inválido NO invalida el barrido entero: se descarta
  // y se reporta aparte para que el watcher lo audite como no-op.
  const candidates = [];
  const invalid = [];
  for (const pr of parsed) {
    if (_isValidPrShape(pr)) candidates.push(_normalizePr(pr));
    else invalid.push(pr && Number.isInteger(pr.number) ? pr.number : null);
  }
  return { ok: true, candidates, invalid };
}

/** Parser de `gh pr view <N> --json ...`: objeto único, no lista. */
function _parseMergeabilityView(result) {
  const failure = _classifyGhFailure(result);
  if (failure) return failure;

  let parsed;
  try {
    parsed = JSON.parse(result.stdout || 'null');
  } catch (e) {
    return { ok: false, reason: 'json_parse_failed', message: _redact(e.message) };
  }
  if (!_isValidPrShape(parsed)) {
    return { ok: false, reason: 'schema_invalid', message: 'campos de mergeabilidad ausentes o invalidos' };
  }
  return { ok: true, pr: _normalizePr(parsed) };
}

// Ejecuta `gh` con argv estructurado. Sin `shell: true`, sin concatenar
// strings. Mismo molde que `fetchPrInfoForIssueAsync` (execFile + timeout +
// windowsHide + maxBuffer acotado), con `asyncRunner` inyectable para tests.
function _runGhAsync(args, opts) {
  const ghBin = opts.ghBin || process.env.GH_BIN || 'gh';
  const cwd = opts.cwd || process.cwd();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const asyncRunner = typeof opts.asyncRunner === 'function' ? opts.asyncRunner : null;

  if (asyncRunner) {
    return Promise.resolve()
      .then(() => asyncRunner(ghBin, args, { timeoutMs, cwd }))
      .catch((e) => ({ error: e instanceof Error ? e : new Error(String(e && e.message)) }));
  }

  return new Promise((resolve) => {
    execFile(
      ghBin,
      args,
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, cwd, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.killed || err.code === 'ETIMEDOUT') {
            resolve({ status: null, error: err, stderr, signal: err.signal });
          } else if (typeof err.code === 'number') {
            resolve({ status: err.code, stdout, stderr });
          } else {
            resolve({ status: null, error: err, stderr });
          }
          return;
        }
        resolve({ status: 0, stdout, stderr });
      },
    );
  });
}

/**
 * Trae los PRs ABIERTOS del repo con sus campos de mergeabilidad.
 *
 * @param {object} options
 * @param {string} options.repo `owner/name`, validado contra charset antes de
 *   llegar al argv. Un repo inválido corta ANTES de invocar `gh`.
 * @param {number} [options.limit] clampeado a [1,100] en código.
 * @returns {Promise<{ok:true, candidates:object[], invalid:Array}|{ok:false, reason:string}>}
 */
function fetchOpenPrCandidatesAsync(options) {
  const opts = options || {};
  if (!_isValidRepo(opts.repo)) return Promise.resolve({ ok: false, reason: 'invalid_repo' });
  const args = _buildOpenCandidatesArgs({ repo: opts.repo, limit: opts.limit });
  return _runGhAsync(args, opts)
    .then((result) => _parseMergeabilityList(result))
    .catch((e) => ({ ok: false, reason: 'spawn_failed', message: _redact(e && e.message) }));
}

/**
 * Segunda pasada: confirma la mergeabilidad de UN PR con `gh pr view`.
 *
 * GitHub calcula `mergeable` de forma diferida — `pr list` casi siempre
 * devuelve UNKNOWN y ceba el cálculo; `pr view` sobre el mismo PR lo resuelve.
 *
 * @returns {Promise<{ok:true, pr:object}|{ok:false, reason:string}>}
 */
function fetchPrMergeabilityAsync(prNumber, options) {
  const opts = options || {};
  if (!_isValidId(prNumber)) return Promise.resolve({ ok: false, reason: 'invalid_id' });
  if (!_isValidRepo(opts.repo)) return Promise.resolve({ ok: false, reason: 'invalid_repo' });
  const args = _buildViewArgs({ repo: opts.repo, pr: prNumber });
  return _runGhAsync(args, opts)
    .then((result) => _parseMergeabilityView(result))
    .catch((e) => ({ ok: false, reason: 'spawn_failed', message: _redact(e && e.message) }));
}

module.exports = {
  fetchPrInfoForIssue,
  fetchPrInfoForIssueAsync,
  resolvePrForGateWrite,
  DEFAULT_TIMEOUT_MS,
  __FIELDS: FIELDS,

  // #4966 — API nueva del watcher de mergeabilidad (estrictamente aditiva).
  fetchOpenPrCandidatesAsync,
  fetchPrMergeabilityAsync,
  MERGEABILITY_FIELDS,
  CANDIDATE_LIMIT_MIN,
  CANDIDATE_LIMIT_MAX,
  DEFAULT_CANDIDATE_LIMIT,
  // Internos expuestos SOLO para tests (prefijo _ = no son contrato publico).
  _buildOpenCandidatesArgs,
  _buildViewArgs,
  _parseMergeabilityList,
  _parseMergeabilityView,
  _clampCandidateLimit,
  _redact,
};
