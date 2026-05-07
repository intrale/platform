// =============================================================================
// quota-snapshot-parser.test.js — Tests del parser OCR de snapshots cuota.
// Issue #3012 (split de #3008, hija 1).
//
// Cubre CAs:
//   - CA-5: validación estricta multi-bucket con clamps explícitos.
//   - CA-6: account_handle ↔ EXPECTED_CLAUDE_ACCOUNT (descarte + categoría
//           account_mismatch sin leak de email).
//   - CA-8: anti path-traversal en screenshot_path.
//   - CA-11: la `reason` del fallo no contiene PII (ni %, ni email).
//   - CA-UX-1.hija1: categorías colapsan a la whitelist cerrada.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const parser = require('../quota-snapshot-parser');

// Helpers para crear PNG temporales (cualquier archivo .png en el allowedRoot
// satisface el path check; el OCR provider está mockeado).
function makeTempPng(dir, name) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  // PNG mínimo de 1px (cabecera + IHDR + IDAT + IEND). No nos importa el
  // contenido, sólo que `fs.existsSync` lo encuentre.
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63000100000005000100' +
    '0d0a2db40000000049454e44ae426082',
    'hex'
  );
  fs.writeFileSync(file, png);
  return file;
}

const TMP_ROOT = path.join(os.tmpdir(), `quota-snapshot-tests-${process.pid}`);

const SAMPLE_TEXT_VALID = [
  'Plan Max',
  'leito.larreta@gmail.com',
  'Sesion actual',
  '42% reset en 3 h 15 m',
  'Semanal — Todos los modelos: 67%',
  'Sonnet: 52%',
  'Claude Design: 12%',
  '3 / 15 rutinas hoy',
  'Overage API: $0 / $50',
].join('\n');

function fakeOcr(text, confidence = 88) {
  return async () => ({ text, confidence });
}

test.beforeEach(() => {
  if (fs.existsSync(TMP_ROOT)) {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  }
  fs.mkdirSync(TMP_ROOT, { recursive: true });
});

