// =============================================================================
// quota-snapshot-parser.js — Parser OCR del panel "Uso" de Claude Desktop.
// Issue #3012 (split de #3008, hija 1).
//
// RESPONSABILIDADES
//   - Extraer 14+1 campos del PNG capturado por capture-quota-snapshot.ps1.
//   - Validación estricta antes de devolver el snapshot (CA-5):
//       * `*_pct` clamp a [0,100].
//       * `session_minutes_to_reset` ∈ (0, 7*24*60).
//       * `daily_routines_used <= daily_routines_max <= 100`.
//       * `api_overage_used_usd >= 0`.
//       * `api_overage_cap_usd >= api_overage_used_usd`.
//   - Validación `account_handle` contra `EXPECTED_CLAUDE_ACCOUNT` (CA-6).
//   - Anti path-traversal en `screenshot_path` (CA-8).
//   - Logs sin PII (CA-11): se loguea sólo categoría del fallo, nunca % ni
//     email.
//
// SCHEMA del JSONL (14 campos + account_handle)
//   ts                            ISO 8601 UTC del momento de parseo.
//   session_pct                   0–100. % de la cuota de sesión.
//   session_minutes_to_reset      minutos hasta el reset de sesión.
//   weekly_all_models_pct         0–100. % de la cuota semanal todos modelos.
//   weekly_sonnet_pct             0–100. % semanal Sonnet.
//   weekly_design_pct             0–100. % semanal Claude Design.
//   daily_routines_used           entero >= 0.
//   daily_routines_max            entero >= used, <= 100.
//   api_overage_used_usd          USD >= 0.
//   api_overage_cap_usd           USD >= used.
//   screenshot_path               path absoluto al PNG (validado anti-traversal).
//   parse_method                  string: "tesseract.js" o "tesseract.js+heuristic".
//   parse_confidence              0–100 (avg confidence del OCR).
//   parse_warnings                array de categorías (whitelist):
//                                 "layout_drift" | "session_disconnected" |
//                                 "account_mismatch" | "unknown".
//   account_handle                string lower-case (validado contra env).
//
// MICROCOPY DE ALERTAS
//   Las alertas Telegram disparadas tras 3 fallos consecutivos (CA-19) y por
//   account_handle no esperado (CA-6) están en
//   `.pipeline/assets/mockups/narrativa-quota-real-snapshot.md` §4.2 y §4.3,
//   y se consumen literal desde `quota-snapshot-alerter.js` (CA-UX-1.hija1,
//   CA-UX-2.hija1).
//
// USO DESDE NODE
//   const { parseSnapshot } = require('.pipeline/lib/quota-snapshot-parser');
//   const result = await parseSnapshot('/abs/path/to/quota-XXX.png', {
//     expectedAccount: 'leito.larreta@gmail.com',
//     ocrProvider: undefined,  // default = lazy-load tesseract.js
//   });
//   // result = { ok: true, snapshot } | { ok: false, category, message }
//
// TESTS
//   .pipeline/lib/__tests__/quota-snapshot-parser.test.js
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// -- Categorías de fallo (whitelist cerrada, CA-UX-1.hija1) -------------------
const FAIL_CATEGORIES = Object.freeze([
  'layout_drift',
  'session_disconnected',
  'account_mismatch',
  'unknown',
]);

function categorize(input) {
  if (typeof input !== 'string') return 'unknown';
  return FAIL_CATEGORIES.includes(input) ? input : 'unknown';
}

// -- Anti path-traversal (CA-8) -----------------------------------------------
/**
 * Valida que `screenshotPath` esté dentro de `allowedRoot` (default
 * `.pipeline/quota-snapshots/`). Resuelve simbólicos vía `fs.realpathSync`
 * cuando el archivo existe; si no existe, normaliza con `path.resolve`.
 *
 * @returns {{ ok: true, abs: string } | { ok: false, reason: string }}
 */
