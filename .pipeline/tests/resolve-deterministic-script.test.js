// #2893 / #5066 — Tests para resolveDeterministicScript.
//
// #2893 estableció el override: la verificacion corre desde ROOT (main) y usa la
// versión vieja de tester.js / build.js / etc. Si un agente pipeline-dev modifica
// el script, el fix tiene que tomar efecto antes del merge o el issue rebota
// eternamente hasta el circuit breaker.
//
// #5066 acota ese override. Aplicarlo a cualquier worktree que TENGA el archivo
// convierte a un worktree viejo en una máquina del tiempo: corre el motor del
// pipeline tal como estaba al cortar la rama. Caso real: el worktree de #5066
// estaba 556 commits atrás, sobre un commit previo a `resolveBashCommand`
// (a922fb28), y el build murió en 47 ms con `"bash" no se reconoce como un
// comando interno o externo` — un fix que llevaba dos meses en main.
//
// La regla ahora es: worktree SÓLO si su rama modifica ese mismo script.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.PULPO_NO_AUTOSTART = '1';
const pulpo = require('../pulpo.js');
const { resolveDeterministicScript } = pulpo;
const determProvider = require('../lib/agent-launcher/providers/deterministic');

// ── Fakes inyectables — sin git real / fs real ───────────────────────────────
//
// El fake de execSync es command-aware: `resolveDeterministicScript` emite hoy
// tres comandos distintos (`git worktree list`, `git diff`, `git status`) y un
// fake que devuelve lo mismo para todos haría pasar tests por casualidad.
//
//   worktrees : salida de `git worktree list --porcelain`
//   diff      : salida de `git diff --name-only <base>...HEAD -- <script>`
//   status    : salida de `git status --porcelain -- <script>`
//
// Un valor Error se lanza en vez de devolverse (simula git roto / ref ausente).
function fakeExecSync({ worktrees = '', diff = '', status = '' } = {}, calls = null) {
  return (cmd) => {
    if (calls) calls.push(cmd);
    let out;
    if (cmd.includes('worktree list')) out = worktrees;
    else if (cmd.includes('git diff')) out = diff;
    else if (cmd.includes('git status')) out = status;
    else throw new Error(`comando git inesperado en el fake: ${cmd}`);
    if (out instanceof Error) throw out;
    return out;
  };
}
function fakeExecSyncThrowing() {
  return () => { throw new Error('git not available'); };
}
function fakeFs(existingPaths) {
  const set = new Set(existingPaths);
  return { existsSync: (p) => set.has(p) };
}

const ROOT = '/repo/platform';
const PIPELINE = path.join(ROOT, '.pipeline');
const REL = '.pipeline/skills-deterministicos/tester.js';

// ── Resolución del worktree ──────────────────────────────────────────────────

test('resolveDeterministicScript devuelve script de ROOT cuando no hay worktree del issue', () => {
  const result = resolveDeterministicScript({
    skill: 'tester',
    issue: 9999,
    ROOT,
    PIPELINE,
    execSyncImpl: fakeExecSync({ worktrees: 'worktree /repo/platform\nHEAD abc123\n\n' }),
    fsImpl: fakeFs([path.join(PIPELINE, 'skills-deterministicos', 'tester.js')]),
  });
  assert.equal(result, path.join(PIPELINE, 'skills-deterministicos', 'tester.js'));
});

test('resolveDeterministicScript devuelve script del worktree cuando la rama modifica ese script', () => {
  const wtRoot = '/repo/platform.agent-2893-pipeline-dev';
  const wtScript = path.join(wtRoot, '.pipeline', 'skills-deterministicos', 'tester.js');
  let hitWith = null;
  const result = resolveDeterministicScript({
    skill: 'tester',
    issue: 2893,
    ROOT,
    PIPELINE,
    execSyncImpl: fakeExecSync({
      worktrees:
        'worktree /repo/platform\nHEAD abc123\n\n' +
        `worktree ${wtRoot}\nHEAD def456\nbranch refs/heads/agent/2893-pipeline-dev\n\n`,
      diff: `${REL}\n`,
    }),
    fsImpl: fakeFs([wtScript, path.join(PIPELINE, 'skills-deterministicos', 'tester.js')]),
    onWorktreeHit: (wt) => { hitWith = wt; },
  });
  assert.equal(result, wtScript);
  assert.equal(hitWith, wtRoot, 'callback onWorktreeHit recibe el worktree path');
});

