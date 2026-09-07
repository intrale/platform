'use strict';

// =============================================================================
// kernel-reconcile-cli.test.js — CLI de la reconciliación append-only (#5209).
//
// El runbook §2 prescribe estos comandos; si el CLI cambia de contrato, el
// procedimiento documentado deja de ser verificable. Estos tests fijan:
//   - los flags y sus defaults,
//   - que `--apply` SIN `--frozen` no corra (y no toque AWS),
//   - que el destino de los artefactos esté FUERA de Git,
//   - que el reporte de estado no mienta cuando no hay nada reintegrado.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, '.pipeline', 'kernel-reconcile.js');
const cli = require('../kernel-reconcile.js');

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: REPO_ROOT });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, stdout: (e.stdout || '') + (e.stderr || '') };
  }
}

test('parseArgs reconoce los flags del runbook y no inventa defaults peligrosos', () => {
  const a = cli.parseArgs(['--apply', '--frozen', '--profile', 'kernel-runtime', '--project-id', 'acme']);
  assert.equal(a.apply, true);
  assert.equal(a.frozen, true);
  assert.equal(a.profile, 'kernel-runtime');
  assert.equal(a.projectId, 'acme');

  const vacio = cli.parseArgs([]);
  assert.equal(vacio.apply, false, 'sin flags no se aplica nada');
  assert.equal(vacio.frozen, false, '`frozen` jamás es true por default');
});

test('`--apply` sin `--frozen` corta antes de tocar AWS y explica por qué', () => {
  const res = runCli(['--apply']);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /falta `--frozen`/);
  assert.match(res.stdout, /daría verde sin serlo/);
  assert.ok(!/aws|dynamodb/i.test(res.stdout), 'no debe haber intentado hablar con AWS');
});

test('sin flags el CLI hace un status de sólo lectura y no crea el directorio', () => {
  const antes = fs.existsSync(cli.DEFAULT_RECONCILE_DIR);
  const res = runCli([]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /ESTADO DE LA RECONCILIACIÓN/);
  assert.match(res.stdout, /--apply --frozen/);
  assert.equal(fs.existsSync(cli.DEFAULT_RECONCILE_DIR), antes,
    'un status no puede tener efectos de lado en el filesystem');
});

test('un conjunto vacío se reporta como tal — nunca como "todo bien"', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-5209-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const st = cli.renderStatus(dir);

  assert.equal(st.ok, true);
  assert.match(st.report, /registros reintegrados: 0/);
  assert.match(st.report, /NO habilita apagar `kernel\.durable`/);
});

test('el destino por default de los artefactos está fuera de Git (firmas y audit nunca se versionan)', () => {
  const rel = path.relative(REPO_ROOT, path.join(cli.DEFAULT_RECONCILE_DIR, 'signatures.jsonl'))
    .split(path.sep).join('/');
  let ignorado = true;
  try {
    execFileSync('git', ['check-ignore', '-q', rel], { cwd: REPO_ROOT });
  } catch (e) {
    ignorado = false;
  }
  assert.equal(ignorado, true,
    `${rel} tiene que estar ignorado por Git: contiene firmas y auditoría del kernel`);
});

test('el CLI no apaga el flag ni reinicia por su cuenta (eso lo hace el operador)', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  assert.ok(!/runDurableRollbackDrill/.test(src),
    'el CLI corre la reconciliación, no el ensayo operativo completo');
  assert.ok(!/restart\.js|writeFileSync\(.*config\.yaml/.test(src),
    'un script de reconciliación no puede reiniciar servicios ni editar config.yaml');
});
