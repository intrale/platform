// =============================================================================
// vault-shadow-metrics.js — núcleo auditable de la ventana sombra del vault
// (#5448 · entrega 1/3 del split de #5427)
// =============================================================================
//
// Qué resuelve
// ------------
// La historia madre (#5427) necesita saber, con evidencia, CUÁNDO se puede
// retirar la vía vieja de resolución de credenciales. El criterio NO puede ser
// "cero fallbacks en 24 h": eso se cumple trivialmente si un host estuvo
// apagado o si un secreto nunca se pidió. El criterio es COBERTURA POSITIVA
// (CA-18): cada descriptor de `ENV_DESCRIPTORS`, en cada host activo, con al
// menos una resolución por `vault`, y cero evidencia negativa, dentro de una
// ventana de reloj que arranca en un t0 persistido.
//
// Este módulo es SÓLO el núcleo: persiste, evalúa y deduplica. No imprime
// reportes (#5449) ni manda avisos (#5450).
//
// Contrato de datos (CA-14/CA-15) — cerrado, no a discreción
// ----------------------------------------------------------
// Una fila JSONL tiene EXACTAMENTE estos campos:
//
//   {"ts":"...","name":"telegram.bot_token","host":"NOTEBOOK-01",
//    "via":"vault","count":7,"first_ts":"...","last_ts":"..."}
//
// Los tres timestamps fechan la RESOLUCIÓN, nunca la escritura: en una fila de
// la vía `vault` (agregada en memoria y volcada al salir el proceso) `ts` vale
// `last_ts`, no el instante del volcado. Fecharla con el volcado haría entrar
// cobertura anterior a t0 en una ventana ya reiniciada — fail-open. La ventana
// se filtra por ese instante efectivo (ver `msEfectivo`).
//
// `name` es el NOMBRE LÓGICO (dot-path del descriptor), nunca la env var ni el
// valor. Están PROHIBIDOS `value`, `prefix`, `suffix`, `len`, `hash`, `sample`
// y cualquier derivado del valor: un hash sobre un espacio de valores chico se
// revierte por fuerza bruta (mismo razonamiento que `credentials.js` aplica al
// ancla de autorización). La API pública de este módulo NUNCA recibe valores de
// secretos: recibe nombres, hosts y vías.
//
// Persistencia ASIMÉTRICA por vía — [H-2 de #5427], no es una optimización
// ----------------------------------------------------------------------------
// Bufferear las dos vías por igual vuelve FAIL-OPEN la evidencia que sostiene
// toda la historia:
//
//   | fila perdida antes del flush | efecto                                    |
//   |------------------------------|-------------------------------------------|
//   | vía `vault`                  | subcuenta cobertura → no cierra → benigno |
//   | vía `file-bootstrap`/`missing`| desaparece la evidencia negativa → "listo
//   |                              | para retirar" → el secreto deja de resolver|
//
// Por eso: `vault` se agrega en memoria y se vuelca con `flush()` best-effort;
// `file-bootstrap` y `missing` se appendean INMEDIATAMENTE. Si ese append
// inmediato falla, se loguea ERROR nombrando el secreto (jamás el valor) y se
// escribe best-effort el sidecar `.integrity` — cuya sola presencia bloquea el
// cierre de la ventana para siempre hasta que un humano lo revise.
//
// Fail-closed (todas las puertas cierran, ninguna abre)
// ----------------------------------------------------
//   - `hosts_activos` ausente, vacío, no-array o con un valor fuera de
//     `^[A-Za-z0-9._-]+$` → `no_verificado` + ERROR que NOMBRA la clave.
//   - sidecar `.integrity` presente → `no_verificado`.
//   - t0 ausente o ilegible → se reinicia desde ahora y esa evaluación NUNCA
//     aprueba.
//   - evidencia negativa dentro de la ventana → `no_cumple`.
//   - un par (secreto, host) sin resolución por vault → `no_cumple`.
//
// Concurrencia
// ------------
// Varios procesos appendean el mismo JSONL. Una fila = un `JSON.stringify` + un
// solo `appendFileSync`. `JSON.stringify` escapa cualquier salto de línea, así
// que una fila nunca se parte en dos: un lector que hace `split('\n')` obtiene
// siempre filas completas y parseables.
//
// La ÚNICA operación que no es append-only es la purga por retención, y por eso
// es fail-closed: escribe a un temporal y sólo reemplaza el JSONL si el archivo
// no cambió de tamaño desde que lo leyó. Ante cualquier duda aborta y no purga
// nada — perder una purga es inocuo, perder una fila negativa es fail-open. Ver
// el comentario de `purgar()`.
//
// Sin red, sin timers, sin Telegram: `loadIntoEnv()` sigue siendo sync (CA-16).
// =============================================================================

'use strict';

const nodeFs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_AUDIT_DIR = path.join(REPO_ROOT, '.pipeline', 'audit');

const JSONL_FILE = 'vault-resolution.jsonl';
const T0_FILE = 'vault-resolution.t0.json';
const DEDUPE_FILE = 'vault-resolution.dedupe.json';
const INTEGRITY_FILE = 'vault-resolution.integrity';

// Vocabulario de vías. Coincide con `SOURCE` de credentials.js a propósito: el
// consumidor (#5449/#5450) no tiene que reinterpretar nada.
const VIA = Object.freeze({
  VAULT: 'vault',
  FILE_BOOTSTRAP: 'file-bootstrap',
  MISSING: 'missing',
});

