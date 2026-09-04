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

const { DESCRIPTOR_SCOPE_ENUM, PROVIDER_VENDORS } = require('./secret-scopes');

// Versión de esquema soportada actualmente por el kernel (#6032).
const CURRENT_SCHEMA_VERSION = '1.1';

// Todas las versiones que el kernel sabe migrar hacia CURRENT. El orden importa
// (ascendente): define la cadena de migración.
const KNOWN_VERSIONS = Object.freeze(['1.0', '1.1']);

// -----------------------------------------------------------------------------
// Vocabulario legacy del enum `1.0` (`contracts/project.schema.json:157` antes de
// este corte). La migración lo mapea de forma TOTAL: cada valor cae en uno y sólo
// uno de TRES destinos (CA-3), y el conjunto de valores está enumerado en código
// — nunca se deriva por heurística de string ni de `providers.order` del propio
// descriptor, que es dato EN BANDA y por lo tanto no confiable (SEC-7).
// -----------------------------------------------------------------------------

// Destino (a) — traducción/expansión hacia el vocabulario del Eje A. `providers`
// se EXPANDE a un scope por vendor de almacenamiento (`PROVIDER_VENDORS`), que es
// el vocabulario de credenciales; jamás `LIVE_PROVIDER_IDS`, que es el de runtime
// (ver el comentario de `secret-scopes.js:31-42`).
const LEGACY_SCOPE_MAP = Object.freeze({
  github: Object.freeze(['github']),
  aws: Object.freeze(['aws']),
  providers: Object.freeze(PROVIDER_VENDORS.map((vendor) => `providers:${vendor}`)),
});

// Destino (b) — LISTA CERRADA de valores del enum `1.0` que se descartan con
// registro (nunca en silencio: viajan en `droppedScopes`, CA-5).
//
// Un valor sólo puede vivir acá si cumple las TRES condiciones de CA-4:
//   (i)   pertenece al enum `1.0`;
//   (ii)  es INERTE en el Eje A — el `credentials[].scopes` del descriptor nunca
//         lo alcanza como credencial a almacenar;
//   (iii) su destino real vive en otro canal que esta migración no toca.
//
// `justificacion` no es decorativa: el test de CA-4 falla si alguien agrega un
// miembro sin explicar por qué cumple las tres condiciones.
const LEGACY_EJE_B_SCOPES = Object.freeze({
  'telegram-hooks': 'contexto de DESTINO (un chat id), no la credencial. (i) esta en el enum 1.0; '
    + '(ii) inerte en el Eje A: no nombra ningun secreto a almacenar; (iii) su destino real es el '
    + 'canal de hooks, que sigue funcionando igual. Traducirlo a `telegram` haria que el bot token '
    + 'cruce al proceso hijo — exactamente lo que el codigo de inyeccion evita hoy (SEC-7 / D-1).',
  'gradle-android': 'paths de toolchain (JAVA_HOME, ANDROID_HOME...), que no son secretos. '
    + '(i) esta en el enum 1.0; (ii) inerte en el Eje A: no hay credencial detras; (iii) su destino '
    + 'real es `build-child-env.js`, que este corte NO toca.',
});

// Índice de orden del vocabulario nuevo. La salida de `migrateScopes` se ordena
// por acá (no con un `.sort()` suelto) para que el resultado sea reproducible y
// quede atado al mismo contrato que el enum del schema.
const SCOPE_ORDER = new Map(DESCRIPTOR_SCOPE_ENUM.map((scope, i) => [scope, i]));

/**
 * Traduce el `credentials[].scopes` del vocabulario `1.0` al del `1.1`.
 *
 * Mapeo TOTAL y enumerado (CA-3), con exactamente tres destinos:
 *   (a) uno o más valores del enum nuevo  → `LEGACY_SCOPE_MAP`
 *   (b) conjunto vacío CON registro        → `LEGACY_EJE_B_SCOPES` ⇒ `droppedScopes`
 *   (c) fallo duro                          → `{ ok:false, code:'unknown_scope', scope }`
 *
 * Errores como DATO — nunca lanza.
 *
 * @param {unknown} scopes  lista de scopes en vocabulario `1.0`.
 * @returns {{ok:true, scopes:string[], droppedScopes:string[]}|{ok:false, code:string, scope?:string, error:string}}
 */
function migrateScopes(scopes) {
  if (!Array.isArray(scopes)) {
    return { ok: false, code: 'scopes_not_array', error: 'credentials[].scopes debe ser una lista' };
  }
  const out = new Set();
  const dropped = [];
  for (const scope of scopes) {
    if (typeof scope !== 'string') {
      return { ok: false, code: 'unknown_scope', error: `scope no reconocido en el vocabulario 1.0: ${JSON.stringify(scope)}` };
    }
    if (Object.prototype.hasOwnProperty.call(LEGACY_SCOPE_MAP, scope)) {
      for (const nuevo of LEGACY_SCOPE_MAP[scope]) out.add(nuevo);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(LEGACY_EJE_B_SCOPES, scope)) {
      if (!dropped.includes(scope)) dropped.push(scope);
      continue;
    }
    // (c) fallo duro. El mensaje NOMBRA el scope: sin eso el operador no sabe
    // cuál de los valores de su descriptor rompió la migración.
    return { ok: false, code: 'unknown_scope', scope, error: `scope no reconocido en el vocabulario 1.0: ${JSON.stringify(scope)}` };
  }
  const ordenados = [...out].sort((a, b) => SCOPE_ORDER.get(a) - SCOPE_ORDER.get(b));
  return { ok: true, scopes: ordenados, droppedScopes: dropped };
}

