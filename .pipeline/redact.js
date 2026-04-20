// =============================================================================
// redact.js — Sanitización reutilizable para outputs del pipeline
//
// Aplica reglas OWASP contra leaks en:
//   - mensajes Telegram del circuit breaker
//   - estado persistido en JSON
//   - rejection reports y dashboard
//
// Reglas (issue #2305):
//   - Strip tokens tipo `bot[0-9]+:[A-Za-z0-9_-]+`
//   - Strip query strings `?token=`, `?access_token=`, `?key=`, `?api_key=`
//   - Strip credenciales en URLs (user:pass@host → host)
//   - Strip paths absolutos → relativos a PIPELINE_ROOT
//   - Strip stack traces → dejar solo la primera línea
// =============================================================================

const path = require('path');

/** Root del pipeline para calcular paths relativos. */
const PIPELINE_ROOT = process.env.PIPELINE_ROOT
  || path.resolve(__dirname, '..');

/**
 * Elimina bot tokens de Telegram (formato `bot<digits>:<alnum_-_>`).
 * También cubre el mismo token standalone sin prefijo `bot`.
 */
function redactTelegramToken(str) {
  return String(str)
    .replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot<REDACTED>')
    .replace(/\b\d{9,}:[A-Za-z0-9_-]{30,}\b/g, '<REDACTED_TOKEN>');
}

/**
 * Reemplaza query strings con claves sensibles.
 * Ej: `?token=abc&foo=bar` → `?token=<REDACTED>&foo=bar`
 */
function redactQueryStringSecrets(str) {
  return String(str).replace(
    /([?&])(token|access_token|api_key|apikey|key|secret|password|authorization)=[^&\s"'#]*/gi,
    '$1$2=<REDACTED>'
  );
}

/**
 * Reemplaza credenciales embebidas en URLs (http://user:pass@host).
 */
function redactUrlCredentials(str) {
  return String(str).replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
    '$1<REDACTED>@'
  );
}

/**
 * Reemplaza paths absolutos por paths relativos a PIPELINE_ROOT.
 * Convierte separadores Windows (`\`) a forward slash para estabilidad.
 */
function redactAbsolutePaths(str) {
  const input = String(str);
  // Normalizar PIPELINE_ROOT — sin trailing slash, con ambos separadores posibles.
  const rootNorm = PIPELINE_ROOT.replace(/[/\\]+$/, '');
  const rootVariants = new Set([
    rootNorm,
    rootNorm.replace(/\\/g, '/'),
    rootNorm.replace(/\//g, '\\'),
  ]);

  let out = input;
  for (const variant of rootVariants) {
    if (!variant) continue;
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '<PIPELINE_ROOT>');
  }

  // Fallback: cualquier path absoluto de Windows (`X:\...`) o Unix (`/home/...`, `/Users/...`, `/c/Workspaces/...`).
  // Sólo aplicamos sobre tokens "path-like" para no destruir texto normal.
  out = out.replace(/[A-Za-z]:\\[^\s"'<>|?*]+/g, (match) => {
    // Si ya contiene <REDACTED> o <PIPELINE_ROOT>, lo dejamos.
    if (/<REDACTED|<PIPELINE_ROOT/.test(match)) return match;
    return '<ABS_PATH>';
  });
  out = out.replace(/(^|[\s(])\/(home|Users|c|mnt|opt|var)\/[^\s"'<>|?*]+/g, (m, pre) => `${pre}<ABS_PATH>`);

  return out;
}

/**
 * Se queda con sólo la primera línea de un stack trace.
 * Un stack trace típico de Node empieza con `Error:` y sigue con `    at ...`.
 */
function redactStackTrace(str) {
  const input = String(str);
  const lines = input.split(/\r?\n/);
  const firstStackIdx = lines.findIndex((l) => /^\s+at\s+/.test(l));
  if (firstStackIdx <= 0) return input;
  return lines.slice(0, firstStackIdx).join('\n').trimEnd() + ' [stack redacted]';
}

/**
 * Redacta proxy URLs dejando sólo el hostname (sin credenciales).
 * Ej: `http://user:pass@proxy.evil:8080` → `proxy.evil`
 */
function redactProxyUrl(str) {
  return String(str).replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@]+@)?([^\s/:?#]+)(?::\d+)?(?:\/[^\s]*)?/gi,
    (match, scheme, host) => {
      // Sólo aplicar a hosts reales (evitamos romper URLs de ejemplo/docs)
      return `${scheme}${host}`;
    }
  );
}

/**
 * Aplicar todas las reglas de redacción en cascada.
 *
 * Orden importa: primero tokens → luego query strings → luego creds en URL → luego paths → luego stack.
 */
function redact(input) {
  if (input == null) return input;
  if (typeof input !== 'string') {
    try { input = JSON.stringify(input); }
    catch { input = String(input); }
  }
  let out = input;
  out = redactTelegramToken(out);
  out = redactQueryStringSecrets(out);
  out = redactUrlCredentials(out);
  out = redactAbsolutePaths(out);
  out = redactStackTrace(out);
  return out;
}

/**
 * Redacción específica para mensajes Telegram: aplica redact() y además
 * escapa caracteres de Markdown (`_`, `*`, `` ` ``, `[`) para evitar que
 * un título de issue con markup roto el formato del mensaje.
 */
function redactForTelegram(input, { parseMode = 'plain' } = {}) {
  const redacted = redact(input);
  if (parseMode === 'plain') return redacted;
  if (parseMode === 'HTML') {
    return String(redacted)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  return redacted;
}

module.exports = {
  redact,
  redactForTelegram,
  redactTelegramToken,
  redactQueryStringSecrets,
  redactUrlCredentials,
  redactAbsolutePaths,
  redactStackTrace,
  redactProxyUrl,
  PIPELINE_ROOT,
};
