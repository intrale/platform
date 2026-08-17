'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isPlaceholderOrEmpty } = require('./credentials');
const { SECRET_SCOPES } = require('./secret-scopes');

const DEFAULT_PATH = path.join(__dirname, '..', 'secrets-manifest.json');
// Fuente unica del vocabulario: misma referencia congelada, mismo contenido y
// mismo orden que el literal que vivia aca. `SCHEMA.services` y `validate` no
// cambian de comportamiento.
const SERVICES = SECRET_SCOPES;
const SOURCES = Object.freeze(['store', 'env', 'external']);
const REQUIRED_WHEN = Object.freeze(['always', 'service_active', 'never']);
const HYDRATION = Object.freeze(['eager', 'deferred', 'n/a']);
// §R5: "presente en el store" no es lo mismo que "resoluble por su consumidor".
// Sin este eje, el health-check del TRAMO 2 (#5243) reportaria verde una clave
// guardada cuyo consumidor no puede resolverla.
const CONSUMER_STATUS = Object.freeze(['resolved', 'broken', 'no_consumer']);
const BLOCKED_BY_RE = /^#\d+$/;

const SCHEMA = Object.freeze({
  services: SERVICES,
  sources: SOURCES,
  required_when: REQUIRED_WHEN,
  hydration: HYDRATION,
  consumer_status: CONSUMER_STATUS,
  required_fields: Object.freeze([
    'name', 'service', 'source', 'env_var', 'required_when', 'hydration', 'shape', 'restore',
  ]),
  // Obligatorio solo en las entradas que viven en el store durable.
  store_required_fields: Object.freeze(['consumer_status']),
  // Obligatorio solo cuando se afirma `consumer_status: "resolved"`.
  resolved_required_fields: Object.freeze(['consumers']),
});

function isMetadataKey(dotPath) {
  return String(dotPath).split('.').some((segment) => segment.startsWith('_'));
}

