// =============================================================================
// Tests del REPORTE de secretos filtrados en /ghostbusters (#5220).
//
// El modo de falla que cubren estos tests no es de lógica: la lógica encuentra
// los secretos. Es de COMUNICACIÓN — el sistema sabía la verdad y la salida
// decía lo contrario (`✅ Sistema sano` con 26 tokens vivos en disco).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const gb = require('../../ghostbusters');
const scan = require('../secret-leak-scan');

// Valor sintético con forma de credencial. No es una credencial real.
const VALOR_SINTETICO = '987654321:AASyntheticValueThatMustNeverBePrinted12345';

/** Reporte vacío con la forma que produce `run()`. */
function reporteBase(over = {}) {
  return {
    timestamp: '2026-07-30T21:00:00.000Z',
    dryRun: true,
    categories: ['secrets'],
    zombies: [], emulators: [], bashOrphans: [], extBotZombies: [],
    duplicateWatchdogs: [], idleClaude: [], idleNodeHooks: [],
    worktrees: [], sessions: [], locks: [], logs: [], qaArtifacts: [],
    agentInconsistencies: [], envIssues: [], staleBranches: [], staleBranchesSkipped: [],
    leakedSecrets: [], secretsScanErrors: [], secretsUnparseable: 0, secretsScanMs: 0,
    ramFreedBytes: 0, diskFreedBytes: 0,
    ...over,
  };
}

function hallazgo(over = {}) {
  const c = scan.classifyValue('bot_token', VALOR_SINTETICO);
  return {
    root: 'C:/Workspaces/Intrale/platform.session-x',
    file: 'C:/Workspaces/Intrale/platform.session-x/.claude/.claude/hooks/telegram-config.json',
    rel: '.claude/.claude/hooks/telegram-config.json',
    key: 'bot_token', kind: c.kind, hash8: c.hash8, len: c.len,
    category: 'purgable', removed: false,
    ...over,
  };
}

// -----------------------------------------------------------------------------

test('fmtReport no imprime Sistema sano cuando hay hallazgos de secretos', () => {
  // ⛔ CA-6 — BLOQUEANTE. Sin sumar los secretos a `otherCounts`, el
  // early-return imprime "Sistema sano" con credenciales vivas en disco.
  const r = reporteBase({ leakedSecrets: [hallazgo({ category: 'historial', rotated: false })] });
  const out = gb.fmtReport(r);

  assert.ok(!out.includes('Sistema sano'),
    'NUNCA "Sistema sano" habiendo hallazgos de secretos');
  assert.ok(out.includes('EXPUESTO'), 'la severidad tiene que estar presente');
  assert.ok(out.includes('ROTAR'), 'y los hallazgos tienen que mostrarse');
});

test('fmtReport sigue diciendo Sistema sano cuando de verdad no hay nada', () => {
  const out = gb.fmtReport(reporteBase());
  assert.ok(out.includes('✅ Sistema sano'), 'sin hallazgos, el mensaje sano se conserva');
});

test('fmtReport no imprime Sistema sano ante copias anidadas del chequeo barato', () => {
  // La corrida default no corre el barrido completo, pero si el chequeo barato
  // ve la firma de la fuga, el sistema NO está sano.
  const r = reporteBase({
    secretsQuickCheck: { nestedClaudeCopies: 33, roots: ['C:/wt/platform.session-x'] },
  });
  const out = gb.fmtReport(r);
  assert.ok(!out.includes('Sistema sano'));
  assert.ok(out.includes('POSIBLE EXPOSICIÓN'));
  assert.ok(out.includes('--secrets'), 'y dice cómo obtener el detalle');
});

test('fmtReport no contiene ninguna subcadena de 8 o mas caracteres del valor sintetico', () => {
  // ⛔ CA-3 — BLOQUEANTE. Falla ante prefijo o sufijo, no sólo ante el valor
  // completo: `redactSecretValue` NUNCA se aplica sobre una línea de reporte
  // (exige `!/\s/`), así que redactar al final no sería un control.
  const r = reporteBase({
    leakedSecrets: [
      hallazgo({ category: 'historial', rotated: false, rotationLabel: 'rotación PENDIENTE' }),
      hallazgo({ category: 'purgable' }),
      hallazgo({ category: 'no-verificable', reason: 'JSON roto', hash8: null, len: null }),
    ],
    secretsScanErrors: [{ root: 'C:/wt', file: 'C:/wt/x.json', reason: 'readdir: EPERM' }],
    secretsUnparseable: 1,
  });
  const out = gb.fmtReport(r);

  for (let i = 0; i + 8 <= VALOR_SINTETICO.length; i++) {
    const sub = VALOR_SINTETICO.slice(i, i + 8);
    assert.ok(!out.includes(sub),
      `el reporte filtró la subcadena "${sub.slice(0, 3)}…" del valor sintético`);
  }
  // Lo que sí debe aparecer: identificación sin revelación.
  assert.ok(out.includes(scan.classifyValue('bot_token', VALOR_SINTETICO).hash8),
    'el hash truncado identifica la credencial sin revelarla');
});

