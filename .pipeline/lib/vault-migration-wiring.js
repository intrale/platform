// =============================================================================
// vault-migration-wiring.js — el cableado PRODUCTIVO del coordinador de
// migración del vault (#5453 · rev-1).
//
// Por qué existe este módulo
// --------------------------
// `lib/vault-migration.js` es una máquina de estados pura con dependencias
// inyectables: no sabe leer config, no sabe dónde viven los `.pid` y no sabe
// escribir auditoría. Ese diseño es correcto, pero deja una trampa: si cada
// consumidor arma sus propias `deps`, el Pulpo y la CLI del operador terminan
// operando sobre criterios distintos, y el estado que ve el operador no es el
// que evalúa el pipeline.
//
// En la rev-0 de #5453 esa trampa se materializó: el único cableado vivía
// inline en `pulpo.js` con `rotate: () => ({ok:false})`, `provision: () =>
// ({ok:false})` y `writeAudit: () => {}`. Con eso ningún host podía pasar de
// `preflight`, el tick del Pulpo (que sólo procesa `respawned+`) era un no-op
// permanente y la evidencia se tiraba a la basura. CA-22/CA-23/CA-26 no eran
// ejercitables por nadie.
//
// Este módulo es AHORA el único cableado. Lo consumen los dos:
//   - `pulpo.js`                 → sólo observa, sin acreditación.
//   - `vault-migration-run.js`   → CLI del operador; acredita etapa por etapa.
//
// Qué significa "ACREDITAR" (y por qué no es "ejecutar")
// ------------------------------------------------------
// Rotar credenciales y subir material al vault los hace el operador FUERA DE
// BANDA, siguiendo `docs/runbooks/credential-rotation.md`: son operaciones
// irreversibles contra proveedores externos (Anthropic, Google, Telegram) que
// ningún proceso automático debería disparar solo. Lo que hace el coordinador
// es ACREDITAR que ocurrieron y persistir el hecho, para que la ventana de
// cobertura pueda abrir.
//
// La acreditación NO es un `--force`: es fail-closed. Sin una confirmación
// explícita del operador para ESTA invocación, `rotate`/`provision` devuelven
// `{ok:false}` exactamente como antes. Lo que cambia es que ahora EXISTE una
// forma de decir que sí.
//
// Idempotencia (el requisito que no se puede aflojar)
// ---------------------------------------------------
// `vault-migration.js` arma una clave `<host>:<op>:1:<nonce>` y la persiste en
// un checkpoint ANTES de invocar la operación; un crash entre etapas reanuda
// con LA MISMA clave. Acá se cierra el otro extremo: cada acreditación se
// registra en un ledger append-only indexado por esa clave. Si la misma clave
// vuelve, se devuelve el MISMO resultado (misma `version`) sin pedirle nada al
// operador — reanudar no puede parecerse a una rotación nueva.
//
// Contención de secretos
// ----------------------
// El ledger guarda nombres lógicos, la clave de idempotencia (que por
// construcción es `<host>:<op>:1:<nonce>`, sin material) y una etiqueta de
// versión validada contra `SLUG_RE`. Nunca un valor, un path ni un PID. La
// auditoría se escribe con la evidencia YA sanitizada por el módulo (modelo
// cerrado de campos), en JSONL append-only con permisos 0600, igual que
// `vault-cut-fallback.js`.
// =============================================================================

'use strict';

const nodeFs = require('fs');
const path = require('path');

const vaultMigration = require('./vault-migration');
const respawnReadiness = require('./vault-respawn-readiness');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PIPELINE_DIR = path.join(REPO_ROOT, '.pipeline');

/** Ledger de acreditaciones del operador. Vive junto al estado por host. */
const ACREDITACIONES_FILE = 'acreditaciones.jsonl';
/** Auditoría operativa sanitizada. Mismo patrón que `vault-cut-fallback.jsonl`. */
const AUDIT_FILE = 'vault-migration.jsonl';

