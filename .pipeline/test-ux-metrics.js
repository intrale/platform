#!/usr/bin/env node
// =============================================================================
// test-ux-metrics.js — Tests de `.pipeline/ux-metrics.js` (#2337 CA10)
//
// Cubre los criterios aceptacion CA10.1-CA10.7:
//   CA10.1 — creacion del directorio + archivo JSONL del dia
//   CA10.2 — campos capturados por evento
//   CA10.3 — escritura atomica / entrada >4KB rechazada
//   CA10.4 — rotacion diaria (archivo distinto por dia)
//   CA10.5 — cleanup lazy + force + cota dura + regex estricta
//   CA10.6 — no fuga de datos sensibles (whitelist + redact)
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  appendMetric,
  cleanup,
  sanitizeEntry,
  deriveLatencias,
  listUxFiles,
  uxFilePath,
  dateSuffix,
  isInsideDir,
  UX_FILE_REGEX,
  MAX_FILES_HARD_CAP,
  MAX_ENTRY_BYTES,
} = require('./ux-metrics');

// --- Helpers de test ---

function mkTempDir(prefix = 'ux-metrics-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmRf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// --- Tests ---

test('CA10.1 — crea directorio y archivo ux-infra-YYYY-MM-DD.json en el primer write', () => {
  const dir = mkTempDir();
  try {
    const now = Date.UTC(2026, 3, 17, 12, 0, 0); // 2026-04-17 UTC
    const r = appendMetric({ event: 'connectivity_restored', timestamp_event: now }, {
      metricsDir: dir, now,
    });
    assert.equal(r.written, true, 'debio escribir');
    assert.ok(fs.existsSync(r.filePath), 'archivo debe existir');
    assert.match(path.basename(r.filePath), UX_FILE_REGEX, 'nombre matchea regex');
    assert.equal(path.basename(r.filePath), 'ux-infra-2026-04-17.json');
  } finally { rmRf(dir); }
});

test('CA10.2 — captura todos los campos requeridos y deriva latencias', () => {
  const dir = mkTempDir();
  try {
    const now = Date.UTC(2026, 3, 17, 12, 0, 0);
    const r = appendMetric({
      event: 'connectivity_restored',
      timestamp_event: now,
      timestamp_dashboard_update: now + 500,
      timestamp_telegram_delivered: now + 1000,
      timestamp_first_issue_running: now + 5000,
      variante_mensaje: 'variant:v2',
      issues_reencolados: 3,
      rate_limit_alcanzado: null,
      previous_state: 'blocked:infra',
      retrying_window_ms: 2000,
    }, { metricsDir: dir, now });

    assert.equal(r.written, true);
    // Latencias derivadas
    assert.equal(r.entry.latencia_telegram_ms, 1000);
    assert.equal(r.entry.latencia_recuperacion_ms, 5000);
    // Campos preservados
    assert.equal(r.entry.issues_reencolados, 3);
    assert.equal(r.entry.variante_mensaje, 'variant:v2');
    assert.equal(r.entry.previous_state, 'blocked:infra');

    // El archivo contiene la linea
    const content = fs.readFileSync(r.filePath, 'utf8');
    assert.ok(content.endsWith('\n'), 'JSONL debe terminar en newline');
    const parsed = JSON.parse(content.trim());
    assert.equal(parsed.event, 'connectivity_restored');
  } finally { rmRf(dir); }
});

test('CA10.3 — JSONL append: multiples writes concatenan sin corromper', () => {
  const dir = mkTempDir();
  try {
    const now = Date.UTC(2026, 3, 17, 0, 0, 0);
    for (let i = 0; i < 5; i++) {
      const r = appendMetric({
        event: 'connectivity_restored',
        timestamp_event: now + i,
        issues_reencolados: i + 1,
      }, { metricsDir: dir, now: now + i });
      assert.equal(r.written, true, `write #${i} debio escribir`);
    }
    const filePath = uxFilePath(dir, now);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    assert.equal(lines.length, 5);
    for (let i = 0; i < 5; i++) {
      const parsed = JSON.parse(lines[i]);
      assert.equal(parsed.issues_reencolados, i + 1);
    }
  } finally { rmRf(dir); }
});

test('CA10.3 — rechaza entrada >4KB con `reason: entry-too-large`', () => {
  const dir = mkTempDir();
  try {
    const now = Date.UTC(2026, 3, 17, 0, 0, 0);
    // Entrada que exceda 4KB cuando serialice. `variante_mensaje` se clampea
    // a 32 chars asi que usamos `previous_state` que no se clampea, sumando
    // strings. Asi el test valida el cap aunque haya sanitizacion posterior.
    const bigString = 'x'.repeat(MAX_ENTRY_BYTES + 100);
    const r = appendMetric({
      event: 'connectivity_restored',
      timestamp_event: now,
      previous_state: bigString,
    }, { metricsDir: dir, now });
    assert.equal(r.written, false);
    assert.match(r.reason || '', /entry-too-large/);
  } finally { rmRf(dir); }
});

test('CA10.4 — rotacion diaria: mismo dia = mismo archivo, dia distinto = archivo nuevo', () => {
  const dir = mkTempDir();
  try {
    const day1 = Date.UTC(2026, 3, 17, 23, 30, 0);
    const day2 = Date.UTC(2026, 3, 18, 0, 30, 0);
    const r1 = appendMetric({ event: 'connectivity_restored' }, { metricsDir: dir, now: day1 });
    const r2 = appendMetric({ event: 'connectivity_restored' }, { metricsDir: dir, now: day2 });
    assert.equal(r1.written, true);
    assert.equal(r2.written, true);
    assert.notEqual(r1.filePath, r2.filePath, 'archivos de distintos dias deben diferir');
    assert.equal(path.basename(r1.filePath), 'ux-infra-2026-04-17.json');
    assert.equal(path.basename(r2.filePath), 'ux-infra-2026-04-18.json');
  } finally { rmRf(dir); }
});

test('CA10.5 — cleanup borra archivos con mtime >30 dias', () => {
  const dir = mkTempDir();
  try {
    const now = Date.UTC(2026, 3, 17, 12, 0, 0);
    // Creamos un archivo "viejo" y uno "reciente"
    const oldFile = path.join(dir, 'ux-infra-2026-01-01.json');
    const newFile = path.join(dir, 'ux-infra-2026-04-10.json');
    fs.writeFileSync(oldFile, '{"stale":true}\n');
    fs.writeFileSync(newFile, '{"fresh":true}\n');
    // mtime del old file lo bajamos 90 dias atras
    const oldTime = now - 90 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime));
    // newFile queda con mtime reciente (hoy)

    const r = cleanup({ metricsDir: dir, now, force: true });
    assert.equal(r.ran, true);
    assert.ok(r.deleted.includes('ux-infra-2026-01-01.json'), 'viejo debe borrarse');
    assert.ok(!r.deleted.includes('ux-infra-2026-04-10.json'), 'reciente NO debe borrarse');
    assert.ok(fs.existsSync(newFile));
    assert.ok(!fs.existsSync(oldFile));
  } finally { rmRf(dir); }
});

