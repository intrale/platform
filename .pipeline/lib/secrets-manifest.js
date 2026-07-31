'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isPlaceholderOrEmpty } = require('./credentials');

const DEFAULT_PATH = path.join(__dirname, '..', 'secrets-manifest.json');
const SERVICES = Object.freeze([
  'telegram', 'github', 'providers', 'aws', 'google_drive', 'r2', 'multimedia',
]);
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

module.exports = { load, SCHEMA, validate, listByService, isMetadataKey, DEFAULT_PATH };

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