/**
 * Step `1.0 -> 1.1`. Función PURA sobre el descriptor (CA-8): no muta la entrada,
 * PRESERVA `ref` y no inventa campos — en particular NUNCA sintetiza un `shared`
 * ni un `inherit` (CA-12: `shared` ausente ⇒ tier `host`, y ningún paso de
 * migración puede invertir ese default de aislamiento).
 *
 * Lanza sólo ante un scope desconocido; `migrateDescriptor` atrapa y devuelve
 * `{ok:false}` — la excepción jamás sale del módulo.
 */
function stepV10ToV11(descriptor) {
  const next = { ...descriptor, schemaVersion: '1.1' };
  const dropped = [];
  if (Array.isArray(descriptor.credentials)) {
    next.credentials = descriptor.credentials.map((entry, i) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const res = migrateScopes(entry.scopes);
      if (!res.ok) {
        const err = new Error(`credentials[${i}].scopes: ${res.error}`);
        err.code = res.code;
        throw err;
      }
      for (const d of res.droppedScopes) if (!dropped.includes(d)) dropped.push(d);
      // `ref` (y cualquier otra clave del item) se preserva por spread; sólo se
      // reemplaza `scopes`.
      return { ...entry, scopes: res.scopes };
    });
  }
  return { descriptor: next, droppedScopes: dropped };
}

// Steps de migración registrados: `${from}->${to}` => fn(descriptor) => { descriptor, droppedScopes }.
const MIGRATION_STEPS = Object.freeze({
  '1.0->1.1': stepV10ToV11,
});

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

  // El descriptor declara una versión MÁS NUEVA que la que el kernel entiende.
  if (cmp === 1) {
    return {
      ok: false,
      code: 'unsupported_newer',
      error: `schemaVersion ${declared} más nueva que la soportada ${current}: actualizá el kernel`,
    };
  }

  // Versión desconocida (no está en la cadena conocida). Fail-closed.
  //
  // ÉSTE es el caso de una versión vieja SIN ruta de migración (p. ej. `0.9`), y
  // es el que hasta #6032 quedaba tapado: el gate anti-downgrade rechazaba TODA
  // versión menor a `current` antes de llegar acá, con lo cual `1.0` (que sí
  // tiene ruta) y `0.9` (que no) eran indistinguibles — devolvían el mismo
  // `downgrade_rejected`. Ese era el defecto; el gate en sí NO se debilita
  // (CA-7): una versión vieja sólo pasa si está en `KNOWN_VERSIONS` **y** tiene
  // step registrado, y el descriptor migrado se valida igual contra el schema
  // de `current`, así que no hay bypass de campos nuevos obligatorios.
  if (!KNOWN_VERSIONS.includes(declared)) {
    return {
      ok: false,
      code: 'unknown_version',
      error: `schemaVersion ${declared} no reconocida por el kernel: no hay ruta de migración registrada hacia ${current}`,
    };
  }

  // Versión conocida (cmp === 0 ⇒ identidad; cmp === -1 ⇒ cadena hacia current).
  let migrated = descriptor;
  let cursor = declared;
  const droppedScopes = [];
  const guard = KNOWN_VERSIONS.length + 2; // anti-loop
  let steps = 0;
  while (compareVersions(cursor, current) === -1) {
    if (steps++ > guard) {
      return { ok: false, code: 'migration_loop', error: 'cadena de migración no converge' };
    }
    const idx = KNOWN_VERSIONS.indexOf(cursor);
    const next = KNOWN_VERSIONS[idx + 1];
    if (!next) {
      return { ok: false, code: 'no_migration_path', error: `sin ruta de migración desde ${cursor} hacia ${current}` };
    }
    const stepFn = MIGRATION_STEPS[`${cursor}->${next}`];
    if (typeof stepFn !== 'function') {
      return { ok: false, code: 'missing_step', error: `falta step de migración ${cursor}->${next}` };
    }
    // CA-8: si el step lanza, se devuelve `{ok:false}` — la excepción NO se propaga.
    let out;
    try {
      out = stepFn(migrated);
    } catch (e) {
      return {
        ok: false,
        code: e && e.code ? e.code : 'step_failed',
        error: `falló el step de migración ${cursor}->${next}: ${e && e.message ? e.message : String(e)}`,
      };
    }
    migrated = out && out.descriptor ? out.descriptor : out;
    for (const d of (out && out.droppedScopes) || []) if (!droppedScopes.includes(d)) droppedScopes.push(d);
    cursor = next;
  }

  return { ok: true, from: declared, to: current, descriptor: migrated, droppedScopes };
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  KNOWN_VERSIONS,
  MIGRATION_STEPS,
  LEGACY_SCOPE_MAP,
  LEGACY_EJE_B_SCOPES,
  migrateScopes,
  parseVersion,
  compareVersions,
  migrateDescriptor,
};
