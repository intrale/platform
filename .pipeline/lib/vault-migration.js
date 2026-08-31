// =============================================================================
// vault-migration.js — coordinador determinístico de la migración al vault
// (#5453 · entrega 3/3 del split de #5428)
// =============================================================================
//
// Qué resuelve
// ------------
// #5451 dejó la frontera vault-only y #5452 el ejecutor operacional del corte.
// Falta lo del medio: LLEVAR cada host desde "resuelve por archivo" hasta
// "resuelve por vault, con evidencia", y recién entonces proponer el corte.
//
// Este módulo es ese recorrido, y NADA más:
//
//   preflight → rotated → provisioned → respawned → coexisting
//             → cutover-ready → verified
//
// Lo que este módulo NO hace, a propósito:
//
//   - NO escribe `vault.bootstrap_fallback`. El único escritor del corte es
//     `vault-cut-fallback.js` (#5452), que tiene su propio lock, su relectura
//     dentro del lock, su journal de auditoría recuperable y su idempotencia
//     `already-cut`. Duplicar cualquiera de esas piezas acá sería una segunda
//     implementación del gate irreversible: dos escritores del mismo estado.
//   - NO mueve work-files (`pendiente/`, `trabajando/`, `listo/`, `procesado/`,
//     `waiting-operator/`). El lifecycle es del Pulpo.
//   - NO lee valores de secretos. Recibe NOMBRES LÓGICOS, hosts, vías y
//     conteos. La API pública no tiene un solo parámetro que pueda transportar
//     material sensible.
//   - NO habla con AWS, Telegram ni Drive. Todo eso entra por dependencias
//     inyectadas, que es lo que hace al coordinador determinístico y testeable
//     sin red.
//
// Por qué el orden es ESTRICTO (rotar antes de provisionar)
// ---------------------------------------------------------
// Provisionar primero y rotar después deja el vault con material ya revocado:
// el host resolvería por vault, la evidencia diría `source: vault`, la cobertura
// cerraría en verde y el secreto NO funcionaría. La cobertura positiva mide
// PROCEDENCIA, no validez, así que no puede atrapar ese caso. Por eso el orden
// se valida en cada transición y no se puede saltear: `provision()` sobre un
// host que todavía no rotó no llama al provisionador, devuelve
// `etapa_fuera_de_orden`.
//
// Idempotencia y crash entre etapas
// ---------------------------------
// El modo de falla caro es rotar DOS VECES: la segunda rotación invalida el
// material que la primera acaba de dejar en el vault. Por eso el checkpoint se
// escribe ANTES de llamar al dependiente, con una clave de idempotencia no
// sensible derivada del host + operación + intento:
//
//   1. persistir `pendiente: {op, clave}` (temporal + rename atómico)
//   2. llamar a `rotate({host, idempotencyKey})`
//   3. persistir `stage` + limpiar `pendiente`
//
// Si el proceso muere entre 2 y 3, la reanudación encuentra el checkpoint y
// vuelve a llamar con LA MISMA CLAVE — nunca con una nueva. El contrato del
// dependiente es que una clave repetida no emite material nuevo. Y una vez que
// `stage >= rotated`, `rotate()` ya no llama a nadie: devuelve el estado.
//
// Cobertura: la regla vive acá, en un solo lugar
// -----------------------------------------------
// La cobertura se expresa como matriz `descriptor lógico × host lógico`. Una
// celda cuenta SÓLO si hay al menos una resolución con `via: vault` ocurrida
// DESPUÉS del último respawn de esa ventana. El filtro por respawn no es
// cosmético: un proceso vivo conserva en memoria el material anterior, así que
// una resolución previa al respawn no prueba nada sobre el estado actual.
//
// Todo lo demás es `not-ready`, sin excepciones:
//
//   | condición                                   | causa                       |
//   |---------------------------------------------|-----------------------------|
//   | host sin ninguna fila en la ventana         | host_silencioso             |
//   | fila con vía ≠ `vault` en la ventana        | fuente_legacy               |
//   | algún descriptor sin celda cubierta         | cobertura_incompleta        |
//   | sólo hay cobertura ANTERIOR al respawn      | cobertura_previa_al_respawn |
//   | allowlist del host vacía                    | allowlist_vacia             |
//   | inventario divergente de código/config      | inventario_*                |
//   | evaluador global en `no_verificado`         | estado_indeterminado        |
//
// "Cero errores" NUNCA es éxito: sin lecturas positivas la celda no está
// cubierta y la ventana no cierra. Ese es el fail-open que #5427 documenta y
// que este módulo hereda.
//
// Evidencia: modelo CERRADO
// -------------------------
// La evidencia sale por `writeAudit`, Telegram y potencialmente un PDF. Por eso
// no se serializa un objeto libre: `sanitizeEvidence()` conserva SÓLO las claves
// del vocabulario y sólo si el valor respeta su forma (entero, ISO, slug corto,
// enum). Cualquier otra clave se descarta, y un valor con pinta de secreto
// (`redactSecretValue`) se reemplaza por el marcador. Es una lista blanca, no
// una lista negra: un campo nuevo que alguien agregue río arriba no viaja hasta
// que se declare acá.
// =============================================================================

'use strict';

const nodeFs = require('fs');
const path = require('path');

const { redactSecretValue, REDACTION_MARKER } = require('./redact');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_STATE_DIR = path.join(REPO_ROOT, '.pipeline', 'state', 'vault-migration');

const STATE_VERSION = 1;

/** Etapas, EN ORDEN. El índice es el que valida cada transición. */
const STAGES = Object.freeze([
  'preflight', 'rotated', 'provisioned', 'respawned',
  'coexisting', 'cutover-ready', 'verified',
]);

const STAGE = Object.freeze({
  PREFLIGHT: 'preflight',
  ROTATED: 'rotated',
  PROVISIONED: 'provisioned',
  RESPAWNED: 'respawned',
  COEXISTING: 'coexisting',
  CUTOVER_READY: 'cutover-ready',
  VERIFIED: 'verified',
});

