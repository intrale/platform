'use strict';

// =============================================================================
// fixtures/demo/run-cycle.js — Demo del ciclo dev -> build -> QA -> delivery
// Issue: intrale/platform#4700 (Split de #4696 · Ola Puente P0 · CA-D2)
// Diseño: docs/pipeline/kernel-repo-design.md §1 · Runbook: docs/runbooks/demo-cycle.md
//
// Qué hace
// --------
// Ejecuta un ciclo dev -> build -> QA -> delivery apuntado EXCLUSIVAMENTE a un
// target controlado del kernel (copia local equivalente del fixture
// `agent/4699-fixtures` de intrale/kernel), NUNCA a intrale/platform. Es la
// evidencia de aceptación de P0 (CA-D2), reutilizable por #4706 cambiando el
// target al `intrale/kernel@main` real (vía env KERNEL_TARGET_REMOTE/REF).
//
// Garantías de seguridad cableadas (criterios del issue)
// ------------------------------------------------------
//  · CA-D2.2 (blast radius, BLOQUEANTE): antes de cada fase mutante
//    (build/QA/delivery) se verifica el target con `verifyTarget`; si el target
//    resuelve a intrale/platform o fuera del sandbox, ABORTA con error accionable.
//  · CA-D2.3: `deliver` corre en dry-run — sin auto-merge, sin merge/firma a
//    `main`, con token scoped al repo/rama del kernel (nunca PAT org-wide). No
//    ejecuta ningún push/gh real.
//  · CA-D2.4 (supply chain): el bootstrap usa `npm ci` contra un lockfile
//    pineado con hashes; rechaza rangos abiertos (^/~/latest) y no auto-actualiza.
//
// El ciclo corre sobre una COPIA del target en un sandbox temporal (os.tmpdir),
// así ninguna fase mutante toca el working tree de intrale/platform.
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

// --- Constantes de política de blast radius ---------------------------------
const ALLOWED_REPO = 'intrale/kernel';
const FORBIDDEN_REPO = 'intrale/platform';
const EXPECTED_PROJECT_ID = 'kernel-fixtures';
const PHASES = ['dev', 'build', 'qa', 'delivery'];
const MUTATING_PHASES = new Set(['build', 'qa', 'delivery']);
const LIFECYCLE = ['pendiente', 'trabajando', 'listo', 'procesado'];
const OPEN_RANGE_RE = /[\^~*]|>=|<=|>|<|\s-\s|\|\||x|latest/i;

const BUNDLED_TARGET = path.join(__dirname, 'target');

// --- Errores ----------------------------------------------------------------
class AbortError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AbortError';
  }
}

// Contrato de error accionable: qué pasó · por qué · cómo seguir.
function abort(phase, what, why, how) {
  throw new AbortError(
    `✗ ABORT [${phase}]: ${what}\n` +
      `  Por qué:    ${why}\n` +
      `  Cómo seguir: ${how}`
  );
}

// --- Helpers de FS ----------------------------------------------------------
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// Detecta el root de intrale/platform (repo donde vive este script) para el
// guard de blast radius. Best-effort: sube buscando un `.git`.
function detectPlatformRoot(startDir) {
  let dir = realpath(startDir);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: dos niveles arriba de fixtures/demo/.
  return realpath(path.join(startDir, '..', '..'));
}

