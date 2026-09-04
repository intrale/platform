#!/usr/bin/env node
// =============================================================================
// connectivity-precheck.js — Pre-check defensivo de conectividad (#2317)
//
// Verifica DNS + TLS contra endpoints críticos antes de lanzar agentes que
// requieren red. Clasifica fallos como 'infra' (no cuentan contra circuit
// breaker del issue) vs 'codigo' (sí cuentan). Retry con backoff exponencial
// + jitter (1s, 2s, 4s, ±20%).
//
// Uso programático:
//   const precheck = require('./connectivity-precheck');
//   const result = await precheck.runPrecheck({ timeoutMs: 5000 });
//   if (!result.ok) { ... }
//
// Uso CLI (smoke test):
//   node connectivity-precheck.js
// =============================================================================

const dns = require('dns').promises;
const tls = require('tls');
const fs = require('fs');
const path = require('path');

// Endpoints chequeados por defecto, agrupados por categoría funcional.
// Cada uno valida al menos DNS + TLS (criterio "handshake TLS contra al menos
// un endpoint por categoría" del issue #2317).
const DEFAULT_ENDPOINTS = [
  { category: 'github',  host: 'api.github.com',                                 tlsPort: 443 },
  { category: 'aws',     host: 's3.us-east-2.amazonaws.com',                     tlsPort: 443 },
  { category: 'backend', host: 'mgnr0htbvd.execute-api.us-east-2.amazonaws.com', tlsPort: 443 },
];

// Códigos de error que clasificamos como INFRA (red/DNS/conectividad).
// El issue #2317 menciona explícitamente ECONNREFUSED, ENOTFOUND, ETIMEDOUT,
// EAI_AGAIN. Agregamos otros comunes en Windows/Linux (EHOSTUNREACH, etc.).
const INFRA_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

// #6745 CA-8 / CA-11 — Los patrones de texto que indican origen infra se
// parten en DOS TIERS con precedencia distinta:
//
//   1. INFRA_MACHINE_TOKENS — literales que una máquina emite y que NO
//      aparecen en la prosa de un agente. Se evalúan sobre el texto CRUDO
//      (truncado): no se enmascaran ni se degradan por señal de código.
//   2. INFRA_PROSE_PATTERNS — lenguaje natural genérico ("timeout", "dns").
//      Se evalúan sobre el texto ENMASCARADO (maskCodeSpans) y pierden contra
//      una señal de código (CA-2).
//
// `INFRA_MESSAGE_PATTERNS` se sigue exportando como la concatenación de ambos
// tiers para no romper consumidores externos (CA-11).

// Tier MÁQUINA — literal puro, cero prosa. NO se enmascara ni se degrada.
const INFRA_MACHINE_TOKENS = [
  /getaddrinfo/i,
  /ENOTFOUND/i,
  /ECONNRESET/i,
  // #2405 CA-1 — JAVA_HOME drift es un problema de entorno (host), no de código.
  // El helper `validate-java-home.js` falla con exit 78. `sysexits(3)` define
  // 78 como EX_CONFIG → clasifica infra. Son códigos de salida, no prosa.
  /\bexit\s+(?:code\s+)?78\b/i,
  /\bEX_CONFIG\b/,
  /FATAL:\s*JAVA_HOME/i,
  // #6495 — El linter sale con exit 2 y este token cuando no puede conseguir
  // una base CONFIABLE contra la cual comparar (fetch de `origin/main` caído).
  // Es una falla de red, no un defecto del entregable: sin esta línea el motivo
  // cae al fallback `codigo` y el pulpo devuelve el issue a `dev` — exactamente
  // el rebote-a-dev-por-timeout que motivó #6495. Se midió que el texto del
  // stderr NO alcanza: sólo "Timed out" matcheaba `/timeout/i`, mientras que
  // "Could not resolve host" y un lock de `.git/FETCH_HEAD.lock` caían en
  // `codigo`. Token de máquina, no lenguaje natural: literal puro, sin
  // quantifiers — cero superficie ReDoS. #6745 CA-8: gana sobre code_signal.
  /LINTER_BASE_UNAVAILABLE/,
];

