// =============================================================================
// eta-markers.test.js — Tests para `.pipeline/lib/eta-markers.js` (#3517).
//
// Cubrimos:
//   - listProcessedFiles: directorio inexistente, vacío, con mix válido/inválido.
//   - collectMarkers: agregaciones perIssue / perFase / perFaseSkill / totales,
//     respeto de filtros MIN/MAX duration, includeRejection on/off.
//   - fmtAbsoluteHHMM: paridad byte-a-byte con la versión histórica de eta.js.
//   - Seguridad (CA-S4): outputs sin paths absolutos / hostnames / usernames.
//   - Seguridad (CA-S6): directorio inexistente no crashea el scanning.
//   - Seguridad (CA-S7): symlinks/directorios bajo procesado/ se descartan.
//
// Todos los tests crean su sandbox bajo `os.tmpdir()`. Ningún test toca el
// `.pipeline/` real del worktree.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const etaMarkers = require('../eta-markers');

// ─── Sandbox helpers ───────────────────────────────────────────────────────

let sandboxCounter = 0;
function makeSandbox(label) {
  sandboxCounter++;
  const dir = path.join(
    os.tmpdir(),
    `eta-markers-test-${process.pid}-${Date.now()}-${sandboxCounter}-${label}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/**
 * Crea un marker `<issue>.<skill>` bajo `<root>/<pipeline>/<fase>/<estado>/`
 * con birthtime simulado vía utimes. Notar que `birthtimeMs` no se puede
 * setear directamente desde Node; usamos un truco: crear el archivo, leer
 * el `birthtimeMs` que el FS le asignó (= now), y setear el `mtimeMs` al
 * birthtime + `durationMs` ofrecido. Como `ctimeMs` lo actualiza el kernel
 * cuando hay cambio de metadata, también se mueve al hacer utimes — en
 * Linux/Windows tras un utimes el ctime queda ~ahora, así que el delta
 * `ctimeMs - birthtimeMs` ≈ `durationMs` deseado.
 */
function createMarker(root, pipelineName, fase, estado, name, durationMs, content) {
  const dir = path.join(root, pipelineName, fase, estado);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content == null ? '' : String(content));
  // Forzar el birthtime "hacia atrás" simulando una duración:
  // utimes(atime, mtime) no toca birthtime, pero sí ctime. Para tests
  // donde necesitamos `dur > MIN_VALID_DURATION_MS`, esperamos unos ms
  // o usamos `durationMs` cero para verificar que se descarta.
  if (durationMs && durationMs > 0) {
    const past = Date.now() - durationMs;
    try { fs.utimesSync(file, past / 1000, past / 1000); } catch {}
  }
  return file;
}

/**
 * Versión alternativa que stub-ea `fs.lstatSync` para devolver duraciones
 * controladas en tests de filtros (las syscalls reales no permiten fijar
 * `birthtimeMs - ctimeMs` directamente y los resultados son flaky).
 */
function withStubbedLstat(fakeMap, fn) {
  const realLstat = fs.lstatSync;
  fs.lstatSync = function patched(p, ...rest) {
    if (Object.prototype.hasOwnProperty.call(fakeMap, p)) {
      const f = fakeMap[p];
      return {
        isFile: () => f.isFile !== false,
        ctimeMs: f.ctimeMs,
        birthtimeMs: f.birthtimeMs,
        mtimeMs: f.mtimeMs || f.ctimeMs,
      };
    }
    return realLstat.call(fs, p, ...rest);
  };
  try {
    return fn();
  } finally {
    fs.lstatSync = realLstat;
  }
}

// ─── fmtAbsoluteHHMM ───────────────────────────────────────────────────────

test('fmtAbsoluteHHMM formatea HH:MM en hora local', () => {
  const d = new Date();
  d.setHours(13); d.setMinutes(42); d.setSeconds(0); d.setMilliseconds(0);
  assert.equal(etaMarkers.fmtAbsoluteHHMM(d.getTime()), '13:42');
});

test('fmtAbsoluteHHMM aplica padding a dos dígitos', () => {
  const d = new Date();
  d.setHours(9); d.setMinutes(5); d.setSeconds(0); d.setMilliseconds(0);
  assert.equal(etaMarkers.fmtAbsoluteHHMM(d.getTime()), '09:05');
});

test('fmtAbsoluteHHMM devuelve dash sentinel para falsy', () => {
  assert.equal(etaMarkers.fmtAbsoluteHHMM(null), '—');
  assert.equal(etaMarkers.fmtAbsoluteHHMM(0), '—');
  assert.equal(etaMarkers.fmtAbsoluteHHMM(undefined), '—');
});

test('fmtAbsoluteHHMM produce output idéntico al de eta.js (CA-UX3)', () => {
  const eta = require('../eta');
  const samples = [
    new Date(2026, 0, 1, 0, 0).getTime(),
    new Date(2026, 5, 15, 12, 30).getTime(),
    new Date(2026, 11, 31, 23, 59).getTime(),
  ];
  for (const s of samples) {
    assert.equal(
      etaMarkers.fmtAbsoluteHHMM(s),
      eta.fmtAbsoluteHHMM(s),
      `divergencia byte-a-byte para ${s}`,
    );
  }
});

// ─── listProcessedFiles ────────────────────────────────────────────────────

test('listProcessedFiles devuelve [] cuando el directorio no existe (CA-S6)', () => {
  const sb = makeSandbox('nope');
  rmTree(sb);
  const result = etaMarkers.listProcessedFiles(path.join(sb, 'desarrollo', 'dev'));
  assert.deepEqual(result, []);
});

test('listProcessedFiles ignora dotfiles y artifacts (CA-F2)', () => {
  const sb = makeSandbox('artifacts');
  const dir = path.join(sb, 'desarrollo', 'dev', 'procesado');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  fs.writeFileSync(path.join(dir, '3517.pipeline-dev'), 'ok');
  fs.writeFileSync(path.join(dir, '3517.pipeline-dev.reason.json'), '{}');
  fs.writeFileSync(path.join(dir, '3517.pipeline-dev.guidance.txt'), 'ayuda');
  fs.writeFileSync(path.join(dir, '_internal.txt'), '');
  const result = etaMarkers.listProcessedFiles(path.join(sb, 'desarrollo', 'dev'));
  const names = result.map((r) => r.name).sort();
  assert.deepEqual(names, ['3517.pipeline-dev']);
  rmTree(sb);
});

test('listProcessedFiles recorre procesado/ y listo/', () => {
  const sb = makeSandbox('procesado-listo');
  const proc = path.join(sb, 'desarrollo', 'dev', 'procesado');
  const listo = path.join(sb, 'desarrollo', 'dev', 'listo');
  fs.mkdirSync(proc, { recursive: true });
  fs.mkdirSync(listo, { recursive: true });
  fs.writeFileSync(path.join(proc, '1.guru'), '');
  fs.writeFileSync(path.join(listo, '2.po'), '');
  const result = etaMarkers.listProcessedFiles(path.join(sb, 'desarrollo', 'dev'));
  assert.equal(result.length, 2);
  const names = result.map((r) => r.name).sort();
  assert.deepEqual(names, ['1.guru', '2.po']);
  rmTree(sb);
});

// ─── collectMarkers ─────────────────────────────────────────────────────────

test('collectMarkers devuelve estructura vacía si root no existe (CA-S6)', () => {
  const result = etaMarkers.collectMarkers({
    root: path.join(os.tmpdir(), 'eta-markers-nope-' + Date.now()),
  });
  assert.deepEqual(result.perIssue, {});
  assert.deepEqual(result.perFase, {});
  assert.deepEqual(result.perFaseSkill, {});
  assert.equal(result.totalProcessed, 0);
  assert.equal(result.totalRejected, 0);
});

test('collectMarkers respeta MIN_VALID_DURATION_MS (descarta <5s)', () => {
  const sb = makeSandbox('min-dur');
  const dir = path.join(sb, 'desarrollo', 'dev', 'procesado');
  fs.mkdirSync(dir, { recursive: true });
  const fast = path.join(dir, '100.fast');
  const ok = path.join(dir, '200.ok');
  fs.writeFileSync(fast, '');
  fs.writeFileSync(ok, '');

  const t = Date.now();
  withStubbedLstat({
    [fast]: { ctimeMs: t, birthtimeMs: t - 2000, mtimeMs: t },     // 2s < 5s
    [ok]:   { ctimeMs: t, birthtimeMs: t - 30000, mtimeMs: t },    // 30s OK
  }, () => {
    const result = etaMarkers.collectMarkers({
      root: sb,
      allFases: [{ pipeline: 'desarrollo', fase: 'dev' }],
    });
    assert.equal(result.totalProcessed, 1, '2s marker debe descartarse');
    assert.ok(result.perIssue[200], 'issue 200 debe estar');
    assert.equal(result.perIssue[100], undefined, 'issue 100 NO debe estar');
  });

  rmTree(sb);
});

test('collectMarkers respeta MAX_VALID_DURATION_MS (descarta >4h)', () => {
  const sb = makeSandbox('max-dur');
  const dir = path.join(sb, 'desarrollo', 'dev', 'procesado');
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, '300.stale');
  const ok = path.join(dir, '400.ok');
  fs.writeFileSync(stale, '');
  fs.writeFileSync(ok, '');

  const t = Date.now();
  const fiveHours = 5 * 60 * 60 * 1000;
  withStubbedLstat({
    [stale]: { ctimeMs: t, birthtimeMs: t - fiveHours, mtimeMs: t }, // 5h > 4h
    [ok]:    { ctimeMs: t, birthtimeMs: t - 30000, mtimeMs: t },
  }, () => {
    const result = etaMarkers.collectMarkers({
      root: sb,
      allFases: [{ pipeline: 'desarrollo', fase: 'dev' }],
    });
    assert.equal(result.totalProcessed, 1, '5h marker debe descartarse');
    assert.ok(result.perIssue[400]);
    assert.equal(result.perIssue[300], undefined);
  });

  rmTree(sb);
});

test('collectMarkers produce perFaseSkill con shape {total,count,avgMs} y bucket coarse', () => {
  const sb = makeSandbox('per-skill');
  const dir = path.join(sb, 'desarrollo', 'dev', 'procesado');
  fs.mkdirSync(dir, { recursive: true });
  const f1 = path.join(dir, '1.guru');
  const f2 = path.join(dir, '2.guru');
  const f3 = path.join(dir, '3.po');
  fs.writeFileSync(f1, '');
  fs.writeFileSync(f2, '');
  fs.writeFileSync(f3, '');

  const t = Date.now();
  withStubbedLstat({
    [f1]: { ctimeMs: t, birthtimeMs: t - 60000, mtimeMs: t }, // 60s
    [f2]: { ctimeMs: t, birthtimeMs: t - 30000, mtimeMs: t }, // 30s
    [f3]: { ctimeMs: t, birthtimeMs: t - 90000, mtimeMs: t }, // 90s
  }, () => {
    const result = etaMarkers.collectMarkers({
      root: sb,
      allFases: [{ pipeline: 'desarrollo', fase: 'dev' }],
    });
    // finegrain
    assert.equal(result.perFaseSkill['dev/guru'].count, 2);
    assert.equal(result.perFaseSkill['dev/guru'].avgMs, Math.round((60000 + 30000) / 2));
    assert.equal(result.perFaseSkill['dev/po'].count, 1);
    assert.equal(result.perFaseSkill['dev/po'].avgMs, 90000);
    // coarse (sin skill): suma de todos los markers de dev
    assert.ok(result.perFaseSkill['dev']);
    assert.equal(result.perFaseSkill['dev'].count, 3);
    assert.equal(result.perFaseSkill['dev'].avgMs, Math.round((60000 + 30000 + 90000) / 3));
  });

  rmTree(sb);
});

test('collectMarkers no marca rejected cuando includeRejection es false (default)', () => {
  const sb = makeSandbox('no-reject');
  const dir = path.join(sb, 'desarrollo', 'dev', 'procesado');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '500.guru');
  fs.writeFileSync(f, 'resultado: rechazado\nmotivo: feo\n');

  const t = Date.now();
  withStubbedLstat({
    [f]: { ctimeMs: t, birthtimeMs: t - 30000, mtimeMs: t },
  }, () => {
    const result = etaMarkers.collectMarkers({
      root: sb,
      allFases: [{ pipeline: 'desarrollo', fase: 'dev' }],
    });
    assert.equal(result.perIssue[500].rejected, false, 'sin includeRejection no se debe marcar');
    assert.equal(result.totalRejected, 0);
  });

  rmTree(sb);
});

test('collectMarkers marca rejected cuando includeRejection=true', () => {
  const sb = makeSandbox('reject');
  const dir = path.join(sb, 'desarrollo', 'dev', 'procesado');
  fs.mkdirSync(dir, { recursive: true });
  const fRej = path.join(dir, '600.guru');
  const fOk = path.join(dir, '601.guru');
  fs.writeFileSync(fRej, 'resultado: rechazado\nmotivo: x\n');
  fs.writeFileSync(fOk, 'resultado: aprobado\n');

  const t = Date.now();
  withStubbedLstat({
    [fRej]: { ctimeMs: t, birthtimeMs: t - 30000, mtimeMs: t },
    [fOk]:  { ctimeMs: t, birthtimeMs: t - 30000, mtimeMs: t },
  }, () => {
    const result = etaMarkers.collectMarkers({
      root: sb,
      allFases: [{ pipeline: 'desarrollo', fase: 'dev' }],
      includeRejection: true,
    });
    assert.equal(result.perIssue[600].rejected, true);
    assert.equal(result.perIssue[601].rejected, false);
    assert.equal(result.totalRejected, 1);
  });

  rmTree(sb);
});

test('collectMarkers descarta entradas que no son archivos (CA-S7: defensa anti-symlink)', () => {
  const sb = makeSandbox('not-file');
  const dir = path.join(sb, 'desarrollo', 'dev', 'procesado');
  fs.mkdirSync(dir, { recursive: true });
  const fakeDirAsMarker = path.join(dir, '700.guru');
  fs.mkdirSync(fakeDirAsMarker); // un directorio plantado con nombre de marker

  const result = etaMarkers.collectMarkers({
    root: sb,
    allFases: [{ pipeline: 'desarrollo', fase: 'dev' }],
  });
  assert.equal(result.totalProcessed, 0, 'el directorio no debe contar como marker');
  assert.equal(result.perIssue[700], undefined);
  rmTree(sb);
});

test('collectMarkers agrega por fase a través de varios pipelines', () => {
  const sb = makeSandbox('cross-pipe');
  const fDev = path.join(sb, 'desarrollo', 'dev', 'procesado', '1.guru');
  const fDef = path.join(sb, 'definicion', 'dev', 'procesado', '2.guru');
  fs.mkdirSync(path.dirname(fDev), { recursive: true });
  fs.mkdirSync(path.dirname(fDef), { recursive: true });
  fs.writeFileSync(fDev, '');
  fs.writeFileSync(fDef, '');

  const t = Date.now();
  withStubbedLstat({
    [fDev]: { ctimeMs: t, birthtimeMs: t - 30000, mtimeMs: t },
    [fDef]: { ctimeMs: t, birthtimeMs: t - 60000, mtimeMs: t },
  }, () => {
    const result = etaMarkers.collectMarkers({
      root: sb,
      allFases: [
        { pipeline: 'desarrollo', fase: 'dev' },
        { pipeline: 'definicion', fase: 'dev' },
      ],
    });
    // misma fase `dev` cruza pipelines: agregación en el mismo bucket
    assert.equal(result.perFase.dev.length, 2);
    assert.equal(result.perFaseSkill['dev/guru'].count, 2);
  });

  rmTree(sb);
});

test('collectMarkers autodescubre pipelines/fases cuando allFases omitido', () => {
  const sb = makeSandbox('autodiscover');
  const f = path.join(sb, 'desarrollo', 'verificacion', 'listo', '999.qa');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '');

  const t = Date.now();
  withStubbedLstat({
    [f]: { ctimeMs: t, birthtimeMs: t - 30000, mtimeMs: t },
  }, () => {
    const result = etaMarkers.collectMarkers({ root: sb });
    assert.equal(result.totalProcessed, 1);
    assert.ok(result.perIssue[999]);
    assert.ok(result.perFaseSkill['verificacion/qa']);
  });

  rmTree(sb);
});

// ─── Seguridad: outputs sin paths absolutos (CA-S4) ───────────────────────

test('collectMarkers no expone paths absolutos en outputs (CA-S4)', () => {
  const sb = makeSandbox('no-paths');
  const f = path.join(sb, 'desarrollo', 'dev', 'procesado', '7.guru');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '');

  const t = Date.now();
  withStubbedLstat({
    [f]: { ctimeMs: t, birthtimeMs: t - 30000, mtimeMs: t },
  }, () => {
    const result = etaMarkers.collectMarkers({
      root: sb,
      allFases: [{ pipeline: 'desarrollo', fase: 'dev' }],
    });
    const serialized = JSON.stringify(result);
    // Patrón conservador: rutas Windows `X:\\` y POSIX `/home/`, `/Users/`.
    assert.equal(/[A-Z]:\\\\/.test(serialized), false, `output contiene path Windows: ${serialized}`);
    assert.equal(/\/home\//.test(serialized), false, `output contiene /home/: ${serialized}`);
    assert.equal(/\/Users\//.test(serialized), false, `output contiene /Users/: ${serialized}`);
  });

  rmTree(sb);
});

// ─── Constantes públicas ───────────────────────────────────────────────────

test('exporta MIN/MAX VALID_DURATION_MS con valores literales esperados', () => {
  assert.equal(etaMarkers.MIN_VALID_DURATION_MS, 5000);
  assert.equal(etaMarkers.MAX_VALID_DURATION_MS, 4 * 60 * 60 * 1000);
});

test('exporta PIPELINES con `desarrollo` y `definicion`', () => {
  assert.deepEqual(etaMarkers.PIPELINES.slice().sort(), ['definicion', 'desarrollo']);
});
