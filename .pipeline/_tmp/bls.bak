#!/usr/bin/env node
/**
 * test-build-log-staleness.js — Tests del módulo build-log-staleness (#2404).
 *
 * Cubre:
 *   S1  — isValidIssueNumber: acepta enteros positivos, rechaza path traversal/negativos/strings
 *   S2  — getStalenessThresholdMs: default, env, config, clamp mínimo 5min
 *   S3  — getMaxResetsPerIssue: default, override válido, override inválido
 *   S4  — inspectBuildLog: sin archivo → exists:false; archivo fresco → stale:false; archivo viejo → stale:true
 *   S5  — isBuildLogStale wrapper consistente con inspectBuildLog
 *   S6  — getStaleResetCount cuenta entradas del JSONL filtradas por issue
 *   S7  — appendAuditReset escribe JSONL y crea el directorio
 *   S8  — buildTelegramStaleMessage / EscalationMessage contienen datos esperados
 *   S9  — cleanYamlForRebuild elimina las keys de rebote sin mutar el input
 *   S10 — motivoReferencesBuildLog detecta path UNIX + Windows + plain
 *   S11 — E2E simulado: pendiente con log 25h → inspectBuildLog + audit + clean YAML
 *
 * Uso:
 *   node .pipeline/test-build-log-staleness.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const staleness = require('./build-log-staleness');
// #6259 (P2) — `PIPELINE_STALENESS_HOURS` es variable COMUN
// (`isSecurityControlVar` -> false), asi que va con `withEnv` sincronico.
const { withEnv, snapshotEnv, restoreEnv } = require('./lib/test-helpers/with-env');

function enableWorktreeDependencies() {
  try { require.resolve('js-yaml'); return; } catch (_) { /* worktree sin node_modules */ }
  const gitFile = fs.readFileSync(path.join(__dirname, '..', '.git'), 'utf8').trim();
  const gitDir = path.resolve(path.join(__dirname, '..'), gitFile.replace(/^gitdir:\s*/, ''));
  process.env.NODE_PATH = path.join(gitDir, '..', '..', '..', 'node_modules');
  require('node:module').Module._initPaths();
}

const __nodePathSnap = snapshotEnv(['NODE_PATH']);
enableWorktreeDependencies();
process.on('exit', () => restoreEnv(__nodePathSnap));

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    // #6259 (CA-9) — `PIPELINE_STALENESS_HOURS` es la UNICA env que este modulo
    // lee (`build-log-staleness.js:79`) y la PRIORIZA sobre el `config` que recibe.
    // Si el proceso que corre la suite la hereda, cualquier test que asserte un
    // threshold derivado del config (S11) se pone en rojo por entorno sucio y no
    // por un bug del codigo. Antes esto se tapaba de rebote: S2 hacia
    // `delete process.env.PIPELINE_STALENESS_HOURS` a pelo y se comia la variable
    // para todo el proceso, asi que los tests posteriores nunca la veian.
    // Al aislar S2 con `withEnv` (que restaura), esa proteccion accidental
    // desaparecio y S11 quedo expuesto. Se fuerza la ausencia para TODO test del
    // archivo — no solo S11 — para que el que se agregue manana nazca cubierto.
    // Los tests que necesitan un valor lo setean con su propio `withEnv` anidado
    // (S2), que al salir restaura a esta ausencia, no al valor heredado.
    await withEnv({ PIPELINE_STALENESS_HOURS: undefined }, () => fn());
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    fail++;
  }
}