// Vías que se registran. `env-preexisting`, `canonical`, `legacy` y `empty` NO
// se registran: no son ni evidencia positiva del vault ni evidencia negativa de
// la dicotomía vault/fallback, y meterlas ensuciaría el denominador de CA-18.
const VIAS_REGISTRADAS = Object.freeze([VIA.VAULT, VIA.FILE_BOOTSTRAP, VIA.MISSING]);

// Evidencia NEGATIVA: bloquea el cierre y reinicia la ventana.
const VIAS_NEGATIVAS = Object.freeze([VIA.FILE_BOOTSTRAP, VIA.MISSING]);

// Estados del evaluador. `no_verificado` NUNCA puede confundirse con éxito ni
// con "ausencia inocua de datos" (contrato UX de #5448).
const ESTADO = Object.freeze({
  CUMPLE: 'cumple',
  NO_CUMPLE: 'no_cumple',
  NO_VERIFICADO: 'no_verificado',
});

// [REQ-SEC-13] — `hosts_activos` llega a mensajes y potencialmente a nombres de
// archivo. Se valida ANTES de usarlo y no se derivan paths sin normalizar.
const HOST_RE = /^[A-Za-z0-9._-]+$/;

// Host que se registra cuando `vault.hostId` no es válido. No es un default
// benigno: no puede coincidir con ningún `hosts_activos` válido (el `?` está
// fuera de `HOST_RE`), así que la cobertura de ese boot no cuenta y la ventana
// queda bloqueada — que es exactamente lo que corresponde.
const HOST_DESCONOCIDO = '?desconocido';

const DEFAULTS = Object.freeze({
  duration_hours: 24,
  hosts_activos: Object.freeze([]),
  retention_days: 30,
});

const MS_HORA = 3600000;
const MS_DIA = 86400000;

/** Sólo el nombre/código del error: una excepción cruda puede arrastrar datos. */
function errorSeguro(err) {
  if (!err) return 'error';
  const code = err.code ? String(err.code) : null;
  const name = err.name ? String(err.name) : 'Error';
  return code ? `${name}/${code}` : name;
}