// --- Resolución del target --------------------------------------------------
// Copia el target controlado a un sandbox temporal. Si se pasa un remote
// (reuso #4706), clona esa rama en su lugar. Nunca opera en-place sobre el
// bundled ni sobre el working tree de platform.
function resolveTarget(opts = {}) {
  const sandboxRoot = opts.sandboxRoot || os.tmpdir();
  const sandbox = fs.mkdtempSync(path.join(sandboxRoot, 'kernel-demo-cycle-'));
  const dir = path.join(sandbox, 'target');

  const remote = opts.remote || process.env.KERNEL_TARGET_REMOTE || null;
  const ref = opts.ref || process.env.KERNEL_TARGET_REF || 'agent/4699-fixtures';

  if (remote) {
    // Reuso #4706: clon pineado de la rama del kernel real.
    execFileSync(
      'git',
      ['clone', '--depth', '1', '--branch', ref, remote, dir],
      { stdio: 'pipe' }
    );
    return { dir, sandbox, source: `clone:${remote}@${ref}`, remote, ref };
  }

  // Default: copia local equivalente del fixture (bundled).
  const bundled = opts.bundledDir || BUNDLED_TARGET;
  if (!fs.existsSync(bundled)) {
    abort(
      'setup',
      `no existe el target bundled en ${bundled}`,
      'la copia local equivalente del fixture del kernel no está presente',
      'restaurá fixtures/demo/target/ o pasá KERNEL_TARGET_REMOTE para clonar el kernel real'
    );
  }
  fs.cpSync(bundled, dir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`),
  });
  return { dir, sandbox, source: `local:${bundled}`, remote: null, ref };
}

// --- Verificación de target (CA-D2.2) ---------------------------------------
// Se invoca antes de CADA fase mutante. Devuelve la línea de evidencia
// `✔ target = kernel-fixtures (verificado)` o ABORTA con error accionable.
function verifyTarget(targetDir, ctx) {
  const phase = ctx.phase;
  const platformRoot = ctx.platformRoot;
  const resolved = realpath(targetDir);

  // 1. Blast radius: el target NO puede ser (ni estar dentro de) el repo platform.
  if (resolved === platformRoot || resolved.startsWith(platformRoot + path.sep)) {
    abort(
      phase,
      `el target resuelve DENTRO de ${FORBIDDEN_REPO} (${resolved})`,
      'una fase mutante sobre intrale/platform es exactamente el blast radius prohibido',
      'el ciclo debe operar sobre una copia en sandbox (os.tmpdir); revisá resolveTarget'
    );
  }

  // 2. Marker de identidad del target.
  const markerFile = path.join(targetDir, '.kernel-target.json');
  if (!fs.existsSync(markerFile)) {
    abort(
      phase,
      `falta el marker .kernel-target.json en ${targetDir}`,
      'sin marker no se puede afirmar que el target sea el kernel/fixtures',
      'verificá que el target sea la copia del fixture agent/4699-fixtures'
    );
  }
  const marker = readJson(markerFile);
  if (marker.repo === FORBIDDEN_REPO) {
    abort(
      phase,
      `el marker declara repo=${FORBIDDEN_REPO}`,
      'el target apunta al producto, no al kernel',
      'apuntá al kernel/fixtures (intrale/kernel)'
    );
  }
  if (marker.repo !== ALLOWED_REPO) {
    abort(
      phase,
      `el marker declara repo=${marker.repo}, se esperaba ${ALLOWED_REPO}`,
      'el target no es el repo del kernel',
      'apuntá exclusivamente al target controlado del kernel'
    );
  }
  if (marker.projectId !== EXPECTED_PROJECT_ID) {
    abort(
      phase,
      `projectId del marker = ${marker.projectId}, se esperaba ${EXPECTED_PROJECT_ID}`,
      'el target no es el fixture del ciclo del kernel',
      'usá el fixture kernel-fixtures'
    );
  }

  // 3. Consistencia con el manifiesto.
  const configFile = path.join(targetDir, 'pipeline.config.json');
  const config = readJson(configFile);
  if (config.projectId !== EXPECTED_PROJECT_ID) {
    abort(
      phase,
      `pipeline.config.projectId = ${config.projectId} ≠ ${EXPECTED_PROJECT_ID}`,
      'el manifiesto del target no coincide con el marker',
      'el target está corrupto o mezclado; regeneralo desde el fixture'
    );
  }

  // 4. Si es un clon real, el remote git no puede ser platform.
  if (fs.existsSync(path.join(targetDir, '.git'))) {
    let originUrl = '';
    try {
      originUrl = execFileSync('git', ['-C', targetDir, 'remote', 'get-url', 'origin'], {
        stdio: 'pipe',
      })
        .toString()
        .trim();
    } catch {
      originUrl = '';
    }
    if (originUrl.includes(FORBIDDEN_REPO)) {
      abort(
        phase,
        `el remote origin del clon apunta a ${FORBIDDEN_REPO} (${originUrl})`,
        'una fase mutante contra el producto es el blast radius prohibido',
        'cloná exclusivamente intrale/kernel'
      );
    }
    if (originUrl && !originUrl.includes(ALLOWED_REPO)) {
      abort(
        phase,
        `el remote origin del clon (${originUrl}) no es ${ALLOWED_REPO}`,
        'el target clonado no es el kernel',
        'cloná exclusivamente intrale/kernel'
      );
    }
  }

  return {
    ok: true,
    phase,
    repo: marker.repo,
    projectId: marker.projectId,
    dir: resolved,
    line: `✔ target = ${EXPECTED_PROJECT_ID} (verificado) [${phase}] repo=${marker.repo} dir=${resolved}`,
  };
}

// --- Bootstrap pineado (CA-D2.4) --------------------------------------------
function bootstrap(targetDir) {
  const pkgFile = path.join(targetDir, 'package.json');
  const lockFile = path.join(targetDir, 'package-lock.json');
  if (!fs.existsSync(pkgFile) || !fs.existsSync(lockFile)) {
    abort(
      'build',
      'falta package.json o package-lock.json en el target',
      'sin lockfile no hay instalación reproducible',
      'el fixture debe traer package.json + package-lock.json pineado'
    );
  }
  const lock = readJson(lockFile);
  if (!(lock.lockfileVersion >= 2)) {
    abort(
      'build',
      `lockfileVersion=${lock.lockfileVersion} (<2, sin soporte de hashes)`,
      'un lockfile viejo no garantiza integridad SRI',
      'regenerá el lockfile con npm >= 7 (lockfileVersion 3)'
    );
  }

  // Rechazo de rangos abiertos: el kernel se pinea por versión exacta.
  const pkg = readJson(pkgFile);
  const openRanges = [];
  for (const bucket of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = pkg[bucket] || {};
    for (const [name, spec] of Object.entries(deps)) {
      if (OPEN_RANGE_RE.test(String(spec))) openRanges.push(`${bucket}.${name}=${spec}`);
    }
  }
  if (openRanges.length) {
    abort(
      'build',
      `rangos abiertos detectados: ${openRanges.join(', ')}`,
      'un rango ^/~/latest habilita auto-update silencioso (A08 supply chain)',
      'pineá cada dependencia del kernel a versión exacta'
    );
  }

  // Instalación reproducible y verificada: `npm ci` (NUNCA `npm install`).
  // Comando constante (sin interpolación de input) — en Windows `execSync`
  // resuelve `npm.cmd` vía el shell del sistema sin el DEP0190 de execFile+args.
  // `npm` (npm.cmd en Windows) vive SIEMPRE junto a `node` (process.execPath),
  // pero el shell del sistema sólo lo encuentra si ese dir está en el PATH. En
  // entornos de spawn con PATH mínimo (p.ej. el runner del tester) node existe
  // pero npm no está en el PATH → `npm ci` falla con "no se reconoce como
  // comando". Prependeamos el dir de node al PATH para resolver npm de forma
  // determinística e independiente del PATH del proceso que invoca.
  const nodeDir = path.dirname(process.execPath);
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const env = {
    ...process.env,
    PATH: `${nodeDir}${pathSep}${process.env.PATH || ''}`,
  };
  const out = execSync('npm ci --no-audit --no-fund', {
    cwd: targetDir,
    stdio: 'pipe',
    env,
  })
    .toString()
    .trim();

  return {
    tool: 'npm ci',
    lockfileVersion: lock.lockfileVersion,
    openRanges: 0,
    log: out || 'npm ci: sin dependencias externas (lockfile pineado verificado)',
  };
}

// --- Movimiento de work file por el lifecycle -------------------------------
function moveWorkFile(targetDir, workFile, fromState, toState) {
  const base = path.join(targetDir, 'demo-pipeline', 'demo-phase');
  const fromDir = path.join(base, fromState);
  const toDir = path.join(base, toState);
  fs.mkdirSync(toDir, { recursive: true });
  const src = path.join(fromDir, workFile);
  const dst = path.join(toDir, workFile);
  fs.renameSync(src, dst);
  return { workFile, from: fromState, to: toState };
}

// --- Delivery dry-run (CA-D2.3) ---------------------------------------------
function deliver(targetDir, ctx) {
  const marker = readJson(path.join(targetDir, '.kernel-target.json'));
  const plan = {
    dryRun: true,
    targetRepo: marker.repo, // intrale/kernel
    headBranch: `agent/4700-demo-cycle`,
    baseBranch: marker.ref || 'agent/4699-fixtures',
    autoMerge: false,
    mergeToMain: false,
    sign: false,
    tokenScope: `repo:${marker.repo}:${marker.ref || 'agent/4699-fixtures'}`,
  };

  // Aserciones de seguridad — el delivery NO puede degradar ninguna de estas.
  if (plan.targetRepo === FORBIDDEN_REPO) {
    abort('delivery', `delivery apunta a ${FORBIDDEN_REPO}`, 'el producto es blast radius prohibido', 'apuntá al kernel');
  }
  if (plan.autoMerge !== false) {
    abort('delivery', 'autoMerge != false', 'el gate QA + GATE 2 no permite auto-merge', 'delivery debe ser dry-run/gate');
  }
  if (plan.mergeToMain !== false || plan.sign !== false) {
    abort('delivery', 'mergeToMain/sign != false', 'no se puede mergear/firmar a main sin gate humano', 'delivery no muta main');
  }
  if (/org|all|:\*|^ghp_/.test(plan.tokenScope) || plan.tokenScope === '*') {
    abort('delivery', `tokenScope sospechoso (${plan.tokenScope})`, 'un PAT org-wide expone toda la organización', 'usá un token scoped al repo/rama del kernel');
  }

  // Evidencia de delivery: manifiesto declarativo. NO ejecuta push/gh real.
  const manifest = {
    ...plan,
    executed: false,
    note: 'dry-run: no se ejecutó push ni gh; evidencia de gate/delivery únicamente',
  };
  const manifestFile = path.join(ctx.runDir, 'delivery-manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  return { manifest, manifestFile };
}

// --- Orquestación del ciclo -------------------------------------------------
function runCycle(opts = {}) {
  const platformRoot = realpath(opts.platformRoot || detectPlatformRoot(__dirname));
  const runDir =
    opts.runDir || fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-demo-run-'));
  fs.mkdirSync(runDir, { recursive: true });

  const resolved = resolveTarget(opts);
  const targetDir = resolved.dir;
  const workFile = 'sample-1.demo-skill';

  const evidence = [];
  const verifications = [];
  const trail = [];

  const record = (phase, data) => {
    const entry = { phase, ...data };
    evidence.push(entry);
    fs.writeFileSync(
      path.join(runDir, `phase-${phase}.json`),
      JSON.stringify(entry, null, 2)
    );
    return entry;
  };

  const gate = (phase) => {
    if (!MUTATING_PHASES.has(phase)) return null;
    const v = verifyTarget(targetDir, { phase, platformRoot });
    verifications.push(v);
    return v;
  };

  // --- Fase dev (no mutante externamente) ---
  const devMove = moveWorkFile(targetDir, workFile, 'pendiente', 'trabajando');
  trail.push('trabajando');
  record('dev', { mutating: false, targetVerification: null, action: devMove, log: 'dev: work file tomado (pendiente -> trabajando)' });

  // --- Fase build (mutante) ---
  const buildV = gate('build');
  const boot = bootstrap(targetDir);
  const buildMove = moveWorkFile(targetDir, workFile, 'trabajando', 'listo');
  trail.push('listo');
  record('build', { mutating: true, targetVerification: buildV, bootstrap: boot, action: buildMove, log: `build: bootstrap pineado (${boot.tool}) + avance a listo` });

  // --- Fase QA (mutante) ---
  const qaV = gate('qa');
  const config = readJson(path.join(targetDir, 'pipeline.config.json'));
  const qaChecks = {
    projectId: config.projectId === EXPECTED_PROJECT_ID,
    lifecycleOk: JSON.stringify(config.lifecycle) === JSON.stringify(LIFECYCLE),
    workFileEnListo: fs.existsSync(
      path.join(targetDir, 'demo-pipeline', 'demo-phase', 'listo', workFile)
    ),
  };
  if (!qaChecks.projectId || !qaChecks.lifecycleOk || !qaChecks.workFileEnListo) {
    abort('qa', `checks estructurales fallaron: ${JSON.stringify(qaChecks)}`, 'el ciclo no avanzó como se esperaba', 'revisá el motor del ciclo y el fixture');
  }
  record('qa', { mutating: true, targetVerification: qaV, checks: qaChecks, log: 'qa: verificación estructural del ciclo OK' });

  // --- Fase delivery (mutante, dry-run) ---
  const delV = gate('delivery');
  const del = deliver(targetDir, { runDir });
  const delMove = moveWorkFile(targetDir, workFile, 'listo', 'procesado');
  trail.push('procesado');
  record('delivery', { mutating: true, targetVerification: delV, delivery: del.manifest, action: delMove, log: 'delivery: dry-run sin auto-merge, sin main, token scoped -> procesado' });

  trail.unshift('pendiente');

  const summary = {
    ok: true,
    issue: 4700,
    target: { source: resolved.source, dir: targetDir, ref: resolved.ref },
    platformRoot,
    trail,
    phases: PHASES,
    mutatingPhasesVerified: verifications.map((v) => v.phase),
    runDir,
  };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ summary, evidence }, null, 2));

  return { summary, evidence, verifications, trail, runDir, targetDir, sandbox: resolved.sandbox };
}

// --- CLI --------------------------------------------------------------------
function main() {
  const cleanup = process.env.KERNEL_DEMO_KEEP !== '1';
  let result;
  try {
    result = runCycle({});
  } catch (err) {
    console.error('');
    console.error(err.message);
    console.error('');
    console.error('Ciclo ABORTADO. Ninguna fase mutó intrale/platform.');
    process.exit(1);
    return;
  }

  const { summary, evidence, verifications } = result;
  console.log('=============================================================');
  console.log(' Demo del ciclo del kernel — dev -> build -> QA -> delivery');
  console.log(' Issue #4700 (CA-D2) · target controlado, sin blast radius');
  console.log('=============================================================');
  console.log(`Target: ${summary.target.source}`);
  console.log(`Sandbox: ${summary.target.dir}`);
  console.log(`Platform root (protegido): ${summary.platformRoot}`);
  console.log('');
  for (const e of evidence) {
    const tag = e.mutating ? 'MUTANTE ' : 'no-mut  ';
    console.log(`[${tag}] fase ${e.phase.padEnd(9)} -> ${e.log}`);
    if (e.targetVerification) console.log(`           ${e.targetVerification.line}`);
  }
  console.log('');
  console.log(`Trail lifecycle: ${summary.trail.join(' -> ')}`);
  console.log(`Fases mutantes con target verificado: ${verifications.map((v) => v.phase).join(', ')}`);
  console.log(`Evidencia por fase: ${summary.runDir}`);
  console.log('');
  console.log('✔ Ciclo completo. Delivery en dry-run (sin auto-merge, sin main).');

  if (cleanup && result.sandbox) {
    try {
      fs.rmSync(result.sandbox, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runCycle,
  resolveTarget,
  verifyTarget,
  bootstrap,
  deliver,
  detectPlatformRoot,
  AbortError,
  __constants__: { ALLOWED_REPO, FORBIDDEN_REPO, EXPECTED_PROJECT_ID, PHASES, MUTATING_PHASES, LIFECYCLE },
};