// Tier PROSA — lenguaje natural. Enmascarable (CA-1) y degradable (CA-2).
const INFRA_PROSE_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /network is unreachable/i,
  /dns/i,
  // #2405 — mensaje de `validate-java-home.js` en castellano. Es una FRASE (no
  // un substring suelto), por eso convive con el enmascarado: `JAVA_HOME` está
  // exento de `IDENT_RE` (ver `IDENT_MASK_EXEMPT`) pero el pattern exige además
  // "invalido" / "no esta en la allowlist" a continuación.
  /JAVA_HOME\s+(?:invalido|no\s+esta\s+en\s+la\s+allowlist)/i,
];

// Compat (CA-11): unión de los dos tiers — mismo contenido que antes de #6745.
const INFRA_MESSAGE_PATTERNS = [...INFRA_MACHINE_TOKENS, ...INFRA_PROSE_PATTERNS];

// #2404 — Patrones de toolchain (JDK/JAVA_HOME/gradle) que también son `infra`.
// Los tenemos separados de INFRA_MESSAGE_PATTERNS por dos razones:
//   1) Auditabilidad: permite testearlos aislados (T14) sin contaminar los
//      tests de red (T1/T2). Recomendación Guru §2.
//   2) Protección contra falsos positivos: si el mensaje de error ES un
//      stacktrace JVM que menciona uno de estos strings (ej. un test que
//      mockea shell y escupe "uname: command not found" adentro de un
//      "at com.intrale..."), NO queremos clasificarlo como infra — eso sería
//      un error de código real que debe contar contra el circuit breaker
//      (Security §5, PO A4). Por eso `classifyError` aplica estos patterns
//      SOLO cuando `hasJvmStacktrace(msg) === false`.
//
// Sin ReDoS — los patterns son literales o `.*` simple sin backtracking
// anidado. Guru §2 + Security §4 lo confirman.
const TOOLCHAIN_INFRA_PATTERNS = [
  /JAVA_HOME is set to an invalid directory/i,
  /JAVA_HOME .* not found/i,
  /uname: command not found/i,
  /Could not find tools\.jar/i,
  /Cannot find a JDK/i,
];