test('ningun valor real sobrevive al camino disco -> barrido -> reporte ni a la salida --json', () => {
  // ⛔ CA-3 — BLOQUEANTE, y el ÚNICO test que defiende el invariante de verdad.
  //
  // El test de arriba arma el hallazgo A MANO con los campos que ya sabe que son
  // seguros, así que el valor sintético nunca entra a `fmtReport`: no puede
  // fallar para NINGUNA implementación. Éste ejercita el camino REAL —
  // escribe el valor en disco, lo hace pasar por `scanLeakedSecrets` +
  // `classifyAll`, y barre las ventanas de 8 chars sobre las DOS salidas.
  //
  // Mutación que este test tiene que matar (verificada: sin él la suite entera
  // queda en verde): agregar `value` al Finding en `mkFinding` o en `walkJson`.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '5220-e2e-'));
  const root = path.join(tmp, 'platform.session-fake');
  const hooks = path.join(root, '.claude', '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });

  // Cuatro formas distintas, todas con valor real en disco.
  const VALORES = {
    bot_token: VALOR_SINTETICO,
    openai_api_key: 'sk-proj-FakeSyntheticOpenAiKeyForTestsOnly000111222333',
    google_oauth_client_secret: 'GOCSPX-FakeSyntheticClientSecret012',
    google_oauth_refresh_token: '1//FakeSyntheticRefreshTokenForTestsOnly0123456789',
  };
  fs.writeFileSync(path.join(hooks, 'telegram-config.json'), JSON.stringify(VALORES, null, 2));

  const barrido = scan.scanLeakedSecrets({ roots: [root] });
  assert.ok(barrido.findings.length >= 4,
    'precondición: el barrido encuentra las credenciales que acabamos de escribir');

  const clasificados = scan.classifyAll(barrido.findings);
  const r = reporteBase({
    dryRun: true,
    leakedSecrets: clasificados,
    secretsScanErrors: barrido.errors,
    secretsUnparseable: barrido.filesUnparseable,
  });

  // Las DOS salidas del comando: el reporte humano y el `--json` que consumen
  // dashboard y automatismos (hoy sin ninguna cobertura).
  const salidas = { 'fmtReport': gb.fmtReport(r), 'JSON.stringify(report)': JSON.stringify(r, null, 2) };

  for (const [nombre, out] of Object.entries(salidas)) {
    for (const [clave, valor] of Object.entries(VALORES)) {
      for (let i = 0; i + 8 <= valor.length; i++) {
        const sub = valor.slice(i, i + 8);
        assert.ok(!out.includes(sub),
          `${nombre} filtró una subcadena de 8 chars del valor de "${clave}" (offset ${i})`);
      }
    }
  }

  // Y lo que SÍ tiene que estar: identificación sin revelación.
  const algunHash = clasificados.find((f) => f.hash8);
  assert.ok(algunHash, 'los hallazgos se identifican por hash8');
  assert.ok(salidas['fmtReport'].includes(algunHash.hash8),
    'el hash truncado identifica la credencial sin revelarla');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('fmtReport reporta purgables, historial y no verificables por separado sin total agregado', () => {
  // CA-1 — mezclar las tres sugiere que «purgar 52» equivale a «rotar 13».
  const r = reporteBase({
    leakedSecrets: [
      hallazgo({ category: 'historial', rotated: false, rotationLabel: 'rotación PENDIENTE' }),
      hallazgo({ category: 'purgable' }),
      hallazgo({ category: 'purgable', root: 'C:/wt/b', file: 'C:/wt/b/.claude/x.json' }),
      hallazgo({ category: 'no-verificable', reason: 'JSON roto', hash8: null, len: null }),
    ],
  });
  const out = gb.fmtReport(r);

  assert.ok(out.includes('re-materializables por historial'), 'categoría historial presente');
  assert.ok(out.includes('no verificables'), 'categoría no-verificable presente');
  assert.ok(out.includes('purgables'), 'categoría purgable presente');
  assert.ok(/1 a ROTAR/.test(out) && /2 a PURGAR/.test(out) && /1 a REVISAR/.test(out),
    'el banner enumera cada categoría con su conteo propio');
  assert.ok(!/4 hallazgos? de credenciales/.test(out),
    'no se emite un total agregado que mezcle las tres categorías');
});

test('la seccion de secretos se imprime primera y con banner antes del encabezado', () => {
  // UX-2 — una sección más en el orden de enumeración queda enterrada entre
  // "Logs oversized" y "Branches stale".
  const r = reporteBase({
    leakedSecrets: [hallazgo({ category: 'historial', rotated: false })],
    envIssues: [{ kind: 'java', detail: 'algo' }],
  });
  const lines = gb.fmtReport(r).split('\n');

  assert.ok(lines[0].includes('EXPUESTO'), 'el banner va ANTES del 👻 Ghostbusters');
  assert.ok(lines[1].includes('Ghostbusters'), 'y el encabezado queda segundo');
  const idxSecretos = lines.findIndex((l) => l.includes('Secretos filtrados'));
  const idxEnv = lines.findIndex((l) => l.includes('Issues de entorno'));
  assert.ok(idxSecretos > 0 && idxSecretos < idxEnv, 'los secretos se imprimen primero');
});

test('la seccion de secretos no se trunca por debajo de lo accionable', () => {
  // UX-1 — `section()` corta a MAX_PER_SECTION=10. Un secreto no es basura:
  // cada línea oculta es una credencial que nadie va a rotar.
  const veinticinco = Array.from({ length: 25 }, (_, i) => hallazgo({
    category: 'historial', rotated: false, rotationLabel: 'rotación PENDIENTE',
    root: `C:/wt/platform.session-${i}`,
    file: `C:/wt/platform.session-${i}/.claude/hooks/telegram-config.json`,
    rel: '.claude/hooks/telegram-config.json',
  }));
  const out = gb.fmtReport(reporteBase({ leakedSecrets: veinticinco }));

  assert.ok(!out.includes('…y '), 'no se trunca con "…y N más"');
  for (let i = 0; i < 25; i++) {
    assert.ok(out.includes(`platform.session-${i}/`), `falta el worktree ${i}: se ocultó una credencial`);
  }
});

test('cada categoria dice quien actua y que hace', () => {
  // UX-4 — `purgable`/`historial`/`no verificable` son términos de ingeniería
  // exactos y no accionables tal cual.
  const r = reporteBase({
    leakedSecrets: [
      hallazgo({ category: 'historial', rotated: false, rotationLabel: 'rotación PENDIENTE' }),
      hallazgo({ category: 'purgable' }),
      hallazgo({ category: 'no-verificable', reason: 'JSON roto', hash8: null, len: null }),
    ],
  });
  const out = gb.fmtReport(r);

  assert.ok(out.includes('Acción: rotar y revocar en el proveedor.'));
  assert.ok(out.includes('Acción: revisar a mano.'));
  assert.ok(out.includes('Acción: correr con `--run`.'));
  assert.ok(out.includes('rotación PENDIENTE'), 'CA-7: el estado de rotación es explícito');
});

test('el vocabulario de glifos de secretos no se confunde con el de basura', () => {
  // UX-5 — reusar 🗑 para un secreto que sigue vivo comunicaría lo contrario
  // de la verdad. UX-7 — glifo + PALABRA, nunca sólo color.
  const r = reporteBase({
    leakedSecrets: [
      hallazgo({ category: 'historial', rotated: false }),
      hallazgo({ category: 'no-verificable', reason: 'x', hash8: null, len: null }),
      hallazgo({ category: 'purgable' }),
    ],
  });
  const seccion = gb.fmtReport(r).split('Sesiones done')[0];

  assert.ok(seccion.includes('● ROTAR') && seccion.includes('● REVISAR') && seccion.includes('● PURGAR'));
  assert.ok(!seccion.includes('🗑'), 'un secreto vivo no lleva el glifo de "borrado"');
});

test('computeExitCode devuelve el codigo semantico ante no verificables', () => {
  // CA-5 / R10 — la FUNCIÓN. El cableado al proceso lo cubre el test de abajo:
  // éste solo no alcanza (borrar `process.exitCode = exitCode` lo deja verde).
  const E = gb.EXIT_CODES;
  const conNoVerificable = reporteBase({
    leakedSecrets: [hallazgo({ category: 'no-verificable', hash8: null, len: null })],
    secretsUnparseable: 1,
  });
  assert.strictEqual(scan.computeExitCode(conNoVerificable), E.UNVERIFIABLE);
  assert.notStrictEqual(scan.computeExitCode(conNoVerificable), 0);

  // Y sigue saliendo 0 cuando no hay nada, para no romper a los callers (R10).
  assert.strictEqual(scan.computeExitCode(reporteBase()), 0);
});

test('el CLI real sale con codigo distinto de cero ante no verificables', { timeout: 90000 }, () => {
  // ⛔ CA-5 / R10 — ejercita el PROCESO, no la función. La regresión que #5220
  // vino a cerrar es «el comando salía SIEMPRE con 0»: sin este test, borrar la
  // línea `process.exitCode = exitCode` de ghostbusters.js deja la suite entera
  // en verde y la regresión vuelve sin que nadie se entere.
  //
  // El barrido real tarda ~11,5 s y depende del disco, así que se inyecta un
  // stub por `--require`: el preload puebla el `require.cache` del módulo y
  // parchea sus exports ANTES de que ghostbusters lo requiera (mismo path
  // resuelto ⇒ mismo objeto de módulo). Determinístico y sin tocar el disco.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '5220-cli-'));
  const modulo = path.resolve(__dirname, '..', 'secret-leak-scan.js').replace(/\\/g, '\\\\');
  const cli = path.resolve(__dirname, '..', '..', 'ghostbusters.js');

  const preload = path.join(tmp, 'stub.js');
  fs.writeFileSync(preload, `
    const scan = require('${modulo}');
    scan.enumerateScanRoots = () => ['C:/fake/platform.session-stub'];
    scan.scanLeakedSecrets = () => ({
      findings: [{
        root: 'C:/fake/platform.session-stub',
        file: 'C:/fake/platform.session-stub/.claude/roto.json',
        rel: '.claude/roto.json', key: '(archivo)', kind: 'json-invalido',
        hash8: null, len: null, category: 'no-verificable', reason: 'JSON roto',
      }],
      errors: [], dirsScanned: 1, filesScanned: 1, filesUnparseable: 1,
    });
    scan.classifyAll = (fs_) => fs_;
  `);

  const r = spawnSync(process.execPath, ['--require', preload, cli, '--secrets', '--dry-run', '--json'],
    { encoding: 'utf8', timeout: 80000 });

  assert.strictEqual(r.error, undefined, `el CLI no llegó a correr: ${r.error && r.error.message}`);
  assert.strictEqual(r.status, scan.EXIT_CODES.UNVERIFIABLE,
    `el proceso tiene que salir ${scan.EXIT_CODES.UNVERIFIABLE} (UNVERIFIABLE), salió ${r.status}`);
  assert.notStrictEqual(r.status, 0, 'un no-verificable NUNCA puede salir 0 (fail-closed)');

  // Y la salida --json tampoco filtra el valor (no hay ninguno que filtrar acá,
  // pero se verifica que el campo prohibido no exista en el contrato de salida).
  const salida = JSON.parse(r.stdout);
  for (const f of salida.leakedSecrets || []) {
    assert.ok(!('value' in f), 'el Finding de la salida --json no puede tener campo `value`');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('el reporte con hallazgos se parte en varios mensajes en vez de truncarse', () => {
  // UX-3 — el corte cae al final del mensaje, que es justo donde viven las
  // últimas credenciales sin rotar.
  const { splitLongMessage } = require('../split-long-message');
  const muchos = Array.from({ length: 60 }, (_, i) => hallazgo({
    category: 'historial', rotated: false, rotationLabel: 'rotación PENDIENTE',
    root: `C:/wt/platform.session-${i}`,
    file: `C:/wt/platform.session-${i}/.claude/hooks/telegram-config.json`,
  }));
  const out = gb.fmtReport(reporteBase({ leakedSecrets: muchos }));

  const partes = splitLongMessage(out);
  assert.ok(partes.length > 1, 'se parte en varios mensajes');
  const rearmado = partes.join('');
  for (let i = 0; i < 60; i++) {
    assert.ok(rearmado.includes(`platform.session-${i}/`), `la parte ${i} se perdió al partir`);
  }
});
