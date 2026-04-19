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

// Patrones de texto que también indican origen infra (timeouts genéricos,
// errores de resolución DNS reportados sin code).
const INFRA_MESSAGE_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /getaddrinfo/i,
  /ENOTFOUND/i,
  /ECONNRESET/i,
  /network is unreachable/i,
  /dns/i,
];

/**
 * Clasifica un error como 'infra' (red/DNS/conectividad) o 'codigo' (otro).
 * Usado para distinguir fallos que NO deben contar contra el circuit breaker
 * del issue (infra) vs los que sí (codigo).
 *
 * @param {Error|string|{code?: string, message?: string}} err
 * @returns {'infra'|'codigo'|null}
 */
function classifyError(err) {
  if (err === null || err === undefined) return null;

  // Acepta string plano (motivo de rechazo escrito por un agente)
  if (typeof err === 'string') {
    const upper = err.toUpperCase();
    for (const code of INFRA_ERROR_CODES) {
      if (upper.includes(code)) return 'infra';
    }
    for (const pat of INFRA_MESSAGE_PATTERNS) {
      if (pat.test(err)) return 'infra';
    }
    return 'codigo';
  }

  const code = err.code || err.errno || err.syscall || '';
  if (code && INFRA_ERROR_CODES.has(String(code))) return 'infra';

  const msg = String(err.message || err || '');
  for (const pat of INFRA_MESSAGE_PATTERNS) {
    if (pat.test(msg)) return 'infra';
  }

  return 'codigo';
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
 * @param {string} host
 * @param {number} timeoutMs
 * @returns {Promise<string[]>} lista de IPs
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

    dns.resolve4(host)
      .then((addrs) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
 * Mantiene compatibilidad con el formato consumido por el dashboard-v2.js
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
  DEFAULT_ENDPOINTS,
  INFRA_ERROR_CODES,
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