// Heurística para detectar un stacktrace de JVM dentro de un mensaje.
// Busca líneas que empiecen con espacios + `at ` + identificador Java típico.
// Se usa en `classifyError` para NO clasificar como infra un mensaje que
// claramente viene de código JVM aunque contenga literalmente alguno de los
// strings toolchain (falso positivo — el error real es de código).
const JVM_STACKTRACE_RE = /(^|\n)\s+at [a-zA-Z_$][a-zA-Z0-9_$.]*[(\s]/;

/** Devuelve true si el mensaje aparenta contener un stacktrace de JVM. */
function hasJvmStacktrace(msg) {
  if (msg === null || msg === undefined) return false;
  return JVM_STACKTRACE_RE.test(String(msg));
}

// =============================================================================
// #6745 — ENMASCARADO DE SPANS DE CÓDIGO + SEÑALES DE CÓDIGO
//
// INVARIANTE DE ASIMETRÍA (CA-10 / SEC-A) — en criollo: para decir "esto es
// infra" hace falta PRUEBA; para decir "esto es código" alcanza con la duda.
//
// `infra` es la ÚNICA clase de rebote sin cota superior: `rebote-counter.js`
// (~:70-74) la excluye del circuit breaker genérico. Por eso `infra` exige
// EVIDENCIA POSITIVA y `codigo` es el fallback seguro (ése sí tiene cota).
// Ante ambigüedad, motivo vacío, nulo o no clasificable ⇒ `codigo`.
// NUNCA agregar un `return 'infra'` como default.
// =============================================================================

// CA-9 / SEC-4 — ventana única de escaneo. Se trunca ANTES de aplicar cualquier
// regex, así el costo de cualquier pattern queda acotado por construcción.
// `lib/rebote-classifier.js` importa esta misma constante para no tener dos
// ventanas divergentes (split-brain de clasificación, SEC-D).
const MAX_MOTIVO_SCAN_LEN = 8192;

// Regexes de enmascarado. TODAS con clases de caracteres planas y escaneo
// lineal: cero cuantificadores anidados, prohibido el shape `(\w+_)+` y
// prohibida la alternancia ambigua tipo `(?:[A-Z][A-Za-z0-9]*)+` (ésa sí es
// exponencial: cada mayúscula podría abrir un grupo nuevo o ser consumida por
// el grupo previo). En `IDENT_RE` el segundo tramo usa `[a-z0-9]*` justamente
// para que cada mayúscula sea un separador NO ambiguo (SEC-4 / CA-9).
const FENCED_BLOCK_RE = /```[^]*?(?:```|$)/g; // bloque de código, tolera no-cierre
const BACKTICK_SPAN_RE = /`[^`\n]*`?/g; // incluye backtick sin cerrar
// #6745 rev-2 (CA-6) — Extensiones RECONOCIDAS en una referencia
// `archivo.ext:linea`. La lista es CERRADA a propósito.
//
// Antes acá vivía `[a-z]{1,5}` genérico, que también matchea un `host:puerto`
// (`registry.npmjs.org:443`, `api.github.com:443`) — la forma NORMAL de citar
// un endpoint en un error de red. Consecuencia medida sobre HEAD 36a291065:
//
//   "fallo por timeout de red a los 30s"                      -> infra (prose)
//   "timeout de red a los 30s contra registry.npmjs.org:443"  -> codigo (code_signal)
//
// Es decir: la prosa de red que CA-6 enumera como caso a PRESERVAR se degradaba
// a `codigo` apenas el agente citaba el endpoint, y un fallo de infra real
// terminaba ruteado a `dev` consumiendo el circuit breaker de código.
//
// PROHIBIDO agregar `com`, `org`, `net`, `io`, `co`, `dev`, `app`, `ar`, `es`:
// son TLDs y reabren exactamente ese falso positivo.
const CODE_FILE_EXT_ALT = [
  'js', 'cjs', 'mjs', 'ts', 'tsx', 'jsx',
  'kt', 'kts', 'java', 'gradle', 'properties',
  'json', 'yaml', 'yml', 'toml', 'xml',
  'md', 'txt', 'log', 'conf',
  'sh', 'bash', 'py', 'sql', 'css', 'html',
].join('|');

// Detector de referencia `archivo.ext:linea`. Arranca por un literal (`.`) para
// que el motor pueda saltar con búsqueda de primer carácter: lineal de verdad.
// El "head" (el nombre del archivo) se extiende hacia atrás con un walk manual.
// Cero cuantificadores anidados: la alternancia es de literales planos y el
// `\b` posterior impide que `js` matchee dentro de `json` (CA-9 intacto).
const CODE_REF_SOURCE = String.raw`\.(?:${CODE_FILE_EXT_ALT})\b:\d+`;
const PATH_REF_TAIL_RE = new RegExp(CODE_REF_SOURCE, 'gi');
const PATH_REF_HEAD_CHARS = /[A-Za-z0-9_./\\-]/;
const IDENT_RE = /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b|\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g;

// Identificadores que NO se enmascaran: los patterns de prosa/toolchain los
// necesitan literales. `JAVA_HOME` es un literal de máquina disfrazado de
// snake_case — y los patterns que lo usan exigen una FRASE completa
// ("JAVA_HOME invalido", "JAVA_HOME is set to an invalid directory"), no un
// substring suelto, así que no reabre el falso positivo que cierra CA-1.
const IDENT_MASK_EXEMPT = new Set(['JAVA_HOME']);

/** Reemplaza el tramo [from, to) del array por espacios (preserva offsets). */
function blankSpan(arr, from, to) {
  for (let i = from; i < to && i < arr.length; i++) arr[i] = ' ';
}

/**
 * Enmascara spans de código dentro del motivo: bloques cercados por triple
 * backtick, spans entre backticks, referencias `archivo.ext:linea` e
 * identificadores camelCase/snake_case. Los reemplaza por ESPACIOS (no borra
 * texto: preserva offsets y longitud), de modo que un pattern de prosa como
 * `/dns/i` deje de matchear dentro de `resolveDnsCache()` o `LOCK_TIMEOUT_MS`
 * (CA-1).
 *
 * Trunca a `MAX_MOTIVO_SCAN_LEN` ANTES de aplicar la primera regex (CA-9).
 *
 * Mismo shape que el precedente `hasJvmStacktrace` de #2404: vetar/neutralizar
 * el contexto ANTES de aplicar los patrones de prosa, nunca después.
 *
 * @param {string} txt
 * @returns {string} el mismo texto con los spans de código en blanco
 */
function maskCodeSpans(txt) {
  const src = String(txt === null || txt === undefined ? '' : txt).slice(0, MAX_MOTIVO_SCAN_LEN);
  const out = src.split('');

  for (const re of [FENCED_BLOCK_RE, BACKTICK_SPAN_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      blankSpan(out, m.index, m.index + m[0].length);
    }
  }

  PATH_REF_TAIL_RE.lastIndex = 0;
  let pm;
  while ((pm = PATH_REF_TAIL_RE.exec(src)) !== null) {
    let start = pm.index;
    while (start > 0 && PATH_REF_HEAD_CHARS.test(src[start - 1])) start--;
    blankSpan(out, start, pm.index + pm[0].length);
  }

  IDENT_RE.lastIndex = 0;
  let im;
  while ((im = IDENT_RE.exec(src)) !== null) {
    if (im[0].length === 0) { IDENT_RE.lastIndex++; continue; }
    if (IDENT_MASK_EXEMPT.has(im[0])) continue;
    blankSpan(out, im.index, im.index + im[0].length);
  }

  return out.join('');
}

// CA-2 — Señales fuertes de que el motivo es un rechazo de CÓDIGO/ENTREGA.
// Son DESEMPATE: sólo degradan `infra` → `codigo`; nunca eligen fase ni
// saltean un gate. Se evalúan sobre el texto CRUDO truncado (no enmascarado):
// justamente lo que buscan son referencias a código.
// Cero cuantificadores anidados.
const CODE_SIGNAL_PATTERNS = [
  /\bgit\s+status\b/i,
  /\bgit\s+add\b/i,
  /\bsin\s+commitear\b/i,
  /\bno\s+est[aá]\s+commitead[oa]\b/i,
  /\bno\s+fue\s+commitead[oa]\b/i,
  /\bcloses\s+#\d+/i,
  /\bCA-\d+\s+incumplid[oa]\b/i,
  // Referencia a archivo:línea — `resolveDnsCache.js:12`, `pulpo.js:5309`.
  // #6745 rev-2 (CA-6): extensión ANCLADA a la lista cerrada `CODE_FILE_EXT_ALT`.
  // Con `[a-z]{1,5}` genérico esto matcheaba `registry.npmjs.org:443` y degradaba
  // a `codigo` cualquier prosa de red que citara el endpoint.
  new RegExp(CODE_REF_SOURCE, 'i'),
];

/** Trunca a la ventana de escaneo (CA-9). Nunca devuelve null/undefined. */
function truncateForScan(txt) {
  return String(txt === null || txt === undefined ? '' : txt).slice(0, MAX_MOTIVO_SCAN_LEN);
}

/** true si el motivo trae al menos una señal fuerte de rechazo de código. */
function hasCodeSignal(txt) {
  const raw = truncateForScan(txt);
  if (!raw) return false;
  for (const re of CODE_SIGNAL_PATTERNS) {
    if (re.test(raw)) return true;
  }
  return false;
}

/**
 * Núcleo tipado de la clasificación (#6745 — CA-1/CA-2/CA-8/CA-9/CA-10).
 *
 * Precedencia OBLIGATORIA, sin excepciones (CA-8):
 *
 *     errno / machine_token  >  code_signal  >  infra prose  >  codigo
 *
 * (el piso de `security`, que va todavía antes, vive en
 * `lib/rebote-classifier.classifyRebote` — es el único que conoce el skill que
 * emitió el rechazo. Ver CA-7 / SEC-B.)
 *
 * `INFRA_MACHINE_TOKENS` e `INFRA_ERROR_CODES` se evalúan sobre el texto CRUDO
 * truncado; `INFRA_PROSE_PATTERNS` y `TOOLCHAIN_INFRA_PATTERNS`, sobre el texto
 * ENMASCARADO.
 *
 * `accionRequerida` es ORTOGONAL a la clasificación: describe QUÉ pide el
 * motivo, no de dónde vino el fallo. Por eso se calcula igual cuando un
 * machine_token gana la clasificación — ahí lo consume la regla de capacidad de
 * fase de `rebote-destino.js` (CA-3), que puede degradar el DESTINO sin tocar
 * la evidencia de la clasificación.
 *
 * `infra_downgraded_by` es un ENUM CERRADO (CA-10 / SEC-E). Prohibido adjuntar
 * el substring que matcheó, el span de evidencia o cualquier fragmento del
 * motivo: `security` está en `SKILLS_SIN_MOTIVO_PUBLICO` justamente para que el
 * texto de un hallazgo no llegue a una superficie pública. La "evidencia
 * tipada" es un TIPO, nunca una cita.
 *
 * @param {Error|string|{code?: string, message?: string}} err
 * @returns {{
 *   clasificacion: 'infra'|'codigo'|null,
 *   evidencia: 'errno'|'machine_token'|'toolchain'|'prose'|'code_signal'|null,
 *   accionRequerida: 'codigo'|null,
 *   infra_downgraded_by: 'security_floor'|'code_signal'|'phase_capability'|null,
 * }}
 */
function classifyErrorDetailed(err) {
  if (err === null || err === undefined) {
    return {
      clasificacion: null,
      evidencia: null,
      accionRequerida: null,
      infra_downgraded_by: null,
    };
  }

  const esString = typeof err === 'string';
  const raw = truncateForScan(esString ? err : String(err.message || err || ''));

  const codeSignal = hasCodeSignal(raw);
  const accionRequerida = codeSignal ? 'codigo' : null;

  // --- 1. errno (tier máquina, texto crudo) ---------------------------------
  if (esString) {
    const upper = raw.toUpperCase();
    for (const code of INFRA_ERROR_CODES) {
      if (upper.includes(code)) {
        return { clasificacion: 'infra', evidencia: 'errno', accionRequerida, infra_downgraded_by: null };
      }
    }
  } else {
    const code = err.code || err.errno || err.syscall || '';
    if (code && INFRA_ERROR_CODES.has(String(code))) {
      return { clasificacion: 'infra', evidencia: 'errno', accionRequerida, infra_downgraded_by: null };
    }
  }

  // --- 2. machine tokens (tier máquina, texto crudo) -------------------------
  for (const pat of INFRA_MACHINE_TOKENS) {
    if (pat.test(raw)) {
      return { clasificacion: 'infra', evidencia: 'machine_token', accionRequerida, infra_downgraded_by: null };
    }
  }

  // --- 3bis. prosa y toolchain, sobre el texto ENMASCARADO (CA-1) ------------
  const masked = maskCodeSpans(raw);
  let evidenciaProsa = null;
  for (const pat of INFRA_PROSE_PATTERNS) {
    if (pat.test(masked)) { evidenciaProsa = 'prose'; break; }
  }
  if (!evidenciaProsa && !hasJvmStacktrace(raw)) {
    // #2404 — Toolchain: sólo si NO parece un stacktrace JVM.
    for (const pat of TOOLCHAIN_INFRA_PATTERNS) {
      if (pat.test(masked)) { evidenciaProsa = 'toolchain'; break; }
    }
  }

  // --- 3. code_signal gana sobre la prosa infra (CA-2 / CA-8) ----------------
  if (codeSignal) {
    return {
      clasificacion: 'codigo',
      evidencia: 'code_signal',
      accionRequerida,
      // Sólo es un "degradado" si la prosa infra habría ganado sin la señal.
      infra_downgraded_by: evidenciaProsa ? 'code_signal' : null,
    };
  }

  if (evidenciaProsa) {
    return { clasificacion: 'infra', evidencia: evidenciaProsa, accionRequerida, infra_downgraded_by: null };
  }

  // --- 5. fallback seguro (SEC-A): NUNCA 'infra' ----------------------------
  return { clasificacion: 'codigo', evidencia: null, accionRequerida, infra_downgraded_by: null };
}

/**
 * Clasifica un error como 'infra' (red/DNS/conectividad) o 'codigo' (otro).
 * Usado para distinguir fallos que NO deben contar contra el circuit breaker
 * del issue (infra) vs los que sí (codigo).
 *
 * #6745 CA-11 — wrapper de una línea sobre `classifyErrorDetailed`. La firma y
 * el contrato de retorno quedan intactos para los call-sites internos
 * (`shouldRetry` del retry con backoff, `entry.dns.error.classification`, etc.)
 * y para los consumidores externos.
 *
 * @param {Error|string|{code?: string, message?: string}} err
 * @returns {'infra'|'codigo'|null}
 */
function classifyError(err) {
  return classifyErrorDetailed(err).clasificacion;
}

/** Espera `ms` milisegundos. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Aplica ±jitter% al delay base. Default 20%.
 * jittered(1000, 0.2) → entre 800ms y 1200ms.
 */
function jittered(baseMs, jitterPct = 0.2) {
  const delta = baseMs * jitterPct * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(baseMs + delta));
}

/**
 * Ejecuta `fn(attempt)` con retry+backoff exponencial con jitter.
 * Backoff por defecto: 1s, 2s, 4s (baseMs * 2^attempt) con ±20% jitter.
 *
 * @param {(attempt:number)=>Promise<T>} fn
 * @param {object} opts
 * @param {number} opts.maxRetries máximo de intentos (default 3)
 * @param {number} opts.baseMs base para el primer backoff (default 1000)
 * @param {number} opts.jitterPct jitter ± (default 0.2)
 * @param {(err:Error, attempt:number)=>boolean} opts.shouldRetry filtro de reintento
 * @returns {Promise<T>}
 */
async function retryWithBackoff(fn, {
  maxRetries = 3,
  baseMs = 1000,
  jitterPct = 0.2,
  shouldRetry = () => true,
  onRetry = () => {},
} = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries - 1) break;
      if (!shouldRetry(err, attempt)) break;
      const delayBase = baseMs * Math.pow(2, attempt); // 1s, 2s, 4s
      const delayMs = jittered(delayBase, jitterPct);
      try { onRetry(err, attempt, delayMs); } catch {}
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

/**
 * Resuelve DNS del host con timeout explícito.
 *
 * Usa `dns.lookup` (getaddrinfo del OS) en vez de `dns.resolve4` (c-ares).
 * Why: en Windows/entornos donde los DNS servers de Node quedan en 127.0.0.1
 * sin resolver local, c-ares devuelve ECONNREFUSED aunque la red funcione.
 * getaddrinfo respeta la resolución del sistema — misma fuente que curl/nslookup.
 *
 * @param {string} host
 * @param {number} timeoutMs
 * @returns {Promise<string[]>} lista de IPs v4
 */
function resolveDnsWithTimeout(host, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const e = new Error(`DNS timeout resolving ${host} after ${timeoutMs}ms`);
      e.code = 'ETIMEDOUT';
      reject(e);
    }, timeoutMs);

    dns.lookup(host, { all: true, family: 4 })
      .then((entries) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const addrs = (entries || []).map((e) => e.address).filter(Boolean);
        if (addrs.length === 0) {
          const e = new Error(`DNS lookup returned no A records for ${host}`);
          e.code = 'ENOTFOUND';
          reject(e);
          return;
        }
        resolve(addrs);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Realiza handshake TLS contra `host:port` con timeout.
 * Valida certificado (rejectUnauthorized: true).
 *
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<{authorized:boolean, protocol:string|null}>}
 */
function tlsHandshakeWithTimeout(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket = null;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (socket) socket.destroy(); } catch { /* noop */ }
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      const e = new Error(`TLS handshake timeout ${host}:${port} after ${timeoutMs}ms`);
      e.code = 'ETIMEDOUT';
      finish(e);
    }, timeoutMs);

    try {
      socket = tls.connect({
        host,
        port,
        servername: host,
        rejectUnauthorized: true,
        timeout: timeoutMs,
      }, () => {
        finish(null, {
          authorized: !!socket.authorized,
          protocol: socket.getProtocol ? socket.getProtocol() : null,
        });
      });

      socket.on('error', (err) => finish(err));
      socket.on('timeout', () => {
        const e = new Error(`TLS socket timeout ${host}:${port}`);
        e.code = 'ETIMEDOUT';
        finish(e);
      });
    } catch (err) {
      finish(err);
    }
  });
}

/**
 * Ejecuta el pre-check completo contra los endpoints configurados.
 * Cada endpoint tiene reintentos independientes (máximo `maxRetries`).
 *
 * @param {object} opts
 * @param {Array<{category:string,host:string,tlsPort:number|null}>} opts.endpoints
 * @param {number} opts.timeoutMs timeout por llamada (default 5000ms)
 * @param {number} opts.maxRetries reintentos por endpoint (default 3)
 * @param {(evt:object)=>void} opts.onEvent hook opcional para telemetría
 * @returns {Promise<{ok:boolean, results:Array, timestamp:string, durationMs:number}>}
 */
async function runPrecheck({
  endpoints = DEFAULT_ENDPOINTS,
  timeoutMs = 5000,
  maxRetries = 3,
  onEvent = () => {},
} = {}) {
  const timestamp = new Date().toISOString();
  const start = Date.now();
  const results = [];

  for (const ep of endpoints) {
    const entry = {
      category: ep.category,
      host: ep.host,
      tlsPort: ep.tlsPort,
      dns: { ok: false, latencyMs: null, error: null, attempts: 0 },
      tls: ep.tlsPort ? { ok: false, latencyMs: null, error: null, attempts: 0 } : null,
    };

    // --- DNS ---
    const dnsStart = Date.now();
    try {
      await retryWithBackoff(
        async (attempt) => {
          entry.dns.attempts = attempt + 1;
          await resolveDnsWithTimeout(ep.host, timeoutMs);
        },
        {
          maxRetries,
          // Solo reintentar errores clasificados como infra
          shouldRetry: (err) => classifyError(err) === 'infra',
          onRetry: (err, attempt, delayMs) => onEvent({
            type: 'dns-retry', host: ep.host, attempt: attempt + 1, delayMs,
            error: { code: err.code, message: String(err.message || err) },
          }),
        },
      );
      entry.dns.ok = true;
      entry.dns.latencyMs = Date.now() - dnsStart;
    } catch (err) {
      entry.dns.error = {
        code: err.code || err.errno || 'UNKNOWN',
        message: String(err.message || err),
        classification: classifyError(err) || 'codigo',
      };
    }

    // --- TLS (solo si DNS OK y hay puerto configurado) ---
    if (entry.dns.ok && ep.tlsPort) {
      const tlsStart = Date.now();
      try {
        await retryWithBackoff(
          async (attempt) => {
            entry.tls.attempts = attempt + 1;
            await tlsHandshakeWithTimeout(ep.host, ep.tlsPort, timeoutMs);
          },
          {
            maxRetries,
            shouldRetry: (err) => classifyError(err) === 'infra',
            onRetry: (err, attempt, delayMs) => onEvent({
              type: 'tls-retry', host: ep.host, port: ep.tlsPort, attempt: attempt + 1, delayMs,
              error: { code: err.code, message: String(err.message || err) },
            }),
          },
        );
        entry.tls.ok = true;
        entry.tls.latencyMs = Date.now() - tlsStart;
      } catch (err) {
        entry.tls.error = {
          code: err.code || err.errno || 'UNKNOWN',
          message: String(err.message || err),
          classification: classifyError(err) || 'codigo',
        };
      }
    }

    results.push(entry);
  }

  // Pre-check OK = todos los endpoints tienen DNS OK y TLS OK (si aplica)
  const ok = results.every((r) => r.dns.ok && (!r.tlsPort || (r.tls && r.tls.ok)));

  return {
    ok,
    results,
    timestamp,
    durationMs: Date.now() - start,
  };
}

/**
 * Lista los endpoints que fallaron en el pre-check, con categorización.
 * Útil para armar mensajes de rebote accionables.
 */
function failedEndpoints(precheckResult) {
  if (!precheckResult || !Array.isArray(precheckResult.results)) return [];
  const out = [];
  for (const r of precheckResult.results) {
    if (!r.dns.ok) {
      out.push({
        category: r.category,
        host: r.host,
        phase: 'dns',
        code: r.dns.error ? r.dns.error.code : 'UNKNOWN',
        message: r.dns.error ? r.dns.error.message : 'sin detalle',
      });
    } else if (r.tls && !r.tls.ok) {
      out.push({
        category: r.category,
        host: r.host,
        phase: 'tls',
        port: r.tlsPort,
        code: r.tls.error ? r.tls.error.code : 'UNKNOWN',
        message: r.tls.error ? r.tls.error.message : 'sin detalle',
      });
    }
  }
  return out;
}

/**
 * Arma un motivo de rebote accionable describiendo qué endpoints fallaron.
 * Formato pensado para ser insertado en el YAML del archivo de trabajo y
 * también como comentario en GitHub.
 */
function buildInfraReboteMotivo(precheckResult) {
  const failed = failedEndpoints(precheckResult);
  if (failed.length === 0) return null;
  const lines = failed.map((f) => {
    if (f.phase === 'dns') {
      return `[infra] DNS FAIL ${f.host} — ${f.code}: ${f.message}`;
    }
    return `[infra] TLS FAIL ${f.host}:${f.port} — ${f.code}: ${f.message}`;
  });
  lines.push(`[infra] timestamp: ${precheckResult.timestamp}`);
  lines.push(`[infra] ref: issue #2314 (bloqueo por red/DNS)`);
  return lines.join('\n');
}