test('CA10.5 — cleanup NO borra archivos dotfiles ni archivos ajenos (regex estricta)', () => {
  const dir = mkTempDir();
  try {
    const now = Date.UTC(2026, 3, 17, 12, 0, 0);
    const marker = path.join(dir, '.last-cleanup');
    const foreign1 = path.join(dir, 'UX-INFRA-2026-01-01.json'); // uppercase
    const foreign2 = path.join(dir, 'ux-infra-2026-01-01.json.bak');
    const foreign3 = path.join(dir, 'ux-infra-bad.json');
    fs.writeFileSync(marker, '{}');
    fs.writeFileSync(foreign1, '{}');
    fs.writeFileSync(foreign2, '{}');
    fs.writeFileSync(foreign3, '{}');
    // Todos con mtime viejo
    const oldTime = now - 90 * 24 * 60 * 60 * 1000;
    for (const f of [marker, foreign1, foreign2, foreign3]) {
      fs.utimesSync(f, new Date(oldTime), new Date(oldTime));
    }
    const r = cleanup({ metricsDir: dir, now, force: true });
    assert.equal(r.ran, true);
    assert.equal(r.deleted.length, 0, 'ningun archivo no-matching debe borrarse');
    assert.ok(fs.existsSync(foreign1));
    assert.ok(fs.existsSync(foreign2));
    assert.ok(fs.existsSync(foreign3));
    // El marker `.last-cleanup` se re-escribe por el propio cleanup, pero no
    // se borra antes.
    assert.ok(fs.existsSync(marker));
  } finally { rmRf(dir); }
});

test('CA10.5 — cleanup lazy: no corre dos veces el mismo dia sin force', () => {
  const dir = mkTempDir();
  try {
    const now = Date.UTC(2026, 3, 17, 12, 0, 0);
    const r1 = cleanup({ metricsDir: dir, now });
    assert.equal(r1.ran, true, 'primera corrida debe ejecutar');
    const r2 = cleanup({ metricsDir: dir, now: now + 1000 });
    assert.equal(r2.ran, false, 'segunda corrida del mismo dia debe skip');
    assert.equal(r2.reason, 'already-today');
    // Pero con force debe correr igual
    const r3 = cleanup({ metricsDir: dir, now: now + 2000, force: true });
    assert.equal(r3.ran, true, 'force debe correr');
  } finally { rmRf(dir); }
});