test('resolveDeterministicScript fallback a ROOT cuando worktree existe pero el script NO está', () => {
  const wtRoot = '/repo/platform.agent-2893-pipeline-dev';
  const rootScript = path.join(PIPELINE, 'skills-deterministicos', 'tester.js');
  const result = resolveDeterministicScript({
    skill: 'tester',
    issue: 2893,
    ROOT,
    PIPELINE,
    execSyncImpl: fakeExecSync({
      worktrees: `worktree /repo/platform\nHEAD abc123\n\nworktree ${wtRoot}\nHEAD def456\n\n`,
      diff: `${REL}\n`,
    }),
    // Sólo existe el script de ROOT, no el del worktree
    fsImpl: fakeFs([rootScript]),
  });
  assert.equal(result, rootScript);
});

test('resolveDeterministicScript fallback a ROOT cuando git worktree list lanza excepción', () => {
  const rootScript = path.join(PIPELINE, 'skills-deterministicos', 'tester.js');
  const result = resolveDeterministicScript({
    skill: 'tester',
    issue: 2893,
    ROOT,
    PIPELINE,
    execSyncImpl: fakeExecSyncThrowing(),
    fsImpl: fakeFs([rootScript]),
  });
  assert.equal(result, rootScript);
});

test('resolveDeterministicScript matchea worktree por número de issue (no se confunde con otros)', () => {
  // El patrón es `platform.agent-<issue>-` así que issue 2893 NO debe
  // matchear el worktree de issue 28930 (que empieza con 2893 también).
  const otherWt = '/repo/platform.agent-28930-android-dev';
  const targetWt = '/repo/platform.agent-2893-pipeline-dev';
  const targetScript = path.join(targetWt, '.pipeline', 'skills-deterministicos', 'tester.js');
  const otherScript = path.join(otherWt, '.pipeline', 'skills-deterministicos', 'tester.js');
  const rootScript = path.join(PIPELINE, 'skills-deterministicos', 'tester.js');
  const result = resolveDeterministicScript({
    skill: 'tester',
    issue: 2893,
    ROOT,
    PIPELINE,
    execSyncImpl: fakeExecSync({
      worktrees:
        `worktree /repo/platform\nHEAD abc\n\n` +
        `worktree ${otherWt}\nHEAD ddd\n\n` +
        `worktree ${targetWt}\nHEAD eee\n\n`,
      diff: `${REL}\n`,
    }),
    fsImpl: fakeFs([targetScript, otherScript, rootScript]),
  });
  assert.equal(result, targetScript, 'debe elegir el worktree correcto, no uno con número similar');
});

test('resolveDeterministicScript devuelve ROOT cuando no se pasa issue', () => {
  const rootScript = path.join(PIPELINE, 'skills-deterministicos', 'builder.js');
  const result = resolveDeterministicScript({
    skill: 'builder',
    issue: null,
    ROOT,
    PIPELINE,
    execSyncImpl: fakeExecSync({}),
    fsImpl: fakeFs([rootScript]),
  });
  assert.equal(result, rootScript);
});

