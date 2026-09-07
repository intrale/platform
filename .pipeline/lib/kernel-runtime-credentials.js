'use strict';

// =============================================================================
// kernel-runtime-credentials.js — Credenciales del principal runtime del kernel
// (#5208 · cierre del gap de cableado detectado al ejecutar el cutover)
//
// EL PROBLEMA QUE RESUELVE
//
// El cutover dejó dos mecanismos que no se hablaban:
//
//   - #5207 aprovisionó el principal runtime como un **perfil de la AWS CLI**
//     (`kernel-aws-bootstrap.js` escribe `~/.aws/credentials`).
//   - `createAwsCliRunner` (provisioner-infra.js) exige **claves estáticas en el
//     env** y rechaza fail-closed si no están: `AWS_PROFILE` no le alcanza.
//
// Y nadie hidrata esas claves: `credentials.loadIntoEnv()` no tiene descriptores
// `aws.*`, y el entorno de Windows sólo define `AWS_PROFILE`. Resultado, con
// `kernel.durable: true` el boot durable del pulpo lanzaba al construir el
// driver, caía en el `catch` de `bootKernelDurable` y degradaba a filesystem con
// alerta fuerte — o sea, el switch decía DynamoDB y el sistema seguía en FS.
// Exactamente la degradación silenciosa que el cutover existe para eliminar.
//
// QUÉ HACE
//
// Resuelve el env AWS acotado del principal runtime, en este orden:
//
//   1. Claves estáticas ya presentes en el env recibido. Gana el entorno: si el
//      operador exportó credenciales, no se las pisa ni se spawnea nada.
//   2. `aws configure get` sobre el perfil declarado en `kernel.runtimeProfile`.
//      Se cachea EN MEMORIA por perfil: el boot construye varios stores y no
//      puede pagar dos spawns por cada uno.
//   3. Si ninguna funciona → error como DATO con causa accionable. El caller
//      decide; este módulo nunca lanza ni termina el proceso.
//
// LAS CLAVES NO ENTRAN A `process.env`. Se devuelven en un objeto que va sólo al
// env del hijo `aws`. Hidratar `process.env` del pulpo se las regalaría a todos
// los agentes que declaren el scope `aws` en `build-child-env.js`, que es una
// ampliación de superficie que nadie pidió (least-privilege).
//
// NUNCA SE LOGUEAN. `describe()` existe para que el caller pueda decir de dónde
// salieron sin poder imprimir el valor.
// =============================================================================

const { spawnSync } = require('node:child_process');

const { buildAwsScopedEnv } = require('./kernel-provision');

// Caché por perfil. Vive lo que vive el proceso: las claves estáticas de un
// perfil no rotan a mitad de un boot, y releerlas en cada `buildDurableStore`
// serían dos spawns por store.
const cache = new Map();

function readProfileKey(profile, key, deps = {}) {
  const exec = deps.spawnSync || spawnSync;
  const args = ['configure', 'get', key];
  if (profile) args.push('--profile', profile);
  const res = exec('aws', args, { encoding: 'utf8', shell: false, env: deps.env || process.env });
  if (res.error || res.status !== 0) return null;
  const val = String(res.stdout || '').trim();
  return val === '' ? null : val;
}

/**
 * Resuelve el env AWS acotado del principal runtime del kernel.
 *
 * @param {object} opts
 * @param {object}  opts.kernel    sección `kernel` del config (`region`, `runtimeProfile`).
 * @param {object}  [opts.env]     env de origen (default `process.env`).
 * @param {object}  [opts.deps]    inyección para tests (`spawnSync`).
 * @param {boolean} [opts.noCache] saltea la caché (tests).
 * @returns {{ ok:true, env:object, source:'env'|'profile', profile?:string }
 *          |{ ok:false, code:string, error:string }}
 */
function resolveRuntimeAwsEnv(opts = {}) {
  const kernel = opts.kernel || {};
  const source = opts.env || process.env;
  const region = kernel.region;

  // 1) El entorno gana. Cero spawns, cero sorpresas.
  if (source.AWS_ACCESS_KEY_ID && source.AWS_SECRET_ACCESS_KEY) {
    return { ok: true, env: buildAwsScopedEnv(source, region), source: 'env' };
  }

  const profile = kernel.runtimeProfile;
  if (!profile || typeof profile !== 'string') {
    return {
      ok: false,
      code: 'runtime_profile_ausente',
      error: 'runtime_profile_ausente: el env no trae claves estáticas de AWS y `kernel.runtimeProfile` '
        + 'no está declarado en .pipeline/config.yaml. Qué hacer ahora: declaralo apuntando al perfil del '
        + 'principal runtime que aprovisionó #5207. La trampa: `AWS_PROFILE` NO alcanza — el runner de la '
        + 'AWS CLI del kernel exige claves estáticas y rechaza fail-closed si sólo hay perfil.',
    };
  }

  if (!opts.noCache && cache.has(profile)) return cache.get(profile);

  const accessKeyId = readProfileKey(profile, 'aws_access_key_id', opts.deps || {});
  const secretAccessKey = readProfileKey(profile, 'aws_secret_access_key', opts.deps || {});
  if (!accessKeyId || !secretAccessKey) {
    // NO se cachea el fallo: un perfil que todavía no existe puede aparecer, y
    // cachear el error dejaría el pipeline degradado hasta el próximo reinicio.
    return {
      ok: false,
      code: 'credenciales_runtime_ausentes',
      error: `credenciales_runtime_ausentes: el perfil "${profile}" no expone claves estáticas. `
        + 'Qué hacer ahora: verificá que el perfil exista en la config de la AWS CLI del usuario que corre '
        + 'el pipeline. La trampa prohibida: no apuntes `kernel.runtimeProfile` a un perfil administrativo '
        + 'para destrabarlo — el kernel dejaría de operar con least-privilege y los Deny de la policy no se '
        + 'probarían nunca.',
    };
  }

  const resolved = {
    ok: true,
    source: 'profile',
    profile,
    env: buildAwsScopedEnv({ AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey }, region),
  };
  cache.set(profile, resolved);
  return resolved;
}

/**
 * Descripción SEGURA del origen de las credenciales, para logs y alertas.
 * Nunca incluye el valor de una clave.
 */
function describe(resolved) {
  if (!resolved || !resolved.ok) return `sin credenciales (${(resolved && resolved.code) || 'desconocido'})`;
  return resolved.source === 'env'
    ? 'claves estáticas del entorno'
    : `perfil AWS "${resolved.profile}"`;
}

/** Limpia la caché en memoria (tests y rotación manual). */
function clearCache() { cache.clear(); }

module.exports = { resolveRuntimeAwsEnv, describe, clearCache };
