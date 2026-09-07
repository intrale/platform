// =============================================================================
// vault-respawn-readiness.js — ¿los consumidores de larga vida ya volvieron?
// (#5453 · CA-26 · soporte del coordinador `vault-migration.js`)
// =============================================================================
//
// Qué resuelve
// ------------
// Rotar una credencial NO alcanza para que el parque la use: `loadIntoEnv()`
// hidrata `process.env` UNA vez, al arranque de cada proceso de larga vida
// (`restart.js:47`, `pulpo.js:18`). Un pulpo, un listener o un `svc-drive` que
// siguen vivos conservan en memoria el material anterior, sin importar qué diga
// el vault. Por eso `vault-migration.js` no cuenta como cobertura ninguna
// resolución previa al respawn: necesita saber que CADA consumidor volvió a
// arrancar DESPUÉS de la rotación.
//
// Este módulo responde exactamente esa pregunta, y sólo esa.
//
// Por qué VERIFICA y no EJECUTA (decisión de diseño, no una simplificación)
// -------------------------------------------------------------------------
// La tentación es que el Pulpo se auto-respawnee al detectar que le toca. No.
// Un proceso que se reinicia a sí mismo dentro de su propio tick es el bucle de
// muerte que tumbó al Commander 12 h en 2026-07: si el arranque nuevo vuelve a
// entrar al mismo tick, el ciclo no cierra nunca y no queda nadie vivo para
// cortarlo. El respawn lo dispara el operador con `node .pipeline/restart.js`
// (que es un proceso EXTERNO al que reinicia), siguiendo el runbook; este
// módulo sólo acredita el resultado.
//
// Cómo se acredita, y por qué así
// -------------------------------
// Por cada consumidor declarado se exige, TODO junto:
//
//   1. que exista su `.pid` — sin archivo no hay nada que acreditar;
//   2. que el archivo se haya (re)escrito DESPUÉS del instante de la rotación —
//      `restart.js` los borra y los vuelve a escribir en cada arranque, así que
//      un mtime viejo es exactamente "este proceso no volvió";
//   3. que el PID de adentro corresponda a un proceso VIVO — un `.pid` fresco
//      de un proceso que murió a los 3 segundos no es readiness.
//
// Los tres son necesarios: (2) sin (3) acredita un arranque que se cayó, y (3)
// sin (2) acredita al proceso VIEJO, que es justo el que hay que reemplazar.
//
// Quién resuelve credenciales y quién las hereda
// ----------------------------------------------
// Sólo `pulpo.js:22` y `restart.js:55` llaman a `loadIntoEnv()`. El listener y
// los `svc-*` NO: heredan el `process.env` ya hidratado de `restart.js`, que
// hidrata ANTES de spawnearlos. Por eso acreditar el `.pid` de un hijo acredita
// también su material: ese hijo no existía cuando `restart.js` resolvió.
//
// Límite conocido, escrito para que nadie lo descubra tarde: entre el
// `loadIntoEnv()` de `restart.js` y el `.pid` del último hijo pasan segundos.
// Un respawn arrancado en esa ventana —después de la rotación pero antes de que
// el material nuevo esté en el vault— acreditaría con material viejo. La
// mitigación NO es este módulo: es la cobertura positiva, que además del
// respawn exige resoluciones reales con `via: vault` posteriores a él. Acreditar
// el respawn es condición NECESARIA, nunca suficiente.
//
// Contención
// ----------
// No lee credenciales, no las pasa por argv ni por el entorno de ningún hijo, y
// lo que devuelve son NOMBRES LÓGICOS de componente y conteos: nunca PIDs,
// paths ni contenido de archivos. Un PID en un mensaje que va a Telegram o a un
// PDF es metadata de infraestructura, y REQ-SEC-13 la deja afuera igual que a un
// valor.
// =============================================================================

'use strict';

const nodeFs = require('fs');
const path = require('path');

/**
 * Consumidores de larga vida que hidratan credenciales al arrancar.
 *
 * Espejo de `COMPONENTS` de `restart.js`. NO se importa de allá a propósito:
 * `restart.js` es un script ejecutable (mata procesos y spawnea al cargarse),
 * no un módulo. La coherencia entre las dos listas la sostiene un test de
 * fuente cruzada, que es lo que evita que se separen en silencio.
 */