/**
 * Persiste el estado de salud de infra en `.pipeline/infra-health.json`.
 * Mantiene compatibilidad con el formato consumido por el dashboard.js
 * (ver sección `infraHealth` / helpers `simular-rebote-infra.js`).
 *
 * Preserva los contadores de retries y circuit breaker previos para no
 * pisarlos cuando solo cambia el DNS.
 */
function writeInfraHealth(precheckResult, targetPath) {
  const { ok, results, timestamp } = precheckResult;
  const dnsLatencies = results
    .filter((r) => r.dns.ok && typeof r.dns.latencyMs === 'number')
    .map((r) => r.dns.latencyMs);
  const avgDnsLatency = dnsLatencies.length
    ? Math.round(dnsLatencies.reduce((a, b) => a + b, 0) / dnsLatencies.length)
    : null;

  const anyDnsFail = results.some((r) => !r.dns.ok);
  const anyTlsFail = results.some((r) => r.tls && !r.tls.ok);
  const status = anyDnsFail ? 'FAIL' : 'OK';

  let previous = {};
  try {
    if (fs.existsSync(targetPath)) {
      const raw = fs.readFileSync(targetPath, 'utf8');
      previous = JSON.parse(raw);
    }
  } catch {
    previous = {};
  }

  const prevCB = previous.circuitBreaker || {};
  const circuitBreaker = ok
    ? { state: 'closed', openedAt: null, lastIssue: null, consecutiveFailures: 0 }
    : {
        state: 'open',
        openedAt: prevCB.openedAt || timestamp,
        lastIssue: prevCB.lastIssue || null,
        consecutiveFailures: (prevCB.consecutiveFailures || 0) + 1,
      };

  const state = {
    dns: {
      status,
      lastCheck: timestamp,
      latencyMs: avgDnsLatency,
      endpoints: results.map((r) => ({
        category: r.category,
        host: r.host,
        dnsOk: r.dns.ok,
        dnsError: r.dns.error ? r.dns.error.code : null,
        tlsOk: r.tls ? r.tls.ok : null,
        tlsError: r.tls && r.tls.error ? r.tls.error.code : null,
      })),
      anyTlsFail,
    },
    retries: previous.retries || { lastHour: 0, previousHour: 0, ratePercent: 0 },
    circuitBreaker,
  };

  try {
    fs.writeFileSync(targetPath, JSON.stringify(state, null, 2));
  } catch {
    // Best-effort: si falla el write (permisos, disco lleno), seguimos.
  }
  return state;
}

