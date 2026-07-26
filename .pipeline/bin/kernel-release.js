#!/usr/bin/env node
/**
 * kernel-release.js — Publica el primer release firmado de @intrale/operating-kernel.
 *
 * Automatiza todo lo automatizable del workflow descrito en
 * docs/pipeline/kernel-release-workflow.md (#4695 · CA-C0..CA-C4). Lo unico que
 * NO automatiza —por diseno, es el gate humano— es la aprobacion del publish.
 *
 * Uso:
 *   node .pipeline/bin/kernel-release.js              # dry-run: no toca nada
 *   node .pipeline/bin/kernel-release.js --apply      # ejecuta de verdad
 *   node .pipeline/bin/kernel-release.js --apply --gate=dispatch
 *
 * Gate humano (--gate):
 *   environment  (default) job `publish` detras de `environment: release` con
 *                required reviewers. Requiere plan de GitHub que habilite
 *                environments protegidos en repos privados.
 *   dispatch     sin trigger por tag: el workflow solo corre por workflow_dispatch
 *                manual. El acto humano de dispararlo ES el gate. Fallback cuando
 *                el plan no habilita environments protegidos.
 *
 * Fases: 0 prechecks · 1 lockfile · 2 workflow · 3 environment · 4 tag · 5 handoff
 */
'use strict';

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyGate, assertGateSafety } = require(path.join(__dirname, '..', 'lib', 'kernel-release-gate.js'));

const REPO = 'Intrale/kernel';
const PKG = '@intrale/operating-kernel';
const REVIEWER = 'leitolarreta';
const PLATFORM_ROOT = path.resolve(__dirname, '..', '..');
const PROPOSED_YML = path.join(PLATFORM_ROOT, 'docs', 'pipeline', 'kernel-release-workflow.proposed.yml');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const GATE = (args.find((a) => a.startsWith('--gate=')) || '--gate=environment').split('=')[1];
const SKIP_SIGNOFF = args.includes('--skip-signoff-check');