test('CA10.5 — cleanup cota dura: borra los mas viejos si quedan >MAX_FILES', () => {
  const dir = mkTempDir();
  try {
    const now = Date.UTC(2026, 3, 17, 12, 0, 0);
    // Crear MAX_FILES_HARD_CAP + 5 archivos TODOS recientes (no se borran por fecha)
    for (let i = 0; i < MAX_FILES_HARD_CAP + 5; i++) {
      const f = path.join(dir, `ux-infra-2026-03-${String((i % 28) + 1).padStart(2, '0')}.json`);
      // Usar distintos nombres para evitar colisiones — redondear por dia-del-mes
      // y variar mtime.
      const fName = path.join(dir, `ux-infra-2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}.json`);
      fs.writeFileSync(fName, `{"i":${i}}\n`);
      // mtime progresivo: i=0 mas viejo, i=max mas reciente (todos dentro de retention)
      const ts = now - (MAX_FILES_HARD_CAP + 5 - i) * 1000;
      fs.utimesSync(fName, new Date(ts), new Date(ts));
    }
    const r = cleanup({ metricsDir: dir, now, force: true });
    assert.equal(r.ran, true);
    assert.equal(r.capEnforced, true, 'cota dura debe haber disparado');
    assert.ok(r.deleted.length >= 5, 'debe borrar al menos el excedente');
  } finally { rmRf(dir); }
});

test('CA10.6 — sanitize: filtra keys no whitelisted y redacta tokens', () => {
  const sanitized = sanitizeEntry({
    event: 'connectivity_restored',
    timestamp_event: 123,
    variante_mensaje: 'variant:v2',
    // Keys prohibidas que NO deben persistir:
    mensaje_literal: 'texto secreto del usuario',
    token: 'sk-1234567890abcdef1234',
    chat_id: '1234567890',
    user_path: 'C:\\Users\\Administrator\\secret.json',
  });
  assert.equal(sanitized.event, 'connectivity_restored');
  assert.equal(sanitized.variante_mensaje, 'variant:v2');
  assert.equal(sanitized.mensaje_literal, undefined, 'clave fuera de whitelist se filtra');
  assert.equal(sanitized.token, undefined);
  assert.equal(sanitized.chat_id, undefined);
  assert.equal(sanitized.user_path, undefined);
});

test('CA10.6 — sanitize: convierte paths absolutos dentro de valores whitelisted a basename', () => {
  // `previous_state` esta whitelisted y se usa para ejemplificar.
  const sanitized = sanitizeEntry({
    previous_state: '/home/user/secret/file.json',
  });
  assert.equal(sanitized.previous_state, 'file.json');
  const sanitizedWin = sanitizeEntry({
    previous_state: 'C:\\Users\\Administrator\\secret.json',
  });
  assert.equal(sanitizedWin.previous_state, 'secret.json');
});

test('CA10.6 — sanitize: redacta tokens-like embedded en values', () => {
  const sanitized = sanitizeEntry({
    variante_mensaje: 'Bearer secrettoken123456',
  });
  assert.equal(sanitized.variante_mensaje, '[REDACTED]');
  const sanitized2 = sanitizeEntry({
    variante_mensaje: 'sk-abc1234567890defghij',
  });
  assert.equal(sanitized2.variante_mensaje, '[REDACTED]');
});

test('CA10.6 — sanitize: clamp variante_mensaje a 32 chars', () => {
  const longVariant = 'v'.repeat(100);
  const sanitized = sanitizeEntry({ variante_mensaje: longVariant });
  assert.equal(sanitized.variante_mensaje.length, 32);
});

test('deriveLatencias: no sobreescribe valores explicitos del caller', () => {
  const derived = deriveLatencias({
    timestamp_event: 1000,
    timestamp_telegram_delivered: 2000,
    latencia_telegram_ms: 999, // valor explicito
  });
  assert.equal(derived.latencia_telegram_ms, 999, 'valor explicito se preserva');
});

test('deriveLatencias: skip si no hay timestamp_event', () => {
  const derived = deriveLatencias({
    timestamp_telegram_delivered: 2000,
  });
  assert.equal(derived.latencia_telegram_ms, undefined);
});

test('isInsideDir: rechaza paths que escapan via ../', () => {
  const base = path.resolve('/tmp/a');
  assert.equal(isInsideDir(base, path.resolve('/tmp/a/foo')), true);
  assert.equal(isInsideDir(base, path.resolve('/tmp/other')), false);
  assert.equal(isInsideDir(base, path.resolve('/tmp/a/../b')), false);
});

test('dateSuffix: UTC consistente incluso a medianoche', () => {
  const d = dateSuffix(Date.UTC(2026, 3, 17, 0, 0, 0));
  assert.equal(d, '2026-04-17');
  const d2 = dateSuffix(Date.UTC(2026, 3, 17, 23, 59, 59));
  assert.equal(d2, '2026-04-17');
});

test('UX_FILE_REGEX: matchea solo formato exacto', () => {
  assert.ok(UX_FILE_REGEX.test('ux-infra-2026-04-17.json'));
  assert.ok(!UX_FILE_REGEX.test('UX-INFRA-2026-04-17.json'));
  assert.ok(!UX_FILE_REGEX.test('ux-infra-2026-04-17.json.bak'));
  assert.ok(!UX_FILE_REGEX.test('ux-infra-bad.json'));
  assert.ok(!UX_FILE_REGEX.test('ux-infra-26-04-17.json'));
  assert.ok(!UX_FILE_REGEX.test('.last-cleanup'));
});