test('resolveDeterministicScript funciona para todos los skills determinísticos esperados', () => {
  const skills = ['tester', 'builder', 'linter', 'delivery'];
  for (const skill of skills) {
    const wtRoot = '/repo/platform.agent-2893-pipeline-dev';
    const wtScript = path.join(wtRoot, '.pipeline', 'skills-deterministicos', `${skill}.js`);
    const result = resolveDeterministicScript({
      skill,
      issue: 2893,
      ROOT,
      PIPELINE,
      execSyncImpl: fakeExecSync({
        worktrees: `worktree ${wtRoot}\nHEAD abc\n\n`,
        diff: `.pipeline/skills-deterministicos/${skill}.js\n`,
      }),
      fsImpl: fakeFs([wtScript]),
    });
    assert.equal(result, wtScript, `worktree-first debe funcionar para skill=${skill}`);
  }
});

// ── #5066 — el worktree stale NO debe secuestrar el motor ────────────────────

test('#5066 worktree que NO modifica el script cae a ROOT (motor vigente, no el del corte de rama)', () => {
  const wtRoot = '/repo/platform.agent-5066-pipeline-dev';
  const wtScript = path.join(wtRoot, '.pipeline', 'skills-deterministicos', 'tester.js');
  const rootScript = path.join(PIPELINE, 'skills-deterministicos', 'tester.js');
  let skippedWith = null;
  let hit = false;
  const result = resolveDeterministicScript({
    skill: 'tester',
    issue: 5066,
    ROOT,
    PIPELINE,
    execSyncImpl: fakeExecSync({
      worktrees: `worktree ${wtRoot}\nHEAD stale\n\n`,
      diff: '',    // la rama no toca el script
      status: '',  // ni cambios sin commitear
    }),
    fsImpl: fakeFs([wtScript, rootScript]),
    onWorktreeHit: () => { hit = true; },
    onWorktreeSkip: (wt) => { skippedWith = wt; },
  });
  assert.equal(result, rootScript, 'el script del worktree existe pero es heredado: gana ROOT');
  assert.equal(hit, false, 'no debe reportarse como worktree-hit');
  assert.equal(skippedWith, wtRoot, 'onWorktreeSkip informa el worktree descartado');
});

test('#5066 cambios SIN COMMITEAR en el script también habilitan el worktree', () => {
  const wtRoot = '/repo/platform.agent-2893-pipeline-dev';
  const wtScript = path.join(wtRoot, '.pipeline', 'skills-deterministicos', 'tester.js');
  const result = resolveDeterministicScript({
    skill: 'tester',
    issue: 2893,
    ROOT,
    PIPELINE,
    execSyncImpl: fakeExecSync({
      worktrees: `worktree ${wtRoot}\nHEAD abc\n\n`,
      diff: '',                    // todavía no commiteó
      status: ` M ${REL}\n`,       // pero el archivo está editado
    }),
    fsImpl: fakeFs([wtScript]),
  });
  assert.equal(result, wtScript, 'el chicken-and-egg de #2893 sigue cubierto pre-commit');
});

test('#5066 el diff se mide con triple punto (rama atrasada no cuenta como modificación)', () => {
  const wtRoot = '/repo/platform.agent-5066-pipeline-dev';
  const wtScript = path.join(wtRoot, '.pipeline', 'skills-deterministicos', 'tester.js');
  const calls = [];
  resolveDeterministicScript({
    skill: 'tester',
    issue: 5066,
    ROOT,
    PIPELINE,
    execSyncImpl: fakeExecSync({ worktrees: `worktree ${wtRoot}\nHEAD stale\n\n` }, calls),
    fsImpl: fakeFs([wtScript]),
  });
  const diffCall = calls.find((c) => c.includes('git diff'));
  assert.ok(diffCall, 'debe consultar el diff de la rama');
  assert.ok(
    diffCall.includes('origin/main...HEAD'),
    `triple punto obligatorio (merge-base); con dos puntos una rama atrasada "difiere" y el override se activa al revés. Comando: ${diffCall}`
  );
  assert.ok(diffCall.includes(`-- ${REL}`), 'el diff debe acotarse al script del skill');
});