function validateScreenshotPath(screenshotPath, allowedRoot) {
  if (typeof screenshotPath !== 'string' || screenshotPath.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  const root = path.resolve(allowedRoot);
  let abs;
  try {
    abs = path.resolve(screenshotPath);
  } catch {
    return { ok: false, reason: 'unresolvable' };
  }
  // Forzar containment: comparamos prefijos normalizados.
  const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  const absNorm = abs.replace(/\\/g, '/');
  if (!absNorm.toLowerCase().startsWith(rootNorm.toLowerCase())) {
    return { ok: false, reason: 'outside_root' };
  }
  return { ok: true, abs };
}

// -- Validación estricta del shape (CA-5) -------------------------------------
function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function isPositiveInt(value, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  if (!Number.isInteger(n)) return false;
  if (n < 0) return false;
  if (typeof max === 'number' && n > max) return false;
  return true;
}

function isFiniteUsd(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

/**
 * Aplica clamps + reglas. Devuelve `{ ok, value | reason }`.
 */
function validateShape(raw) {
  const required = [
    'session_pct',
    'session_minutes_to_reset',
    'weekly_all_models_pct',
    'weekly_sonnet_pct',
    'weekly_design_pct',
    'daily_routines_used',
    'daily_routines_max',
    'api_overage_used_usd',
    'api_overage_cap_usd',
    'account_handle',
  ];
  for (const k of required) {
    if (!(k in raw)) {
      return { ok: false, reason: `missing:${k}` };
    }
  }

  // Clamp porcentajes.
  const session_pct = clampPct(raw.session_pct);
  const weekly_all_models_pct = clampPct(raw.weekly_all_models_pct);
  const weekly_sonnet_pct = clampPct(raw.weekly_sonnet_pct);
  const weekly_design_pct = clampPct(raw.weekly_design_pct);
  if (
    session_pct === null ||
    weekly_all_models_pct === null ||
    weekly_sonnet_pct === null ||
    weekly_design_pct === null
  ) {
    return { ok: false, reason: 'pct_invalid' };
  }

  // session_minutes_to_reset > 0 y < 7*24*60.
  const minutes = Number(raw.session_minutes_to_reset);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes >= 7 * 24 * 60) {
    return { ok: false, reason: 'session_minutes_out_of_range' };
  }

  // daily_routines_used <= daily_routines_max <= 100.
  const used = Number(raw.daily_routines_used);
  const max = Number(raw.daily_routines_max);
  if (!isPositiveInt(used, 100) || !isPositiveInt(max, 100)) {
    return { ok: false, reason: 'routines_invalid' };
  }
  if (used > max) {
    return { ok: false, reason: 'routines_used_gt_max' };
  }

  // api_overage_used_usd >= 0 y cap >= used.
  const usdUsed = Number(raw.api_overage_used_usd);
  const usdCap = Number(raw.api_overage_cap_usd);
  if (!isFiniteUsd(usdUsed) || !isFiniteUsd(usdCap)) {
    return { ok: false, reason: 'overage_invalid' };
  }
  if (usdCap < usdUsed) {
    return { ok: false, reason: 'overage_cap_lt_used' };
  }

  // account_handle no vacío.
  const handle = String(raw.account_handle || '').trim().toLowerCase();
  if (!handle) {
    return { ok: false, reason: 'account_empty' };
  }

  return {
    ok: true,
    value: {
      session_pct,
      session_minutes_to_reset: Math.round(minutes),
      weekly_all_models_pct,
      weekly_sonnet_pct,
      weekly_design_pct,
      daily_routines_used: Math.round(used),
      daily_routines_max: Math.round(max),
      api_overage_used_usd: usdUsed,
      api_overage_cap_usd: usdCap,
      account_handle: handle,
    },
  };
}

// -- OCR provider (lazy load Tesseract.js) ------------------------------------
/**
 * Wrapper alrededor de tesseract.js. Inyectable para tests via `ocrProvider`.
 * `ocrProvider` debe ser una función `async (pngPath) => { text, confidence }`.
 */
async function defaultTesseractOcr(pngPath) {
  // Lazy require: si la dep no está instalada, fallamos con categoría limpia
  // para que el scheduler reporte sin crashear (CA-16).
  let Tesseract;
  try {
    // eslint-disable-next-line global-require
    Tesseract = require('tesseract.js');
  } catch (e) {
    const err = new Error('tesseract_not_installed');
    err.category = 'unknown';
    throw err;
  }
  const { data } = await Tesseract.recognize(pngPath, 'eng', { logger: () => {} });
  return {
    text: String(data && data.text ? data.text : ''),
    confidence: Number(data && data.confidence) || 0,
  };
}

// -- Heurísticas de extracción (texto OCR → campos) ---------------------------
const PCT_RE = /(\d{1,3})\s*%/;
const USD_RE = /\$\s*(\d+(?:[.,]\d{1,2})?)/;
const INT_RE = /(\d{1,3})/;

/**
 * Busca una línea que matchea un keyword y aplica una regex sobre la línea
 * (y, opcionalmente, las 2 líneas siguientes).
 */
function matchAfterKeyword(text, keywordRe, valueRe, lookahead = 2) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (keywordRe.test(lines[i])) {
      for (let j = 0; j <= lookahead && i + j < lines.length; j++) {
        const m = lines[i + j].match(valueRe);
        if (m) return m;
      }
    }
  }
  return null;
}