const GH = process.env.GH_BIN || 'gh';
const log = (m) => console.log(m);
const step = (n, m) => console.log(`\n=== Fase ${n} · ${m} ===`);
const ok = (m) => console.log(`  [ok] ${m}`);
const warn = (m) => console.log(`  [!]  ${m}`);
const fail = (m) => {
  console.error(`\n[X] BLOQUEADO: ${m}`);
  process.exit(1);
};

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}
function gh(argv, opts = {}) {
  return execFileSync(GH, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}
function mutate(label, fn) {
  if (!APPLY) {
    log(`  [dry-run] ${label}`);
    return null;
  }
  const r = fn();
  ok(label);
  return r;
}

// ─── Fase 0 · Prechecks ──────────────────────────────────────────────────────
step(0, 'Prechecks (fail-closed)');

if (!['environment', 'dispatch'].includes(GATE)) fail(`--gate invalido: ${GATE}`);

let scopes = '';
try {
  scopes = execFileSync(GH, ['auth', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  scopes = String(e.stdout || '') + String(e.stderr || '');
}
if (!/write:packages/.test(scopes)) {
  fail('El token de gh no tiene scope write:packages. Corre: gh auth refresh -h github.com -s write:packages');
}
ok('gh autenticado con write:packages');

let perms;
try {
  perms = JSON.parse(gh(['api', `repos/${REPO}`, '--jq', '{admin:.permissions.admin,push:.permissions.push}']));
} catch {
  fail(`No se puede leer ${REPO} con el token actual.`);
}
if (!perms.admin) fail(`Se requiere admin sobre ${REPO} (crear environment / proteger main).`);
ok(`admin sobre ${REPO}`);

if (!fs.existsSync(PROPOSED_YML)) fail(`Falta el YAML propuesto: ${PROPOSED_YML}`);
ok('YAML propuesto presente');

// CA-C0: el release.yml NO se commitea sin sign-off de `security` sobre este YAML.
const SIGNOFF_GLOBS = [
  path.join(PLATFORM_ROOT, '.pipeline', 'assets', 'docs', '4695'),
  path.join(PLATFORM_ROOT, 'docs', 'pipeline'),
];
const signoff = SIGNOFF_GLOBS.flatMap((dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /security.*(sign-?off|4695)|kernel-release.*sign-?off/i.test(f)).map((f) => path.join(dir, f))
    : []
);
if (signoff.length) ok(`sign-off de security encontrado: ${path.basename(signoff[0])}`);
else if (SKIP_SIGNOFF) warn('sign-off de security NO encontrado — omitido por --skip-signoff-check');
else fail('CA-C0: no hay sign-off de `security` sobre kernel-release-workflow.proposed.yml. Corre /security sobre ese archivo, o pasa --skip-signoff-check si ya fue firmado fuera de banda.');

// ─── Clone de trabajo ────────────────────────────────────────────────────────
const work = path.join(os.tmpdir(), `kernel-release-${process.pid}`);
log(`\n  workdir: ${work}`);
if (APPLY) {
  gh(['repo', 'clone', REPO, work, '--', '--depth', '50']);
} else {
  fs.mkdirSync(work, { recursive: true });
  gh(['repo', 'clone', REPO, work, '--', '--depth', '50']); // read-only, seguro en dry-run
}
const inRepo = { cwd: work };
const version = JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json.version no es pin exacto: ${version}`);
ok(`version a publicar: ${PKG}@${version} (tag v${version})`);

const existingTags = gh(['api', `repos/${REPO}/tags`, '--jq', '.[].name']).split('\n');
if (existingTags.includes(`v${version}`)) {
  warn(`El tag v${version} ya existe — bumpea package.json.version antes de re-publicar.`);
}

// ─── Fase 1 · Lockfile reproducible (npm ci lo exige) ────────────────────────
step(1, 'package-lock.json + pin de optionalDependencies');
const pkgPath = path.join(work, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const wildcards = Object.entries(pkg.optionalDependencies || {}).filter(([, v]) => v === '*');
if (wildcards.length) {
  warn(`optionalDependencies con comodin "*": ${wildcards.map(([k]) => k).join(', ')}`);
  mutate(`pinear ${wildcards.length} optionalDependencies a la version resuelta`, () => {
    for (const [name] of wildcards) {
      const v = sh(`npm view ${name} version`).trim();
      pkg.optionalDependencies[name] = v;
      log(`       ${name} -> ${v}`);
    }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  });
}
if (!fs.existsSync(path.join(work, 'package-lock.json'))) {
  warn('el kernel NO tiene package-lock.json — `npm ci` del workflow fallaria');
  mutate('generar package-lock.json (npm install --package-lock-only)', () =>
    sh('npm install --package-lock-only --ignore-scripts', inRepo)
  );
} else ok('package-lock.json ya presente');

// ─── Fase 2 · release.yml en el repo del kernel ──────────────────────────────
step(2, `release.yml (gate=${GATE})`);
const rawYml = fs.readFileSync(PROPOSED_YML, 'utf8');
// La transformacion normaliza CRLF y preserva comentarios; la asercion posterior
// es la red fail-closed (auditoria 2026-07-26 · CRITICAL-1: los regex viejos
// borraban el gate y dejaban vivo el auto-publish, en silencio).
const yml = applyGate(rawYml, GATE);
try {
  assertGateSafety(yml, GATE);
} catch (e) {
  fail(`${e.message}\n    No se escribio ni se commiteo nada.`);
}
ok(GATE === 'dispatch'
  ? 'verificado: sin trigger automatico — publicar exige disparo manual'
  : 'verificado: el job publish quedo detras de environment: release');
const ymlDest = path.join(work, '.github', 'workflows', 'release.yml');
mutate(`escribir .github/workflows/release.yml en ${REPO}`, () => {
  fs.mkdirSync(path.dirname(ymlDest), { recursive: true });
  fs.writeFileSync(ymlDest, yml);
});
mutate('commit + push a main del kernel', () => {
  sh('git add -A', inRepo);
  sh(`git -c user.name="pipeline" -c user.email="pipeline@intrale" commit -m "Workflow de release firmado (#4695 CA-C0..CA-C4)"`, inRepo);
  sh('git push origin HEAD:main', inRepo);
});

// ─── Fase 3 · Gate humano ────────────────────────────────────────────────────
step(3, 'Gate humano de publicacion');
if (GATE === 'environment') {
  mutate(`crear environment "release" con required reviewer @${REVIEWER}`, () => {
    const uid = gh(['api', `users/${REVIEWER}`, '--jq', '.id']);
    const body = JSON.stringify({ reviewers: [{ type: 'User', id: Number(uid) }], deployment_branch_policy: null });
    const planFail = () => {
      // Sin required reviewers el environment NO es un gate: seria auto-publish
      // disfrazado. Fail-closed y limpiamos el environment a medio crear.
      try { gh(['api', '--method', 'DELETE', `repos/${REPO}/environments/release`]); } catch { /* noop */ }
      fail('El plan de GitHub no habilita "required reviewers" en repos privados (verificado 2026-07-26).\n' +
           '    Salidas: (a) hacer publico Intrale/kernel, (b) subir la org a GitHub Team,\n' +
           '    (c) re-correr con --gate=dispatch (el disparo manual pasa a ser el gate humano).');
    };
    try {
      execFileSync(GH, ['api', '--method', 'PUT', `repos/${REPO}/environments/release`, '--input', '-'], {
        input: body, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      const msg = String(e.stdout || '') + String(e.stderr || '');
      if (/billing plan|Upgrade|not available|403|422/i.test(msg)) planFail();
      throw e;
    }
    // Verificacion post-creacion: el reviewer tiene que haber quedado registrado.
    const reviewers = gh(['api', `repos/${REPO}/environments/release`, '--jq',
      '[.protection_rules[]? | select(.type=="required_reviewers") | .reviewers[]?.reviewer.login] | join(",")']);
    if (!reviewers.includes(REVIEWER)) planFail();
  });
} else {
  // El gate es el disparo manual. Ya quedo verificado en la fase 2 que el
  // workflow no tiene NINGUN trigger automatico, asi que este mensaje no puede
  // mentir: si hubiera sobrevivido el `on.push`, la fase 2 habria abortado.
  ok('gate = disparo manual del workflow (verificado en fase 2; no se crea environment)');
}

// ─── Fase 4 · Tag ────────────────────────────────────────────────────────────
step(4, `Tag v${version}`);
if (GATE === 'environment') {
  mutate(`crear y pushear tag v${version} (dispara el workflow, pausa en el gate)`, () => {
    sh(`git tag -a v${version} -m "Kernel operativo ${version}"`, inRepo);
    sh(`git push origin v${version}`, inRepo);
  });
} else {
  mutate(`crear y pushear tag v${version} (no dispara nada: gate=dispatch)`, () => {
    sh(`git tag -a v${version} -m "Kernel operativo ${version}"`, inRepo);
    sh(`git push origin v${version}`, inRepo);
  });
  log(`  Para publicar, corre:  gh workflow run release.yml -R ${REPO} -f tag=v${version}`);
}

// ─── Fase 5 · Handoff ────────────────────────────────────────────────────────
step(5, 'Que queda por hacer (humano)');
log(`  1. Aprobar/disparar el publish:  https://github.com/${REPO}/actions`);
log(`  2. Verificar la firma cosign del release v${version} (comando en docs/pipeline/kernel-release-workflow.md).`);
log(`  3. Cerrar el cutover en el producto:`);
log(`       node .pipeline/bin/kernel-release.js --post   (pendiente: pobla integrity.sri en pipeline.config.json)`);
log(`\n${APPLY ? 'APLICADO.' : 'DRY-RUN: no se modifico nada. Re-corre con --apply.'}`);
