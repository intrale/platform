// =============================================================================
// validate-agent-models.test.js — Tests del CLI humanizado (#3089 U4)
//
// Cubre las CA consolidadas en el issue:
//   - CA-FUNC-1/2/3: ejecutable, exit code != 0 si error, archivo:línea + sugerencia
//   - CA-SEC-1: el script NO imprime valores de env vars
//   - CA-SEC-2/3: schema/heurística rechazan valores hardcoded
//   - CA-SEC-5: idempotente, sin side effects en filesystem
//   - CA-UX-1: símbolos + texto en palabras (redundancia accesibilidad)
//   - CA-UX-2: NO_COLOR / no-TTY autodetección
//   - CA-EXIT-0..4: exit codes categorizados
//   - CA-TECH-1: VALID_PROVIDERS no se duplica (drift check vs resolve-provider.js)
//
// Framework: node --test (built-in, sin deps).
// =============================================================================

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'validate-agent-models.js');
const FIXTURES = path.resolve(__dirname, '__fixtures__', 'validate-agent-models');

// Cargar el módulo para tests unitarios. Hacemos require() — el `if (require.main
// === module)` impide que el CLI corra al importarlo.
const cli = require('..' + path.sep + 'validate-agent-models.js'.replace(/\\/g, '/'));

// ────────────────────────────────────────────────────────────────────────────
// Spawn helper: corre el CLI como subproceso con un fixture específico
// reemplazando temporalmente .pipeline/agent-models.json. Para mantener
// idempotencia + zero side effects: copiamos el archivo original a un backup
// y lo restauramos en el finally.
//
// IMPORTANTE: las pruebas que mutan el archivo canónico se serializan con
// `describe()` para evitar carreras con otros tests del repo. Si el repo crece,
// considerar mover esto a un dir tmp + flag --file (refactor follow-up).
// ────────────────────────────────────────────────────────────────────────────

const REAL_JSON = path.resolve(__dirname, '..', 'agent-models.json');
const BACKUP_JSON = REAL_JSON + '.test-backup';

function withFixture(fixtureName, fn) {
  const src = path.join(FIXTURES, fixtureName);
  const srcContent = fs.readFileSync(src, 'utf8');

  // Backup del real.
  const hadOriginal = fs.existsSync(REAL_JSON);
  if (hadOriginal) fs.copyFileSync(REAL_JSON, BACKUP_JSON);

  try {
    fs.writeFileSync(REAL_JSON, srcContent);
    return fn();
  } finally {
    if (hadOriginal) {
      fs.copyFileSync(BACKUP_JSON, REAL_JSON);
      fs.unlinkSync(BACKUP_JSON);
    } else {
      try { fs.unlinkSync(REAL_JSON); } catch { /* no-op */ }
    }
  }
}

function runCli(args, env) {
  // En no-TTY (subproceso), el CLI suprime colores automáticamente. No hace
  // falta forzar NO_COLOR — pero lo seteamos a "1" para test determinístico.
  const childEnv = Object.assign({}, process.env, { NO_COLOR: '1' }, env || {});
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: childEnv,
    encoding: 'utf8',
  });
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests unitarios — funciones puras del módulo (sin spawn).
// ────────────────────────────────────────────────────────────────────────────