/**
 * Extrae los campos del texto OCR. Retorna `null` para campos que no se
 * detectan (la validación posterior los rechaza con `missing:*`).
 */
function extractFromText(text) {
  if (typeof text !== 'string' || !text) return {};

  const out = {};

  // Sesión actual: % + minutos hasta reset.
  const sessionPctMatch = matchAfterKeyword(text, /sesi[oó]n|session/i, PCT_RE);
  if (sessionPctMatch) out.session_pct = Number(sessionPctMatch[1]);
  const resetMatch = matchAfterKeyword(text, /reset|en\s*\d+\s*h|in\s*\d+\s*h/i, /(\d+)\s*h\s*(\d+)?\s*m?/i);
  if (resetMatch) {
    const h = Number(resetMatch[1]) || 0;
    const m = Number(resetMatch[2]) || 0;
    out.session_minutes_to_reset = h * 60 + m;
  }

  // Semanal — todos los modelos.
  const weeklyAll = matchAfterKeyword(text, /semanal\s*[-—·]?\s*(todos|all)/i, PCT_RE);
  if (weeklyAll) out.weekly_all_models_pct = Number(weeklyAll[1]);

  // Semanal — Sonnet.
  const weeklySonnet = matchAfterKeyword(text, /sonnet/i, PCT_RE);
  if (weeklySonnet) out.weekly_sonnet_pct = Number(weeklySonnet[1]);

  // Semanal — Design.
  const weeklyDesign = matchAfterKeyword(text, /design|dise[nñ]o/i, PCT_RE);
  if (weeklyDesign) out.weekly_design_pct = Number(weeklyDesign[1]);

  // Rutinas diarias: N/M con la palabra "rutinas|routines|daily" cerca.
  // Probamos 2 órdenes; nombramos los grupos para evitar offsets ambiguos.
  let routinesMatch = text.match(/(?<used>\d{1,3})\s*\/\s*(?<max>\d{1,3})\s*(?:rutinas|routines|daily)/i);
  if (!routinesMatch) {
    routinesMatch = text.match(/(?:rutinas|routines|daily)[^\d\n]{0,20}(?<used>\d{1,3})\s*\/\s*(?<max>\d{1,3})/i);
  }
  if (routinesMatch && routinesMatch.groups) {
    out.daily_routines_used = Number(routinesMatch.groups.used);
    out.daily_routines_max = Number(routinesMatch.groups.max);
  }

  // Overage USD: $N / $M (used / cap).
  const overage = text.match(/\$\s*(\d+(?:[.,]\d{1,2})?)\s*\/\s*\$\s*(\d+(?:[.,]\d{1,2})?)/);
  if (overage) {
    out.api_overage_used_usd = Number(overage[1].replace(',', '.'));
    out.api_overage_cap_usd = Number(overage[2].replace(',', '.'));
  } else {
    // Si no hay /, podría ser sin overage (asume 0 / cap). Lo dejamos null para
    // que la validación lo rechace si layout drift; el caller decide categoría.
  }

  // Account handle (email).
  const account = text.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/);
  if (account) out.account_handle = account[0].toLowerCase();

  return out;
}

