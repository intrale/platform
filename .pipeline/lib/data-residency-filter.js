// =============================================================================
// data-residency-filter.js — Filtro de paths para providers no-Anthropic
// (issue #3084 / S6 multi-provider).
//
// Cumple §6.4 del épico multi-provider (#3065): cada provider tiene su política
// de TOS/data residency; ciertos archivos del repo NO deben mandarse a un
// proveedor distinto de Anthropic. Este módulo es el ENFORCEMENT del lado
// del lanzador del adapter — independiente del sanitizer de logs (§6.5/S2).
//
// Diseño:
//   - Sidecar JSON `.pipeline/data-residency-exclusions.json` valida vs schema.
//   - Lista de patrones glob anti path-traversal (validados al boot).
//   - Tres categorías de provider: `anthropic` (passthrough), `deterministic`
//     (passthrough — no LLM), `non_anthropic` (filtra los matchados).
//   - Audit log append-only `.pipeline/audit/data-residency-filter.jsonl` con
//     `path_hash` (SHA-256 truncado a 12 hex) — NUNCA path crudo.
//   - Fail-closed: si el sidecar no carga / no parsea / no valida, el filtro
//     LANZA error. El caller (lanzador del adapter no-Anthropic) NO debe
//     atrapar el error y degradar a "sin filtro" — debe abortar el spawn.
//
// Uso programático típico (lanzador del adapter no-Anthropic, futuro):
//   const filter = require('./lib/data-residency-filter');
//   const exclusions = filter.loadExclusionsOrThrow();           // boot
//   const { allowed, blocked } = filter.filterPathsForProvider({
//     paths: contextPaths,
//     provider: 'openai-codex',
//     exclusions,
//   });
//   if (blocked.length > 0) {
//     filter.appendAudit({ skill, provider: 'openai-codex', blocked });
//   }
//   // pasar `allowed` al adapter; si `allowed.length === 0`, abortar.
//
// Uso boot (pulpo.js):
//   const filter = require('./lib/data-residency-filter');
//   filter.validateOrExit({ pipelineDir: PIPELINE });
//
// Uso CLI (pre-commit hook + reproducción manual):
//   node .pipeline/lib/data-residency-filter.js
//   node .pipeline/lib/data-residency-filter.js --file path/to/sidecar.json
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ─── Constantes ──────────────────────────────────────────────────────────────

const CANONICAL_SIDECAR_PATH = path.resolve(__dirname, '..', 'data-residency-exclusions.json');
const CANONICAL_SCHEMA_PATH = path.resolve(__dirname, '..', 'data-residency-exclusions.schema.json');
const CANONICAL_AUDIT_PATH = path.resolve(__dirname, '..', 'audit', 'data-residency-filter.jsonl');

// Categorías especiales del policy. Si una entrada del sidecar lista
// `non_anthropic`, aplica a cualquier provider que NO sea `anthropic` ni
// `deterministic`. Si lista nombres concretos (ej. `openai-codex`), aplica
// solo a esos.
const CATEGORY_ANTHROPIC = 'anthropic';
const CATEGORY_DETERMINISTIC = 'deterministic';
const CATEGORY_NON_ANTHROPIC = 'non_anthropic';

// Exit codes (alineado con agent-models-validate.js para coherencia operativa).
const EXIT_CODES = Object.freeze({
  OK: 0,
  UNCAUGHT: 1,
  INVALID_CONFIG: 2,
  TOOLCHAIN_MISSING: 3,
});

// ─── Carga defensiva de ajv ──────────────────────────────────────────────────

function tryLoadAjv() {
  try {
    const Ajv = require('ajv/dist/2020');
    return { ok: true, Ajv };
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  }
}

// ─── Glob → RegExp (subset POSIX, anti-traversal) ────────────────────────────

/**
 * Convierte un glob a RegExp anchorado al string completo del path. Diseño
 * conservador: solo soporta los meta `**`, `*`, `?`. Cualquier otro carácter
 * se trata como literal y se escapa para regex.
 *
 * Reglas:
 *   - `**` → `.*` (cualquier path, incluyendo `/`)
 *   - `*`  → `[^/]*` (cualquier char excepto separador)
 *   - `?`  → `[^/]` (un char excepto separador)
 *
 * El glob viaja por el schema con guard anti path-traversal (no `/` inicial,
 * no `..`, no `~/`, no `\\`). Por defensa redundante, esta función rechaza
 * glob con `..` o prefijo absoluto.
 */