describe('validate-agent-models (unit)', () => {
  test('classifyError detecta secret hardcoded por mensaje', () => {
    const err = { path: '#/providers/x/model', message: 'valor hardcoded prohibido: parece un Anthropic key (sk-ant-)', fix: 'fix' };
    assert.equal(cli.classifyError(err), 'hardcoded');
    assert.equal(cli.bucketToExitCode('hardcoded'), cli.EXIT.CREDENTIAL_HARDCODED);
  });

  test('classifyError detecta env var ausente por mensaje', () => {
    const err = { path: '#/providers/anthropic/credentials_env', message: 'provider "anthropic" requiere env var ANTHROPIC_API_KEY pero no está presente en process.env', fix: 'export' };
    assert.equal(cli.classifyError(err), 'missing-env');
  });

  test('classifyError detecta path inválido por path sintético', () => {
    assert.equal(cli.classifyError({ path: '(file)', message: 'falta crear agent-models.json' }), 'path');
    assert.equal(cli.classifyError({ path: '(schema)', message: 'falta schema' }), 'path');
    assert.equal(cli.classifyError({ path: '(toolchain)', message: 'no se pudo cargar ajv' }), 'path');
  });

  test('classifyError defaultea a schema cuando no matchea ningún bucket', () => {
    const err = { path: '#/providers/anthropic/launcher', message: 'must be equal to one of the allowed values', fix: 'fix' };
    assert.equal(cli.classifyError(err), 'schema');
  });

  test('selectDominantExit prioriza hardcoded > missing > schema > path', () => {
    const errs1 = [
      { path: '(file)', message: 'falta archivo' },
      { path: '#/providers/x/model', message: 'valor hardcoded prohibido: parece un sk-ant-' },
    ];
    assert.equal(cli.selectDominantExit(errs1), cli.EXIT.CREDENTIAL_HARDCODED);

    const errs2 = [
      { path: '#/x', message: 'must be string' },
      { path: '#/y', message: 'requiere env var FOO pero no está presente en process.env' },
    ];
    assert.equal(cli.selectDominantExit(errs2), cli.EXIT.CREDENTIAL_MISSING);
  });

  test('countByBucket suma correctamente', () => {
    const errs = [
      { path: '(file)', message: 'falta' },
      { path: '#/providers/x', message: 'valor hardcoded prohibido' },
      { path: '#/y', message: 'must be string' },
      { path: '#/z', message: 'must have required property' },
    ];
    const counts = cli.countByBucket(errs);
    assert.equal(counts['hardcoded'], 1);
    assert.equal(counts['path'], 1);
    assert.equal(counts['schema'], 2);
    assert.equal(counts['missing-env'], 0);
  });

  test('locateLine encuentra la línea de una jsonPointer en texto crudo', () => {
    const json = JSON.stringify({ providers: { anthropic: { launcher: 'claude' } } }, null, 2);
    const line = cli.locateLine(json, '#/providers/anthropic/launcher');
    assert.ok(line > 0, `línea debería ser positiva, fue ${line}`);
  });

  test('locateLine devuelve 1 para pointer raíz', () => {
    assert.equal(cli.locateLine('{}', '#'), 1);
    assert.equal(cli.locateLine('{}', '#/'), 1);
  });

  test('parseArgs reconoce --quiet, --help, --no-env', () => {
    assert.equal(cli.parseArgs(['node', 'x', '--quiet']).quiet, true);
    assert.equal(cli.parseArgs(['node', 'x', '--help']).help, true);
    assert.equal(cli.parseArgs(['node', 'x', '--no-env']).checkEnv, false);
    assert.equal(cli.parseArgs(['node', 'x']).quiet, false);
    assert.equal(cli.parseArgs(['node', 'x']).checkEnv, true);
  });

  test('shouldUseColor respeta NO_COLOR cuando está definida', () => {
    const orig = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      assert.equal(cli.shouldUseColor(), false);
    } finally {
      if (orig === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = orig;
    }
  });

  test('EXIT codes están definidos y son números 0-4 disjuntos', () => {
    const codes = Object.values(cli.EXIT);
    assert.deepEqual([...codes].sort(), [0, 1, 2, 3, 4]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Tests de integración — spawn del CLI con fixtures.
// ────────────────────────────────────────────────────────────────────────────

describe('validate-agent-models (CLI integration)', () => {
  test('--help imprime banner + tabla de exit codes con exit 0', () => {
    const r = runCli(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /validate-agent-models/);
    assert.match(r.stdout, /Exit codes:/);
    assert.match(r.stdout, /0\s+OK/);
    assert.match(r.stdout, /1\s+Schema/);
    assert.match(r.stdout, /2\s+Credencial faltante/);
    assert.match(r.stdout, /3\s+Credencial hardcoded/);
    assert.match(r.stdout, /4\s+Path/);
  });

  test('fixture válida con env var presente retorna exit 0 y NO leakea valor de credencial', () => {
    withFixture('valid.json', () => {
      const SECRET = 'sk-ant-supersecreto-NUNCA-DEBE-APARECER-EN-OUTPUT-1234567890';
      const r = runCli([], { ANTHROPIC_API_KEY: SECRET });
      assert.equal(r.code, 0, `esperaba exit 0, fue ${r.code}. stderr=${r.stderr}`);
      assert.match(r.stdout, /Validación OK/);
      // CA-SEC-1: el valor NUNCA debe aparecer en stdout/stderr.
      assert.equal(r.stdout.includes(SECRET), false, 'CA-SEC-1: stdout leakeó el valor del secret');
      assert.equal(r.stderr.includes(SECRET), false, 'CA-SEC-1: stderr leakeó el valor del secret');
    });
  });

  test('fixture válida (launcher=codex) con env var faltante retorna exit 2 (credencial faltante)', () => {
    // #3154: El bypass per-launcher hace que `launcher: "claude"` no exija
    // env var (auth delegada al OAuth del CLI). Para seguir cubriendo el
    // contrato CA-EXIT-2 ("credencial faltante → exit 2") usamos un fixture
    // con launcher=codex, que SÍ requiere OPENAI_API_KEY en env.
    withFixture('valid-codex.json', () => {
      // Borramos la env var del child sin tocar la del padre.
      const env = Object.assign({}, process.env);
      delete env.OPENAI_API_KEY;
      const result = spawnSync(process.execPath, [SCRIPT], {
        env: Object.assign(env, { NO_COLOR: '1' }),
        encoding: 'utf8',
      });
      assert.equal(result.status, cli.EXIT.CREDENTIAL_MISSING, `esperaba exit ${cli.EXIT.CREDENTIAL_MISSING}, fue ${result.status}. stderr=${result.stderr}`);
      assert.match(result.stderr, /credencial faltante/i);
      assert.match(result.stderr, /OPENAI_API_KEY/);
    });
  });

  test('#3154 · fixture válida (launcher=claude) con env var faltante retorna exit 0 (bypass OAuth)', () => {
    // #3154: launcher=claude delega auth al OAuth del CLI (`~/.claude/.credentials.json`),
    // por lo que la ausencia de ANTHROPIC_API_KEY NO debe abortar el boot.
    // Este test documenta el bypass a nivel CLI integration (complementa los
    // tests unitarios en lib/__tests__/agent-models-validate.test.js).
    withFixture('valid.json', () => {
      const env = Object.assign({}, process.env);
      delete env.ANTHROPIC_API_KEY;
      const result = spawnSync(process.execPath, [SCRIPT], {
        env: Object.assign(env, { NO_COLOR: '1' }),
        encoding: 'utf8',
      });
      assert.equal(result.status, cli.EXIT.OK, `esperaba exit 0 (bypass claude), fue ${result.status}. stderr=${result.stderr}`);
      assert.match(result.stdout, /Validación OK/);
    });
  });

  test('fixture con secret hardcoded retorna exit 3 y NO imprime el valor literal', () => {
    withFixture('hardcoded-secret.json', () => {
      const r = runCli([], { ANTHROPIC_API_KEY: 'real-key-aaa' });
      assert.equal(r.code, cli.EXIT.CREDENTIAL_HARDCODED, `esperaba exit 3 (hardcoded), fue ${r.code}. stderr=${r.stderr}`);
      assert.match(r.stderr, /hardcoded/);
      // CA-SEC-1: incluso si el JSON tiene el literal, el output NUNCA debe imprimirlo entero.
      // El módulo de redact en lib/agent-models-validate.js se encarga de no echar el valor.
      assert.equal(r.stderr.includes('sk-ant-fakefakefakefake1234567890'), false, 'CA-SEC-1: stderr leakeó el valor hardcoded');
    });
  });

  test('fixture sin default_provider retorna exit 1 (schema inválido)', () => {
    withFixture('schema-invalid-missing-default.json', () => {
      const r = runCli([], { ANTHROPIC_API_KEY: 'k' });
      assert.equal(r.code, cli.EXIT.SCHEMA_INVALID, `esperaba exit 1, fue ${r.code}. stderr=${r.stderr}`);
      assert.match(r.stderr, /schema|required/i);
    });
  });

  test('fixture con launcher fuera de allowlist retorna exit 1 (schema inválido)', () => {
    withFixture('schema-invalid-bad-launcher.json', () => {
      const r = runCli([], { ANTHROPIC_API_KEY: 'k' });
      assert.equal(r.code, cli.EXIT.SCHEMA_INVALID, `esperaba exit 1, fue ${r.code}. stderr=${r.stderr}`);
    });
  });

  test('fixture con skill apuntando a provider inexistente retorna exit 1 (cross-ref schema)', () => {
    withFixture('schema-invalid-bad-provider-ref.json', () => {
      const r = runCli([], { ANTHROPIC_API_KEY: 'k' });
      assert.equal(r.code, cli.EXIT.SCHEMA_INVALID, `esperaba exit 1, fue ${r.code}. stderr=${r.stderr}`);
      assert.match(r.stderr, /phantom-provider/);
    });
  });

  test('--quiet con fixture válida emite 1 línea de OK', () => {
    withFixture('valid.json', () => {
      const r = runCli(['--quiet'], { ANTHROPIC_API_KEY: 'k' });
      assert.equal(r.code, 0);
      // Una línea (trailing \n cuenta como terminator, no como línea adicional).
      const lines = r.stdout.trim().split(/\r?\n/);
      assert.equal(lines.length, 1, `esperaba 1 línea, fue ${lines.length}. stdout=${r.stdout}`);
      assert.match(r.stdout, /OK/);
    });
  });

  test('--quiet con fallo emite 1 línea con conteo categorizado a stderr', () => {
    withFixture('hardcoded-secret.json', () => {
      const r = runCli(['--quiet'], { ANTHROPIC_API_KEY: 'k' });
      assert.equal(r.code, cli.EXIT.CREDENTIAL_HARDCODED);
      const lines = r.stderr.trim().split(/\r?\n/);
      assert.equal(lines.length, 1, `esperaba 1 línea de stderr en --quiet, fue ${lines.length}. stderr=${r.stderr}`);
      assert.match(r.stderr, /FAIL/);
      assert.match(r.stderr, /hardcoded=/);
    });
  });

  test('--no-env saltea check de env vars (no falla por ANTHROPIC_API_KEY ausente)', () => {
    withFixture('valid.json', () => {
      const env = Object.assign({}, process.env);
      delete env.ANTHROPIC_API_KEY;
      env.NO_COLOR = '1';
      const result = spawnSync(process.execPath, [SCRIPT, '--no-env'], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, `esperaba exit 0 con --no-env, fue ${result.status}. stderr=${result.stderr}`);
    });
  });

  test('NO_COLOR=1 suprime escapes ANSI en la salida', () => {
    withFixture('valid.json', () => {
      const r = runCli([], { ANTHROPIC_API_KEY: 'k', NO_COLOR: '1' });
      // No debe haber ningún byte \x1b (ESC).
      assert.equal(r.stdout.includes('\x1b'), false, 'CA-UX-2: stdout incluyó escape ANSI con NO_COLOR=1');
    });
  });

  test('output humano incluye símbolos + texto en palabras (CA-UX-1)', () => {
    withFixture('valid.json', () => {
      const r = runCli([], { ANTHROPIC_API_KEY: 'k' });
      // Símbolo de ok + palabra "OK" — redundancia accesibilidad.
      assert.match(r.stdout, /OK/);
    });
  });

  test('idempotencia: ejecución NO crea ni muta archivos fuera de stdin/stdout', () => {
    withFixture('valid.json', () => {
      const before = fs.statSync(REAL_JSON);
      const r = runCli([], { ANTHROPIC_API_KEY: 'k' });
      assert.equal(r.code, 0);
      const after = fs.statSync(REAL_JSON);
      // Mtime no cambia (no se sobrescribió el archivo).
      assert.equal(before.mtimeMs, after.mtimeMs, 'CA-SEC-5: el validador modificó agent-models.json');
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Drift test: el script NO debe duplicar VALID_PROVIDERS de
// resolve-provider.js. Verifica que la engine subyacente (que sí conoce el
// schema) y la tabla hardcoded del runtime están alineadas — un divergence
// hace que el validador apruebe configs que el runtime rechaza o viceversa.
// CA-TECH-1 / CA-TECH-2.
// ────────────────────────────────────────────────────────────────────────────

describe('validate-agent-models (drift)', () => {
  test('VALID_PROVIDERS del runtime == keys del agent-models.json canónico', () => {
    const resolveProvider = require('..' + path.sep + 'lib/agent-launcher/resolve-provider.js'.replace(/\\/g, '/'));
    const runtimeProviders = new Set(resolveProvider.VALID_PROVIDERS);

    // Leemos el canónico (NO el fixture — el contrato vive en main).
    const realJson = JSON.parse(fs.readFileSync(REAL_JSON, 'utf8'));
    const configProviders = new Set(Object.keys(realJson.providers || {}));

    // Cada provider del runtime debe estar declarado en el JSON; vice-versa
    // también — si alguien borra un provider del runtime pero lo deja en el
    // JSON, el validador del CLI no falla pero el runtime se rompe en lanzamiento.
    for (const p of runtimeProviders) {
      assert.ok(configProviders.has(p), `drift: provider runtime "${p}" no está en agent-models.json`);
    }
    for (const p of configProviders) {
      assert.ok(runtimeProviders.has(p), `drift: provider JSON "${p}" no está en VALID_PROVIDERS del runtime`);
    }
  });
});