const CONSUMIDORES = Object.freeze([
  'pulpo', 'listener', 'svc-telegram', 'svc-github',
  'svc-drive', 'svc-emulador', 'svc-reconciler', 'dashboard',
]);

/** `svc-drive` → `svc-drive.pid`, igual que `COMPONENTS[].pid`. */
function archivoPid(nombre) {
  return `${nombre}.pid`;
}

/**
 * @param {object} [opts]
 * @param {string}   [opts.pipelineDir]  dónde viven los `.pid` (default `.pipeline/`).
 * @param {object}   [opts.fs]
 * @param {Function} [opts.isAlive]      `(pid) => boolean`.
 * @param {string[]} [opts.consumidores] override SÓLO para tests.
 * @param {Function} [opts.logger]
 */
function createRespawnReadiness(opts = {}) {
  const fs = opts.fs || nodeFs;
  const pipelineDir = opts.pipelineDir
    ? path.resolve(opts.pipelineDir)
    : path.resolve(__dirname, '..');
  const consumidores = Array.isArray(opts.consumidores) && opts.consumidores.length
    ? [...opts.consumidores]
    : [...CONSUMIDORES];
  const logger = typeof opts.logger === 'function' ? opts.logger : () => {};

  const isAlive = typeof opts.isAlive === 'function'
    ? opts.isAlive
    : (pid) => {
      // `signal 0` no manda nada: sólo pregunta si el proceso existe y si
      // tenemos permiso sobre él. EPERM significa "existe pero es de otro
      // usuario", y para readiness eso NO alcanza: no podemos afirmar que sea
      // nuestro componente, así que se responde `false` (fail-closed).
      try { process.kill(pid, 0); return true; } catch { return false; }
    };

  /**
   * @param {object} params
   * @param {string|number} params.since  instante de la rotación (ISO o ms).
   * @returns {{ok:boolean, consumers:string[], pendientes:string[], total:number}}
   */
  function verify(params = {}) {
    const sinceMs = typeof params.since === 'number'
      ? params.since
      : Date.parse(params.since);
    const listos = [];
    const pendientes = [];

    // Sin un instante de referencia NO se puede distinguir "volvió" de "nunca
    // se fue": se responde que nada está listo, jamás que todo lo está.
    if (!Number.isFinite(sinceMs)) {
      logger('[vault-respawn] ERROR: falta el instante de rotacion contra el cual comparar. '
        + 'Impacto: el respawn no se puede acreditar y la ventana de cobertura no abre. '
        + 'Proximo paso: reanudar la migracion despues de registrar la rotacion del host');
      return { ok: false, consumers: [], pendientes: [...consumidores], total: consumidores.length };
    }

    for (const nombre of consumidores) {
      const ruta = path.join(pipelineDir, archivoPid(nombre));
      let stat;
      try { stat = fs.statSync(ruta); }
      catch { pendientes.push(nombre); continue; }

      if (!(stat.mtimeMs >= sinceMs)) { pendientes.push(nombre); continue; }

      let pid;
      try { pid = Number.parseInt(String(fs.readFileSync(ruta, 'utf8')).trim(), 10); }
      catch { pendientes.push(nombre); continue; }

      if (!Number.isInteger(pid) || pid <= 0) { pendientes.push(nombre); continue; }
      if (!isAlive(pid)) { pendientes.push(nombre); continue; }

      listos.push(nombre);
    }

    if (pendientes.length) {
      logger(`[vault-respawn] ${listos.length}/${consumidores.length} consumidores acreditados. `
        + `Pendientes: ${pendientes.join(', ')}. `
        + 'Impacto: la ventana de cobertura no abre porque esos procesos siguen con el material previo. '
        + 'Proximo paso: correr `node .pipeline/restart.js` y volver a acreditar');
    }
    return {
      ok: pendientes.length === 0 && listos.length === consumidores.length,
      consumers: listos,
      pendientes,
      total: consumidores.length,
    };
  }

  return { verify, CONSUMIDORES: Object.freeze([...consumidores]) };
}

module.exports = { createRespawnReadiness, CONSUMIDORES, archivoPid };
