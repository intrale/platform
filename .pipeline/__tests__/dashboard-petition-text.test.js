'use strict';

// =============================================================================
// Tests de `lib/presentation-petition.resolvePetitionText` (#4443, CA-11).
//
// Resolver server-side del texto de la petición vigente para las cards
// observacionales de Commander/Sherlock. Cubre:
//   - CA-3: devuelve la petición más reciente dentro de la ventana de presencia.
//   - CA-5: null (→ fallback idle) cuando no hay entry `direction:in` en la ventana.
//   - SR-4/SR-6: descarta peticiones fuera del TTL / previas a startedAt / futuras.
//   - SR-2: redacta secrets ANTES de truncar (no llega token crudo al render).
//   - CA-4: trunca a maxLen conservando el texto completo en `full` (→ `title`).
//   - SR-5: sólo inspecciona las últimas N líneas (`.slice(-N)`).
//
// El escape HTML (SR-1) lo hace el render en `dashboard.js` (cuerpo + `title`) y
// se valida por separado en el test estructural del dashboard; acá se prueba la
// lógica pura de resolución.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolvePetitionText, DEFAULT_MAX_LEN } = require('../lib/presentation-petition');

// Base temporal única por proceso (sin Math.random: determinístico).
const TMP_BASE = path.join(os.tmpdir(), `petition-test-${process.pid}`);
fs.mkdirSync(TMP_BASE, { recursive: true });
let _seq = 0;

// Escribe un history.jsonl temporal con las entries dadas y devuelve su path.
function writeHistory(entries) {
  const p = path.join(TMP_BASE, `history-${_seq++}.jsonl`);
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(p, lines + '\n');
  return p;
}

function iso(ms) { return new Date(ms).toISOString(); }

const T0 = 1_800_000_000_000; // epoch fijo de referencia (sin Date.now real)
const TTL = 5 * 60 * 1000;

test('devuelve el texto de la petición más reciente dentro de la ventana de presencia (CA-3)', () => {
  const startedAt = T0;
  const now = T0 + 30_000;
  const p = writeHistory([
    { direction: 'in', text: 'primera petición', timestamp: iso(T0 + 1_000) },
    { direction: 'out', text: 'respuesta del bot', timestamp: iso(T0 + 2_000) },
    { direction: 'in', text: 'petición más reciente', timestamp: iso(T0 + 10_000) },
  ]);
  const r = resolvePetitionText(p, startedAt, TTL, { nowMs: now });
  assert.ok(r, 'debe resolver algo');
  assert.equal(r.full, 'petición más reciente');
  assert.equal(r.clipped, 'petición más reciente');
});

test('retorna null (fallback idle) cuando no hay entry direction:in dentro del TTL (CA-5)', () => {
  const startedAt = T0;
  const now = T0 + 30_000;
  const p = writeHistory([
    { direction: 'out', text: 'sólo salidas', timestamp: iso(T0 + 1_000) },
    { direction: 'reconcile', text: '[entrega confirmada]', timestamp: iso(T0 + 2_000) },
  ]);
  assert.equal(resolvePetitionText(p, startedAt, TTL, { nowMs: now }), null);
});

test('descarta peticiones previas a startedAt (fuera de ventana, SR-6)', () => {
  const startedAt = T0;
  const now = T0 + 30_000;
  const p = writeHistory([
    // Muy anterior a startedAt (más allá de la holgura de 5s) → otra corrida.
    { direction: 'in', text: 'petición de OTRO usuario', timestamp: iso(T0 - 60_000) },
  ]);
  assert.equal(resolvePetitionText(p, startedAt, TTL, { nowMs: now }), null);
});

test('acepta petición dentro de la holgura de 5s previa a startedAt', () => {
  const startedAt = T0;
  const now = T0 + 30_000;
  const p = writeHistory([
    { direction: 'in', text: 'petición justo antes de publicar presencia', timestamp: iso(T0 - 3_000) },
  ]);
  const r = resolvePetitionText(p, startedAt, TTL, { nowMs: now });
  assert.ok(r);
  assert.equal(r.full, 'petición justo antes de publicar presencia');
});

test('descarta peticiones fuera del TTL (stale, SR-4)', () => {
  const startedAt = T0;
  const now = T0 + TTL + 10_000; // ya pasó el TTL
  const p = writeHistory([
    { direction: 'in', text: 'petición vencida', timestamp: iso(T0 + 1_000) },
  ]);
  assert.equal(resolvePetitionText(p, startedAt, TTL, { nowMs: now }), null);
});

test('descarta peticiones futuras (timestamp > now)', () => {
  const startedAt = T0;
  const now = T0 + 10_000;
  const p = writeHistory([
    { direction: 'in', text: 'petición del futuro', timestamp: iso(T0 + 60_000) },
  ]);
  assert.equal(resolvePetitionText(p, startedAt, TTL, { nowMs: now }), null);
});