/** Vocabulario CERRADO de causas. Nada de texto libre en el campo que rutea. */
const CAUSA = Object.freeze({
  ANCLA_NO_VAULT_ONLY: 'ancla_no_vault_only',
  ALLOWLIST_VACIA: 'allowlist_vacia',
  DESCRIPTORES_AUSENTES: 'descriptores_ausentes',
  INVENTARIO_INCOMPLETO: 'inventario_incompleto',
  INVENTARIO_DIVERGENTE: 'inventario_divergente',
  POLITICA_INDETERMINADA: 'politica_indeterminada',
  HOST_INVALIDO: 'host_invalido',
  ETAPA_FUERA_DE_ORDEN: 'etapa_fuera_de_orden',
  ROTACION_FALLIDA: 'rotacion_fallida',
  PROVISION_FALLIDA: 'provision_fallida',
  RESPAWN_INCOMPLETO: 'respawn_incompleto',
  ESTADO_INDETERMINADO: 'estado_indeterminado',
  EVIDENCIA_CORRUPTA: 'evidencia_corrupta',
  FUENTE_LEGACY: 'fuente_legacy',
  HOST_SILENCIOSO: 'host_silencioso',
  COBERTURA_INCOMPLETA: 'cobertura_incompleta',
  COBERTURA_PREVIA_AL_RESPAWN: 'cobertura_previa_al_respawn',
  EVIDENCIA_NO_PUBLICABLE: 'evidencia_no_publicable',
  HOSTS_AUSENTES: 'hosts_ausentes',
  HOST_NO_LISTO: 'host_no_listo',
  CORTE_YA_DELEGADO: 'corte_ya_delegado',
  CORTE_RECHAZADO: 'corte_rechazado',
  PERSISTENCIA_FALLIDA: 'persistencia_fallida',
});