/** Causas de gate cerrado. Se devuelven para que la CLI explique QUÉ falta. */
const GATE = Object.freeze({
  ABIERTO: 'abierto',
  VAULT_CERRADO: 'vault_deshabilitado',
  MIGRACION_CERRADA: 'migracion_deshabilitada',
  CONFIG_ILEGIBLE: 'config_ilegible',
});

/**
 * Etiqueta de versión de rotación. Espejo de `SLUG_RE` de `vault-migration.js`
 * (que la usa para normalizar el campo antes de persistirlo): validar acá
 * también convierte un typo del operador en un error explícito, en vez de un
 * `version: null` silencioso dentro del estado del host.
 */
const VERSION_RE = vaultMigration.SLUG_RE || /^[A-Za-z0-9._:@-]{1,64}$/;

/**
 * Frases de confirmación de las dos etapas irreversibles.
 *
 * Viven ACÁ, en la capa que comparten la CLI y el Pulpo, y no en el dispatch de
 * la CLI: en la rev-1 estaban sólo allá, y el mensaje que el wiring le imprime
 * al operador las repetía como literal. Dos copias de la frase que abre la etapa
 * irreversible es exactamente el tipo de duplicación que se desincroniza en
 * silencio — y la copia que se desincroniza es la que le dice al operador qué
 * escribir.
 */
const CONFIRM = Object.freeze({
  rotate: 'ROTACION ACREDITADA',
  provision: 'PROVISION ACREDITADA',
});

/**
 * El host viaja a mensajes del operador. Se normaliza contra `HOST_RE` antes de
 * concatenarlo: un host inválido se reporta como `<host-invalido>` en vez de
 * inyectar texto arbitrario en el log.
 */