test.after(() => {
  if (fs.existsSync(TMP_ROOT)) {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// CA-5: shape válido
// -----------------------------------------------------------------------------
test('parseSnapshot: shape válido devuelve los 14+1 campos validados', async () => {
  const png = makeTempPng(TMP_ROOT, 'quota-valid.png');
  const r = await parser.parseSnapshot(png, {
    allowedRoot: TMP_ROOT,
    expectedAccount: 'leito.larreta@gmail.com',
    ocrProvider: fakeOcr(SAMPLE_TEXT_VALID, 92),
    now: () => '2026-05-07T10:00:00.000Z',
  });

  assert.strictEqual(r.ok, true, 'shape válido debe devolver ok=true');
  assert.strictEqual(r.snapshot.session_pct, 42);
  assert.strictEqual(r.snapshot.weekly_all_models_pct, 67);
  assert.strictEqual(r.snapshot.weekly_sonnet_pct, 52);
  assert.strictEqual(r.snapshot.weekly_design_pct, 12);
  assert.strictEqual(r.snapshot.daily_routines_used, 3);
  assert.strictEqual(r.snapshot.daily_routines_max, 15);
  assert.strictEqual(r.snapshot.api_overage_used_usd, 0);
  assert.strictEqual(r.snapshot.api_overage_cap_usd, 50);
  assert.strictEqual(r.snapshot.account_handle, 'leito.larreta@gmail.com');
  assert.strictEqual(r.snapshot.parse_method, 'tesseract.js+heuristic');
  assert.strictEqual(r.snapshot.parse_confidence, 92);
  assert.deepStrictEqual(r.snapshot.parse_warnings, []);
  assert.strictEqual(r.snapshot.ts, '2026-05-07T10:00:00.000Z');
  assert.ok(r.snapshot.session_minutes_to_reset > 0);
});

// -----------------------------------------------------------------------------
// CA-5: shape inválido — uno por bucket
// -----------------------------------------------------------------------------
test('parseSnapshot: pct fuera de rango → clamp ok pero session_minutes negativo rechaza', async () => {
  const png = makeTempPng(TMP_ROOT, 'quota-bad-minutes.png');
  // Mismo OCR pero con minutos = 0 (out of range).
  const text = SAMPLE_TEXT_VALID.replace(/3 h 15 m/, '0 h 0 m');
  const r = await parser.parseSnapshot(png, {
    allowedRoot: TMP_ROOT,
    expectedAccount: 'leito.larreta@gmail.com',
    ocrProvider: fakeOcr(text),
  });

  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.category, 'layout_drift');
  // CA-11: la reason no debe contener % ni email.
  assert.ok(!/\d{1,3}%/.test(r.reason), 'reason no debe leakear %');
  assert.ok(!/@/.test(r.reason), 'reason no debe leakear email');
});

test('parseSnapshot: routines_used > routines_max es rechazado', async () => {
  const png = makeTempPng(TMP_ROOT, 'quota-bad-routines.png');
  const text = SAMPLE_TEXT_VALID.replace('3 / 15 rutinas', '20 / 15 rutinas');
  const r = await parser.parseSnapshot(png, {
    allowedRoot: TMP_ROOT,
    expectedAccount: 'leito.larreta@gmail.com',
    ocrProvider: fakeOcr(text),
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.category, 'layout_drift');
  assert.match(r.reason, /routines/);
});

test('parseSnapshot: api_overage cap < used es rechazado', async () => {
  const png = makeTempPng(TMP_ROOT, 'quota-bad-overage.png');
  const text = SAMPLE_TEXT_VALID.replace('$0 / $50', '$80 / $50');
  const r = await parser.parseSnapshot(png, {
    allowedRoot: TMP_ROOT,
    expectedAccount: 'leito.larreta@gmail.com',
    ocrProvider: fakeOcr(text),
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.category, 'layout_drift');
  assert.match(r.reason, /overage/);
});

test('parseSnapshot: campos faltantes (layout drift) categorizan layout_drift', async () => {
  const png = makeTempPng(TMP_ROOT, 'quota-missing-fields.png');
  // Texto OCR pobre que no contiene los buckets esperados.
  const r = await parser.parseSnapshot(png, {
    allowedRoot: TMP_ROOT,
    ocrProvider: fakeOcr('Plan Max\nNo data available\nfoo@bar.com\n'),
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.category, 'layout_drift');
});

test('parseSnapshot: OCR vacío → session_disconnected', async () => {
  const png = makeTempPng(TMP_ROOT, 'quota-empty-ocr.png');
  const r = await parser.parseSnapshot(png, {
    allowedRoot: TMP_ROOT,
    ocrProvider: fakeOcr(''),
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.category, 'session_disconnected');
});

// -----------------------------------------------------------------------------
// CA-5 clamp: porcentajes > 100 se clampean a 100, < 0 a 0
// -----------------------------------------------------------------------------
test('clampPct: clampea valores fuera de rango', () => {
  assert.strictEqual(parser.clampPct(150), 100);
  assert.strictEqual(parser.clampPct(-10), 0);
  assert.strictEqual(parser.clampPct(67.4), 67.4);
  assert.strictEqual(parser.clampPct('abc'), null);
});

// -----------------------------------------------------------------------------
// CA-6: account mismatch
// -----------------------------------------------------------------------------
test('parseSnapshot: account_handle != expected → category=account_mismatch sin leak de email', async () => {
  const png = makeTempPng(TMP_ROOT, 'quota-account-mismatch.png');
  const text = SAMPLE_TEXT_VALID.replace('leito.larreta@gmail.com', 'otra.cuenta@example.com');
  const r = await parser.parseSnapshot(png, {
    allowedRoot: TMP_ROOT,
    expectedAccount: 'leito.larreta@gmail.com',
    ocrProvider: fakeOcr(text),
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.category, 'account_mismatch');
  assert.ok(!/@/.test(r.reason), 'reason no debe contener "@"');
  assert.ok(!/leito\.larreta/.test(r.reason));
  assert.ok(!/otra\.cuenta/.test(r.reason));
});

// -----------------------------------------------------------------------------
// CA-8: anti path-traversal
// -----------------------------------------------------------------------------
test('validateScreenshotPath: rechaza path fuera del root', () => {
  const allowed = path.join(TMP_ROOT, 'allowed');
  fs.mkdirSync(allowed, { recursive: true });
  const outside = path.join(TMP_ROOT, 'outside.png');
  fs.writeFileSync(outside, 'x');
  const r = parser.validateScreenshotPath(outside, allowed);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'outside_root');
});

test('validateScreenshotPath: acepta path dentro del root', () => {
  const allowed = path.join(TMP_ROOT, 'allowed-ok');
  fs.mkdirSync(allowed, { recursive: true });
  const inside = path.join(allowed, 'snap.png');
  fs.writeFileSync(inside, 'x');
  const r = parser.validateScreenshotPath(inside, allowed);
  assert.strictEqual(r.ok, true);
});

test('validateScreenshotPath: rechaza traversal "../"', () => {
  const allowed = path.join(TMP_ROOT, 'allowed-traversal');
  fs.mkdirSync(allowed, { recursive: true });
  const traversal = path.join(allowed, '..', 'evil.png');
  const r = parser.validateScreenshotPath(traversal, allowed);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'outside_root');
});

test('parseSnapshot: PNG fuera del allowedRoot se rechaza con category=unknown', async () => {
  const allowed = path.join(TMP_ROOT, 'allowed-fence');
  const elsewhere = path.join(TMP_ROOT, 'unfenced');
  fs.mkdirSync(allowed, { recursive: true });
  const evilPng = makeTempPng(elsewhere, 'quota-evil.png');
  const r = await parser.parseSnapshot(evilPng, {
    allowedRoot: allowed,
    ocrProvider: fakeOcr(SAMPLE_TEXT_VALID),
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.category, 'unknown');
  assert.match(r.reason, /^path_/);
});

// -----------------------------------------------------------------------------
// CA-UX-1.hija1: whitelist cerrada de categorías
// -----------------------------------------------------------------------------
test('categorize: valor inventado colapsa a "unknown"', () => {
  assert.strictEqual(parser.categorize('valor_inventado'), 'unknown');
  assert.strictEqual(parser.categorize(null), 'unknown');
  assert.strictEqual(parser.categorize(''), 'unknown');
  assert.strictEqual(parser.categorize(123), 'unknown');
});

test('categorize: las 4 categorías de la whitelist se preservan', () => {
  for (const cat of parser.FAIL_CATEGORIES) {
    assert.strictEqual(parser.categorize(cat), cat);
  }
});

// -----------------------------------------------------------------------------
// Confidence baja del OCR no rompe el shape válido (sólo se persiste como dato)
// -----------------------------------------------------------------------------
test('parseSnapshot: confidence baja persiste en el snapshot pero no rechaza', async () => {
  const png = makeTempPng(TMP_ROOT, 'quota-low-conf.png');
  const r = await parser.parseSnapshot(png, {
    allowedRoot: TMP_ROOT,
    expectedAccount: 'leito.larreta@gmail.com',
    ocrProvider: fakeOcr(SAMPLE_TEXT_VALID, 18),
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.snapshot.parse_confidence, 18);
});