/** Igual que `vault-shadow-metrics.HOST_RE`: el host viaja a mensajes y a paths. */
const HOST_RE = /^[A-Za-z0-9._-]+$/;
const SLUG_RE = /^[A-Za-z0-9._:@-]{1,64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Vía que acredita procedencia. Cualquier otra es evidencia NEGATIVA. */
const VIA_POSITIVA = 'vault';

/** Derivados del valor que una fila de evidencia NUNCA puede traer. */
const CAMPOS_PROHIBIDOS = Object.freeze([
  'value', 'valor', 'secret', 'secreto', 'hash', 'prefix', 'suffix', 'len', 'sample', 'token',
]);

/**
 * Campos que la evidencia PUEDE llevar, con la forma que se les exige. Es una
 * lista blanca: lo que no está acá no sale del proceso.
 */
const EVIDENCIA_CAMPOS = Object.freeze({
  event: 'slug',
  host: 'host',
  stage: 'stage',
  causa: 'causa',
  ok: 'bool',
  ts: 'iso',
  descriptores: 'int',
  scopes: 'int',
  compartidos: 'int',
  cubiertos: 'int',
  pendientes: 'int',
  negativos: 'int',
  resoluciones: 'int',
  allowlist: 'int',
  consumidores: 'int',
  hosts: 'int',
  hosts_listos: 'int',
  rotacion_version: 'slug',
  rotacion_ts: 'iso',
  respawn_ts: 'iso',
  intento: 'int',
  source: 'via',
});

// -----------------------------------------------------------------------------
// Sanitización de evidencia
// -----------------------------------------------------------------------------

function esEntero(v) { return Number.isInteger(v) && v >= 0 && v <= 1e6; }
function esTexto(v) { return typeof v === 'string' && v.length > 0; }

/**
 * Valida un valor contra la forma declarada. Devuelve el valor NORMALIZADO o
 * `undefined` si no cumple — nunca "algo parecido": una forma inesperada se
 * descarta, no se recorta, porque recortar es exactamente cómo se filtra un
 * prefijo de secreto.
 */
function normalizarCampo(forma, valor) {
  switch (forma) {
    case 'bool': return typeof valor === 'boolean' ? valor : undefined;
    case 'int': return esEntero(valor) ? valor : undefined;
    case 'iso': return esTexto(valor) && ISO_RE.test(valor) ? valor : undefined;
    case 'host': return esTexto(valor) && valor.length <= 64 && HOST_RE.test(valor) ? valor : undefined;
    case 'stage': return STAGES.includes(valor) ? valor : undefined;
    case 'causa': return Object.values(CAUSA).includes(valor) ? valor : undefined;
    case 'via': return esTexto(valor) && SLUG_RE.test(valor) ? valor : undefined;
    case 'slug': {
      if (!esTexto(valor) || !SLUG_RE.test(valor)) return undefined;
      // Última barrera: `rotacion_version` la produce un dependiente que este
      // módulo no controla. Si tiene pinta de material, no viaja.
      const redactado = redactSecretValue(valor);
      return redactado === valor ? valor : REDACTION_MARKER;
    }
    default: return undefined;
  }
}

/**
 * Modelo CERRADO de evidencia. Sólo nombres lógicos, conteos, timestamps y
 * enums. Sin paths, sin IDs de infraestructura, sin valores.
 */
function sanitizeEvidence(evidencia) {
  const out = {};
  if (!evidencia || typeof evidencia !== 'object' || Array.isArray(evidencia)) return out;
  for (const [clave, forma] of Object.entries(EVIDENCIA_CAMPOS)) {
    if (!Object.prototype.hasOwnProperty.call(evidencia, clave)) continue;
    const normalizado = normalizarCampo(forma, evidencia[clave]);
    if (normalizado !== undefined) out[clave] = normalizado;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Utilidades de etapa
// -----------------------------------------------------------------------------

function indiceEtapa(stage) { return STAGES.indexOf(stage); }

/** ¿`stage` alcanzó (o pasó) `objetivo`? Un estado inicial (`null`) nunca. */
function alcanzo(stage, objetivo) {
  const a = indiceEtapa(stage);
  const b = indiceEtapa(objetivo);
  return a >= 0 && b >= 0 && a >= b;
}

function iso(ms) { return new Date(ms).toISOString(); }

/** `providers.openai.api_key` → `providers`. Mismo criterio que credentials.js. */
function scopeDe(dotPath) {
  const i = dotPath.indexOf('.');
  return i < 0 ? dotPath : dotPath.slice(0, i);
}

function unicos(lista) { return [...new Set(lista)]; }

function faltantes(esperados, declarados) {
  const set = new Set(declarados);
  return esperados.filter((x) => !set.has(x));
}

// -----------------------------------------------------------------------------
// Coordinador
// -----------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {object}   [deps.fs]                  inyección de filesystem (tests).
 * @param {string}   [deps.stateDir]            dónde persiste el estado por host.
 * @param {Function} [deps.now]                 reloj, `() => ms`.
 * @param {Function} [deps.logger]              `(msg) => void`. Nunca recibe valores.
 * @param {Function} [deps.listDescriptors]     `() => ENV_DESCRIPTORS`.
 * @param {Function} deps.resolveHostPolicy     `(host) => {vaultOnly, allowlistSize,
 *                                               requiredScopes, sharedSecrets}`.
 * @param {Function} deps.rotate                `({host, idempotencyKey, descriptors})
 *                                               => {ok, version}`.
 * @param {Function} deps.provision             `({host, idempotencyKey, scopes}) => {ok}`.
 * @param {Function} deps.respawnConsumers      `({host, rotatedAt}) =>
 *                                               {ok, consumers: string[]}`.
 * @param {Function} deps.readCoverage          `() => {estado, motivo, t0, rows}`.
 * @param {Function} deps.requestCutover        `(snapshot) => {ok, status}` — #5452.
 * @param {Function} [deps.writeAudit]          `(evidenciaSanitizada) => void`.
 * @param {Function} [deps.canPublishEvidence]  `() => boolean` — Drive/Telegram vivos.
 * @param {Function} [deps.signalNeedsHuman]    `(evidenciaSanitizada) => void`.
 */
function createVaultMigration(deps = {}) {
  const fs = deps.fs || nodeFs;
  const stateDir = deps.stateDir ? path.resolve(deps.stateDir) : DEFAULT_STATE_DIR;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};

  const listDescriptors = typeof deps.listDescriptors === 'function'
    ? deps.listDescriptors
    : () => require('./credentials').ENV_DESCRIPTORS;

  // El corte se delega UNA sola vez por proceso, además del candado persistido.
  let corteEnVuelo = false;

  // ---------------------------------------------------------------------------
  // Persistencia — temporal + rename atómico, sólo estado NO sensible
  // ---------------------------------------------------------------------------

  function rutaEstado(host) { return path.join(stateDir, `host-${host}.json`); }
  function rutaCorte() { return path.join(stateDir, 'cutover.json'); }

  function asegurarDir() {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }

  function leerJson(ruta) {
    try {
      const parsed = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    } catch {
      // Ausente o ilegible son el MISMO estado para el coordinador: "no hay
      // checkpoint". Nunca se interpreta como "etapa cumplida".
      return null;
    }
  }

  function escribirJson(ruta, valor) {
    const temp = `${ruta}.${process.pid}.${now()}.tmp`;
    try {
      asegurarDir();
      fs.writeFileSync(temp, `${JSON.stringify(valor, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, ruta);
      return true;
    } catch (e) {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best-effort */ }
      logger('[vault-migration] ERROR: no se pudo persistir el checkpoint '
        + `(${e && e.code ? e.code : 'io'}). `
        + 'Impacto: la etapa NO avanza; la reanudacion reusa la clave de idempotencia. '
        + 'Proximo paso: revisar permisos del directorio de estado del coordinador');
      return false;
    }
  }

  /** Estado por host. Un host ilegible NO contamina a los demás (aislamiento). */
  function readState(host) {
    if (!esTexto(host) || !HOST_RE.test(host)) return null;
    const st = leerJson(rutaEstado(host));
    if (!st || st.host !== host || !Number.isInteger(st.version)) return null;
    if (st.stage !== null && !STAGES.includes(st.stage)) return null;
    return st;
  }

  function estadoInicial(host) {
    return {
      version: STATE_VERSION,
      host,
      stage: null,
      pendiente: null,
      rotacion: null,
      provision: null,
      respawn: null,
      cobertura: null,
      historia: [],
      updated_at: iso(now()),
    };
  }

  function guardarEstado(st, etapa, extra) {
    const siguiente = { ...st, ...(extra || {}) };
    if (etapa) {
      siguiente.stage = etapa;
      siguiente.historia = [...(st.historia || []), { stage: etapa, at: iso(now()) }].slice(-32);
    }
    siguiente.updated_at = iso(now());
    return escribirJson(rutaEstado(st.host), siguiente) ? siguiente : null;
  }

  function listHosts() {
    let entradas = [];
    try { entradas = fs.readdirSync(stateDir); } catch { return []; }
    return entradas
      .filter((f) => typeof f === 'string' && f.startsWith('host-') && f.endsWith('.json'))
      .map((f) => f.slice('host-'.length, -'.json'.length))
      .filter((h) => h.length > 0 && HOST_RE.test(h))
      .sort();
  }

  // ---------------------------------------------------------------------------
  // Auditoría
  // ---------------------------------------------------------------------------

  function auditar(evidencia) {
    const limpia = sanitizeEvidence({ ts: iso(now()), ...evidencia });
    if (typeof deps.writeAudit === 'function') {
      try { deps.writeAudit(limpia); }
      catch (e) {
        logger(`[vault-migration] WARN: la auditoria no se pudo escribir (${e && e.code ? e.code : 'io'})`);
      }
    }
    return limpia;
  }

  function fallo(causa, evidencia) {
    const limpia = auditar({ ok: false, causa, ...evidencia });
    return { ok: false, causa, evidencia: limpia };
  }

  function exito(stage, evidencia) {
    const limpia = auditar({ ok: true, stage, ...evidencia });
    return { ok: true, stage, evidencia: limpia };
  }

  // ---------------------------------------------------------------------------
  // Inventario derivado — nunca una lista paralela
  // ---------------------------------------------------------------------------

  /**
   * Deriva el inventario esperado de `ENV_DESCRIPTORS`. `file-only` queda fuera
   * porque, por contrato de `vaultScopePlan()`, no va al vault.
   */
  function inventarioDerivado() {
    let descriptors;
    try { descriptors = listDescriptors(); }
    catch { descriptors = null; }
    if (!descriptors || typeof descriptors !== 'object') {
      return { nombres: [], scopes: [], compartidos: [] };
    }
    const nombres = Object.keys(descriptors);
    const scopes = [];
    const compartidos = [];
    for (const nombre of nombres) {
      const d = descriptors[nombre] || {};
      if (d.backend === 'file-only') continue;
      const scope = scopeDe(nombre);
      scopes.push(scope);
      if (d.shared === true) compartidos.push(scope);
    }
    return { nombres, scopes: unicos(scopes), compartidos: unicos(compartidos) };
  }

  /**
   * Contrasta el inventario derivado contra la política declarada del host.
   *
   * Fail-closed en las DOS direcciones, y por razones distintas:
   *   - faltante  ⇒ el vault no resolvería ese scope: el host caería al archivo.
   *   - extra     ⇒ la allowlist autoriza más de lo que el código necesita.
   *
   * Y `required_scopes: []` NO es "todo declarado": con la lista vacía la
   * comparación se cumpliría vacuamente. Es `inventario_incompleto`.
   */
  function verificarInventario(politica, inventario) {
    if (inventario.nombres.length === 0) {
      return { ok: false, causa: CAUSA.DESCRIPTORES_AUSENTES };
    }
    const declarados = Array.isArray(politica.requiredScopes) ? politica.requiredScopes : null;
    const compartidos = Array.isArray(politica.sharedSecrets) ? politica.sharedSecrets : null;
    if (declarados === null || compartidos === null) {
      return { ok: false, causa: CAUSA.POLITICA_INDETERMINADA };
    }
    if (declarados.length === 0 && inventario.scopes.length > 0) {
      return { ok: false, causa: CAUSA.INVENTARIO_INCOMPLETO };
    }
    if (faltantes(inventario.scopes, declarados).length > 0) {
      return { ok: false, causa: CAUSA.INVENTARIO_INCOMPLETO };
    }
    if (faltantes(declarados, inventario.scopes).length > 0) {
      return { ok: false, causa: CAUSA.INVENTARIO_DIVERGENTE };
    }
    if (inventario.compartidos.length > 0 && compartidos.length === 0) {
      return { ok: false, causa: CAUSA.INVENTARIO_INCOMPLETO };
    }
    if (faltantes(inventario.compartidos, compartidos).length > 0) {
      return { ok: false, causa: CAUSA.INVENTARIO_INCOMPLETO };
    }
    // Un scope declarado como compartido que ningún descriptor comparte saca
    // material del namespace del host sin que el código lo pida: es divergencia.
    if (faltantes(compartidos, inventario.compartidos).length > 0) {
      return { ok: false, causa: CAUSA.INVENTARIO_DIVERGENTE };
    }
    return { ok: true };
  }

  /** Política del host, con la forma validada. Un error del dependiente NO abre. */
  function politicaDe(host) {
    if (typeof deps.resolveHostPolicy !== 'function') return null;
    try {
      const p = deps.resolveHostPolicy(host);
      return (p && typeof p === 'object') ? p : null;
    } catch (e) {
      logger('[vault-migration] ERROR: no se pudo resolver la politica del host '
        + `(${e && e.code ? e.code : 'error'}). `
        + 'Impacto: el preflight queda fail-closed y la ventana no arranca. '
        + 'Proximo paso: revisar `vault.required_scopes`/`vault.shared_secrets` del host');
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Preflight (CA-22 / CA-25)
  // ---------------------------------------------------------------------------

  /** Verdicto del preflight SIN persistir. Lo reusa la revalidación del corte. */
  function evaluatePreflight(host) {
    if (!esTexto(host) || !HOST_RE.test(host)) return { ok: false, causa: CAUSA.HOST_INVALIDO };

    const politica = politicaDe(host);
    if (!politica) return { ok: false, causa: CAUSA.POLITICA_INDETERMINADA };

    // Ancla vault-only: sólo el booleano `true` exacto. `"true"`, `1` y
    // `undefined` dejan el gate cerrado, igual que `vault.enabled`.
    if (politica.vaultOnly !== true) return { ok: false, causa: CAUSA.ANCLA_NO_VAULT_ONLY };

    const allowlist = politica.allowlistSize;
    if (!Number.isInteger(allowlist) || allowlist < 1) {
      return {
        ok: false,
        causa: CAUSA.ALLOWLIST_VACIA,
        allowlist: esEntero(allowlist) ? allowlist : 0,
      };
    }

    const inventario = inventarioDerivado();
    const verdicto = verificarInventario(politica, inventario);
    if (!verdicto.ok) {
      return {
        ok: false,
        causa: verdicto.causa,
        allowlist,
        descriptores: inventario.nombres.length,
        scopes: inventario.scopes.length,
        compartidos: inventario.compartidos.length,
      };
    }
    return {
      ok: true,
      allowlist,
      inventario,
      descriptores: inventario.nombres.length,
      scopes: inventario.scopes.length,
      compartidos: inventario.compartidos.length,
    };
  }

  function preflight({ host } = {}) {
    const v = evaluatePreflight(host);
    const hostSeguro = normalizarCampo('host', host);
    if (!v.ok) {
      return fallo(v.causa, {
        host: hostSeguro,
        allowlist: v.allowlist,
        descriptores: v.descriptores,
        scopes: v.scopes,
      });
    }
    const st = readState(host) || estadoInicial(host);
    // Reanudación: el preflight vuelve a validar, pero NO retrocede la etapa.
    if (alcanzo(st.stage, STAGE.ROTATED)) {
      return exito(st.stage, {
        host, allowlist: v.allowlist, descriptores: v.descriptores, scopes: v.scopes,
      });
    }
    const guardado = guardarEstado(st, STAGE.PREFLIGHT, {
      preflight: {
        allowlist: v.allowlist,
        descriptores: v.descriptores,
        scopes: v.scopes,
        at: iso(now()),
      },
    });
    if (!guardado) return fallo(CAUSA.PERSISTENCIA_FALLIDA, { host });
    return exito(STAGE.PREFLIGHT, {
      host,
      allowlist: v.allowlist,
      descriptores: v.descriptores,
      scopes: v.scopes,
      compartidos: v.compartidos,
    });
  }

  // ---------------------------------------------------------------------------
  // Checkpoint de idempotencia
  // ---------------------------------------------------------------------------

  /**
   * Clave de idempotencia NO sensible: `<host>:<op>:<intento>`. El intento sólo
   * crece cuando la operación anterior CERRÓ; un crash entre etapas reusa el
   * checkpoint y por lo tanto la misma clave.
   */
  function clavePendiente(st, op) {
    if (st.pendiente && st.pendiente.op === op && esTexto(st.pendiente.clave)) {
      return {
        clave: st.pendiente.clave,
        intento: Number.isInteger(st.pendiente.intento) ? st.pendiente.intento : 1,
        reanudada: true,
      };
    }
    return { clave: `${st.host}:${op}:1`, intento: 1, reanudada: false };
  }

  /**
   * Ejecuta una operación irreversible con checkpoint previo.
   * El checkpoint se persiste ANTES de llamar; si no se puede persistir, NO se
   * llama: sin checkpoint no hay forma de reanudar sin repetir material.
   */
  function conCheckpoint(st, op, ejecutar) {
    const { clave, intento, reanudada } = clavePendiente(st, op);
    let actual = st;
    if (!reanudada) {
      actual = guardarEstado(st, null, { pendiente: { op, clave, intento, at: iso(now()) } });
      if (!actual) return { ok: false, causa: CAUSA.PERSISTENCIA_FALLIDA };
    }
    let resultado;
    try {
      resultado = ejecutar({ idempotencyKey: clave, intento, reanudada });
    } catch (e) {
      logger(`[vault-migration] ERROR: la operacion "${op}" fallo (${e && e.code ? e.code : 'error'}). `
        + 'Impacto: la etapa NO avanza y el checkpoint conserva la clave de idempotencia. '
        + 'Proximo paso: reanudar; se reintenta con la MISMA clave, sin emitir material nuevo');
      return { ok: false, estado: actual, intento, clave };
    }
    return { ok: resultado && resultado.ok === true, resultado, estado: actual, intento, clave };
  }

  // ---------------------------------------------------------------------------
  // rotate → provision → respawn
  // ---------------------------------------------------------------------------

  function rotate({ host } = {}) {
    const hostSeguro = normalizarCampo('host', host);
    const st = readState(host);
    if (!st) return fallo(CAUSA.ETAPA_FUERA_DE_ORDEN, { host: hostSeguro });
    // Idempotente: ya rotado ⇒ NO se vuelve a rotar. Ni una llamada.
    if (alcanzo(st.stage, STAGE.ROTATED)) {
      return exito(st.stage, {
        host, rotacion_version: st.rotacion ? st.rotacion.version : undefined,
      });
    }
    if (st.stage !== STAGE.PREFLIGHT) return fallo(CAUSA.ETAPA_FUERA_DE_ORDEN, { host, stage: st.stage });
    if (typeof deps.rotate !== 'function') return fallo(CAUSA.ROTACION_FALLIDA, { host });

    const inventario = inventarioDerivado();
    const r = conCheckpoint(st, 'rotate', ({ idempotencyKey }) => deps.rotate({
      host, idempotencyKey, descriptors: inventario.nombres, scopes: inventario.scopes,
    }));
    if (r.causa === CAUSA.PERSISTENCIA_FALLIDA) return fallo(CAUSA.PERSISTENCIA_FALLIDA, { host });
    if (!r.ok) return fallo(CAUSA.ROTACION_FALLIDA, { host, intento: r.intento });

    const version = normalizarCampo('slug', r.resultado && r.resultado.version);
    const guardado = guardarEstado(r.estado, STAGE.ROTATED, {
      pendiente: null,
      rotacion: { version: version === undefined ? null : version, at: iso(now()), intento: r.intento },
      // Rotar invalida cualquier cobertura previa: el material cambió.
      cobertura: null,
    });
    if (!guardado) return fallo(CAUSA.PERSISTENCIA_FALLIDA, { host });
    return exito(STAGE.ROTATED, { host, rotacion_version: version, intento: r.intento });
  }

  function provision({ host } = {}) {
    const hostSeguro = normalizarCampo('host', host);
    const st = readState(host);
    if (!st) return fallo(CAUSA.ETAPA_FUERA_DE_ORDEN, { host: hostSeguro });
    if (alcanzo(st.stage, STAGE.PROVISIONED)) return exito(st.stage, { host });
    // Orden ESTRICTO: provisionar sin rotar deja material revocado en el vault.
    if (st.stage !== STAGE.ROTATED) return fallo(CAUSA.ETAPA_FUERA_DE_ORDEN, { host, stage: st.stage });
    if (typeof deps.provision !== 'function') return fallo(CAUSA.PROVISION_FALLIDA, { host });

    const inventario = inventarioDerivado();
    const r = conCheckpoint(st, 'provision', ({ idempotencyKey }) => deps.provision({
      host, idempotencyKey, scopes: inventario.scopes, descriptors: inventario.nombres,
    }));
    if (r.causa === CAUSA.PERSISTENCIA_FALLIDA) return fallo(CAUSA.PERSISTENCIA_FALLIDA, { host });
    if (!r.ok) return fallo(CAUSA.PROVISION_FALLIDA, { host, intento: r.intento });

    const guardado = guardarEstado(r.estado, STAGE.PROVISIONED, {
      pendiente: null,
      provision: { at: iso(now()), scopes: inventario.scopes.length, intento: r.intento },
    });
    if (!guardado) return fallo(CAUSA.PERSISTENCIA_FALLIDA, { host });
    return exito(STAGE.PROVISIONED, { host, scopes: inventario.scopes.length, intento: r.intento });
  }

  /**
   * Respawn de los consumidores de larga vida. Es lo que ABRE la ventana de
   * cobertura: un proceso vivo conserva el material anterior, así que toda
   * resolución previa a este instante queda fuera del denominador.
   */
  function respawn({ host } = {}) {
    const hostSeguro = normalizarCampo('host', host);
    const st = readState(host);
    if (!st) return fallo(CAUSA.ETAPA_FUERA_DE_ORDEN, { host: hostSeguro });
    if (alcanzo(st.stage, STAGE.RESPAWNED) && st.respawn) {
      return exito(st.stage, { host, consumidores: st.respawn.consumidores });
    }
    if (st.stage !== STAGE.PROVISIONED) return fallo(CAUSA.ETAPA_FUERA_DE_ORDEN, { host, stage: st.stage });
    if (typeof deps.respawnConsumers !== 'function') return fallo(CAUSA.RESPAWN_INCOMPLETO, { host });

    let r;
    try {
      // `rotatedAt` es lo que le permite al verificador distinguir "volvió a
      // arrancar" de "nunca se fue": un proceso vivo desde antes de la rotación
      // conserva el material previo en memoria y no acredita nada.
      r = deps.respawnConsumers({ host, rotatedAt: st.rotacion ? st.rotacion.at : null });
    } catch { return fallo(CAUSA.RESPAWN_INCOMPLETO, { host }); }
    if (!r || r.ok !== true || !Array.isArray(r.consumers) || r.consumers.length === 0) {
      return fallo(CAUSA.RESPAWN_INCOMPLETO, {
        host,
        consumidores: (r && Array.isArray(r.consumers)) ? r.consumers.length : 0,
      });
    }

    const at = iso(now());
    const guardado = guardarEstado(st, STAGE.RESPAWNED, {
      pendiente: null,
      respawn: { at, consumidores: r.consumers.length },
      // La ventana de cobertura arranca de cero con cada respawn.
      cobertura: null,
    });
    if (!guardado) return fallo(CAUSA.PERSISTENCIA_FALLIDA, { host });
    return exito(STAGE.RESPAWNED, { host, consumidores: r.consumers.length, respawn_ts: at });
  }

  // ---------------------------------------------------------------------------
  // Cobertura (CA-26) — matriz descriptor × host, posterior al respawn
  // ---------------------------------------------------------------------------

  function filaValida(fila) {
    if (!fila || typeof fila !== 'object') return false;
    if (!esTexto(fila.name) || !esTexto(fila.host) || !esTexto(fila.via)) return false;
    // Una fila de evidencia NUNCA lleva derivados del valor. Si aparece uno, la
    // evidencia entera es sospechosa: se corta, no se filtra el campo.
    for (const prohibido of CAMPOS_PROHIBIDOS) {
      if (Object.prototype.hasOwnProperty.call(fila, prohibido)) return false;
    }
    return true;
  }

  function msEfectivo(fila) {
    const t = Date.parse(fila.last_ts || fila.ts);
    return Number.isFinite(t) ? t : NaN;
  }

  /**
   * Verdicto de cobertura del host, SIN persistir. Se reusa tal cual en la
   * revalidación inmediatamente anterior al corte (mitigación del TOCTOU).
   */
  function evaluateCoverage(host) {
    const st = readState(host);
    if (!st || !alcanzo(st.stage, STAGE.RESPAWNED) || !st.respawn || !esTexto(st.respawn.at)) {
      return { ok: false, causa: CAUSA.ETAPA_FUERA_DE_ORDEN, host };
    }
    // La allowlist y el inventario se REVALIDAN acá: pueden haber cambiado
    // entre el preflight y la ventana, y el corte no puede apoyarse en el
    // verdicto viejo.
    const pre = evaluatePreflight(host);
    if (!pre.ok) return { ok: false, causa: pre.causa, host, allowlist: pre.allowlist };

    if (typeof deps.readCoverage !== 'function') {
      return { ok: false, causa: CAUSA.ESTADO_INDETERMINADO, host };
    }
    let cov;
    try { cov = deps.readCoverage(); }
    catch { return { ok: false, causa: CAUSA.ESTADO_INDETERMINADO, host }; }
    if (!cov || typeof cov !== 'object' || !Array.isArray(cov.rows)) {
      return { ok: false, causa: CAUSA.ESTADO_INDETERMINADO, host };
    }
    // El evaluador global manda sobre la integridad de la evidencia: si él dice
    // `no_verificado` (sidecar de integridad, t0 reiniciado, hosts inválidos),
    // ninguna cuenta local puede sobrescribir ese veredicto.
    if (cov.estado === 'no_verificado') {
      return { ok: false, causa: CAUSA.ESTADO_INDETERMINADO, host };
    }
    if (!cov.rows.every(filaValida)) {
      return { ok: false, causa: CAUSA.EVIDENCIA_CORRUPTA, host };
    }

    const respawnMs = Date.parse(st.respawn.at);
    if (!Number.isFinite(respawnMs)) return { ok: false, causa: CAUSA.ESTADO_INDETERMINADO, host };

    const delHost = cov.rows.filter((r) => r.host === host);
    const enVentana = delHost.filter((r) => {
      const ms = msEfectivo(r);
      return Number.isFinite(ms) && ms >= respawnMs;
    });

    const nombres = pre.inventario.nombres;
    const base = {
      host,
      descriptores: nombres.length,
      allowlist: pre.allowlist,
      respawn_ts: st.respawn.at,
    };

    if (enVentana.length === 0) {
      // Silencioso ≠ sano: sin lecturas positivas la migración no se probó.
      // Se distingue del caso "sólo hay cobertura vieja" porque la remediación
      // es distinta: allá hay que volver a respawnear, acá hay que usar el host.
      const habiaAntes = delHost.some((r) => r.via === VIA_POSITIVA);
      return {
        ...base,
        ok: false,
        causa: habiaAntes ? CAUSA.COBERTURA_PREVIA_AL_RESPAWN : CAUSA.HOST_SILENCIOSO,
        cubiertos: 0,
        pendientes: nombres.length,
        negativos: 0,
        resoluciones: 0,
      };
    }

    const negativos = enVentana.filter((r) => r.via !== VIA_POSITIVA);
    const cubiertos = new Set(
      enVentana
        .filter((r) => r.via === VIA_POSITIVA && Number(r.count) > 0)
        .map((r) => r.name),
    );
    const pendientes = nombres.filter((n) => !cubiertos.has(n));
    const resoluciones = enVentana
      .filter((r) => r.via === VIA_POSITIVA)
      .reduce((acc, r) => acc + (Number.isFinite(Number(r.count)) ? Number(r.count) : 0), 0);

    const detalle = {
      ...base,
      cubiertos: cubiertos.size,
      pendientes: pendientes.length,
      negativos: negativos.length,
      resoluciones,
    };

    // La evidencia negativa gana sobre la positiva: una sola resolución por
    // `file-bootstrap`/`missing`/`env`/legacy prueba que la migración NO cerró.
    if (negativos.length > 0) return { ...detalle, ok: false, causa: CAUSA.FUENTE_LEGACY };
    if (pendientes.length > 0) return { ...detalle, ok: false, causa: CAUSA.COBERTURA_INCOMPLETA };
    if (resoluciones === 0) return { ...detalle, ok: false, causa: CAUSA.COBERTURA_INCOMPLETA };
    return { ...detalle, ok: true };
  }

  /**
   * Persiste el resultado de observar la ventana. Avanza a `coexisting` y, con
   * la matriz completa, a `cutover-ready`. Una caída posterior de la cobertura
   * RETROCEDE a `coexisting`: es la única regresión permitida, y nunca baja de
   * ahí (jamás se des-rota ni se des-provisiona).
   */
  function observeCoverage({ host } = {}) {
    const hostSeguro = normalizarCampo('host', host);
    const st = readState(host);
    if (!st) return fallo(CAUSA.ETAPA_FUERA_DE_ORDEN, { host: hostSeguro });
    if (st.stage === STAGE.VERIFIED) return exito(STAGE.VERIFIED, { host });
    if (!alcanzo(st.stage, STAGE.RESPAWNED)) {
      return fallo(CAUSA.ETAPA_FUERA_DE_ORDEN, { host, stage: st.stage });
    }

    const v = evaluateCoverage(host);
    const evidencia = {
      host,
      descriptores: v.descriptores,
      cubiertos: v.cubiertos,
      pendientes: v.pendientes,
      negativos: v.negativos,
      resoluciones: v.resoluciones,
      allowlist: v.allowlist,
      respawn_ts: v.respawn_ts,
    };
    const cobertura = {
      at: iso(now()),
      cubiertos: v.cubiertos || 0,
      pendientes: v.pendientes || 0,
      negativos: v.negativos || 0,
      resoluciones: v.resoluciones || 0,
      descriptores: v.descriptores || 0,
    };

    if (!v.ok) {
      const guardado = guardarEstado(st, STAGE.COEXISTING, { cobertura, pendiente: null });
      if (!guardado) return fallo(CAUSA.PERSISTENCIA_FALLIDA, { host });
      return fallo(v.causa, evidencia);
    }
    const guardado = guardarEstado(st, STAGE.CUTOVER_READY, { cobertura, pendiente: null });
    if (!guardado) return fallo(CAUSA.PERSISTENCIA_FALLIDA, { host });
    return exito(STAGE.CUTOVER_READY, evidencia);
  }

  // ---------------------------------------------------------------------------
  // Avance por host
  // ---------------------------------------------------------------------------

  /** Ejecuta EXACTAMENTE la transición siguiente del host. */
  function advance({ host } = {}) {
    const st = readState(host);
    const stage = st ? st.stage : null;
    if (stage === null) return preflight({ host });
    switch (stage) {
      case STAGE.PREFLIGHT: return rotate({ host });
      case STAGE.ROTATED: return provision({ host });
      case STAGE.PROVISIONED: return respawn({ host });
      case STAGE.RESPAWNED:
      case STAGE.COEXISTING:
      case STAGE.CUTOVER_READY: return observeCoverage({ host });
      case STAGE.VERIFIED: return exito(STAGE.VERIFIED, { host });
      default: return fallo(CAUSA.ETAPA_FUERA_DE_ORDEN, { host: normalizarCampo('host', host) });
    }
  }

  /**
   * Avanza hasta trabarse o llegar a `cutover-ready`. NO corta: el corte es una
   * decisión operacional separada, con autorización propia.
   */
  function run({ host } = {}) {
    let ultimo = null;
    // Cota DURA: una transición por etapa, más una. Nunca un `while (true)`
    // sobre estado de filesystem — el pipeline no puede quedarse colgado acá.
    for (let i = 0; i <= STAGES.length; i += 1) {
      const antes = readState(host);
      ultimo = advance({ host });
      if (!ultimo.ok) return ultimo;
      const despues = readState(host);
      const sinAvance = antes && despues && antes.stage === despues.stage;
      const terminal = despues
        && (despues.stage === STAGE.CUTOVER_READY || despues.stage === STAGE.VERIFIED);
      if (sinAvance || terminal) return ultimo;
    }
    return ultimo;
  }

  // ---------------------------------------------------------------------------
  // Corte final — se DELEGA, no se ejecuta
  // ---------------------------------------------------------------------------

  function corteState() {
    return leerJson(rutaCorte()) || { status: null, at: null };
  }

  /**
   * Snapshot de elegibilidad. Es SÓLO informativo: el ejecutor de #5452
   * revalida todo por su cuenta dentro de su lock, inmediatamente antes de
   * persistir. Acá se revalida igual para no proponerle un corte que ya sabemos
   * que va a rechazar.
   */
  function coverageSnapshot({ hosts } = {}) {
    const lista = Array.isArray(hosts) && hosts.length ? hosts.filter((h) => esTexto(h) && HOST_RE.test(h)) : listHosts();
    if (!lista.length) {
      return {
        ok: false, causa: CAUSA.HOSTS_AUSENTES, ts: iso(now()),
        hosts: [], hosts_total: 0, hosts_listos: 0, descriptores: 0,
      };
    }
    const detalle = lista.map((host) => {
      const v = evaluateCoverage(host);
      const st = readState(host);
      return {
        host,
        stage: st ? st.stage : null,
        listo: v.ok === true,
        causa: v.ok ? null : v.causa,
        descriptores: v.descriptores || 0,
        cubiertos: v.cubiertos || 0,
        pendientes: v.pendientes === undefined ? null : v.pendientes,
        negativos: v.negativos || 0,
        resoluciones: v.resoluciones || 0,
        allowlist: v.allowlist || 0,
        respawn_ts: v.respawn_ts || null,
        rotacion_version: st && st.rotacion ? st.rotacion.version : null,
      };
    });
    const listos = detalle.filter((d) => d.listo);
    return {
      ok: listos.length === lista.length,
      causa: listos.length === lista.length ? null : CAUSA.HOST_NO_LISTO,
      ts: iso(now()),
      hosts: detalle,
      hosts_total: lista.length,
      hosts_listos: listos.length,
      descriptores: detalle.length ? detalle[0].descriptores : 0,
    };
  }

  /**
   * Propone el corte al ejecutor operacional de #5452. Este módulo NO escribe
   * `bootstrap_fallback`, no arma HMAC, no valida nonce y no persiste el estado
   * del corte en el config: todo eso es de `vault-cut-fallback.js`.
   *
   * @param {object} params
   * @param {string[]} [params.hosts]
   * @param {object}   [params.authorization]  capability ya emitida (#5452).
   */
  async function cutover(params = {}) {
    if (corteEnVuelo) return fallo(CAUSA.CORTE_YA_DELEGADO, {});
    if (corteState().status === 'done') return fallo(CAUSA.CORTE_YA_DELEGADO, {});

    const snapshot = coverageSnapshot({ hosts: params.hosts });
    if (!snapshot.ok) {
      return fallo(snapshot.causa || CAUSA.HOST_NO_LISTO, {
        hosts: snapshot.hosts_total, hosts_listos: snapshot.hosts_listos,
      });
    }

    // Drive/Telegram caídos NO habilitan el corte: sin canal para publicar la
    // evidencia el cierre queda ambiguo, y "ambiguo" nunca es "cortá".
    let puedePublicar = false;
    if (typeof deps.canPublishEvidence === 'function') {
      try { puedePublicar = deps.canPublishEvidence() === true; } catch { puedePublicar = false; }
    }
    if (!puedePublicar) {
      const evidencia = sanitizeEvidence({
        ts: iso(now()),
        event: 'cutover_bloqueado',
        ok: false,
        causa: CAUSA.EVIDENCIA_NO_PUBLICABLE,
        hosts: snapshot.hosts_total,
        hosts_listos: snapshot.hosts_listos,
      });
      if (typeof deps.signalNeedsHuman === 'function') {
        try { deps.signalNeedsHuman(evidencia); }
        catch { /* la señal local ya queda en la auditoría de abajo */ }
      }
      return fallo(CAUSA.EVIDENCIA_NO_PUBLICABLE, {
        hosts: snapshot.hosts_total, hosts_listos: snapshot.hosts_listos,
      });
    }

    if (typeof deps.requestCutover !== 'function') {
      return fallo(CAUSA.CORTE_RECHAZADO, { hosts: snapshot.hosts_total });
    }

    corteEnVuelo = true;
    escribirJson(rutaCorte(), { status: 'requested', at: iso(now()), hosts: snapshot.hosts_total });
    let resultado;
    try {
      resultado = await deps.requestCutover({ snapshot, authorization: params.authorization });
    } catch {
      escribirJson(rutaCorte(), { status: 'rejected', at: iso(now()) });
      return fallo(CAUSA.CORTE_RECHAZADO, { hosts: snapshot.hosts_total });
    } finally {
      corteEnVuelo = false;
    }

    if (!resultado || resultado.ok !== true) {
      escribirJson(rutaCorte(), { status: 'rejected', at: iso(now()) });
      return fallo(CAUSA.CORTE_RECHAZADO, { hosts: snapshot.hosts_total });
    }

    escribirJson(rutaCorte(), { status: 'done', at: iso(now()), hosts: snapshot.hosts_total });
    for (const d of snapshot.hosts) {
      const st = readState(d.host);
      if (st) guardarEstado(st, STAGE.VERIFIED, { pendiente: null });
    }
    return exito(STAGE.VERIFIED, {
      event: 'cutover_delegado',
      hosts: snapshot.hosts_total,
      hosts_listos: snapshot.hosts_listos,
    });
  }

  return {
    STAGES,
    STAGE,
    CAUSA,
    readState,
    listHosts,
    preflight,
    evaluatePreflight,
    rotate,
    provision,
    respawn,
    observeCoverage,
    evaluateCoverage,
    advance,
    run,
    coverageSnapshot,
    cutover,
    corteState,
    paths: Object.freeze({ stateDir }),
  };
}

module.exports = {
  createVaultMigration,
  sanitizeEvidence,
  STAGES,
  STAGE,
  CAUSA,
  HOST_RE,
  EVIDENCIA_CAMPOS,
};