module.exports = {
  runPrecheck,
  classifyError,
  retryWithBackoff,
  jittered,
  sleep,
  writeInfraHealth,
  buildInfraReboteMotivo,
  failedEndpoints,
  resolveDnsWithTimeout,
  tlsHandshakeWithTimeout,
  hasJvmStacktrace,
  // #6745 — evidencia tipada + enmascarado (CA-1/CA-2/CA-9/CA-10/CA-11)
  classifyErrorDetailed,
  maskCodeSpans,
  hasCodeSignal,
  DEFAULT_ENDPOINTS,
  INFRA_ERROR_CODES,
  INFRA_MESSAGE_PATTERNS,
  INFRA_MACHINE_TOKENS,
  INFRA_PROSE_PATTERNS,
  CODE_SIGNAL_PATTERNS,
  TOOLCHAIN_INFRA_PATTERNS,
  MAX_MOTIVO_SCAN_LEN,
};

// --- CLI smoke test ---
if (require.main === module) {
  (async () => {
    const target = path.join(__dirname, 'infra-health.json');
    const onlyWrite = process.argv.includes('--write');
    try {
      const result = await runPrecheck({});
      if (onlyWrite) {
        writeInfraHealth(result, target);
      }
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    } catch (err) {
      console.error('[precheck] error:', err.message);
      process.exit(2);
    }
  })();
}