function compileGlob(glob) {
  if (typeof glob !== 'string' || glob.length === 0) {
    throw new Error(`compileGlob: glob inválido "${glob}"`);
  }
  // Defensa redundante (el schema ya lo rechaza).
  if (glob.startsWith('/') || glob.startsWith('\\') || glob.startsWith('~')) {
    throw new Error(`compileGlob: prefijo absoluto/home prohibido en "${glob}"`);
  }
  if (/(^|\/)\.\.(\/|$)/.test(glob)) {
    throw new Error(`compileGlob: segmento ".." prohibido en "${glob}"`);
  }
  if (glob.includes('\\\\')) {
    throw new Error(`compileGlob: backslash prohibido en "${glob}"`);
  }

  // Tokenizar y construir la regex pieza a pieza para poder distinguir `**`
  // de `*` sin colisión con escapes.
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    const next = glob[i + 1];
    if (c === '*' && next === '*') {
      re += '.*';
      i += 2;
      // Comer un slash inmediato si lo hay para que `**/foo` y `foo` matcheen
      // ambos `foo` (caso típico glob).
      if (glob[i] === '/') {
        re += '\\/?';
        i++;
      }
      continue;
    }
    if (c === '*') {
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (/[.+^$()|[\]{}\\]/.test(c)) {
      re += '\\' + c;
      i++;
      continue;
    }
    re += c;
    i++;
  }
  return new RegExp('^' + re + '$');
}

/**
 * Normaliza un path para matching: convierte separadores `\` a `/` (Windows),
 * y descarta el prefijo `./` si está presente. NO resuelve `..` (eso es input
 * sucio que debería rechazarse antes en el lanzador del adapter; el filtro
 * solo decide bloqueo/passthrough sobre el string que recibe).
 */
function normalizePath(p) {
  if (typeof p !== 'string') return '';
  let out = p.replace(/\\/g, '/');
  if (out.startsWith('./')) out = out.slice(2);
  return out;
}

// ─── Validación del sidecar (CA-5) ───────────────────────────────────────────

/**
 * Valida el sidecar contra el schema (ajv) + cross-checks anti path-traversal.
 * Devuelve `{ ok, errors, exclusions }` sin lanzar.
 *
 * @param {object} sidecar  contenido parseado del JSON
 * @param {object} options  { schemaPath?, allowedProviders? }
 *   - allowedProviders: lista de nombres de provider del agent-models.json. Si
 *     se pasa, valida que cada `providers[i]` esté en el set
 *     [...allowedProviders, 'anthropic', 'deterministic', 'non_anthropic'].
 */
function validateExclusionsSidecar(sidecar, options = {}) {
  const errors = [];
  const ajvResult = tryLoadAjv();
  if (!ajvResult.ok) {
    return {
      ok: false,
      exitCode: EXIT_CODES.TOOLCHAIN_MISSING,
      errors: [{
        path: '(toolchain)',
        message: `no se pudo cargar ajv: ${ajvResult.reason}`,
        fix: "correr 'npm install' en la raíz del repo para instalar ajv",
      }],
    };
  }

  let schema;
  try {
    const schemaPath = options.schemaPath || CANONICAL_SCHEMA_PATH;
    schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      exitCode: EXIT_CODES.INVALID_CONFIG,
      errors: [{
        path: '(schema)',
        message: `no se pudo cargar data-residency-exclusions.schema.json: ${err.message}`,
        fix: 'restaurar el schema canónico desde main',
      }],
    };
  }

  const ajv = new ajvResult.Ajv({ allErrors: true, strict: false });
  const validateFn = ajv.compile(schema);
  const ok = validateFn(sidecar);
  if (!ok) {
    for (const e of validateFn.errors || []) {
      errors.push({
        path: `${e.instancePath || '#/'}`,
        message: `${e.message || 'error de schema'}${e.params ? ` — ${JSON.stringify(e.params)}` : ''}`,
        fix: 'ajustar el campo al tipo/forma esperada por data-residency-exclusions.schema.json',
      });
    }
  }

  // Cross-validations no expresables en schema vanilla.
  if (sidecar && Array.isArray(sidecar.exclusions)) {
    const allowedProviders = Array.isArray(options.allowedProviders)
      ? new Set([...options.allowedProviders, CATEGORY_ANTHROPIC, CATEGORY_DETERMINISTIC, CATEGORY_NON_ANTHROPIC])
      : null;

    sidecar.exclusions.forEach((entry, idx) => {
      if (!entry || typeof entry !== 'object') return;
      // 1. Pattern compilable (defensa redundante anti-traversal).
      if (typeof entry.pattern === 'string') {
        try {
          compileGlob(entry.pattern);
        } catch (err) {
          errors.push({
            path: `#/exclusions/${idx}/pattern`,
            message: err.message,
            fix: 'ajustar el patrón a un glob relativo válido (no absolutos, no `..`)',
          });
        }
      }
      // 2. Providers contra allowlist (si fue pasado).
      if (allowedProviders && Array.isArray(entry.providers)) {
        entry.providers.forEach((p, pi) => {
          if (typeof p === 'string' && !allowedProviders.has(p)) {
            errors.push({
              path: `#/exclusions/${idx}/providers/${pi}`,
              message: `provider "${p}" no está en el allowlist (válidos: [${[...allowedProviders].sort().join(', ')}])`,
              fix: 'declarar el provider en agent-models.json o usar la categoría "non_anthropic"',
            });
          }
        });
      }
    });
  }

  return {
    ok: errors.length === 0,
    exitCode: errors.length === 0 ? EXIT_CODES.OK : EXIT_CODES.INVALID_CONFIG,
    errors,
    exclusions: sidecar && sidecar.exclusions ? sidecar.exclusions : [],
  };
}

