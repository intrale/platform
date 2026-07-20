'use strict';

// =============================================================================
// project-descriptor-migrations.js — Migración por `schemaVersion` (Ola Puente P2 #4687)
//
// CA-F1 (R4): un descriptor viejo debe seguir arrancando. Desde el día 1 existe
// el mecanismo de migración, aunque hoy sólo haya una versión (`1.0`) y la
// migración sea la identidad `1.0 → 1.0`.
//
// Requisito de seguridad #7 / CA-B4 (A08 · downgrade de esquema): declarar un
// `schemaVersion` INFERIOR al actual para saltear campos nuevos obligatorios
// (`signers`/`gates`) es un vector de bypass. La migración RECHAZA downgrades y
// versiones desconocidas — fail-closed, nunca "arranca degradado".
//
// Patrón: errores como DATO (return { ok:false, ... }), NO se lanza. Espeja el
// estilo de dev-contract.js / task-contract.js.
// =============================================================================

// Versión de esquema soportada actualmente por el kernel. Al introducir `1.1`
// se agrega '1.1' a KNOWN_VERSIONS y un step en MIGRATION_STEPS ('1.0' -> '1.1').
const CURRENT_SCHEMA_VERSION = '1.0';

// Todas las versiones que el kernel sabe migrar hacia CURRENT. El orden importa
// (ascendente): define la cadena de migración.
const KNOWN_VERSIONS = Object.freeze(['1.0']);

// Steps de migración registrados: `${from}->${to}` => fn(descriptor) => descriptor.
// Vacío por ahora (identidad). Cuando exista 1.1 se registra '1.0->1.1'.
const MIGRATION_STEPS = Object.freeze({});

// Parseo estricto de una versión `major.minor` (sólo dígitos). Devuelve
// [major, minor] o null. NO acepta unicode, sufijos, ni `..`.
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,4})\.(\d{1,4})$/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

// Compara dos versiones `major.minor`. -1 si a<b, 0 si a==b, 1 si a>b, null si
// alguna es inválida.
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  return 0;
}

/**
 * Valida compatibilidad de `schemaVersion` y aplica la cadena de migración hacia
 * CURRENT_SCHEMA_VERSION. Fail-closed en TODOS los caminos anómalos.
 *
 * @param {object} descriptor  descriptor parseado (objeto).
 * @param {object} [opts]
 * @param {string} [opts.current=CURRENT_SCHEMA_VERSION] override para tests.
 * @returns {{ ok:boolean, code?:string, error?:string, from?:string, to?:string, descriptor?:object }}
 */
function migrateDescriptor(descriptor, opts = {}) {
  const current = opts.current || CURRENT_SCHEMA_VERSION;

  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    return { ok: false, code: 'not_object', error: 'descriptor no es un objeto' };
  }

  const declared = descriptor.schemaVersion;
  const parsed = parseVersion(declared);
  if (!parsed) {
    return {
      ok: false,
      code: 'invalid_version',
      error: `schemaVersion inválido: se esperaba 'major.minor' (ej. '${current}'), se encontró ${JSON.stringify(declared)}`,
    };
  }

  const cmp = compareVersions(declared, current);

  // Downgrade: el descriptor declara una versión ANTERIOR a la soportada. Vector
  // de bypass (#7) — se rechaza SIEMPRE, aunque la versión "vieja" fuese conocida.
  if (cmp === -1) {
    return {
      ok: false,
      code: 'downgrade_rejected',
      error: `downgrade de schemaVersion rechazado: declara ${declared} < soportada ${current} (posible bypass de campos obligatorios)`,
    };
  }

  // El descriptor declara una versión MÁS NUEVA que la que el kernel entiende.
  if (cmp === 1) {
    return {
      ok: false,
      code: 'unsupported_newer',
      error: `schemaVersion ${declared} más nueva que la soportada ${current}: actualizá el kernel`,
    };
  }

  // Versión desconocida (no está en la cadena conocida). Fail-closed.
  if (!KNOWN_VERSIONS.includes(declared)) {
    return {
      ok: false,
      code: 'unknown_version',
      error: `schemaVersion ${declared} no reconocida por el kernel`,
    };
  }

  // cmp === 0 y conocida: aplicar la cadena de migración hacia current.
  let migrated = descriptor;
  let cursor = declared;
  const guard = KNOWN_VERSIONS.length + 2; // anti-loop
  let steps = 0;
  while (compareVersions(cursor, current) === -1) {
    if (steps++ > guard) {
      return { ok: false, code: 'migration_loop', error: 'cadena de migración no converge' };
    }
    const idx = KNOWN_VERSIONS.indexOf(cursor);
    const next = KNOWN_VERSIONS[idx + 1];
    if (!next) {
      return { ok: false, code: 'no_migration_path', error: `sin ruta de migración desde ${cursor}` };
    }
    const stepFn = MIGRATION_STEPS[`${cursor}->${next}`];
    if (typeof stepFn !== 'function') {
      return { ok: false, code: 'missing_step', error: `falta step de migración ${cursor}->${next}` };
    }
    migrated = stepFn(migrated);
    cursor = next;
  }

  return { ok: true, from: declared, to: current, descriptor: migrated };
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  KNOWN_VERSIONS,
  MIGRATION_STEPS,
  parseVersion,
  compareVersions,
  migrateDescriptor,
};