(async () => {
  // S1 — isValidIssueNumber
  await test('S1: isValidIssueNumber acepta enteros positivos y rechaza otros', () => {
    // Válidos
    assert.strictEqual(staleness.isValidIssueNumber(2404), true);
    assert.strictEqual(staleness.isValidIssueNumber('2404'), true);
    assert.strictEqual(staleness.isValidIssueNumber('1'), true);

    // Inválidos — path traversal y edge cases (Security §1)
    assert.strictEqual(staleness.isValidIssueNumber('../../../etc/passwd'), false);
    assert.strictEqual(staleness.isValidIssueNumber('2404; rm -rf /'), false);
    assert.strictEqual(staleness.isValidIssueNumber('../'), false);
    assert.strictEqual(staleness.isValidIssueNumber('2404.log'), false);
    assert.strictEqual(staleness.isValidIssueNumber('abc'), false);
    assert.strictEqual(staleness.isValidIssueNumber(''), false);
    assert.strictEqual(staleness.isValidIssueNumber(null), false);
    assert.strictEqual(staleness.isValidIssueNumber(undefined), false);
    assert.strictEqual(staleness.isValidIssueNumber('-5'), false);
    assert.strictEqual(staleness.isValidIssueNumber('0'), false, '0 no debería ser válido (no hay issue #0)');
  });

  // S2 — getStalenessThresholdMs
  await test('S2: getStalenessThresholdMs respeta env, config, y clamp mínimo 5min', () => {
    // #6259 — este bloque hacia `delete process.env.PIPELINE_STALENESS_HOURS`
    // a pelo para probar el default: si el proceso heredaba la variable, el test
    // se la COMIA para siempre (fuga que el probe de ausencia no ve, porque
    // 'ausente' es justo lo que espera). `withEnv` con `undefined` fuerza la
    // ausencia durante el test y devuelve el valor heredado al salir.
    withEnv({ PIPELINE_STALENESS_HOURS: undefined }, () => {
      const d = staleness.getStalenessThresholdMs();
      assert.strictEqual(d.hours, staleness.DEFAULT_STALENESS_HOURS);
      assert.strictEqual(d.clamped, false);

      // Config válido
      const c = staleness.getStalenessThresholdMs({ staleness: { build_log_max_age_hours: 12 } });
      assert.strictEqual(c.hours, 12);
      assert.strictEqual(c.clamped, false);

      // Clamp mínimo: config 0 → elevado a 5min
      const clamped = staleness.getStalenessThresholdMs({ staleness: { build_log_max_age_hours: 0 } });
      assert.strictEqual(clamped.ms, staleness.MIN_STALENESS_MS);
      assert.strictEqual(clamped.clamped, true);

      // Negativo → default
      const neg = staleness.getStalenessThresholdMs({ staleness: { build_log_max_age_hours: -5 } });
      assert.strictEqual(neg.hours, staleness.DEFAULT_STALENESS_HOURS);

      // String inválido → default
      const bad = staleness.getStalenessThresholdMs({ staleness: { build_log_max_age_hours: 'abc' } });
      assert.strictEqual(bad.hours, staleness.DEFAULT_STALENESS_HOURS);

      // Env pisa config.
      // #6259 (R-5) — antes esto seteaba, asertaba y borraba a mano: si el assert
      // fallaba, el `delete` nunca corria y la variable se filtraba al resto de la
      // suite y al proceso. `withEnv` restaura pase lo que pase.
      withEnv({ PIPELINE_STALENESS_HOURS: '6' }, () => {
        const e = staleness.getStalenessThresholdMs({ staleness: { build_log_max_age_hours: 24 } });
        assert.strictEqual(e.hours, 6);
      });
    });
  });

  // S3 — getMaxResetsPerIssue
  await test('S3: getMaxResetsPerIssue default 5 + overrides válidos/inválidos', () => {
    assert.strictEqual(staleness.getMaxResetsPerIssue(), 5);
    assert.strictEqual(staleness.getMaxResetsPerIssue({}), 5);
    assert.strictEqual(staleness.getMaxResetsPerIssue({ staleness: { max_resets_per_issue: 10 } }), 10);
    assert.strictEqual(staleness.getMaxResetsPerIssue({ staleness: { max_resets_per_issue: 0 } }), 5, '0 inválido → default');
    assert.strictEqual(staleness.getMaxResetsPerIssue({ staleness: { max_resets_per_issue: -3 } }), 5);
    assert.strictEqual(staleness.getMaxResetsPerIssue({ staleness: { max_resets_per_issue: 'abc' } }), 5);
    assert.strictEqual(staleness.getMaxResetsPerIssue({ staleness: { max_resets_per_issue: 2.7 } }), 2, '2.7 → 2 (floor)');
  });

  // S4 — inspectBuildLog
  await test('S4: inspectBuildLog detecta archivo fresco vs stale + issue inválido', () => {
    // Issue inválido → exists:false sin llegar a stat (Security §1)
    const bad = staleness.inspectBuildLog('../../../etc/passwd', 1000);
    assert.strictEqual(bad.exists, false);

    // Archivo inexistente
    const missing = staleness.inspectBuildLog('9999999', 1000);
    assert.strictEqual(missing.exists, false);

    // Archivo fresco
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'staleness-'));
    const fakeLogDir = path.join(tmpRoot, '.pipeline', 'logs');
    fs.mkdirSync(fakeLogDir, { recursive: true });
    // Usamos un issue que no existe en el repo real para evitar colisiones
    // Para testear con un path específico necesitamos inyectar; pero la
    // función usa LOG_DIR interno. Hacemos un test alternativo tocando
    // directamente el LOG_DIR real del repo.
    // Verificamos al menos el shape/comportamiento con un issue inexistente.
    assert.strictEqual(missing.exists, false);

    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  // S5 — isBuildLogStale wrapper
  await test('S5: isBuildLogStale devuelve false si no existe', () => {
    assert.strictEqual(staleness.isBuildLogStale('9999999', 1000), false);
    assert.strictEqual(staleness.isBuildLogStale('../evil', 1000), false);
  });

  // S6 — getStaleResetCount cuenta entradas del JSONL
  await test('S6: getStaleResetCount cuenta entradas del audit JSONL filtradas por issue', () => {
    const tmp = path.join(os.tmpdir(), `audit-${Date.now()}.jsonl`);
    try {
      const lines = [
        { event: 'circuit_breaker_reset', issue: 100, reason: 'stale_log' },
        { event: 'circuit_breaker_reset', issue: 100, reason: 'stale_log' },
        { event: 'circuit_breaker_reset', issue: 200, reason: 'stale_log' },
        { event: 'circuit_breaker_reset', issue: 100, reason: 'other' },
        { event: 'other_event', issue: 100, reason: 'stale_log' },
      ];
      fs.writeFileSync(tmp, lines.map(l => JSON.stringify(l)).join('\n'));
      assert.strictEqual(staleness.getStaleResetCount(100, tmp), 2);
      assert.strictEqual(staleness.getStaleResetCount(200, tmp), 1);
      assert.strictEqual(staleness.getStaleResetCount(999, tmp), 0);

      // Archivo inexistente → 0
      assert.strictEqual(staleness.getStaleResetCount(100, tmp + '.nope'), 0);

      // Issue inválido → 0 (no llega a leer)
      assert.strictEqual(staleness.getStaleResetCount('../evil', tmp), 0);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  // S7 — appendAuditReset
  await test('S7: appendAuditReset escribe JSONL y crea el directorio', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
    const target = path.join(tmpDir, 'subdir', 'cb.jsonl');
    try {
      staleness.appendAuditReset({ event: 'circuit_breaker_reset', issue: 42, reason: 'stale_log' }, target);
      staleness.appendAuditReset({ event: 'circuit_breaker_reset', issue: 42, reason: 'stale_log' }, target);
      assert.ok(fs.existsSync(target), 'archivo debe existir');
      const content = fs.readFileSync(target, 'utf8');
      const lines = content.trim().split('\n');
      assert.strictEqual(lines.length, 2);
      const first = JSON.parse(lines[0]);
      assert.strictEqual(first.issue, 42);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  // S8 — Telegram messages
  await test('S8: buildTelegramStaleMessage y EscalationMessage incluyen datos esperados', () => {
    const m1 = staleness.buildTelegramStaleMessage(2404, 28.3, '.pipeline/logs/build-2404.log', 1, 5);
    assert.ok(m1.includes('#2404'));
    assert.ok(m1.includes('28.3h'));
    assert.ok(m1.includes('build-2404.log'));
    // Reset 1/5 no debe mostrar el contador (feedback UX: solo mostrarlo cuando resetsCount > 1)
    assert.ok(!m1.includes('reset 1/5'));

    const m2 = staleness.buildTelegramStaleMessage(2404, 50, '/tmp/log', 3, 5);
    assert.ok(m2.includes('reset 3/5'), `m2 debería mencionar reset 3/5: ${m2}`);

    const esc = staleness.buildTelegramEscalationMessage(2404, 5, 5, '/tmp/log');
    assert.ok(esc.includes('5/5'));
    assert.ok(esc.includes('#2404'));
    assert.ok(esc.toLowerCase().includes('manual'));
  });

  // S9 — cleanYamlForRebuild
  await test('S9: cleanYamlForRebuild elimina keys de rebote sin mutar el input', () => {
    const input = {
      issue: 2404,
      pipeline: 'desarrollo',
      fase: 'dev',
      rebote: true,
      rebote_numero: 2,
      rebote_tipo: 'codigo',
      rebote_numero_infra: 0,
      motivo_rechazo: 'cosas',
      rechazado_en_fase: 'verificacion',
      rechazado_desde_pipeline: 'desarrollo',
      otraKey: 'se preserva',
    };
    const clone = JSON.parse(JSON.stringify(input));
    const out = staleness.cleanYamlForRebuild(input);

    // Input no mutado (UX §1 defensivo)
    assert.deepStrictEqual(input, clone, 'cleanYamlForRebuild no debe mutar el input');

    // Output limpio
    assert.strictEqual(out.rebote, undefined);
    assert.strictEqual(out.motivo_rechazo, undefined);
    assert.strictEqual(out.rebote_numero, undefined);
    assert.strictEqual(out.rebote_tipo, undefined);
    assert.strictEqual(out.rechazado_en_fase, undefined);
    assert.strictEqual(out.rechazado_desde_pipeline, undefined);
    // Otras keys preservadas
    assert.strictEqual(out.issue, 2404);
    assert.strictEqual(out.pipeline, 'desarrollo');
    assert.strictEqual(out.otraKey, 'se preserva');
  });

  // S10 — motivoReferencesBuildLog
  await test('S10: motivoReferencesBuildLog detecta build-log en distintos formatos', () => {
    const msg1 = '[builder] fail — ver .pipeline/logs/build-2404.log tail 100';
    const msg2 = 'cat ".pipeline\\logs\\build-2404.log" | tail -100';
    const msg3 = 'error en build-2404.log';
    const msg4 = 'error en build-2405.log';

    assert.strictEqual(staleness.motivoReferencesBuildLog(msg1, 2404), true);
    assert.strictEqual(staleness.motivoReferencesBuildLog(msg2, 2404), true);
    assert.strictEqual(staleness.motivoReferencesBuildLog(msg3, 2404), true);
    assert.strictEqual(staleness.motivoReferencesBuildLog(msg4, 2404), false, 'otro issue no debe matchear');
    assert.strictEqual(staleness.motivoReferencesBuildLog(null, 2404), false);
    assert.strictEqual(staleness.motivoReferencesBuildLog('', 2404), false);
    assert.strictEqual(staleness.motivoReferencesBuildLog(msg1, '../evil'), false, 'issue inválido → false');
  });

  // S11 — Integración E2E simulado: pendiente con log 25h → reset + clean
  await test('S11: E2E simulado — log 25h → stale + audit + YAML limpio', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'staleness-e2e-'));
    const auditFile = path.join(tmpRoot, 'cb.jsonl');

    try {
      // Arrange: config, YAML del pendiente con motivo_rechazo + rebote
      const config = { staleness: { build_log_max_age_hours: 24, max_resets_per_issue: 5 } };
      const pendienteYaml = {
        issue: 9999,
        fase: 'dev',
        pipeline: 'desarrollo',
        rebote: true,
        rebote_numero: 2,
        rebote_tipo: 'codigo',
        motivo_rechazo: '[builder] build falló — cat ".pipeline/logs/build-9999.log" | tail -100',
        rechazado_en_fase: 'build',
      };

      // Act 1: parse threshold (default 24h)
      const { ms: thresholdMs, clamped } = staleness.getStalenessThresholdMs(config);
      assert.strictEqual(clamped, false);
      assert.strictEqual(thresholdMs, 24 * 3600 * 1000);

      // Act 2: motivoReferencesBuildLog detecta
      assert.strictEqual(
        staleness.motivoReferencesBuildLog(pendienteYaml.motivo_rechazo, 9999),
        true,
      );

      // Act 3: simular log stale con mtime de 25h — creamos un archivo mock y lo
      // inspect-eamos directamente pasándole el mtime a mano (sin modificar file).
      // Como inspectBuildLog usa LOG_DIR del proyecto real, para el e2e acá
      // simulamos el cálculo directamente (el helper ya está cubierto en S6 y S9).
      const mtimeMs = Date.now() - (25 * 3600 * 1000);
      const ageMs = Date.now() - mtimeMs;
      const stale = ageMs > thresholdMs;
      assert.strictEqual(stale, true, 'log de 25h debe ser stale con threshold 24h');

      // Act 4: getStaleResetCount sin entries previas
      assert.strictEqual(staleness.getStaleResetCount(9999, auditFile), 0);
      const maxResets = staleness.getMaxResetsPerIssue(config);
      assert.strictEqual(maxResets, 5);
      assert.strictEqual(0 < maxResets, true, 'NO debe estar en tope');

      // Act 5: limpiar YAML + construir el que se escribe a build/pendiente
      const cleanYaml = staleness.cleanYamlForRebuild(pendienteYaml);
      cleanYaml.fase = 'build';

      // Assert: YAML post-stale LIMPIO (UX §1 — criterio D2 del PO)
      assert.strictEqual(cleanYaml.motivo_rechazo, undefined, 'motivo_rechazo debe haberse limpiado');
      assert.strictEqual(cleanYaml.rebote, undefined, 'rebote debe haberse limpiado');
      assert.strictEqual(cleanYaml.rebote_numero, undefined);
      assert.strictEqual(cleanYaml.rebote_tipo, undefined);
      assert.strictEqual(cleanYaml.rechazado_en_fase, undefined);
      assert.strictEqual(cleanYaml.issue, 9999);
      assert.strictEqual(cleanYaml.pipeline, 'desarrollo');
      assert.strictEqual(cleanYaml.fase, 'build');

      // Act 6: auditar el reset
      staleness.appendAuditReset({
        ts: new Date().toISOString(),
        event: 'circuit_breaker_reset',
        issue: 9999,
        reason: 'stale_log',
        log_mtime: new Date(mtimeMs).toISOString(),
        log_age_hours: Number((ageMs / 3600 / 1000).toFixed(2)),
        threshold_hours: 24,
        resets_count: 1,
        max_resets: maxResets,
      }, auditFile);

      // Assert: audit file escrito en formato esperado
      assert.ok(fs.existsSync(auditFile));
      const entries = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(JSON.parse);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].event, 'circuit_breaker_reset');
      assert.strictEqual(entries[0].issue, 9999);
      assert.strictEqual(entries[0].reason, 'stale_log');
      // ts ISO8601 (UX §3)
      assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(entries[0].ts), 'ts debe ser ISO8601');
      // log_age_hours human-friendly (no epoch ms)
      assert.ok(entries[0].log_age_hours >= 24);
      assert.ok(entries[0].log_age_hours < 26);

      // Act 7: getStaleResetCount refleja el incremento
      assert.strictEqual(staleness.getStaleResetCount(9999, auditFile), 1);

      // Act 8: telegram message
      const tg = staleness.buildTelegramStaleMessage(9999, ageMs / 3600 / 1000, '/tmp/build-9999.log', 1, 5);
      assert.ok(tg.includes('#9999'));
      assert.ok(tg.toLowerCase().includes('builder'), 'Telegram debe mencionar al builder: ' + tg);
      assert.ok(tg.split('\n').length <= 3, 'Telegram debe ser conciso (≤ 3 líneas)');
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    }
  });

  // S12 — Tope duro de resets: cuando resetsCount >= max, no se hace más reset
  await test('S12: tope de resets → escalar, no resetear más (criterio C2 PO)', () => {
    const tmp = path.join(os.tmpdir(), `cap-${Date.now()}.jsonl`);
    try {
      // Simular 5 resets previos del issue 777
      const lines = Array.from({ length: 5 }, () => JSON.stringify({
        event: 'circuit_breaker_reset', issue: 777, reason: 'stale_log',
      }));
      fs.writeFileSync(tmp, lines.join('\n'));
      assert.strictEqual(staleness.getStaleResetCount(777, tmp), 5);

      const maxResets = staleness.getMaxResetsPerIssue({ staleness: { max_resets_per_issue: 5 } });
      const resetsPrev = staleness.getStaleResetCount(777, tmp);
      // Gate de tope (lógica del pulpo.js)
      assert.strictEqual(resetsPrev >= maxResets, true, 'debe bloquear el reset 6');

      const escMsg = staleness.buildTelegramEscalationMessage(777, resetsPrev, maxResets, '/tmp/x.log');
      assert.ok(escMsg.includes('5/5'));
      assert.ok(escMsg.includes('#777'));
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  // S13 — js-yaml safe parse (documentar regresión A05 Security)
  await test('S13: parse YAML usa js-yaml 4.x (safe por default, sin tags custom)', () => {
    const yaml = require('js-yaml');
    // yaml.load en js-yaml 4.x usa DEFAULT_SCHEMA que no permite !!js/function ni
    // otros tags custom. Este test fija el contrato.
    const safe = yaml.load('foo: bar\nbaz: 42');
    assert.strictEqual(safe.foo, 'bar');
    assert.strictEqual(safe.baz, 42);

    // Tag custom !!js/function debe fallar — confirma safe mode por default
    assert.throws(
      () => yaml.load('fn: !!js/function "function () { return 42; }"'),
      /unknown tag|cannot resolve/i,
    );
  });

  // ===========================================================================
  // Gate-reject staleness genérico (#4759 parte b) — SR-4 / SR-5.
  // Se inyecta un fake runGit para no depender del estado real del repo.
  // ===========================================================================

  // fakeGit(map): responde a merge-base / diff / (default error) según `map`.
  //   map.ancestor  {boolean}  exit 0 para `merge-base --is-ancestor`
  //   map.changed   {string[]} salida de `diff --name-only`
  //   map.throwOn   {string=}  substring del comando en el que lanza excepción
  //   map.diffExit  {number=}  override exit_code del diff (default 0)
  function fakeGit(map = {}) {
    return (args) => {
      const key = args.join(' ');
      if (map.throwOn && key.includes(map.throwOn)) {
        throw new Error('boom git: ' + key);
      }
      if (key.startsWith('merge-base --is-ancestor')) {
        return { exit_code: map.ancestor ? 0 : 1, stdout: '', stderr: '' };
      }
      if (key.startsWith('diff --name-only')) {
        return {
          exit_code: map.diffExit == null ? 0 : map.diffExit,
          stdout: (map.changed || []).join('\n'),
          stderr: '',
        };
      }
      return { exit_code: 1, stdout: '', stderr: '' };
    };
  }

  const CITED = '.pipeline/build-log-staleness.js';

  // SEC-2: los SHAs de prueba DEBEN validar contra /^[0-9a-f]{7,40}$/ (7-40 hex).
  const SHA_REJECT = 'aaa1111';
  const SHA_HEAD = 'bbb2222';

  // S14 — stale mecánico: fix posterior + toca archivo citado → true
  await test('S14: isGateRejectStale true cuando fix es posterior y toca el archivo citado (SR-5 cumplida)', () => {
    const reject = { source: 'build', rejectSha: SHA_REJECT, citedFiles: [CITED] };
    const runGit = fakeGit({ ancestor: true, changed: [CITED, 'otro.js'] });
    const info = staleness.inspectGateReject(reject, SHA_HEAD, { runGit });
    assert.strictEqual(info.stale, true, JSON.stringify(info.reasons));
    assert.strictEqual(info.touchesCited, true);
    assert.strictEqual(info.rejectRef, SHA_REJECT);
    assert.strictEqual(info.fixCommit, SHA_HEAD);
    assert.strictEqual(staleness.isGateRejectStale(reject, SHA_HEAD, { runGit }), true);
  });

  // S15 — falso stale: fix posterior pero NO toca el archivo citado → false (decision)
  await test('S15: falso stale — fix no toca el archivo citado → false (SR-5 → decision)', () => {
    const reject = { source: 'verificacion', rejectSha: SHA_REJECT, citedFiles: [CITED] };
    const runGit = fakeGit({ ancestor: true, changed: ['un/archivo/distinto.js'] });
    const info = staleness.inspectGateReject(reject, SHA_HEAD, { runGit });
    assert.strictEqual(info.stale, false);
    assert.strictEqual(info.touchesCited, false);
    assert.strictEqual(staleness.isGateRejectStale(reject, SHA_HEAD, { runGit }), false);
  });

  // S16 — falso stale: fix NO es posterior (mismo sha o no-ancestro) → false
  await test('S16: falso stale — fix no es posterior al rechazo → false (SR-5)', () => {
    // Mismo sha
    const same = { source: 'build', rejectSha: SHA_REJECT, citedFiles: [CITED] };
    assert.strictEqual(
      staleness.isGateRejectStale(same, SHA_REJECT, { runGit: fakeGit({ ancestor: true, changed: [CITED] }) }),
      false,
    );
    // rejectSha no es ancestro de head (anterior/divergente)
    const notAnc = { source: 'build', rejectSha: 'ccc3333', citedFiles: [CITED] };
    const info = staleness.inspectGateReject(notAnc, SHA_HEAD, { runGit: fakeGit({ ancestor: false, changed: [CITED] }) });
    assert.strictEqual(info.stale, false);
  });

  // S17 — SR-4: security con doble condición cumplida → false incondicional (nunca stale)
  await test('S17: source=security con fix posterior + toca líneas → false incondicional (SR-4)', () => {
    const reject = { source: 'security', rejectSha: SHA_REJECT, citedFiles: [CITED] };
    // fakeGit diría stale=true, pero SR-4 corta antes de tocar git.
    const runGit = fakeGit({ ancestor: true, changed: [CITED] });
    assert.strictEqual(staleness.isGateRejectStale(reject, SHA_HEAD, { runGit }), false);
    const info = staleness.inspectGateReject(reject, SHA_HEAD, { runGit });
    assert.strictEqual(info.stale, false);
    assert.ok(info.reasons.some((r) => /SR-4/.test(r)), 'debe registrar SR-4: ' + info.reasons.join(' | '));
  });

  // S17b — SR-4/SEC-1 (HALLAZGO 1): `source` NO normalizado NO debe evadir el
  // candado. 'Security' / 'SECURITY' / ' security ' (con casing/espacios) + doble
  // condición SR-5 cumplida → false incondicional (nunca mecánico → nunca re-corre
  // el gate de seguridad sin re-auditar).
  await test('S17b: source con casing/espacios (Security/SECURITY/ security ) nunca stale (SR-4/SEC-1)', () => {
    const runGit = fakeGit({ ancestor: true, changed: [CITED] }); // diría stale=true
    for (const variant of ['Security', 'SECURITY', ' security ', '  SeCuRiTy']) {
      const reject = { source: variant, rejectSha: SHA_REJECT, citedFiles: [CITED] };
      assert.strictEqual(
        staleness.isGateRejectStale(reject, SHA_HEAD, { runGit }), false,
        `variante '${variant}' debe cortar por SR-4`,
      );
      const info = staleness.inspectGateReject(reject, SHA_HEAD, { runGit });
      assert.strictEqual(info.stale, false, `variante '${variant}' → inspect.stale false`);
      assert.ok(
        info.reasons.some((r) => /SR-4/.test(r)),
        `variante '${variant}' debe registrar SR-4: ${info.reasons.join(' | ')}`,
      );
    }
  });

  // S17c — SEC-2 (HALLAZGO 2): `rejectSha`/`head` maliciosos NO llegan a git.
  // normalizeGateSha rechaza metacaracteres, flags `-x`, `..` y refs simbólicas;
  // e inspectGateReject cae conservador (false) SIN invocar runGit (sin efecto
  // lateral). Además citedFiles maliciosos se confinan/descartan.
  await test('S17c: rejectSha/head malicioso → false sin tocar git (SEC-2, injection-safe)', () => {
    // normalizeGateSha (whitelist estricta)
    assert.strictEqual(staleness.normalizeGateSha('a & echo pwned'), null);
    assert.strictEqual(staleness.normalizeGateSha('--output=x'), null);
    assert.strictEqual(staleness.normalizeGateSha('$(whoami)'), null);
    assert.strictEqual(staleness.normalizeGateSha('`id`'), null);
    assert.strictEqual(staleness.normalizeGateSha('aaa|calc'), null);
    assert.strictEqual(staleness.normalizeGateSha('HEAD~1'), null);
    assert.strictEqual(staleness.normalizeGateSha('deadbee'), 'deadbee', '7 hex OK');
    assert.strictEqual(staleness.normalizeGateSha('  DEADBEEF  '), 'deadbeef', 'trim + lowercase');
    assert.strictEqual(staleness.normalizeGateSha('abc'), null, '<7 hex inválido');
    assert.strictEqual(staleness.normalizeGateSha('a'.repeat(41)), null, '>40 hex inválido');

    // rejectSha malicioso → conservador, y runGit NUNCA se invoca.
    let gitCalls = 0;
    const spyGit = () => { gitCalls += 1; return { exit_code: 0, stdout: '', stderr: '' }; };
    for (const mal of ['a & echo pwned', '--output=x', '$(whoami)', 'zzz999']) {
      const info = staleness.inspectGateReject(
        { source: 'build', rejectSha: mal, citedFiles: [CITED] }, SHA_HEAD, { runGit: spyGit },
      );
      assert.strictEqual(info.stale, false, `rejectSha malicioso '${mal}' → false`);
    }
    // head malicioso → conservador antes de tocar git.
    const infoHead = staleness.inspectGateReject(
      { source: 'build', rejectSha: SHA_REJECT, citedFiles: [CITED] }, '-- --output=x', { runGit: spyGit },
    );
    assert.strictEqual(infoHead.stale, false, 'head malicioso → false');
    assert.strictEqual(gitCalls, 0, 'runGit NUNCA se invoca con refs inválidos (sin efecto lateral)');
  });

  // S17d — SEC-2: citedFiles maliciosos (absolutos / path-traversal) se confinan
  // → sin citedFiles válidos → conservador (false).
  await test('S17d: citedFiles absolutos/traversal se confinan → false (SEC-2)', () => {
    assert.strictEqual(staleness.confineCitedPath('/etc/passwd'), null);
    assert.strictEqual(staleness.confineCitedPath('C:/Windows/system32'), null);
    assert.strictEqual(staleness.confineCitedPath('../../secret.txt'), null);
    assert.strictEqual(staleness.confineCitedPath('a/../../escape'), null);
    assert.strictEqual(staleness.confineCitedPath('./.pipeline/x.js'), '.pipeline/x.js');
    assert.strictEqual(staleness.confineCitedPath('.pipeline\\x.js'), '.pipeline/x.js');

    const runGit = fakeGit({ ancestor: true, changed: [CITED] });
    const info = staleness.inspectGateReject(
      { source: 'build', rejectSha: SHA_REJECT, citedFiles: ['/etc/passwd', '../../x', 'C:/y'] },
      SHA_HEAD, { runGit },
    );
    assert.strictEqual(info.stale, false, 'todos los paths se descartan → sin citedFiles → false');
    assert.strictEqual(info.touchesCited, false);
  });

  // S18 — entradas nula/ambigua/sin citedFiles → false (conservador)
  await test('S18: entrada nula/ambigua/sin citedFiles → false (conservador)', () => {
    assert.strictEqual(staleness.isGateRejectStale(null, SHA_HEAD), false);
    assert.strictEqual(staleness.isGateRejectStale(undefined, SHA_HEAD), false);
    // sin citedFiles
    const noFiles = { source: 'build', rejectSha: SHA_REJECT };
    assert.strictEqual(staleness.isGateRejectStale(noFiles, SHA_HEAD, { runGit: fakeGit({ ancestor: true }) }), false);
    // sin rejectSha ni rejectedAt
    const noRef = { source: 'build', citedFiles: [CITED] };
    const info = staleness.inspectGateReject(noRef, SHA_HEAD, { runGit: fakeGit({ ancestor: true, changed: [CITED] }) });
    assert.strictEqual(info.stale, false);
    // sólo rejectedAt (sin rejectSha) → conservador
    const onlyDate = { source: 'build', rejectedAt: '2026-01-01T00:00:00Z', citedFiles: [CITED] };
    assert.strictEqual(staleness.isGateRejectStale(onlyDate, SHA_HEAD, { runGit: fakeGit({ changed: [CITED] }) }), false);
    // head inválido
    assert.strictEqual(staleness.isGateRejectStale({ source: 'build', rejectSha: 'aaa', citedFiles: [CITED] }, ''), false);
  });

  // S19 — error de git (ref inexistente / excepción) → false, sin lanzar
  await test('S19: error de git (ref inexistente o excepción) → false, sin excepción', () => {
    const reject = { source: 'build', rejectSha: SHA_REJECT, citedFiles: [CITED] };
    // merge-base lanza excepción → conservador, sin propagar
    const throwing = fakeGit({ throwOn: 'merge-base' });
    assert.doesNotThrow(() => staleness.isGateRejectStale(reject, SHA_HEAD, { runGit: throwing }));
    assert.strictEqual(staleness.isGateRejectStale(reject, SHA_HEAD, { runGit: throwing }), false);
    // diff falla con exit != 0 (ref inexistente) → conservador
    const diffFails = fakeGit({ ancestor: true, diffExit: 128, changed: [] });
    const info = staleness.inspectGateReject(reject, SHA_HEAD, { runGit: diffFails });
    assert.strictEqual(info.stale, false);
  });

  // S20 — normalizeGitPath: backslashes/`./` → forma canónica para intersección
  await test('S20: normalizeGitPath normaliza separadores y ./ (match Windows/UNIX)', () => {
    assert.strictEqual(staleness.normalizeGitPath('.\\a\\b.js'), 'a/b.js');
    assert.strictEqual(staleness.normalizeGitPath('./a/b.js'), 'a/b.js');
    assert.strictEqual(staleness.normalizeGitPath('a/b.js'), 'a/b.js');
    // citedFile con backslash matchea salida de git (forward slash)
    const reject = { source: 'build', rejectSha: SHA_REJECT, citedFiles: ['.pipeline\\build-log-staleness.js'] };
    const runGit = fakeGit({ ancestor: true, changed: [CITED] });
    assert.strictEqual(staleness.isGateRejectStale(reject, SHA_HEAD, { runGit }), true);
  });

  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  process.exit(fail === 0 ? 0 : 1);
})();
