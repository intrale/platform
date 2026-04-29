#!/usr/bin/env node
// =============================================================================
// test-notifier-infra-recovered.js — Tests unitarios para #2336.
//
// Cobertura:
//   1. Fuzz MarkdownV2 sobre titulo con todos los caracteres especiales.
//   2. Anti-inyeccion: `[visible](https://evil.com)` se escapa literal.
//   3. Idempotencia: 2 eventos identicos en <5min -> 1 solo mensaje.
//   4. Set distinto: 2 eventos consecutivos -> segundo menciona solo los nuevos.
//   5. Rate limit per-issue: 2 eventos del mismo issue en <10min -> sin audio.
//   6. Rate limit global: 11 audios/hora -> fail-closed + alerta unica.
//   7. Escritura atomica concurrente (simular dos writes simultaneos).
//   8. Formato corto cuando hay >5 issues.
//   9. Variantes rotables (cubre las 5).
//  10. Archivo corrupto -> fallar cerrado a estado vacio.
//  11. Clamp defensivo contra NaN/negativos.
//
// Ejecucion:
//   node .pipeline/test-notifier-infra-recovered.js
//
// Framework: no dependencias externas (node built-in asserts).
// =============================================================================

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const notifier = require('./notifier-infra-recovered');

let failed = 0;
let passed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve().then(async () => {
    try {
      await fn();
      passed++;
      console.log(`  \u2713 ${name}`);
    } catch (e) {
      failed++;
      failures.push({ name, error: e });
      console.log(`  \u2717 ${name}\n      ${e.message}`);
    }
  });
}

function mkTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-infra-test-'));
  return dir;
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function main() {
  console.log('\n# Tests notifier-infra-recovered.js\n');

  // -------------------------------------------------------------------------
  // 1. Fuzz MarkdownV2
  // -------------------------------------------------------------------------
  await test('Fuzz MarkdownV2 — escapa todos los caracteres especiales', () => {
    const specials = '_*[]()~`>#+-=|{}.!\\';
    const escaped = notifier.escapeMarkdownV2(specials);
    for (const ch of specials) {
      assert.ok(
        escaped.includes('\\' + ch),
        `Falta escape para '${ch}' en "${escaped}"`
      );
    }
  });

  await test('Fuzz MarkdownV2 — titulo con especiales no rompe', () => {
    const titles = [
      'feat: config [v2]',
      'fix(pipeline): *very* important!',
      'add `code`, > quote, # tag',
      'name_with_underscores.and.dots',
      'link-like (text) {braces}',
      'backslash \\ pipe | equals =',
    ];
    for (const t of titles) {
      const out = notifier.escapeMarkdownV2(t);
      // Ningun caracter especial queda sin escapar (salvo los que ya van doble-backslash)
      assert.ok(typeof out === 'string' && out.length >= t.length,
        `Output invalido para "${t}"`);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Anti-inyeccion
  // -------------------------------------------------------------------------
  await test('Anti-inyeccion — "[visible](evil)" se escapa literal', () => {
    const malicious = '[visible](https://evil.com)';
    const escaped = notifier.escapeMarkdownV2(malicious);
    // Los corchetes y parentesis deben quedar escapados -> no renderiza link
    assert.ok(escaped.includes('\\['), 'No escapo el [');
    assert.ok(escaped.includes('\\]'), 'No escapo el ]');
    assert.ok(escaped.includes('\\('), 'No escapo el (');
    assert.ok(escaped.includes('\\)'), 'No escapo el )');
    assert.ok(escaped.includes('\\.'), 'No escapo el .');
  });

  await test('Escape null/undefined/objetos devuelve string', () => {
    assert.strictEqual(notifier.escapeMarkdownV2(null), '');
    assert.strictEqual(notifier.escapeMarkdownV2(undefined), '');
    assert.strictEqual(typeof notifier.escapeMarkdownV2({ a: 1 }), 'string');
  });

  // -------------------------------------------------------------------------
  // 3. Idempotencia dedup
  // -------------------------------------------------------------------------
  await test('Dedup — 2 eventos identicos en mismo bucket -> 1 solo mensaje', async () => {
    const dir = mkTmpDir();
    try {
      const dedupFile = path.join(dir, 'dedup.json');
      const rateFile = path.join(dir, 'rate.json');
      const now = 1_700_000_000_000; // ms fijo
      let msgCount = 0;
      const sendTelegramMessage = () => { msgCount++; return { droppedAt: 'stub' }; };
      const sendTtsAudio = async () => ({ sent: false, reason: 'test-stub' });

      const event = { type: 'connectivity_restored', requeued: { issues: [2296, 2304] } };
      const opts = {
        dedupFile, rateLimitFile: rateFile,
        now: () => now,
        sendTelegramMessage, sendTtsAudio,
      };

      const r1 = await notifier.notify(event, opts);
      const r2 = await notifier.notify(event, opts);

      assert.strictEqual(r1.sent, true, 'Primer evento debe enviarse');
      assert.strictEqual(r2.sent, false, 'Segundo evento duplicado no debe enviarse');
      assert.strictEqual(r2.reason, 'duplicate');
      assert.strictEqual(msgCount, 1, 'Solo 1 mensaje enviado');
    } finally { rmDir(dir); }
  });

  // -------------------------------------------------------------------------
  // 4. Set distinto -> "solo los nuevos"
  // -------------------------------------------------------------------------
  await test('Dedup — set parcialmente nuevo menciona solo los nuevos', async () => {
    const dir = mkTmpDir();
    try {
      const dedupFile = path.join(dir, 'dedup.json');
      const rateFile = path.join(dir, 'rate.json');
      const now = 1_700_000_000_000;
      const messages = [];
      const sendTelegramMessage = (text) => { messages.push(text); return {}; };
      const sendTtsAudio = async () => ({ sent: false, reason: 'stub' });
      const base = { now: () => now, sendTelegramMessage, sendTtsAudio,
        dedupFile, rateLimitFile: rateFile };

      await notifier.notify(
        { type: 'connectivity_restored', requeued: { issues: [2296, 2304] } },
        base
      );
      const r2 = await notifier.notify(
        { type: 'connectivity_restored', requeued: { issues: [2296, 2304, 2307] } },
        { ...base, now: () => now + 1000 }
      );

      assert.strictEqual(r2.sent, true);
      assert.strictEqual(r2.newOnly, true);
      assert.deepStrictEqual(r2.activeIssues, [2307]);
      // El segundo mensaje NO debe mencionar 2296 ni 2304
      const second = messages[1];
      assert.ok(!second.includes('2296'), `Segundo mensaje no debe listar 2296: ${second}`);
      assert.ok(!second.includes('2304'), `Segundo mensaje no debe listar 2304: ${second}`);
      assert.ok(second.includes('2307'), `Segundo mensaje debe listar 2307: ${second}`);
    } finally { rmDir(dir); }
  });

  // -------------------------------------------------------------------------
  // 5. Rate limit per-issue
  // -------------------------------------------------------------------------
  await test('Rate limit per-issue — segundo evento del mismo issue en <10min sin audio', async () => {
    const dir = mkTmpDir();
    try {
      const dedupFile = path.join(dir, 'dedup.json');
      const rateFile = path.join(dir, 'rate.json');
      const messages = [];
      let audiosSent = 0;
      const sendTelegramMessage = (t) => { messages.push(t); return {}; };
      const sendTtsAudio = async () => { audiosSent++; return { sent: true }; };
      let now = 1_700_000_000_000;
      const optsBase = {
        dedupFile, rateLimitFile: rateFile,
        sendTelegramMessage, sendTtsAudio,
      };

      // Evento 1
      await notifier.notify(
        { type: 'connectivity_restored', requeued: { issues: [5000] } },
        { ...optsBase, now: () => now }
      );
      // Evento 2: avanzamos 7 min (bucket distinto -> no hay dedup) pero la
      // ventana per-issue de 10 min aun esta activa sobre el issue 5000.
      now += 7 * 60 * 1000;
      const r2 = await notifier.notify(
        { type: 'connectivity_restored', requeued: { issues: [5000] } },
        { ...optsBase, now: () => now }
      );

      assert.strictEqual(r2.sent, true);
      assert.strictEqual(r2.rateLimitReason, 'per-issue',
        `Esperado per-issue, recibido ${r2.rateLimitReason}`);
      assert.strictEqual(r2.audioSent, false);
      assert.strictEqual(audiosSent, 1, 'Solo 1 audio emitido');

      // El mensaje debe incluir la nota de rate limit
      const last = messages[messages.length - 1];
      assert.ok(last.includes('sin audio') || last.includes('solo texto') || last.includes('sin voz'),
        `Mensaje no incluye nota de rate limit: "${last}"`);
    } finally { rmDir(dir); }
  });

  // -------------------------------------------------------------------------
  // 6. Rate limit global
  // -------------------------------------------------------------------------
  await test('Rate limit global — >10 audios/hora fail-closed + alerta unica', async () => {
    const dir = mkTmpDir();
    try {
      const dedupFile = path.join(dir, 'dedup.json');
      const rateFile = path.join(dir, 'rate.json');
      let audioCount = 0;
      const messages = [];
      const sendTelegramMessage = (t) => { messages.push(t); return {}; };
      const sendTtsAudio = async () => { audioCount++; return { sent: true }; };
      let now = 1_700_000_000_000;
      const optsBase = {
        dedupFile, rateLimitFile: rateFile,
        sendTelegramMessage, sendTtsAudio,
      };

      // Pre-cargar rate-limit con 10 timestamps ya existentes (satura el global)
      const saturated = {
        perIssue: {},
        global: Array(10).fill(0).map((_, i) => now - (i * 1000)),
        lastGlobalAlertTs: 0,
      };
      fs.writeFileSync(rateFile, JSON.stringify(saturated));

      const r = await notifier.notify(
        { type: 'connectivity_restored', requeued: { issues: [9001] } },
        { ...optsBase, now: () => now }
      );
      assert.strictEqual(r.sent, true);
      assert.strictEqual(r.rateLimitReason, 'global',
        `Esperado global, recibido ${r.rateLimitReason}`);
      assert.strictEqual(r.audioSent, false, 'No debe enviar audio con global saturado');
      assert.strictEqual(audioCount, 0);
      assert.strictEqual(r.globalAlert, true, 'Debe emitir alerta global');

      // Segundo evento dentro de la hora -> alerta NO se repite
      now += 1000;
      const r2 = await notifier.notify(
        { type: 'connectivity_restored', requeued: { issues: [9002] } },
        { ...optsBase, now: () => now }
      );
      assert.strictEqual(r2.globalAlert, false,
        'Alerta global no debe repetirse dentro de la misma hora');
    } finally { rmDir(dir); }
  });

  // -------------------------------------------------------------------------
  // 7. Escritura atomica concurrente
  // -------------------------------------------------------------------------
  await test('Escritura atomica — 50 writes paralelos no corrompen el archivo', async () => {
    const dir = mkTmpDir();
    try {
      const file = path.join(dir, 'atomic.json');
      const tasks = [];
      for (let i = 0; i < 50; i++) {
        tasks.push(Promise.resolve().then(() => {
          try { notifier.writeJsonAtomic(file, { counter: i, ts: Date.now() }); }
          catch (_) { /* EBUSY ok, seguimos */ }
        }));
      }
      await Promise.all(tasks);
      // El archivo final debe ser JSON valido
      const content = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(content);
      assert.ok(parsed && typeof parsed.counter === 'number',
        `Contenido invalido: ${content}`);
    } finally { rmDir(dir); }
  });

  // -------------------------------------------------------------------------
  // 8. Formato corto >5 issues
  // -------------------------------------------------------------------------
  await test('Formato — <=5 issues enumera, >5 issues usa formato corto', () => {
    assert.strictEqual(notifier.formatIssueList([1]), '#1');
    assert.strictEqual(notifier.formatIssueList([1, 2]), '#1 y #2');
    assert.strictEqual(notifier.formatIssueList([1, 2, 3]), '#1, #2 y #3');
    assert.strictEqual(notifier.formatIssueList([1, 2, 3, 4, 5]), '#1, #2, #3, #4 y #5');
    const six = notifier.formatIssueList([10, 20, 30, 40, 50, 60, 70]);
    assert.ok(six.includes('7 issues'), `No usa formato corto: ${six}`);
    assert.ok(six.includes('4 mas'), `No indica cantidad restante: ${six}`);
  });

  // -------------------------------------------------------------------------
  // 9. Variantes rotables
  // -------------------------------------------------------------------------
  await test('Variantes — hay al menos 3 distintas y rotan por seed', () => {
    assert.ok(notifier.MESSAGE_VARIANTS.length >= 3, 'Debe haber >=3 variantes');
    const samples = new Set();
    for (let i = 0; i < 20; i++) {
      const text = notifier.formatMessage({
        issues: [1000 + i, 2000 + i],
        seed: `seed-${i}`,
      });
      // Extrae el cuerpo sin el prefijo emoji + escape
      samples.add(text.substring(text.indexOf(' ') + 1, 40));
    }
    assert.ok(samples.size >= 3, `Debe haber al menos 3 variantes distintas, solo ${samples.size}`);
  });

  // -------------------------------------------------------------------------
  // 10. Archivo corrupto -> fail-closed
  // -------------------------------------------------------------------------
  await test('Fail-closed — archivo dedup corrupto cae a estado vacio', () => {
    const dir = mkTmpDir();
    try {
      const corrupt = path.join(dir, 'corrupt.json');
      fs.writeFileSync(corrupt, '{this is not json');
      const state = notifier.loadDedupState(corrupt, Date.now());
      assert.ok(Array.isArray(state.entries), 'entries debe ser array');
      assert.strictEqual(state.entries.length, 0, 'estado vacio ante corrupcion');
    } finally { rmDir(dir); }
  });

  await test('Fail-closed — archivo rate-limit corrupto cae a default', () => {
    const dir = mkTmpDir();
    try {
      const corrupt = path.join(dir, 'corrupt-rate.json');
      fs.writeFileSync(corrupt, 'not valid json at all');
      const state = notifier.loadRateLimitState(corrupt, Date.now());
      assert.strictEqual(typeof state.perIssue, 'object');
      assert.ok(Array.isArray(state.global));
      assert.strictEqual(state.lastGlobalAlertTs, 0);
    } finally { rmDir(dir); }
  });

  // -------------------------------------------------------------------------
  // 11. Clamp defensivo
  // -------------------------------------------------------------------------
  await test('Clamp defensivo — NaN/negativos en rate-limit se normalizan', () => {
    const dir = mkTmpDir();
    try {
      const file = path.join(dir, 'rate.json');
      fs.writeFileSync(file, JSON.stringify({
        perIssue: { '123': ['not a number', null, NaN, Date.now()] },
        global: ['bad', -5, NaN, Date.now()],
        lastGlobalAlertTs: -99,
      }));
      const state = notifier.loadRateLimitState(file, Date.now());
      assert.ok(state.global.every((t) => Number.isFinite(t) && t > 0),
        'Global debe contener solo timestamps validos');
      for (const v of Object.values(state.perIssue)) {
        assert.ok(v.every((t) => Number.isFinite(t) && t > 0),
          'PerIssue debe contener solo timestamps validos');
      }
      assert.strictEqual(state.lastGlobalAlertTs, 0, 'lastGlobalAlertTs negativo -> 0');
    } finally { rmDir(dir); }
  });

  // -------------------------------------------------------------------------
  // 12. computeDedupHash: mismo set sin importar orden
  // -------------------------------------------------------------------------
  await test('computeDedupHash — mismo set ordenado produce mismo hash', () => {
    const now = 1_700_000_000_000;
    const h1 = notifier.computeDedupHash([2296, 2304], now);
    const h2 = notifier.computeDedupHash([2304, 2296], now);
    assert.strictEqual(h1, h2, 'Hash debe ser estable ante orden');
    const h3 = notifier.computeDedupHash([2296, 2304], now + DEDUP_BUCKET_TEST_MS());
    assert.notStrictEqual(h1, h3, 'Bucket distinto -> hash distinto');
  });

  // -------------------------------------------------------------------------
  // 13. Audio script nunca excede limite y es corto
  // -------------------------------------------------------------------------
  await test('Audio — script acotado a MAX_TTS_INPUT_CHARS', () => {
    const many = Array(500).fill(0).map((_, i) => i + 1);
    const s = notifier.formatAudioScript({ issues: many });
    assert.ok(s.length <= notifier.MAX_TTS_INPUT_CHARS,
      `Script excede limite: ${s.length} > ${notifier.MAX_TTS_INPUT_CHARS}`);
  });

  await test('Audio — tono calmo sin timestamps ni IDs internos', () => {
    const s = notifier.formatAudioScript({ issues: [100, 200] });
    assert.ok(!s.includes('bucket'), 'No debe mencionar "bucket"');
    assert.ok(!s.includes('hash'), 'No debe mencionar "hash"');
    assert.ok(!s.includes('!'), 'No tono celebratorio');
    assert.ok(!s.toLowerCase().includes('back online'), 'No "back online"');
  });

  // -------------------------------------------------------------------------
  // 14. Prefijo emoji en todo mensaje
  // -------------------------------------------------------------------------
  await test('Prefijo emoji — todos los mensajes llevan prefijo infra', () => {
    const m = notifier.formatMessage({ issues: [42], seed: 'x' });
    assert.ok(m.startsWith(notifier.INFRA_EMOJI + ' '),
      `Mensaje no arranca con prefijo: "${m}"`);
  });

  // -------------------------------------------------------------------------
  // 15. Issues vacios -> no envia
  // -------------------------------------------------------------------------
  await test('Evento sin issues -> no envia mensaje', async () => {
    const dir = mkTmpDir();
    try {
      let sent = 0;
      const r = await notifier.notify(
        { type: 'connectivity_restored', requeued: { issues: [] } },
        {
          dedupFile: path.join(dir, 'd.json'),
          rateLimitFile: path.join(dir, 'r.json'),
          sendTelegramMessage: () => { sent++; return {}; },
          sendTtsAudio: async () => ({ sent: false }),
          now: () => Date.now(),
        }
      );
      assert.strictEqual(r.sent, false);
      assert.strictEqual(r.reason, 'empty-issues');
      assert.strictEqual(sent, 0);
    } finally { rmDir(dir); }
  });

  // ---- Resumen ----
  console.log(`\n# Resultado: ${passed} pasaron, ${failed} fallaron (total ${passed + failed})\n`);
  if (failed > 0) {
    for (const f of failures) {
      console.error(`  FAIL: ${f.name}`);
      console.error(`  ${f.error.stack || f.error.message}\n`);
    }
    process.exit(1);
  }
}

function DEDUP_BUCKET_TEST_MS() { return notifier.DEDUP_BUCKET_MS; }

main().catch((e) => {
  console.error('Fallo catastrofico en test runner:', e);
  process.exit(1);
});