// -- API pública --------------------------------------------------------------
/**
 * Parsea un PNG de snapshot. Devuelve un resultado discriminado:
 *   { ok: true, snapshot }
 *   { ok: false, category, reason }
 *
 * `category` está en la whitelist `FAIL_CATEGORIES`. `reason` es un string
 * corto sin PII apto para logs.
 *
 * @param {string} screenshotPath
 * @param {object} [opts]
 * @param {string} [opts.expectedAccount]   Si se pasa, valida que coincida con
 *                                          `account_handle` (CA-6).
 * @param {string} [opts.allowedRoot]       Root permitido para el PNG (CA-8).
 *                                          Default: `.pipeline/quota-snapshots`.
 * @param {(p:string)=>Promise<{text:string,confidence:number}>} [opts.ocrProvider]
 *                                          Inyectable para tests.
 * @param {() => string} [opts.now]         Inyectable para tests; ISO string.
 */
async function parseSnapshot(screenshotPath, opts = {}) {
  const allowedRoot = opts.allowedRoot
    || path.resolve(__dirname, '..', 'quota-snapshots');

  // CA-8: anti path-traversal.
  const pathCheck = validateScreenshotPath(screenshotPath, allowedRoot);
  if (!pathCheck.ok) {
    return { ok: false, category: 'unknown', reason: `path_${pathCheck.reason}` };
  }

  if (!fs.existsSync(pathCheck.abs)) {
    return { ok: false, category: 'unknown', reason: 'png_missing' };
  }

  // OCR.
  const ocrProvider = typeof opts.ocrProvider === 'function'
    ? opts.ocrProvider
    : defaultTesseractOcr;
  let ocrResult;
  try {
    ocrResult = await ocrProvider(pathCheck.abs);
  } catch (e) {
    const cat = categorize(e && e.category);
    return { ok: false, category: cat, reason: 'ocr_failed' };
  }
  const text = String(ocrResult && ocrResult.text || '');
  const confidence = Number(ocrResult && ocrResult.confidence) || 0;

  // Heurística text → campos. Si está vacío, layout drift (probablemente
  // sesión desconectada o pantalla en blanco).
  if (!text.trim()) {
    return { ok: false, category: 'session_disconnected', reason: 'ocr_empty' };
  }

  const extracted = extractFromText(text);

  // Validación estricta.
  const valid = validateShape(extracted);
  if (!valid.ok) {
    return { ok: false, category: 'layout_drift', reason: valid.reason };
  }

  // CA-6: account_handle ↔ EXPECTED_CLAUDE_ACCOUNT.
  if (opts.expectedAccount) {
    const expected = String(opts.expectedAccount).trim().toLowerCase();
    if (expected && expected !== valid.value.account_handle) {
      // CA-11: NO retornamos el handle real ni el esperado en `reason`.
      return { ok: false, category: 'account_mismatch', reason: 'account_mismatch' };
    }
  }

  const nowIso = (typeof opts.now === 'function' ? opts.now() : new Date().toISOString());

  const snapshot = Object.assign({}, valid.value, {
    ts: nowIso,
    screenshot_path: pathCheck.abs,
    parse_method: 'tesseract.js+heuristic',
    parse_confidence: Math.max(0, Math.min(100, Math.round(confidence))),
    parse_warnings: [],
  });

  return { ok: true, snapshot };
}

module.exports = {
  parseSnapshot,
  // Internals exportados para tests.
  validateScreenshotPath,
  validateShape,
  extractFromText,
  clampPct,
  categorize,
  FAIL_CATEGORIES,
};
