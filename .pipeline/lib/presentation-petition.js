'use strict';

// =============================================================================
// presentation-petition.js — Resolver server-side del texto de la petición del
// usuario que atiende una presencia observacional (Commander / Sherlock), para
// mostrarlo en su card del área "Ejecutando ahora" del dashboard V3 (#4443,
// CA-3/CA-4/CA-5).
//
// Diseño (cierra el sourcing PII sin romper SEC-1 de #3948):
//   - SR-3 / SEC-1: NO persiste ni lee campos nuevos del canal de presencia
//     (`commander-presence.json` / `sherlock-presence.json` quedan intactos, con
//     su whitelist `{petitionId, fase, startedAt}`). El texto se resuelve aparte,
//     server-side, desde `commander-history.jsonl` (append-only) correlacionando
//     por la ventana temporal viva de la presencia (`startedAt` + TTL).
//   - SR-5 (perf/DoS): nunca carga el jsonl entero al render — `.slice(-N)` de
//     las últimas líneas, igual que `renderCommanderRequestLogs` / la lectura de
//     actividad (`dashboard.js` L1456).
//   - SR-2 (secrets): el texto pasa por el `redact` inyectado (→ `redactLogText`
//     → `handoff.sanitize`) ANTES de truncar. El escape HTML (SR-1) lo hace el
//     render en `dashboard.js` (cuerpo + atributo `title`), fuera de este módulo.
//   - SR-4 / SR-6 (petición fantasma / correlación cruzada): sólo considera
//     entries `direction:'in'` con texto no vacío, dentro de `[startedAt-slack,
//     now]` y del TTL; elige la más reciente. Fuera de ventana → null (fallback
//     idle "Sin petición activa", CA-5).
//
// Módulo PURO y sin efectos: recibe el path del history, `startedAt`, `ttlMs` y
// deps inyectables (`nowMs`, `redact`, `sliceN`, `maxLen`) para ser 100% testeable
// con `node --test` sin montar el server del dashboard.
// =============================================================================

const fs = require('fs');

// Longitud del pre-corte server-side (el ellipsis visual real lo hace el CSS por
// ancho de card; esto es pre-corte de seguridad/perf — receta del arquitecto).
const DEFAULT_MAX_LEN = 120;
// Últimas N líneas del history a inspeccionar (SR-5). 40 cubre de sobra la
// ventana de TTL (5 min) con margen; nunca carga el archivo completo al parseo.
const DEFAULT_SLICE = 40;
// Holgura hacia atrás sobre `startedAt`: la petición del usuario entra al history
// unos ms ANTES de que el brazo publique la presencia. 5s absorbe ese desfasaje
// sin abrir la ventana a peticiones de otra corrida (SR-6).
const WINDOW_SLACK_MS = 5000;

function identity(x) { return x; }

/**
 * Resuelve el texto (redactado + truncado) de la petición vigente para una
 * presencia observacional, o `null` si no hay ninguna dentro de la ventana.
 *
 * @param {string} historyPath  path a `commander-history.jsonl`
 * @param {number} startedAt    epoch ms de inicio de la presencia (whitelisteado)
 * @param {number} ttlMs        TTL de la presencia (COMMANDER/SHERLOCK_PRESENCE_TTL_MS)
 * @param {{nowMs?: number, redact?: (s:string)=>string, sliceN?: number, maxLen?: number}} [opts]
 * @returns {{full: string, clipped: string} | null}
 */
function resolvePetitionText(historyPath, startedAt, ttlMs, opts = {}) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(ttlMs) || ttlMs <= 0) return null;

  const now = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const sliceN = Number.isFinite(opts.sliceN) && opts.sliceN > 0 ? opts.sliceN : DEFAULT_SLICE;
  const maxLen = Number.isFinite(opts.maxLen) && opts.maxLen > 0 ? opts.maxLen : DEFAULT_MAX_LEN;
  const redact = typeof opts.redact === 'function' ? opts.redact : identity;

  let content;
  try { content = fs.readFileSync(historyPath, 'utf8'); }
  catch { return null; } // history ausente/ilegible → fallback idle

  const trimmed = content.trim();
  if (!trimmed) return null;
  const lines = trimmed.split('\n').slice(-sliceN);

  let best = null;
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || e.direction !== 'in' || typeof e.text !== 'string') continue;
    if (!e.text.trim()) continue; // texto vacío (p.ej. voz sin transcript) → inútil como petición
    const ts = Date.parse(e.timestamp);
    if (!Number.isFinite(ts)) continue;
    // SR-4/SR-6: acotar a la ventana viva de la presencia y descartar futuras.
    if (ts < startedAt - WINDOW_SLACK_MS || ts > now) continue;
    if (now - ts >= ttlMs) continue; // fuera de TTL → stale
    if (!best || ts > best.ts) best = { ts, text: e.text };
  }
  if (!best) return null;

  // SR-2: redactar secrets ANTES de truncar (no debe llegar token crudo, ni
  // siquiera cortado, al render).
  const redacted = redact(best.text);
  if (typeof redacted !== 'string') return null;
  const full = redacted;
  const clipped = full.length > maxLen ? full.slice(0, maxLen) + '…' : full;
  return { full, clipped };
}

module.exports = {
  resolvePetitionText,
  DEFAULT_MAX_LEN,
  DEFAULT_SLICE,
  WINDOW_SLACK_MS,
};