function esTexto(v) {
  return typeof v === 'string' && v.length > 0;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/** Parsea un ISO a ms. Devuelve `null` si no es una fecha usable. */
function msDeIso(v) {
  if (!esTexto(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Instante con el que una fila se ubica DENTRO o FUERA de la ventana.
 *
 * No es `ts` a secas y no es un detalle: la vía `vault` se agrega en memoria y
 * se vuelca al salir el proceso, así que el instante del VOLCADO puede ser
 * horas posterior al de la resolución que la fila documenta. Si la ventana se
 * reinicia en el medio (CA-20 — evidencia negativa mueve t0), fechar la fila
 * con el volcado mete cobertura ANTERIOR a t0 como si fuera posterior: la
 * ventana cierra con `cumple` sin una sola resolución por vault después del
 * reinicio y se habilita retirar el fallback de credenciales. Fail-open exacto
 * que CA-18/CA-20 existen para impedir.
 *
 * Por eso manda `last_ts` (última resolución real agregada en esa fila) y `ts`
 * queda sólo como respaldo para filas viejas escritas antes de este fix, que
 * igual llevaban `last_ts` persistido. `last_ts` y no `first_ts`: alcanza con
 * UNA resolución dentro de la ventana, y la última es la que efectivamente
 * ocurrió en `last_ts`.
 */
function msEfectivo(r) {
  const ms = msDeIso(r && r.last_ts);
  return ms !== null ? ms : msDeIso(r && r.ts);
}

/** Comparación ORDINAL de strings. Nada de `localeCompare`: el orden no puede depender del locale. */
function ordinal(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Conteos de resoluciones por (secreto, host, vía) dentro de la ventana.
 * Ampliación aditiva para CA-17 de #5427, consumida por el reporte de #5449.
 *
 * Vive acá y no en el comando A PROPÓSITO: ubicar una fila dentro de la ventana
 * exige la regla `msEfectivo` (`last_ts || ts`), que es interna y existe para
 * cerrar un fail-open concreto. Reimplementarla del lado del reporte crearía una
 * SEGUNDA fuente de verdad sobre la misma evidencia con la que se decide retirar
 * el fallback de credenciales, y las dos podrían divergir sin que nadie lo note.
 * El comando sólo renderiza lo que sale de esta función.
 *
 * `count` cuenta EVALUACIONES DE PRECEDENCIA agregadas en la fila, no usos del
 * secreto (de ahí la leyenda obligatoria del reporte). Una fila sin `count`
 * usable cuenta 1: documenta al menos una resolución, y descartarla subcontaría
 * evidencia — incluida la negativa.
 *
 * @param {Array<object>} rows filas YA filtradas por la ventana.
 * @returns {Array<{name:string, host:string, via:string, resoluciones:number}>}
 *          ordenado por name, host y vía con comparación ordinal.
 */
function contarResoluciones(rows) {
  const acc = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !esTexto(r.name) || !VIAS_REGISTRADAS.includes(r.via)) continue;
    // `readRows` no valida `host`: una fila vieja o incompleta no puede
    // atribuirse a un host activo, así que cae en el host que ningún
    // `hosts_activos` válido puede igualar.
    const host = esTexto(r.host) ? r.host : HOST_DESCONOCIDO;
    const n = Number(r.count);
    const suma = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
    // Clave INYECTIVA: una interpolacion con separador podria fusionar dos
    // pares distintos si ese separador aparece dentro de un nombre o un host.
    const clave = JSON.stringify([r.name, host, r.via]);
    const prev = acc.get(clave);
    if (prev) prev.resoluciones += suma;
    else acc.set(clave, { name: r.name, host, via: r.via, resoluciones: suma });
  }
  return Array.from(acc.values()).sort((a, b) => (
    ordinal(a.name, b.name) || ordinal(a.host, b.host) || ordinal(a.via, b.via)
  ));
}

/**
 * Normaliza y valida `vault.shadow_window`.
 *
 * @returns {{duration_hours:number, hosts_activos:string[], retention_days:number,
 *            valido:boolean, motivo:string|null}}
 */
function normalizarShadowWindow(raw) {
  const cfg = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};

  const duration = Number(cfg.duration_hours);
  const retention = Number(cfg.retention_days);

  const out = {
    duration_hours: Number.isFinite(duration) && duration > 0 ? duration : DEFAULTS.duration_hours,
    retention_days: Number.isFinite(retention) && retention > 0 ? retention : DEFAULTS.retention_days,
    hosts_activos: [],
    valido: false,
    motivo: null,
  };

  // CA-21 — con la lista vacía la condición "en cada host activo" se cumpliría
  // VACUAMENTE y la ventana cerraría con un solo host, que es justo el modo de
  // falla que CA-18 existe para evitar.
  if (!Array.isArray(cfg.hosts_activos)) {
    out.motivo = 'hosts_activos_no_array';
    return out;
  }
  if (cfg.hosts_activos.length === 0) {
    out.motivo = 'hosts_activos_vacio';
    return out;
  }
  for (const h of cfg.hosts_activos) {
    if (!esTexto(h) || !HOST_RE.test(h)) {
      out.motivo = 'hosts_activos_invalido';
      return out;
    }
  }

  out.hosts_activos = cfg.hosts_activos.slice();
  out.valido = true;
  return out;
}

/**
 * Núcleo de la ventana sombra. Todo inyectable para que los tests no toquen ni
 * el reloj real ni el `.pipeline/audit/` del repo.
 *
 * @param {object} [opts]
 * @param {string}   [opts.auditDir]  raíz de los artefactos (default `.pipeline/audit`).
 * @param {function} [opts.now]       reloj en ms.
 * @param {object}   [opts.fs]        módulo fs inyectable.
 * @param {function} [opts.logger]    logger de una línea.
 * @param {boolean}  [opts.autoFlushOnExit=true] volcar el buffer de `vault` al salir.
 */
function createVaultShadowMetrics(opts = {}) {
  const fs = opts.fs || nodeFs;
  const auditDir = opts.auditDir ? path.resolve(opts.auditDir) : DEFAULT_AUDIT_DIR;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const logger = typeof opts.logger === 'function' ? opts.logger : console.log;
  const notify = typeof opts.notify === 'function' ? opts.notify : null;

  function notifyPrivate(payload) {
    const chatId = process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
    const result = notify ? notify({ ...payload, chat_id: chatId == null ? '' : chatId }) : { ok: false, reason: 'notifier_unavailable' };
    if (!result || result.ok !== true) {
      logger(`[vault-shadow] aviso privado omitido: ${(result && result.reason) || 'notify_failed'}`);
    }
    return result;
  }

  function canNotifyPrivate() {
    const chatId = process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
    const canonical = (value) => {
      if (typeof value !== 'string' || !/^-?[1-9]\d*$/.test(value)) return null;
      const numeric = Number(value);
      return Number.isSafeInteger(numeric) ? String(numeric) : null;
    };
    const destination = !chatId
      ? { ok: false, reason: 'no_operator_chat_id' }
      : (canonical(chatId) ? { ok: true } : { ok: false, reason: 'invalid_operator_chat_id' });
    if (!destination.ok) logger(`[vault-shadow] aviso privado omitido: ${destination.reason}`);
    return destination.ok;
  }

  const jsonlPath = path.join(auditDir, JSONL_FILE);
  const t0Path = path.join(auditDir, T0_FILE);
  const dedupePath = path.join(auditDir, DEDUPE_FILE);
  const integrityPath = path.join(auditDir, INTEGRITY_FILE);

  // Buffer SÓLO de la vía `vault`: `name|host|via` → {count, first_ts, last_ts}.
  const buffer = new Map();
  let exitHookInstalado = false;

  // ---------------------------------------------------------------------------
  // I/O — nada crea directorios hasta que hay algo real que escribir (CA-25).
  // ---------------------------------------------------------------------------

  function asegurarDir() {
    // `recursive: true` es idempotente y no falla si ya existe.
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  }

  /** [REQ-SEC-9] una fila = un stringify + un append. Nunca se parte. */
  function appendFila(row) {
    asegurarDir();
    // [REQ-SEC-10] `mode` sólo aplica al CREAR; en Windows se ignora.
    fs.appendFileSync(jsonlPath, JSON.stringify(row) + '\n', { mode: 0o600 });
  }

  function escribirSidecar(motivo) {
    try {
      asegurarDir();
      // El sidecar tampoco lleva valores: motivo, nombre lógico y timestamp.
      fs.appendFileSync(integrityPath, JSON.stringify({ ts: iso(now()), motivo }) + '\n', { mode: 0o600 });
    } catch (e) {
      // Best-effort a propósito: si ni el sidecar se puede escribir, el ERROR
      // del log es la única señal que queda. No se puede hacer más sin volver
      // async el camino de boot.
      logger(`[vault-shadow] ERROR: no se pudo escribir el sidecar de integridad (${errorSeguro(e)}). `
        + 'Impacto: la ventana sombra puede reportar una cobertura que no es confiable. '
        + `Proximo paso: revisar permisos de ${auditDir}`);
    }
  }

  function hayIntegridadRota() {
    try {
      return fs.existsSync(integrityPath);
    } catch (e) {
      // No poder ni mirar el sidecar es, por definición, no verificable.
      return true;
    }
  }

  function leerJson(p) {
    try {
      if (!fs.existsSync(p)) return null;
      const txt = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(txt);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function escribirJson(p, obj) {
    try {
      asegurarDir();
      fs.writeFileSync(p, JSON.stringify(obj) + '\n', { mode: 0o600 });
      return true;
    } catch (e) {
      logger(`[vault-shadow] WARN: no se pudo persistir ${path.basename(p)} (${errorSeguro(e)}). `
        + 'Impacto: la ventana se reinicia en la proxima evaluacion y no aprueba. '
        + `Proximo paso: revisar permisos de ${auditDir}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // t0 — CA-22
  // ---------------------------------------------------------------------------

  /**
   * Devuelve el t0 vigente. Si falta o es ilegible lo REINICIA desde ahora y
   * marca `reiniciado`, que hace que la evaluación NUNCA apruebe (CA-22c).
   *
   * @returns {{ms:number, iso:string, reiniciado:boolean}}
   */
  function leerT0() {
    const st = leerJson(t0Path);
    const ms = st ? msDeIso(st.t0) : null;
    if (ms !== null) return { ms, iso: st.t0, reiniciado: false };

    // Ausente vs ilegible NO son el mismo problema para quien opera: uno es
    // "la ventana todavía no arrancó", el otro es "hay un archivo corrupto que
    // hay que mirar". Colapsarlos en `t0_ausente` mandaría al operador a buscar
    // al lugar equivocado. `leerJson` devuelve `null` en ambos casos, así que la
    // existencia se consulta aparte.
    let existia = false;
    try { existia = fs.existsSync(t0Path); } catch (e) { existia = true; }

    const ahora = now();
    escribirJson(t0Path, { t0: iso(ahora), motivo: existia ? 't0_ilegible' : 't0_ausente' });
    return { ms: ahora, iso: iso(ahora), reiniciado: true, motivo: existia ? 't0_ilegible' : 't0_ausente' };
  }

  /**
   * Reinicia la ventana (CA-20). `desdeMs` es el instante de la evidencia
   * negativa; el t0 nuevo queda 1 ms DESPUÉS para que esa misma fila quede
   * fuera de la ventana nueva — si no, la ventana no volvería a cerrar jamás.
   */
  function reiniciarVentana(desdeMs, motivo) {
    escribirJson(t0Path, { t0: iso(desdeMs + 1), motivo });
  }

  // ---------------------------------------------------------------------------
  // Dedupe persistido — CA-20 (por nombre) y CA-23 (por ventana)
  // ---------------------------------------------------------------------------
  //
  // [REQ-SEC-14] — su ausencia hace REPETIR el aviso, nunca silenciarlo: si el
  // archivo no se puede leer se responde "sí, avisá".

  function leerDedupe() {
    const st = leerJson(dedupePath);
    return {
      fallback: (st && st.fallback && typeof st.fallback === 'object') ? st.fallback : {},
      cumplimiento_t0: (st && esTexto(st.cumplimiento_t0)) ? st.cumplimiento_t0 : null,
    };
  }

  /** ¿Hay que avisar el fallback de `name`? Marca por NOMBRE, jamás por valor. */
  function shouldNotifyFallback(name) {
    if (!esTexto(name)) return false;
    const st = leerDedupe();
    if (Object.prototype.hasOwnProperty.call(st.fallback, name)) return false;
    st.fallback[name] = iso(now());
    escribirJson(dedupePath, st);
    return true;
  }

  function alreadyNotifiedFallback(name) {
    return esTexto(name) && Object.prototype.hasOwnProperty.call(leerDedupe().fallback, name);
  }

  /**
   * ¿Hay que avisar el cumplimiento de la ventana que arrancó en `t0Iso`?
   * La clave es el t0: una ventana reiniciada re-arma el aviso sola, sin
   * necesidad de limpiar estado a mano.
   */
  function shouldNotifyCumplimiento(t0Iso) {
    if (!esTexto(t0Iso)) return false;
    const st = leerDedupe();
    if (st.cumplimiento_t0 === t0Iso) return false;
    st.cumplimiento_t0 = t0Iso;
    escribirJson(dedupePath, st);
    return true;
  }

  function alreadyNotifiedCumplimiento(t0Iso) {
    return esTexto(t0Iso) && leerDedupe().cumplimiento_t0 === t0Iso;
  }

  // ---------------------------------------------------------------------------
  // record / flush
  // ---------------------------------------------------------------------------

  /** `{TELEGRAM_BOT_TOKEN: 'telegram.bot_token', ...}` desde los descriptores. */
  function indiceEnvALogico(descriptors) {
    const idx = {};
    if (!descriptors || typeof descriptors !== 'object') return idx;
    for (const [dotPath, d] of Object.entries(descriptors)) {
      if (d && esTexto(d.env)) idx[d.env] = dotPath;
    }
    return idx;
  }

  function instalarExitHook() {
    if (exitHookInstalado || opts.autoFlushOnExit === false) return;
    exitHookInstalado = true;
    // `exit` NO mantiene vivo el proceso (a diferencia de un timer) y sólo
    // admite trabajo sync — que es exactamente lo que hace `flush()`.
    try {
      process.on('exit', () => { flush(); });
    } catch (e) {
      exitHookInstalado = false;
    }
  }

  /**
   * Registra el resultado de UNA evaluación de precedencia.
   *
   * NO recibe valores de secretos: recibe el mapa `envVar → vía` que
   * `loadIntoEnv` ya construyó y los descriptores que dan el nombre lógico.
   *
   * @param {object} sources  `result.sources` de `loadIntoEnv` (envVar → vía).
   * @param {object} [meta]
   * @param {string} [meta.hostId]      `vault.hostId`.
   * @param {object} [meta.descriptors] `ENV_DESCRIPTORS`.
   * @returns {{registradas:number, negativas:number, integridad:string}}
   */
  function record(sources, meta = {}) {
    const out = { registradas: 0, negativas: 0, integridad: 'ok' };
    if (!sources || typeof sources !== 'object') return out;

    const idx = indiceEnvALogico(meta.descriptors);
    if (Object.keys(idx).length === 0) return out;

    let host = esTexto(meta.hostId) ? meta.hostId : '';
    if (!HOST_RE.test(host)) {
      if (host) {
        logger('[vault-shadow] WARN: `vault.hostId` no es un identificador valido. '
          + 'Impacto: la cobertura de este boot no se atribuye a ningun host activo y la ventana '
          + 'sombra no puede cerrar. Proximo paso: corregir `vault.hostId` en config.yaml');
      }
      host = HOST_DESCONOCIDO;
    }

    let ultimaNegativaMs = null;

    for (const [envVar, via] of Object.entries(sources)) {
      const name = idx[envVar];
      if (!name) continue;                          // no es uno de los descriptores
      if (!VIAS_REGISTRADAS.includes(via)) continue;

      const ahora = now();
      const ts = iso(ahora);

      if (via === VIA.VAULT) {
        // Volumen real → agregación en memoria, un flush por proceso.
        const clave = `${name}|${host}|${via}`;
        const prev = buffer.get(clave);
        if (prev) {
          prev.count += 1;
          prev.last_ts = ts;
        } else {
          buffer.set(clave, { name, host, via, count: 1, first_ts: ts, last_ts: ts });
        }
        out.registradas += 1;
        instalarExitHook();
        continue;
      }

      // Evidencia NEGATIVA: append inmediato. Perderla es fail-open (H-2).
      const row = { ts, name, host, via, count: 1, first_ts: ts, last_ts: ts };
      try {
        appendFila(row);
        out.registradas += 1;
        out.negativas += 1;
        if (ultimaNegativaMs === null || ahora > ultimaNegativaMs) ultimaNegativaMs = ahora;
        if (canNotifyPrivate() && !alreadyNotifiedFallback(name)) {
          const notification = notifyPrivate({
            level: 'warn',
            component: 'vault-shadow',
            message: `Fallback confirmado: ${name}`,
            context: { secreto: name, host, via, timestamp: ts },
            action: 'La ventana sombra se reinició; el fallback continúa vigente.',
          });
          if (notification && notification.ok === true) shouldNotifyFallback(name);
        }
      } catch (e) {
        out.integridad = ESTADO.NO_VERIFICADO;
        // El mensaje nombra el SECRETO (nombre lógico), nunca el valor.
        logger(`[vault-shadow] ERROR: no se pudo registrar la resolucion por "${via}" del secreto `
          + `"${name}" (${errorSeguro(e)}). Impacto: se perdio evidencia negativa, asi que la ventana `
          + 'sombra queda en `no_verificado` y NO puede aprobarse el retiro del fallback. '
          + `Proximo paso: revisar permisos de ${auditDir} y borrar el sidecar recien cuando se audite`);
        escribirSidecar(`append_fallido:${via}`);
      }
    }

    // CA-20 — la evidencia negativa REINICIA la ventana. Se hace una sola vez
    // por `record`, con el instante de la última negativa.
    if (ultimaNegativaMs !== null) {
      reiniciarVentana(ultimaNegativaMs, 'evidencia_negativa');
    }

    return out;
  }

  /**
   * Vuelca el buffer de la vía `vault`. Best-effort a propósito: perder
   * cobertura positiva sólo puede dejar el gate CERRADO (fail-closed benigno).
   *
   * La fila se sella con el instante de la ÚLTIMA RESOLUCIÓN (`last_ts`), NO
   * con el del volcado: entre una y otro pueden pasar horas y la ventana puede
   * haberse reiniciado en el medio (CA-20). Fechar con el volcado haría contar
   * cobertura previa a t0 como si fuera posterior — fail-open. Ver `msEfectivo`.
   */
  function flush() {
    if (buffer.size === 0) return { escritas: 0, error: null };
    const filas = Array.from(buffer.values());
    let escritas = 0;
    try {
      for (const f of filas) {
        appendFila({
          ts: esTexto(f.last_ts) ? f.last_ts : iso(now()),
          name: f.name,
          host: f.host,
          via: f.via,
          count: f.count,
          first_ts: f.first_ts,
          last_ts: f.last_ts,
        });
        escritas += 1;
      }
      buffer.clear();
      return { escritas, error: null };
    } catch (e) {
      // Se traga con WARN: subcontar cobertura ya es fail-closed.
      logger(`[vault-shadow] WARN: no se pudo volcar la cobertura por vault (${errorSeguro(e)}). `
        + 'Impacto: se subcuenta la cobertura y la ventana sombra tarda mas en cerrar (fail-closed). '
        + `Proximo paso: revisar permisos de ${auditDir}`);
      buffer.clear();
      return { escritas, error: errorSeguro(e) };
    }
  }

  // ---------------------------------------------------------------------------
  // Lectura y retención
  // ---------------------------------------------------------------------------

  /** Filas parseables del JSONL. Una línea rota se descarta, no rompe la lectura. */
  function readRows() {
    let txt;
    try {
      if (!fs.existsSync(jsonlPath)) return [];
      txt = fs.readFileSync(jsonlPath, 'utf8');
    } catch (e) {
      return [];
    }
    const rows = [];
    for (const linea of txt.split('\n')) {
      const l = linea.trim();
      if (!l) continue;
      try {
        const r = JSON.parse(l);
        if (r && typeof r === 'object' && esTexto(r.name) && esTexto(r.via) && msDeIso(r.ts) !== null) {
          rows.push(r);
        }
      } catch (e) { /* fila incompleta o basura: se ignora */ }
    }
    return rows;
  }

  /** Tamaño en bytes del JSONL, o `null` si no se puede determinar. */
  function tamanoJsonl() {
    try {
      return fs.statSync(jsonlPath).size;
    } catch (e) {
      // Inexistente o ilegible: no hay un tamaño con el que comparar. Devolver
      // `null` (y no 0) obliga a ABORTAR la purga en vez de asumir "no cambió".
      return null;
    }
  }

  /**
   * Purga por retención (CA-22d / [REQ-SEC-12]).
   *
   * El límite efectivo NUNCA supera t0: la evidencia de la ventana vigente no
   * se toca, y t0 no se mueve acá bajo ninguna circunstancia.
   *
   * Purga FAIL-CLOSED frente a la concurrencia — no es una precaución teórica
   * --------------------------------------------------------------------------
   * La purga es la única operación del módulo que NO es append-only: lee el
   * JSONL entero y lo reemplaza. Otros procesos appendean ese mismo archivo en
   * cualquier momento (`record()` de un boot concurrente), así que toda fila
   * appendeada ENTRE la lectura y la reescritura desaparecería sin dejar señal:
   * el append original tuvo éxito, así que tampoco se dispara el sidecar
   * `.integrity`. Si la fila perdida es evidencia NEGATIVA, `evaluate()` pasa de
   * `no_cumple`/`evidencia_negativa` a `cumple` y habilita retirar el fallback —
   * exactamente el modo de falla fail-open que [H-2 de #5427] y la asimetría de
   * persistencia por vía existen para evitar.
   *
   * Por eso la purga se hace en dos tiempos y se ABORTA ante la mínima duda:
   *
   *   1. se captura el tamaño del JSONL ANTES de leerlo;
   *   2. las filas conservadas se escriben en un temporal propio del proceso;
   *   3. JUSTO antes del `rename` se relee el tamaño: si cambió (o no se puede
   *      leer), se descarta el temporal y NO se toca el JSONL.
   *
   * La asimetría de costos manda: perder una purga es inocuo (el archivo crece
   * un poco más y se reintenta en la próxima evaluación); perder una fila
   * negativa habilita retirar el fallback de credenciales. El `rename` además
   * elimina la ventana en la que el JSONL quedaba truncado a medio escribir, y
   * el temporal lleva el pid para que dos purgas simultáneas no se pisen (la
   * segunda ve el tamaño ya cambiado por la primera y aborta).
   *
   * Alcance honesto de la guarda: cubre TODA la ventana de trabajo real — leer
   * y parsear el JSONL, filtrar, serializar y escribir el temporal — y deja
   * fuera sólo los dos syscalls adyacentes `statSync`/`renameSync`, entre los
   * que no se ejecuta ni una línea de JS. Cerrar también ese resto exigiría un
   * lock que los appendeadores tendrían que tomar en el camino de boot, lo que
   * agrega un modo de falla (lock huérfano ⇒ boot bloqueado) peor que el que
   * evita. Sin lock y en sync no existe un read-modify-write atómico.
   */
  function purgar({ retentionDays, t0Ms }) {
    const dias = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : DEFAULTS.retention_days;
    const limitePorRetencion = now() - dias * MS_DIA;
    const limite = Math.min(limitePorRetencion, t0Ms);

    // ANTES de leer: cualquier append posterior a esta marca cambia el tamaño.
    const tamanoAntes = tamanoJsonl();

    const rows = readRows();
    // Acá se filtra por `ts` y no por el instante efectivo a propósito: `ts` es
    // siempre >= `last_ts` (son iguales salvo en filas viejas, donde `ts` era el
    // volcado), así que purgar por `ts` conserva TODO lo que `evaluate` podría
    // llegar a contar. Al revés se podría borrar una fila que sigue siendo
    // cobertura vigente. Ante la duda, se conserva.
    const conservadas = rows.filter((r) => msDeIso(r.ts) >= limite);
    if (conservadas.length === rows.length) return { purgadas: 0 };

    const tmpPath = `${jsonlPath}.${process.pid}.tmp`;
    try {
      asegurarDir();
      const txt = conservadas.map((r) => JSON.stringify(r)).join('\n') + (conservadas.length ? '\n' : '');
      fs.writeFileSync(tmpPath, txt, { mode: 0o600 });

      // Última comprobación, pegada al `rename`: nada puede ejecutarse entre
      // esta guarda y el reemplazo del archivo.
      const tamanoDespues = tamanoJsonl();
      if (tamanoAntes === null || tamanoDespues === null || tamanoDespues !== tamanoAntes) {
        borrarTmp(tmpPath);
        logger('[vault-shadow] WARN: se aborto la purga del registro de la ventana sombra porque otro '
          + 'proceso escribio el archivo mientras se purgaba. '
          + 'Impacto: ninguno sobre la evaluacion; el archivo crece un poco mas y se reintenta en la '
          + 'proxima evaluacion. Proximo paso: ninguno, es el comportamiento esperado');
        return { purgadas: 0, abortada: 'archivo_modificado' };
      }

      fs.renameSync(tmpPath, jsonlPath);
      return { purgadas: rows.length - conservadas.length };
    } catch (e) {
      borrarTmp(tmpPath);
      logger(`[vault-shadow] WARN: no se pudo purgar el registro de la ventana sombra (${errorSeguro(e)}). `
        + 'Impacto: el archivo crece mas de lo previsto; la evaluacion no se altera. '
        + `Proximo paso: revisar permisos de ${auditDir}`);
      return { purgadas: 0, error: errorSeguro(e) };
    }
  }

  /** Borra el temporal de la purga. Best-effort: su presencia no afecta a nadie. */
  function borrarTmp(tmpPath) {
    try {
      if (typeof fs.unlinkSync === 'function') fs.unlinkSync(tmpPath);
    } catch (e) { /* no existía o no se puede borrar: nadie lo lee */ }
  }

  // ---------------------------------------------------------------------------
  // evaluate — CA-18 / CA-21 / CA-22
  // ---------------------------------------------------------------------------

  /**
   * Evalúa el criterio de salida de la ventana sombra.
   *
   * @param {object} params
   * @param {object}   params.descriptors    `ENV_DESCRIPTORS` (denominador de secretos).
   * @param {string[]} params.hostsActivos   `vault.shadow_window.hosts_activos`.
   * @param {number}   [params.durationHours]
   * @param {number}   [params.retentionDays]
   * @returns {{estado:string, motivo:string, t0:string|null, ventana_horas:number,
   *            horas_transcurridas:number, secretos:number, hosts:string[],
   *            no_verificados:Array<{name:string,host:string}>,
   *            negativos:Array<{name:string,host:string,via:string,ts:string}>,
   *            conteos:Array<{name:string,host:string,via:string,resoluciones:number}>,
   *            error:string|null}}
   */
  function evaluate(params = {}) {
    const cfg = normalizarShadowWindow({
      duration_hours: params.durationHours,
      retention_days: params.retentionDays,
      hosts_activos: params.hostsActivos,
    });

    const base = {
      estado: ESTADO.NO_VERIFICADO,
      motivo: '',
      t0: null,
      ventana_horas: cfg.duration_hours,
      horas_transcurridas: 0,
      secretos: 0,
      hosts: cfg.hosts_activos,
      no_verificados: [],
      negativos: [],
      // Ampliación aditiva para CA-17 de #5427 (reporte de #5449). Arranca
      // vacío para que TODA salida temprana lo traiga presente y tipado: un
      // consumidor nunca tiene que distinguir "sin conteos" de "campo ausente".
      conteos: [],
      error: null,
    };

    // 1 · CA-21 — hosts inválidos: fail-closed y ERROR que NOMBRA la clave, con
    // el mismo formato `Impacto: … Proximo paso: …` del resto del módulo.
    if (!cfg.valido) {
      const detalle = {
        hosts_activos_no_array: 'no es una lista',
        hosts_activos_vacio: 'esta vacia',
        hosts_activos_invalido: 'tiene un valor que no es un identificador de host valido',
      }[cfg.motivo] || 'es invalida';
      base.motivo = cfg.motivo;
      base.error = `\`vault.shadow_window.hosts_activos\` ${detalle}`;
      logger(`[vault-shadow] ERROR: \`vault.shadow_window.hosts_activos\` ${detalle}. `
        + 'Impacto: la cobertura por host se cumpliria vacuamente, asi que la ventana sombra queda en '
        + '`no_verificado` y NO habilita retirar el fallback. '
        + 'Proximo paso: enumerar en config.yaml los hosts que realmente bootean el pipeline');
      return base;
    }

    // 2 · denominador de secretos DERIVADO — nunca una lista a mano.
    const nombres = (params.descriptors && typeof params.descriptors === 'object')
      ? Object.keys(params.descriptors) : [];
    base.secretos = nombres.length;
    if (nombres.length === 0) {
      base.motivo = 'descriptores_ausentes';
      base.error = 'no se pudo derivar el denominador de secretos de `ENV_DESCRIPTORS`';
      return base;
    }

    // 3 · sidecar de integridad: su sola presencia bloquea, siempre.
    if (hayIntegridadRota()) {
      base.motivo = 'integridad_comprometida';
      base.error = 'existe el sidecar de integridad: se perdio evidencia negativa';
      return base;
    }

    // 4 · t0. Ausente o ilegible ⇒ se reinicia y esta evaluación NO aprueba.
    const t0 = leerT0();
    base.t0 = t0.iso;
    if (t0.reiniciado) {
      base.motivo = 't0_reiniciado';
      base.error = t0.motivo === 't0_ilegible'
        ? 'el archivo de inicio de ventana existe pero no se puede leer: la ventana arranca de nuevo'
        : 'no habia inicio de ventana persistido: la ventana arranca ahora';
      return base;
    }

    // 5 · retención — nunca borra dentro de la ventana vigente ni mueve t0.
    purgar({ retentionDays: cfg.retention_days, t0Ms: t0.ms });

    // 6 · sólo cuenta lo que pasó DESDE t0. Se filtra por el instante EFECTIVO
    // (la resolución, no el volcado): una fila `vault` bufferada antes de que la
    // evidencia negativa reiniciara la ventana queda AFUERA aunque se haya
    // escrito después. Vale también para las filas viejas, que ya persistían
    // `last_ts` aunque ningún consumidor lo leyera.
    const rows = readRows().filter((r) => msEfectivo(r) >= t0.ms);
    base.horas_transcurridas = Math.max(0, (now() - t0.ms) / MS_HORA);

    // Conteos sobre ESAS filas (las de la ventana), no sobre el archivo entero:
    // el reporte no puede volver a filtrar por su cuenta sin duplicar la regla.
    base.conteos = contarResoluciones(rows);

    // 7 · evidencia negativa dentro de la ventana.
    base.negativos = rows
      .filter((r) => VIAS_NEGATIVAS.includes(r.via))
      .map((r) => ({ name: r.name, host: r.host, via: r.via, ts: r.ts }));

    // 8 · cobertura positiva: cada secreto × cada host activo con ≥1 `vault`.
    const cubierto = new Set();
    for (const r of rows) {
      if (r.via === VIA.VAULT && Number(r.count) > 0) cubierto.add(`${r.name}|${r.host}`);
    }
    for (const name of nombres) {
      for (const host of cfg.hosts_activos) {
        if (!cubierto.has(`${name}|${host}`)) base.no_verificados.push({ name, host });
      }
    }

    if (base.negativos.length > 0) {
      base.estado = ESTADO.NO_CUMPLE;
      base.motivo = 'evidencia_negativa';
      return base;
    }
    if (base.no_verificados.length > 0) {
      base.estado = ESTADO.NO_CUMPLE;
      base.motivo = 'cobertura_incompleta';
      return base;
    }
    if (base.horas_transcurridas < cfg.duration_hours) {
      base.estado = ESTADO.NO_CUMPLE;
      base.motivo = 'ventana_en_curso';
      return base;
    }

    base.estado = ESTADO.CUMPLE;
    base.motivo = 'cobertura_completa';
    if (canNotifyPrivate() && !alreadyNotifiedCumplimiento(base.t0)) {
      const notification = notifyPrivate({
        level: 'info',
        component: 'vault-shadow',
        message: 'Ventana sombra cumplida',
        context: {
          secretos: base.secretos,
          hosts: base.hosts.length,
          ventana_horas: base.ventana_horas,
          timestamp: iso(now()),
        },
        action: 'La cobertura requerida está completa y sin fallbacks en la ventana vigente.',
      });
      if (notification && notification.ok === true) shouldNotifyCumplimiento(base.t0);
    }
    return base;
  }

  return {
    record,
    flush,
    evaluate,
    // Superficie chica extra que consumen #5449 (lectura) y #5450 (avisos).
    readRows,
    shouldNotifyFallback,
    shouldNotifyCumplimiento,
    paths: Object.freeze({
      auditDir, jsonl: jsonlPath, t0: t0Path, dedupe: dedupePath, integrity: integrityPath,
    }),
  };
}

// -----------------------------------------------------------------------------
// Singleton del proceso — el hook de `loadIntoEnv` agrega por proceso, no por
// invocación (`loadIntoEnv` se llama POR LANZAMIENTO DE AGENTE, no sólo al boot).
// Crearlo NO toca el filesystem: recién el primer `record` con datos crea el dir.
// -----------------------------------------------------------------------------
let _instancia = null;

function getVaultShadowMetrics(opts) {
  if (!_instancia) _instancia = createVaultShadowMetrics(opts || {});
  return _instancia;
}

/** Invalidación explícita. Exportada SÓLO para los tests. */
function _resetVaultShadowMetrics() {
  _instancia = null;
}

module.exports = {
  createVaultShadowMetrics,
  getVaultShadowMetrics,
  normalizarShadowWindow,
  VIA,
  VIAS_REGISTRADAS,
  VIAS_NEGATIVAS,
  ESTADO,
  HOST_RE,
  DEFAULTS,
  _resetVaultShadowMetrics,
};