// ─── Carga del sidecar (fail-closed) ─────────────────────────────────────────

/**
 * Lee + parsea + valida el sidecar. Lanza Error si algo falla — diseño
 * fail-closed (CA-3): el caller (lanzador no-Anthropic) NO debe degradar.
 *
 * Devuelve `{ version, default_policy, exclusions, raw }`.
 */
function loadExclusionsOrThrow(options = {}) {
  const sidecarPath = options.sidecarPath || CANONICAL_SIDECAR_PATH;
  let raw;
  try {
    raw = fs.readFileSync(sidecarPath, 'utf8');
  } catch (err) {
    throw new Error(
      `[data-residency] FAIL-CLOSED: no se pudo leer ${sidecarPath} (${err.code || err.message}). ` +
      `El adapter no-Anthropic NO arranca sin sidecar válido. Restaurá el archivo desde main.`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[data-residency] FAIL-CLOSED: JSON inválido en ${sidecarPath}: ${err.message}. ` +
      `El adapter no-Anthropic NO arranca con sidecar corrupto. Corregí la sintaxis.`
    );
  }

  const result = validateExclusionsSidecar(parsed, {
    schemaPath: options.schemaPath,
    allowedProviders: options.allowedProviders,
  });
  if (!result.ok) {
    const head = result.errors[0] || { path: '?', message: 'error desconocido' };
    const moreLines = result.errors.length > 1
      ? `\n  (+ ${result.errors.length - 1} error(es) adicional(es))`
      : '';
    throw new Error(
      `[data-residency] FAIL-CLOSED: sidecar inválido en ${sidecarPath}\n` +
      `  problema: ${head.path} ${head.message}\n` +
      `  solución: ${head.fix || 'corregir el archivo'}${moreLines}`
    );
  }

  return {
    version: parsed.version,
    doc_ref: parsed.doc_ref,
    default_policy: parsed.default_policy,
    exclusions: parsed.exclusions,
    raw: parsed,
  };
}

// ─── Filtro principal: filterPathsForProvider ────────────────────────────────

/**
 * Aplica el filtro a una lista de paths para un provider dado. Devuelve
 * `{ allowed, blocked }`. `blocked` incluye `{ path, motivo, pattern }` para
 * que el caller pueda audit-loggear.
 *
 * Reglas:
 *   - Si `provider === 'anthropic'` o `'deterministic'` → passthrough (todo
 *     pasa, salvo que el sidecar tenga `default_policy[provider] === 'filter'`,
 *     lo que sería poco habitual pero válido).
 *   - Si el provider NO es `anthropic` ni `deterministic` → cae en la
 *     categoría `non_anthropic`. Cualquier exclusión con `providers` que
 *     incluya esa categoría O el nombre del provider concreto bloquea.
 *
 * Garantías testeables:
 *   - Match determinístico (orden de patrones del sidecar preservado).
 *   - El primer patrón que matchea decide; se reporta su `motivo`.
 *   - `paths` viene como string[]; resultado es shape estable.
 */
function filterPathsForProvider({ paths, provider, exclusions, defaultPolicy }) {
  if (!Array.isArray(paths)) {
    throw new Error('filterPathsForProvider: `paths` debe ser array');
  }
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new Error('filterPathsForProvider: `provider` requerido');
  }
  if (!Array.isArray(exclusions)) {
    throw new Error('filterPathsForProvider: `exclusions` debe ser array (cargar con loadExclusionsOrThrow)');
  }

  const policy = defaultPolicy || {};
  // Categoría efectiva del provider:
  let category;
  if (provider === CATEGORY_ANTHROPIC) category = CATEGORY_ANTHROPIC;
  else if (provider === CATEGORY_DETERMINISTIC) category = CATEGORY_DETERMINISTIC;
  else category = CATEGORY_NON_ANTHROPIC;

  const policyForCategory = policy[category];
  // Si la política dice passthrough explícito, no aplicamos exclusiones.
  if (policyForCategory === 'passthrough') {
    return {
      allowed: paths.slice(),
      blocked: [],
      provider,
      category,
      policy: 'passthrough',
    };
  }

  // Compile globs una vez (cache local — no se cruza llamadas para mantener
  // la función pura y el caller controla el ciclo de vida del sidecar).
  const compiled = exclusions.map((entry) => ({
    re: compileGlob(entry.pattern),
    pattern: entry.pattern,
    providers: new Set(entry.providers),
    motivo: entry.motivo,
  }));

  const allowed = [];
  const blocked = [];

  for (const rawPath of paths) {
    const norm = normalizePath(rawPath);
    let matchedRule = null;
    for (const rule of compiled) {
      const appliesByCategory = rule.providers.has(category);
      const appliesByName = rule.providers.has(provider);
      if (!appliesByCategory && !appliesByName) continue;
      if (rule.re.test(norm)) {
        matchedRule = rule;
        break;
      }
    }
    if (matchedRule) {
      blocked.push({
        path: rawPath,
        pattern: matchedRule.pattern,
        motivo: matchedRule.motivo,
      });
    } else {
      allowed.push(rawPath);
    }
  }

  return {
    allowed,
    blocked,
    provider,
    category,
    policy: 'filter',
  };
}

// ─── Audit log ───────────────────────────────────────────────────────────────

/**
 * Calcula `path_hash` = SHA-256(path) truncado a 12 hex. NUNCA logueamos el
 * path crudo en el audit (el log podría volverse en sí mismo un canal de leak
 * si lo expone un endpoint o lo arrastra una telemetry chain).
 */
function hashPath(p) {
  return crypto.createHash('sha256').update(String(p), 'utf8').digest('hex').slice(0, 12);
}

/**
 * Append-only de eventos de bloqueo al audit log. Crea el directorio si no
 * existe; modo `0o600` en el archivo (defensa para entornos POSIX — Windows
 * NTFS lo ignora pero no rompe).
 *
 * Shape de cada línea (JSONL):
 *   { ts, skill, provider, path_hash, motivo, pattern }
 */
function appendAudit({ skill, provider, blocked, auditPath, fsImpl }) {
  if (!Array.isArray(blocked) || blocked.length === 0) return { written: 0 };
  const _fs = fsImpl || fs;
  const target = auditPath || CANONICAL_AUDIT_PATH;
  const dir = path.dirname(target);
  try {
    _fs.mkdirSync(dir, { recursive: true });
  } catch (_) { /* idempotente */ }

  const ts = new Date().toISOString();
  const lines = blocked.map((b) => JSON.stringify({
    ts,
    skill: String(skill || 'unknown'),
    provider: String(provider || 'unknown'),
    path_hash: hashPath(b.path),
    motivo: b.motivo,
    pattern: b.pattern,
  })).join('\n') + '\n';

  // Append + chmod best-effort.
  _fs.appendFileSync(target, lines, { encoding: 'utf8' });
  try { _fs.chmodSync(target, 0o600); } catch (_) { /* Windows NTFS / no-op */ }

  return { written: blocked.length, auditPath: target };
}

// ─── API: validateOrExit (boot-style fail-fast) ──────────────────────────────

/**
 * Llamada típica desde pulpo.js boot, complementaria a `agent-models-validate`:
 *   require('./lib/data-residency-filter').validateOrExit({ pipelineDir: PIPELINE });
 *
 * Si el sidecar no existe, no parsea o no valida → exit 2.
 * Si ajv no carga → exit 3.
 */
function validateOrExit(options = {}) {
  const sidecarPath = options.sidecarPath || (
    options.pipelineDir
      ? path.join(options.pipelineDir, 'data-residency-exclusions.json')
      : CANONICAL_SIDECAR_PATH
  );
  const schemaPath = options.schemaPath || CANONICAL_SCHEMA_PATH;
  const onErrorWrite = options.onErrorWrite || ((msg) => process.stderr.write(msg + '\n'));
  const exitFn = options.exitFn || ((c) => process.exit(c));

  let raw;
  try {
    raw = fs.readFileSync(sidecarPath, 'utf8');
  } catch (err) {
    onErrorWrite(formatBootError({
      contextLabel: options.contextLabel || 'boot abortado',
      filePath: sidecarPath,
      problem: `no se pudo leer ${err.code || err.message}`,
      fix: 'restaurar data-residency-exclusions.json desde main',
    }));
    exitFn(EXIT_CODES.INVALID_CONFIG);
    return { ok: false, exitCode: EXIT_CODES.INVALID_CONFIG };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    onErrorWrite(formatBootError({
      contextLabel: options.contextLabel || 'boot abortado',
      filePath: sidecarPath,
      problem: `JSON inválido: ${err.message}`,
      fix: 'corregir sintaxis JSON',
    }));
    exitFn(EXIT_CODES.INVALID_CONFIG);
    return { ok: false, exitCode: EXIT_CODES.INVALID_CONFIG };
  }

  const result = validateExclusionsSidecar(parsed, {
    schemaPath,
    allowedProviders: options.allowedProviders,
  });
  if (result.ok) return result;

  const head = result.errors[0];
  onErrorWrite(formatBootError({
    contextLabel: options.contextLabel || 'boot abortado',
    filePath: sidecarPath,
    problem: `${head.path} ${head.message}`,
    fix: head.fix,
    extras: result.errors.slice(1).map((e) => `  + ${e.path} ${e.message}`).join('\n'),
  }));
  exitFn(result.exitCode);
  return result;
}

function formatBootError({ contextLabel, filePath, problem, fix, extras }) {
  const lines = [];
  lines.push(`[data-residency] FATAL data-residency-exclusions.json inválido — ${contextLabel}`);
  lines.push(`  archivo: ${filePath}`);
  lines.push(`  problema: ${problem}`);
  if (fix) lines.push(`  solución: ${fix}`);
  lines.push(`  reproducir: node .pipeline/lib/data-residency-filter.js`);
  if (extras) lines.push(extras);
  return lines.join('\n');
}

// ─── CLI entrypoint ──────────────────────────────────────────────────────────

function cliMain(argv) {
  const args = argv.slice(2);
  let sidecarPath = CANONICAL_SIDECAR_PATH;
  let schemaPath = CANONICAL_SCHEMA_PATH;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--file' && args[i + 1]) sidecarPath = path.resolve(args[++i]);
    else if (a === '--schema' && args[i + 1]) schemaPath = path.resolve(args[++i]);
    else if (a === '--quiet') quiet = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write([
        'data-residency-filter — valida data-residency-exclusions.json',
        '',
        'Uso: node .pipeline/lib/data-residency-filter.js [--file PATH] [--schema PATH] [--quiet]',
        '',
        'Exit codes:',
        '  0 = OK',
        '  1 = excepción no controlada',
        '  2 = config inválida',
        '  3 = toolchain ausente (correr npm install)',
        '',
      ].join('\n'));
      process.exit(0);
    }
  }

  let raw;
  try {
    raw = fs.readFileSync(sidecarPath, 'utf8');
  } catch (err) {
    process.stderr.write(`[data-residency] FATAL no se pudo leer ${sidecarPath}: ${err.message}\n`);
    process.exit(EXIT_CODES.INVALID_CONFIG);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[data-residency] FATAL JSON inválido: ${err.message}\n`);
    process.exit(EXIT_CODES.INVALID_CONFIG);
  }
  const result = validateExclusionsSidecar(parsed, { schemaPath });
  if (result.ok) {
    if (!quiet) process.stdout.write(`[data-residency] OK ${path.relative(process.cwd(), sidecarPath)}\n`);
    process.exit(EXIT_CODES.OK);
  }
  for (const e of result.errors) {
    process.stderr.write(`[data-residency] ${e.path} ${e.message}\n`);
    if (e.fix) process.stderr.write(`    fix: ${e.fix}\n`);
  }
  process.exit(result.exitCode);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Constantes públicas.
  CANONICAL_SIDECAR_PATH,
  CANONICAL_SCHEMA_PATH,
  CANONICAL_AUDIT_PATH,
  CATEGORY_ANTHROPIC,
  CATEGORY_DETERMINISTIC,
  CATEGORY_NON_ANTHROPIC,
  EXIT_CODES,

  // API pública.
  loadExclusionsOrThrow,
  filterPathsForProvider,
  appendAudit,
  validateExclusionsSidecar,
  validateOrExit,

  // Helpers (testing).
  compileGlob,
  normalizePath,
  hashPath,
  tryLoadAjv,
};

if (require.main === module) {
  try {
    cliMain(process.argv);
  } catch (err) {
    process.stderr.write(`[data-residency] FATAL excepción no controlada: ${err.stack || err.message}\n`);
    process.exit(EXIT_CODES.UNCAUGHT);
  }
}