function validate(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['el manifiesto debe ser un objeto'] };
  }
  if (!manifest._precedence || typeof manifest._precedence !== 'object') {
    errors.push('falta el bloque _precedence');
  }
  if (!Array.isArray(manifest.entries)) {
    errors.push('entries debe ser un array');
    return { ok: false, errors };
  }

  const names = new Set();
  for (const [index, entry] of manifest.entries.entries()) {
    const at = `entries[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${at} debe ser un objeto`);
      continue;
    }
    for (const field of SCHEMA.required_fields) {
      if (!(field in entry)) errors.push(`${at}.${field} es obligatorio`);
    }
    if (isPlaceholderOrEmpty(entry.name)) errors.push(`${at}.name es invalido`);
    if (names.has(entry.name)) errors.push(`${at}.name esta duplicado`);
    names.add(entry.name);
    if (!SERVICES.includes(entry.service)) errors.push(`${at}.service es invalido`);
    if (!SOURCES.includes(entry.source)) errors.push(`${at}.source es invalido`);
    if (!REQUIRED_WHEN.includes(entry.required_when)) errors.push(`${at}.required_when es invalido`);
    if (!HYDRATION.includes(entry.hydration)) errors.push(`${at}.hydration es invalido`);
    if (entry.source === 'store' && !['eager', 'deferred'].includes(entry.hydration)) {
      errors.push(`${at}.hydration debe ser eager o deferred para source=store`);
    }
    if (entry.source !== 'store' && entry.hydration !== 'n/a') {
      errors.push(`${at}.hydration debe ser n/a fuera del store`);
    }
    if (entry.hydration === 'deferred'
      && (typeof entry.defer_reason !== 'string' || entry.defer_reason.length < 40)) {
      errors.push(`${at}.defer_reason debe justificar el diferimiento`);
    }
    if (entry.hydration !== 'deferred' && 'defer_reason' in entry) {
      errors.push(`${at}.defer_reason solo aplica a hydration=deferred`);
    }
    if (entry.source === 'store') {
      if (!CONSUMER_STATUS.includes(entry.consumer_status)) {
        errors.push(`${at}.consumer_status es obligatorio y debe ser ${CONSUMER_STATUS.join('|')}`);
      }
    } else if ('consumer_status' in entry) {
      errors.push(`${at}.consumer_status solo aplica a source=store`);
    }
    // `consumers` obliga a NOMBRAR quien lee la clave cuando se afirma que su
    // consumo esta resuelto. Sin este campo, `resolved` es una opinion que
    // nadie puede auditar — y su reverso (`no_consumer` sobre una clave con
    // lectores reales) fue exactamente el defecto de la pasada anterior.
    if (entry.consumer_status === 'resolved') {
      if (!Array.isArray(entry.consumers) || entry.consumers.length === 0) {
        errors.push(`${at}.consumers es obligatorio y no vacio cuando consumer_status=resolved`);
      }
    }
    if ('consumers' in entry) {
      if (!Array.isArray(entry.consumers)
        || entry.consumers.some((ref) => typeof ref !== 'string' || ref.trim().length === 0)) {
        errors.push(`${at}.consumers debe ser un array de referencias no vacias`);
      }
    }
    if (entry.consumer_status === 'broken') {
      if (typeof entry.blocked_by !== 'string' || !BLOCKED_BY_RE.test(entry.blocked_by)) {
        errors.push(`${at}.blocked_by es obligatorio con forma #<issue> cuando consumer_status=broken`);
      }
    } else if ('blocked_by' in entry) {
      errors.push(`${at}.blocked_by solo aplica a consumer_status=broken`);
    }
    if (entry.required_when === 'never'
      && (typeof entry.restore !== 'string'
        || entry.restore.length < 40
        || entry.restore.startsWith('docs/'))) {
      errors.push(`${at}.restore debe justificar en prosa required_when=never`);
    }
    if (entry.shape !== null) {
      if (typeof entry.shape !== 'string') errors.push(`${at}.shape debe ser string o null`);
      else {
        try { new RegExp(entry.shape); } catch { errors.push(`${at}.shape no es una regex valida`); }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Detector de consumidores reales (candado generalizado de `no_consumer`).
//
// Por que existe: el candado inverso original estaba acotado a `service`
// `providers` con `auth_mode != oauth`, asi que por construccion no podia ver
// `telegram.*` ni los providers OAuth. Por ese hueco se publicaron como
// `no_consumer` dos claves con lectores reales (una de ellas, el allowlist de
// firma fail-closed de GATE 2). La regla ahora es del manifiesto entero y se
// verifica mecanicamente contra el repo: si el codigo de produccion lee la
// `env_var`, la entrada NO puede declararse `no_consumer`.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.join(__dirname, '..', '..');
// El barrido cubre el codigo de produccion del repo, no solo `.pipeline/`:
// `google_drive.drive_folder_id` se consume desde `qa/scripts/`, y acotar el
// scan a un directorio es la misma clase de angosto que dejo pasar los dos
// falsos `no_consumer` de la pasada anterior.
const READER_SCAN_ROOTS = Object.freeze(['.pipeline', 'qa']);
// `credentials.js` declara el ENV_MAPPING: nombra la env var para hidratarla,
// no la consume. Contarlo como lector haria que toda entrada eager se viera
// "leida" y el candado pasaria a ser trivialmente cierto (verde por vacuidad).
const READER_SCAN_EXCLUDED_FILES = Object.freeze(['.pipeline/lib/credentials.js']);
// `_tmp` es el scratchpad de los agentes: scripts de verificacion ad-hoc que
// quedan commiteados por otros issues (p. ej. `.pipeline/_tmp/5353-sec-*.js`,
// "prueba empirica" del rechazo de seguridad de #5353). Leen env vars para
// SIMULAR escenarios, no para consumirlas en produccion, y su vida es efimera:
// contarlos como lectores obligaria al manifiesto PUBLICO a nombrar rutas
// descartables como `consumers`, y el candado pasaria a rojo o verde segun que
// scratch dejo el ultimo agente. Es la misma clase de no-produccion que `logs`
// y `sessions`.
const READER_SCAN_EXCLUDED_DIRS = Object.freeze([
  'node_modules', '__tests__', 'tests', 'fixtures', 'logs', 'sessions', '_tmp',
]);

/** Quita comentarios de linea y de bloque: una mencion en prosa no es una lectura. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1');
}

function listProductionSources(dir, baseDir, acc) {
  let dirents;
  try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const dirent of dirents) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (READER_SCAN_EXCLUDED_DIRS.includes(dirent.name)) continue;
      listProductionSources(full, baseDir, acc);
    } else if (dirent.name.endsWith('.js') && !dirent.name.endsWith('.test.js')) {
      const rel = path.relative(baseDir, full).split(path.sep).join('/');
      if (READER_SCAN_EXCLUDED_FILES.includes(rel)) continue;
      acc.push({ rel, full });
    }
  }
  return acc;
}

/** Lee una vez los fuentes de produccion del repo (cacheado por raiz). */
function loadProductionSources(repoRoot = REPO_ROOT) {
  const files = [];
  for (const root of READER_SCAN_ROOTS) {
    listProductionSources(path.join(repoRoot, root), repoRoot, files);
  }
  return files.map((file) => ({ rel: file.rel, source: fs.readFileSync(file.full, 'utf8') }));
}

/**
 * Devuelve los archivos de produccion del repo que LEEN `envVar`.
 * Se cuenta como lectura el acceso por propiedad (`process.env.X`, `env.X`) o
 * por indice (`env['X']`), fuera de comentarios: una mencion en prosa no es un
 * consumo.
 *
 * @param {string} envVar nombre de la variable de entorno
 * @param {{ repoRoot?: string, files?: Array<{rel: string, source: string}> }} [opts]
 * @returns {string[]} paths relativos a la raiz del repo, ordenados
 */
function findEnvVarReaders(envVar, opts = {}) {
  const escaped = String(envVar).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `process.env.X`, `env.X`, `childEnv.X`, `env['X']`, `env["X"]`.
  const readRe = new RegExp(`(?:\\w*[eE]nv\\s*\\.\\s*${escaped}\\b|\\[\\s*['"\`]${escaped}['"\`]\\s*\\])`);
  const files = opts.files || loadProductionSources(opts.repoRoot);
  return files
    .filter((file) => readRe.test(stripComments(file.source)))
    .map((file) => file.rel)
    .sort();
}

function load(opts = {}) {
  const manifestPath = opts.path || DEFAULT_PATH;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const result = validate(manifest);
  if (!result.ok) throw new Error(`manifiesto de secretos invalido: ${result.errors.join('; ')}`);
  return manifest;
}

function listByService(manifest) {
  return manifest.entries.reduce((grouped, entry) => {
    if (!grouped[entry.service]) grouped[entry.service] = [];
    grouped[entry.service].push(entry);
    return grouped;
  }, {});
}

module.exports = {
  load,
  SCHEMA,
  // Sin este export, derivar un `enum` de Ajv desde `require(...).SERVICES` da
  // `undefined`, y un `enum: undefined` no valida nada: fail-open silencioso.
  SERVICES,
  validate,
  listByService,
  isMetadataKey,
  findEnvVarReaders,
  loadProductionSources,
  DEFAULT_PATH,
  REPO_ROOT,
};

if (require.main === module) {
  try {
    const manifest = load();
    const services = listByService(manifest);
    process.stdout.write(`${JSON.stringify({
      valid: true,
      services: Object.fromEntries(Object.entries(services).map(([name, entries]) => [
        name, entries.map((entry) => entry.name),
      ])),
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write('[secrets-manifest] ERROR: manifiesto invalido\n');
    process.exitCode = 1;
  }
}