test('ignora entries in con texto vacío (voz sin transcript)', () => {
  const startedAt = T0;
  const now = T0 + 30_000;
  const p = writeHistory([
    { direction: 'in', text: '   ', timestamp: iso(T0 + 5_000) },
    { direction: 'in', text: '', timestamp: iso(T0 + 6_000) },
  ]);
  assert.equal(resolvePetitionText(p, startedAt, TTL, { nowMs: now }), null);
});

test('redacta secrets antes de truncar — no llega token crudo (SR-2)', () => {
  const startedAt = T0;
  const now = T0 + 30_000;
  // redactor inyectado que simula redactLogText (reemplaza tokens tipo API key).
  const redact = (s) => s.replace(/sk-[A-Za-z0-9]+/g, '«REDACTED»');
  const p = writeHistory([
    { direction: 'in', text: 'mi key es sk-ABC123XYZsecret y algo más', timestamp: iso(T0 + 5_000) },
  ]);
  const r = resolvePetitionText(p, startedAt, TTL, { nowMs: now, redact });
  assert.ok(r);
  assert.ok(!r.full.includes('sk-ABC123XYZsecret'), 'el token crudo no debe aparecer');
  assert.ok(r.full.includes('«REDACTED»'));
});

test('trunca a maxLen conservando el texto completo en full (CA-4)', () => {
  const startedAt = T0;
  const now = T0 + 30_000;
  const longText = 'x'.repeat(300);
  const p = writeHistory([
    { direction: 'in', text: longText, timestamp: iso(T0 + 5_000) },
  ]);
  const r = resolvePetitionText(p, startedAt, TTL, { nowMs: now });
  assert.ok(r);
  assert.equal(r.full, longText, 'full conserva el texto completo (para el title)');
  assert.equal(r.clipped.length, DEFAULT_MAX_LEN + 1, 'clipped = maxLen chars + ellipsis');
  assert.ok(r.clipped.endsWith('…'));
});

test('respeta maxLen custom', () => {
  const startedAt = T0;
  const now = T0 + 30_000;
  const p = writeHistory([
    { direction: 'in', text: 'abcdefghij', timestamp: iso(T0 + 5_000) },
  ]);
  const r = resolvePetitionText(p, startedAt, TTL, { nowMs: now, maxLen: 5 });
  assert.equal(r.clipped, 'abcde…');
  assert.equal(r.full, 'abcdefghij');
});

test('sólo inspecciona las últimas N líneas (SR-5, .slice)', () => {
  const startedAt = T0;
  const now = T0 + 30_000;
  // 50 entries out + 1 in vieja al principio; con sliceN:5 la vieja queda fuera.
  const entries = [{ direction: 'in', text: 'petición fuera del slice', timestamp: iso(T0 + 1_000) }];
  for (let i = 0; i < 50; i++) {
    entries.push({ direction: 'out', text: 'ruido ' + i, timestamp: iso(T0 + 2_000 + i) });
  }
  const p = writeHistory(entries);
  assert.equal(resolvePetitionText(p, startedAt, TTL, { nowMs: now, sliceN: 5 }), null);
});

test('null cuando el history no existe (fallback idle, CA-5)', () => {
  const p = path.join(TMP_BASE, 'no-existe.jsonl');
  assert.equal(resolvePetitionText(p, T0, TTL, { nowMs: T0 + 1000 }), null);
});

test('null cuando el history está vacío', () => {
  const p = path.join(TMP_BASE, `vacio-${_seq++}.jsonl`);
  fs.writeFileSync(p, '   \n');
  assert.equal(resolvePetitionText(p, T0, TTL, { nowMs: T0 + 1000 }), null);
});

test('tolera líneas JSON corruptas sin romper', () => {
  const startedAt = T0;
  const now = T0 + 30_000;
  const p = path.join(TMP_BASE, `corrupto-${_seq++}.jsonl`);
  fs.writeFileSync(p, '{no es json\n' + JSON.stringify({ direction: 'in', text: 'válida', timestamp: iso(T0 + 5_000) }) + '\n');
  const r = resolvePetitionText(p, startedAt, TTL, { nowMs: now });
  assert.ok(r);
  assert.equal(r.full, 'válida');
});

test('parámetros inválidos → null (startedAt/ttl no finitos)', () => {
  const p = writeHistory([{ direction: 'in', text: 'x', timestamp: iso(T0 + 1_000) }]);
  assert.equal(resolvePetitionText(p, NaN, TTL, { nowMs: T0 }), null);
  assert.equal(resolvePetitionText(p, T0, NaN, { nowMs: T0 }), null);
  assert.equal(resolvePetitionText(p, T0, 0, { nowMs: T0 }), null);
});

test('descarta entries con timestamp no parseable', () => {
  const startedAt = T0;
  const now = T0 + 30_000;
  const p = writeHistory([
    { direction: 'in', text: 'sin timestamp válido', timestamp: 'no-es-fecha' },
  ]);
  assert.equal(resolvePetitionText(p, startedAt, TTL, { nowMs: now }), null);
});

test.after(() => {
  try { fs.rmSync(TMP_BASE, { recursive: true, force: true }); } catch { /* best-effort */ }
});