test('#5066 baseRef es parametrizable', () => {
  const wtRoot = '/repo/platform.agent-5066-pipeline-dev';
  const wtScript = path.join(wtRoot, '.pipeline', 'skills-deterministicos', 'tester.js');
  const calls = [];
  resolveDeterministicScript({
    skill: 'tester',
    issue: 5066,
    ROOT,
    PIPELINE,
    baseRef: 'origin/develop',
    execSyncImpl: fakeExecSync({ worktrees: `worktree ${wtRoot}\nHEAD x\n\n` }, calls),
    fsImpl: fakeFs([wtScript]),
  });
  assert.ok(calls.some((c) => c.includes('origin/develop...HEAD')));
});

test('#5066 git roto en el worktree => fail-closed a ROOT', () => {
  const wtRoot = '/repo/platform.agent-5066-pipeline-dev';
  const wtScript = path.join(wtRoot, '.pipeline', 'skills-deterministicos', 'tester.js');
  const rootScript = path.join(PIPELINE, 'skills-deterministicos', 'tester.js');
  const result = resolveDeterministicScript({
    skill: 'tester',
    issue: 5066,
    ROOT,
    PIPELINE,
    execSyncImpl: fakeExecSync({
      worktrees: `worktree ${wtRoot}\nHEAD x\n\n`,
      diff: new Error("fatal: ambiguous argument 'origin/main...HEAD'"),
      status: new Error('fatal: not a git repository'),
    }),
    fsImpl: fakeFs([wtScript, rootScript]),
  });
  assert.equal(result, rootScript, 'sin evidencia verificable de que el worktree lo modifica, gana ROOT');
});

test('#5066 ref base ausente pero script editado sin commitear => igual gana el worktree', () => {
  const wtRoot = '/repo/platform.agent-2893-pipeline-dev';
  const wtScript = path.join(wtRoot, '.pipeline', 'skills-deterministicos', 'tester.js');
  const result = resolveDeterministicScript({
    skill: 'tester',
    issue: 2893,
    ROOT,
    PIPELINE,
    execSyncImpl: fakeExecSync({
      worktrees: `worktree ${wtRoot}\nHEAD x\n\n`,
      diff: new Error("fatal: bad revision 'origin/main'"),  // repo sin remoto fetcheado
      status: ` M ${REL}\n`,
    }),
    fsImpl: fakeFs([wtScript]),
  });
  assert.equal(result, wtScript, 'el fallo del chequeo 1 no debe cancelar el chequeo 2');
});

// ── #5066 — sanitización e integridad estructural ────────────────────────────

test('#5066 skill con metacaracteres no se interpola en la línea de git', () => {
  const wtRoot = '/repo/platform.agent-5066-pipeline-dev';
  const calls = [];
  const owns = determProvider.worktreeOwnsScript({
    worktree: wtRoot,
    skill: 'tester.js; rm -rf /',
    execSyncImpl: fakeExecSync({ diff: 'x\n', status: 'x\n' }, calls),
  });
  assert.equal(owns, false, 'skill fuera de la allowlist de caracteres => false');
  assert.equal(calls.length, 0, 'no debe ejecutarse ningún comando con el valor sucio');
});

test('#5066 pulpo.resolveDeterministicScript delega en el provider (una sola implementación)', () => {
  assert.equal(
    typeof determProvider.resolveDeterministicScript,
    'function',
    'el provider expone la implementación real'
  );
  const original = determProvider.resolveDeterministicScript;
  let delegated = false;
  determProvider.resolveDeterministicScript = () => { delegated = true; return '/sentinela'; };
  try {
    const out = pulpo.resolveDeterministicScript({ skill: 'tester', issue: 1, ROOT, PIPELINE });
    assert.equal(delegated, true, 'pulpo NO debe reimplementar el resolver: tiene que delegar');
    assert.equal(out, '/sentinela');
  } finally {
    determProvider.resolveDeterministicScript = original;
  }
});