function normalizarHost(host) {
  return (typeof host === 'string' && host.length <= 64 && vaultMigration.HOST_RE.test(host))
    ? host : '<host-invalido>';
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Lee el config vivo. Nunca tira: un config ilegible es gate CERRADO.
 *
 * `pipelineDir` NO es opcional en la practica (#5453 rev-4): sin el,
 * `config-resolver.resolve()` cae a `REPO_ROOT`/`PIPELINE_REPO_ROOT` del
 * ambiente, que el pipeline setea al repo principal. La CLI del operador
 * corriendo dentro de un worktree escribia estado y auditoria en el worktree
 * pero leia el gate, `hosts_activos`, `required_scopes` y el ancla `vaultOnly`
 * de OTRO repo. Decidir un corte con la politica de un arbol y el estado de
 * otro es exactamente el fail-open que este modulo existe para evitar.
 */
function cargarConfig(loadConfig, pipelineDir) {
  try {
    if (typeof loadConfig === 'function') {
      const cfg = loadConfig();
      return (cfg && typeof cfg === 'object') ? cfg : null;
    }
    // eslint-disable-next-line global-require
    const cfg = require('./config-resolver').resolve(pipelineDir ? { pipelineDir } : {});
    return (cfg && typeof cfg === 'object') ? cfg : null;
  } catch { return null; }
}

function seccionVault(cfg) {
  const v = cfg && cfg.vault;
  return (v && typeof v === 'object') ? v : {};
}

/**
 * Doble gate fail-closed: `vault.enabled` Y `vault.migration.enabled`, sólo el
 * booleano `true` exacto. `"true"`, `1` o `undefined` lo dejan cerrado.
 */
function evaluarGate(cfg) {
  if (!cfg) return GATE.CONFIG_ILEGIBLE;
  const vault = seccionVault(cfg);
  if (vault.enabled !== true) return GATE.VAULT_CERRADO;
  const mig = (vault.migration && typeof vault.migration === 'object') ? vault.migration : {};
  if (mig.enabled !== true) return GATE.MIGRACION_CERRADA;
  return GATE.ABIERTO;
}

/** Hosts declarados en la ventana de convivencia. Sin hosts no hay migración. */
function hostsDeConfig(cfg) {
  const vault = seccionVault(cfg);
  const win = (vault.shadow_window && typeof vault.shadow_window === 'object')
    ? vault.shadow_window : {};
  return Array.isArray(win.hosts_activos)
    ? win.hosts_activos.filter((h) => typeof h === 'string' && vaultMigration.HOST_RE.test(h))
    : [];
}

// ---------------------------------------------------------------------------
// Ledger de acreditaciones (append-only, indexado por clave de idempotencia)
// ---------------------------------------------------------------------------

function crearLedger({ fs, ruta, logger }) {
  function leerTodo() {
    let crudo;
    try { crudo = fs.readFileSync(ruta, 'utf8'); }
    catch { return []; }
    const out = [];
    for (const linea of String(crudo).split(/\r?\n/)) {
      if (!linea.trim()) continue;
      // Una línea corrupta NO invalida el ledger entero: se saltea. Perder una
      // acreditación vieja degrada a "pedir confirmación de nuevo", que es el
      // lado seguro; abortar la lectura dejaría al operador sin poder reanudar.
      try {
        const rec = JSON.parse(linea);
        if (rec && typeof rec === 'object') out.push(rec);
      } catch { /* línea corrupta: se ignora a propósito */ }
    }
    return out;
  }

  /** Busca por (op, clave). La clave es `<host>:<op>:1:<nonce>`: no lleva material. */
  function buscar(op, clave) {
    if (typeof clave !== 'string' || !clave) return null;
    const todos = leerTodo();
    for (let i = todos.length - 1; i >= 0; i -= 1) {
      if (todos[i].op === op && todos[i].clave === clave) return todos[i];
    }
    return null;
  }

  function registrar(rec) {
    try {
      fs.mkdirSync(path.dirname(ruta), { recursive: true });
      fs.appendFileSync(ruta, JSON.stringify(rec) + '\n', { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch (e) {
      // Sin ledger no hay idempotencia acreditada: se falla, no se acredita a
      // ciegas. Acreditar sin poder registrarlo haría que la reanudación
      // volviera a pedir una rotación que YA se hizo.
      logger('[vault-migration] ERROR: no se pudo registrar la acreditacion '
        + '(' + ((e && e.code) || 'io') + '). Impacto: la etapa NO avanza. '
        + 'Proximo paso: verificar permisos de .pipeline/state/vault-migration/');
      return false;
    }
  }

  return { buscar, registrar, leerTodo, ruta };
}

// ---------------------------------------------------------------------------
// Cableado
// ---------------------------------------------------------------------------

/**
 * Arma el coordinador de migración con las dependencias REALES.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.pipelineDir]      raíz de `.pipeline/`.
 * @param {Function} [opts.logger]
 * @param {Function} [opts.loadConfig]       lector del config vivo.
 * @param {object}   [opts.acreditacion]     confirmación del operador para ESTA
 *   invocación: `{ rotate: {confirmado:true, version:'<slug>'} }` y/o
 *   `{ provision: {confirmado:true} }`. Ausente ⇒ `rotate`/`provision` fallan
 *   cerrado, que es exactamente el modo en que corre el Pulpo.
 * @param {Function} [opts.canPublishEvidence]
 * @param {Function} [opts.signalNeedsHuman]
 * @param {Function} [opts.metricsFactory]   fábrica del evaluador de cobertura.
 * @param {object}   [opts.fs] @param {Function} [opts.now]
 * @returns {{coordinador:object|null, gate:string, gateAbierto:boolean,
 *           hosts:string[], stateDir:string, auditPath:string,
 *           acreditacionesPath:string, config:object|null}}
 */
function createProductionVaultMigration(opts = {}) {
  const fs = opts.fs || nodeFs;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const logger = typeof opts.logger === 'function' ? opts.logger : () => {};
  const pipelineDir = opts.pipelineDir ? path.resolve(opts.pipelineDir) : DEFAULT_PIPELINE_DIR;
  const stateDir = path.join(pipelineDir, 'state', 'vault-migration');
  const auditPath = path.join(pipelineDir, 'audit', AUDIT_FILE);
  const acreditacionesPath = path.join(stateDir, ACREDITACIONES_FILE);

  const cfg = cargarConfig(opts.loadConfig, pipelineDir);
  const gate = evaluarGate(cfg);
  const hosts = hostsDeConfig(cfg);

  // Gate CERRADO ⇒ no se construye el coordinador. Sin coordinador no se crea
  // un solo archivo bajo `state/vault-migration/` ni se consulta cobertura.
  if (gate !== GATE.ABIERTO) {
    return {
      coordinador: null, gate, gateAbierto: false, hosts,
      stateDir, auditPath, acreditacionesPath, config: cfg, ledger: null,
    };
  }

  // eslint-disable-next-line global-require
  const { ENV_DESCRIPTORS } = require('./credentials');
  // eslint-disable-next-line global-require
  const operatorGate = require('./operator-gate');

  const ledger = crearLedger({ fs, ruta: acreditacionesPath, logger });
  const acreditacion = (opts.acreditacion && typeof opts.acreditacion === 'object')
    ? opts.acreditacion : {};

  const readiness = respawnReadiness.createRespawnReadiness({
    pipelineDir,
    fs,
    logger: (msg) => logger(msg),
  });

  /**
   * Auditoría append-only. La evidencia llega YA sanitizada por
   * `vault-migration.js` (modelo cerrado de campos): acá sólo se serializa.
   * Un fallo de escritura lo captura y loguea el propio módulo — pero deja de
   * ser un descarte silencioso, que era el bug de la rev-0.
   */
  function writeAudit(evidencia) {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify(evidencia) + '\n', { encoding: 'utf8', mode: 0o600 });
  }

  /**
   * ¿Esta invocación es una REANUDACIÓN legítima de un crash?
   *
   * El replay del ledger salta la confirmación del operador, así que es la
   * superficie que hay que cerrar (#5453 rev-2, hallazgo de `security`:
   * OWASP A04 + A01). Se exigen las TRES condiciones, y ninguna alcanza sola:
   *
   *   1. `reanudada === true` — lo computa `conCheckpoint()` mirando si el
   *      checkpoint YA existía antes de este intento. Es el único dato que
   *      distingue crash de intento fresco.
   *   2. el estado persistido del host trae un `pendiente` VIVO con la misma
   *      `op` y la misma `clave`. Chequeo independiente contra el filesystem:
   *      no se le cree al parámetro, se verifica. Sin `pendiente` no hubo
   *      checkpoint, y sin checkpoint no hay nada que reanudar.
   *   3. la clave está en el ledger (lo evalúa el llamador).
   *
   * Por qué (1) y (2) juntas: `conCheckpoint()` persiste el `pendiente` ANTES
   * de invocar la operación, así que en el momento en que corre esta función
   * hay un `pendiente` vivo también en el primer intento. (2) sola devolvería
   * `true` siempre. Y (1) sola confiaría en un booleano del llamador.
   */
  function esReanudacionReal(p, op) {
    if (!p || p.reanudada !== true) return false;
    if (typeof p.idempotencyKey !== 'string' || !p.idempotencyKey) return false;
    // El coordinador se asigna abajo; estas funciones sólo corren a través de
    // él, así que para cuando se invocan ya está cableado.
    if (!coordinador || typeof coordinador.readState !== 'function') return false;
    let st;
    try { st = coordinador.readState(p.host); } catch { return false; }
    const pend = st && st.pendiente;
    if (!pend || typeof pend !== 'object') return false;
    return pend.op === op && pend.clave === p.idempotencyKey;
  }

  /** Mensaje único del rechazo fail-closed. Explica QUÉ falta y CÓMO se acredita. */
  function explicarFaltaAck(host, op) {
    const frase = CONFIRM[op];
    const extra = op === 'rotate' ? ' --version <etiqueta>' : '';
    logger('[vault-migration] ' + host + ': la etapa "' + op + '" NO se acredito: falta la '
      + 'confirmacion explicita del operador para esta invocacion. '
      + 'Impacto: el host no avanza y el fallback se conserva. '
      + 'Proximo paso: rotar fuera de banda segun docs/runbooks/credential-rotation.md y acreditar con '
      + 'echo "' + frase + '" | node .pipeline/vault-migration-run.js ' + op + ' --host ' + host + extra);
  }

  /**
   * Acredita una rotación hecha fuera de banda.
   *
   * Tres caminos, en este orden:
   *   1. REANUDACIÓN real (ver `esReanudacionReal`) cuya clave ya está en el
   *      ledger ⇒ se devuelve el MISMO resultado: no hubo material nuevo;
   *   2. hay confirmación del operador para esta invocación ⇒ se registra y se
   *      acredita;
   *   3. ninguna de las dos ⇒ `{ok:false}` (el modo del Pulpo, y el modo de
   *      `advance`: ningún comando automático puede acreditar una rotación).
   */
  function rotate(params) {
    const p = params || {};
    if (esReanudacionReal(p, 'rotate')) {
      const previa = ledger.buscar('rotate', p.idempotencyKey);
      if (previa) {
        logger('[vault-migration] ' + normalizarHost(p.host) + ': rotacion ya acreditada con la '
          + 'misma clave; no se emite material nuevo');
        return { ok: true, version: previa.version || undefined, reanudada: true };
      }
    }
    const ack = acreditacion.rotate;
    if (!ack || ack.confirmado !== true) {
      explicarFaltaAck(normalizarHost(p.host), 'rotate');
      return { ok: false };
    }
    const version = typeof ack.version === 'string' ? ack.version.trim() : '';
    if (!VERSION_RE.test(version)) {
      logger('[vault-migration] ERROR: la etiqueta de version de la rotacion es invalida. '
        + 'Impacto: la rotacion NO se acredita y la etapa no avanza. '
        + 'Proximo paso: reintentar con una etiqueta no sensible tipo 2026-08-31-r1');
      return { ok: false };
    }
    const registrado = ledger.registrar({
      ts: new Date(now()).toISOString(),
      op: 'rotate',
      host: p.host,
      clave: p.idempotencyKey,
      version,
    });
    if (!registrado) return { ok: false };
    return { ok: true, version };
  }

  /** Acredita el provisionamiento en el vault. Mismos tres caminos que `rotate`. */
  function provision(params) {
    const p = params || {};
    if (esReanudacionReal(p, 'provision')) {
      const previa = ledger.buscar('provision', p.idempotencyKey);
      if (previa) {
        logger('[vault-migration] ' + normalizarHost(p.host) + ': provision ya acreditada con la misma clave');
        return { ok: true, reanudada: true };
      }
    }
    const ack = acreditacion.provision;
    if (!ack || ack.confirmado !== true) {
      explicarFaltaAck(normalizarHost(p.host), 'provision');
      return { ok: false };
    }
    const registrado = ledger.registrar({
      ts: new Date(now()).toISOString(),
      op: 'provision',
      host: p.host,
      clave: p.idempotencyKey,
      scopes: Array.isArray(p.scopes) ? p.scopes.length : 0,
    });
    if (!registrado) return { ok: false };
    return { ok: true };
  }

  const metricsFactory = typeof opts.metricsFactory === 'function'
    ? opts.metricsFactory
    // eslint-disable-next-line global-require
    : () => require('./vault-shadow-metrics').getVaultShadowMetrics();

  const coordinador = vaultMigration.createVaultMigration({
    stateDir,
    fs,
    now,
    logger,

    // Denominador DERIVADO del código. No hay lista paralela que mantener.
    listDescriptors: () => ENV_DESCRIPTORS,

    // Política por host, releída del config VIVO en cada llamada: la allowlist
    // y el inventario pueden cambiar durante la ventana, y el corte no puede
    // apoyarse en el veredicto viejo.
    resolveHostPolicy: () => {
      const fresh = cargarConfig(opts.loadConfig, pipelineDir);
      const v = seccionVault(fresh);
      return {
        // El ancla de autorización es vault-only cuando el gate del vault está
        // abierto y la ventana de bootstrap está cerrada (#5451).
        vaultOnly: v.enabled === true && v.bootstrap_fallback === false,
        allowlistSize: operatorGate.resolveOperatorAllowlist(process.env).size,
        requiredScopes: Array.isArray(v.required_scopes) ? v.required_scopes : null,
        sharedSecrets: Array.isArray(v.shared_secrets) ? v.shared_secrets : null,
      };
    },

    rotate,
    provision,

    // El respawn se ACREDITA, no se ejecuta: cada consumidor de larga vida debe
    // tener su `.pid` reescrito después de la rotación y su proceso vivo. Un
    // proceso que se reinicia dentro de su propio tick es el bucle de muerte de
    // 2026-07. Ver `lib/vault-respawn-readiness.js`.
    respawnConsumers: (p) => readiness.verify({ since: (p || {}).rotatedAt }),

    // Parque DECLARADO, releído del config vivo (#5453 rev-4). Un host que
    // figura en `shadow_window.hosts_activos` pero nunca arrancó la migración
    // no tiene archivo de estado; sin esta lista el corte global no lo vería y
    // le retiraría el `bootstrap_fallback` del que todavía vive.
    listDeclaredHosts: () => hostsDeConfig(cargarConfig(opts.loadConfig, pipelineDir)),

    // Mismo evaluador que `/vault-shadow-status` y que el productor de
    // propuesta: una segunda implementación se desincronizaría del criterio que
    // el operador ve en pantalla.
    readCoverage: () => {
      const fresh = cargarConfig(opts.loadConfig, pipelineDir);
      const v = seccionVault(fresh);
      const win = (v.shadow_window && typeof v.shadow_window === 'object') ? v.shadow_window : {};
      const instancia = metricsFactory();
      const evaluacion = instancia.evaluate({
        descriptors: ENV_DESCRIPTORS,
        hostsActivos: win.hosts_activos,
        durationHours: win.duration_hours,
        retentionDays: win.retention_days,
      });
      return Object.assign({}, evaluacion, { rows: instancia.readRows() });
    },

    // El corte NO se automatiza desde acá: sin capability firmada no hay
    // ejecutor. El único escritor es `vault-cut-fallback.js` (#5452), que se
    // invoca por su propia CLI (`vault-cut-breakglass.js`) con confirmación del
    // operador. Se declara para que el coordinador reporte `corte_rechazado` en
    // vez de quedar en un estado ambiguo si alguien lo llama.
    requestCutover: () => ({ ok: false, status: 'precondition-failed' }),

    canPublishEvidence: typeof opts.canPublishEvidence === 'function'
      ? opts.canPublishEvidence : () => false,
    signalNeedsHuman: typeof opts.signalNeedsHuman === 'function'
      ? opts.signalNeedsHuman
      : (evidencia) => logger('[vault-migration] FAIL-CLOSED ('
        + ((evidencia && evidencia.causa) || 'desconocida')
        + '): el fallback se conserva, hace falta un humano'),

    writeAudit,
  });

  return {
    coordinador,
    gate,
    gateAbierto: true,
    hosts,
    stateDir,
    auditPath,
    acreditacionesPath,
    config: cfg,
    ledger,
  };
}

module.exports = {
  CONFIRM,
  createProductionVaultMigration,
  GATE,
  VERSION_RE,
  ACREDITACIONES_FILE,
  AUDIT_FILE,
  evaluarGate,
  hostsDeConfig,
};
