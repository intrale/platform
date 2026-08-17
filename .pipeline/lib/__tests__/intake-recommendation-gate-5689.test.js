'use strict';

// =============================================================================
// intake-recommendation-gate-5689.test.js — #5689 (split de #5678, parte 1/3).
//
// Cubre las dos defensas del intake contra el backlog de ~935 recomendaciones,
// que NO son intercambiables:
//
//   1. DISPONIBILIDAD (R1, anti-starvation) — `buildIntakeSearchQuery()`.
//      GitHub aplica el `--limit 50` SERVER-SIDE, antes de `calcularPrioridad()`.
//      Sin `-label:tipo:recomendacion` los 50 slots se llenan de recomendaciones
//      y el intake de definición real se ahoga en silencio, sin alarma.
//
//   2. SEGURIDAD (SEC-1/SEC-2) — el gate JS sobre los labels ya traídos.
//      El search se evalúa contra el índice de búsqueda de GitHub, que es
//      EVENTUALMENTE CONSISTENTE: un issue recién etiquetado puede pasarlo. El
//      gate corre sobre estado fresco y es el control AUTORITATIVO (REQ-SEC-1).
//
// Incluye además asserts a nivel FUENTE (GURU-3): el riesgo real de esta
// historia es parchear un solo call site del `--search`, ver el test en verde, y
// dejar el otro sin blindar. Los asserts de fuente lo hacen imposible.
// =============================================================================

process.env.PULPO_NO_AUTOSTART = '1'; // permitir require sin arrancar el pulpo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pulpo = require('../../pulpo.js');
const {
  buildIntakeSearchQuery,
  buildIntakeSearchRescueQuery,
  buildIntakeSearchQueries,
  INTAKE_SEARCH_EXCLUDED_LABELS,
  isPendingRecommendationIssue,
} = pulpo;

const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');

// ---------------------------------------------------------------------------
// SEC-1 — el gate del intake, con los 3 casos exigidos por la CA.
//
// Se ejercita el MISMO predicado que corre el gate (`isPendingRecommendationIssue`,
// exportado por pulpo.js), con `issueLabels` en la forma exacta que el intake
// construye: `(issue.labels || []).map(l => l.name)` ⇒ array de strings.
// ---------------------------------------------------------------------------

test('SEC-1 gate: tipo:recomendacion sin approved → OMITIDO', () => {
  assert.equal(isPendingRecommendationIssue(['needs-definition', 'tipo:recomendacion']), true);
});

test('SEC-1 gate: con recommendation:approved → ADMITIDO', () => {
  assert.equal(
    isPendingRecommendationIssue(['needs-definition', 'tipo:recomendacion', 'recommendation:approved']),
    false,
  );
});

test('SEC-1 gate: sólo source:recommendation → OMITIDO (gap que cerró SEC-2)', () => {
  // El chequeo inline previo (`issueLabels.includes('tipo:recomendacion')`) dejaba
  // pasar este caso. Exposición viva medida = 0 issues, así que migrar hoy es
  // cambio de comportamiento nulo sobre el backlog y cierra el gap a futuro.
  assert.equal(isPendingRecommendationIssue(['needs-definition', 'source:recommendation']), true);
});

test('SEC-1 gate: un issue de definición real NO se ve afectado', () => {
  assert.equal(isPendingRecommendationIssue(['needs-definition', 'priority:high']), false);
  assert.equal(isPendingRecommendationIssue([]), false);
});

test('SEC-2 el gate del intake usa el discriminador único, no un chequeo inline', () => {
  assert.ok(
    /if \(isPendingRecommendationIssue\(issueLabels\)\)/.test(PULPO_SRC),
    'el gate debe invocar isPendingRecommendationIssue(issueLabels)',
  );
  assert.ok(
    !/issueLabels\.includes\(['"]tipo:recomendacion['"]\)/.test(PULPO_SRC),
    'no debe quedar ningún chequeo inline de un solo label en el gate',
  );
});

// ---------------------------------------------------------------------------
// R1 — el término `--search`: una sola fuente, consumida por los dos call sites.
// ---------------------------------------------------------------------------

test('R1 buildIntakeSearchQuery excluye needs-human Y tipo:recomendacion', () => {
  const q = buildIntakeSearchQuery();
  assert.ok(q.includes('-label:needs-human'), `falta -label:needs-human en: ${q}`);
  assert.ok(q.includes('-label:tipo:recomendacion'), `falta -label:tipo:recomendacion en: ${q}`);
  assert.deepEqual(INTAKE_SEARCH_EXCLUDED_LABELS.slice(), ['needs-human', 'tipo:recomendacion']);
});

test('R1 ningún pase rompe el entrecomillado del comando gh', () => {
  // Se interpolan dentro de `--search "..."`. Una comilla doble ahí partiría el
  // argumento y `gh` recibiría basura (o peor, tokens sueltos).
  for (const q of buildIntakeSearchQueries()) {
    assert.ok(!q.includes('"'), `el término no puede contener comillas dobles: ${q}`);
    assert.ok(!/[`$\\]/.test(q), `el término no puede contener metacaracteres de shell: ${q}`);
  }
});

test('GURU-3 los DOS call sites iteran la MISMA fuente de pases', () => {
  // Sin esto, el modo de falla probable es: parchear el dry-run, test verde,
  // intake real sin blindar ⇒ R1 vivo en producción con la CA cumplida.
  const loops = PULPO_SRC.match(/for \(const search of buildIntakeSearchQueries\(\)\)/g) || [];
  assert.equal(loops.length, 2, `se esperaban 2 loops de pases, hay ${loops.length}`);

  const callSites = PULPO_SRC.match(/--search "\$\{search\}"/g) || [];
  assert.equal(callSites.length, 2, `se esperaban 2 call sites, hay ${callSites.length}`);

  // Ningún `--search` del intake puede seguir con el término hardcodeado, ni
  // quedar atado al pase base solo (que es exactamente la regresión de rev-1).
  const hardcoded = PULPO_SRC.match(/--search "-label:[^"]*"/g) || [];
  assert.deepEqual(hardcoded, [], `quedan --search hardcodeados: ${JSON.stringify(hardcoded)}`);
  const soloBase = PULPO_SRC.match(/--search "\$\{buildIntakeSearchQuery\(\)\}"/g) || [];
  assert.deepEqual(soloBase, [], 'ningún call site puede usar sólo el pase base: excluye las recos aprobadas');
});

// ---------------------------------------------------------------------------
// REGRESIÓN rev-1 (hallazgo de security) — el camino de LIBERACIÓN del gate de
// #2653 quedó inoperante: `-label:tipo:recomendacion` es incondicional (la
// búsqueda de GitHub no soporta OR), así que excluía también las recos ya
// aprobadas por un humano. El gate JS las habría admitido, pero nunca llegaban
// a él. Caso vivo al detectarlo: #5055.
// ---------------------------------------------------------------------------

test('rev-1 el pase de rescate trae las recomendaciones YA aprobadas', () => {
  const rescue = buildIntakeSearchRescueQuery();
  // Positivo, NO negado: es lo que reabre el camino.
  assert.ok(
    /(^|\s)label:recommendation:approved(\s|$)/.test(rescue),
    `el pase de rescate debe filtrar POR recommendation:approved: ${rescue}`,
  );
  assert.ok(
    !rescue.includes('-label:tipo:recomendacion'),
    'el pase de rescate NO puede excluir tipo:recomendacion — una reco aprobada lo conserva',
  );
});

test('rev-1 el pase de rescate NO es un bypass del circuit breaker de #2405', () => {
  // Una reco aprobada que después se bloquea de verdad sigue afuera del intake.
  assert.ok(
    buildIntakeSearchRescueQuery().includes('-label:needs-human'),
    'el rescate debe seguir excluyendo needs-human',
  );
  for (const q of buildIntakeSearchQueries()) {
    assert.ok(q.includes('-label:needs-human'), `todo pase debe excluir needs-human: ${q}`);
  }
});

test('rev-1 el pase base sigue conteniendo el filtro anti-starvation (no se revirtió R1)', () => {
  // El fix de la regresión no puede "arreglarse" borrando el filtro de R1.
  assert.ok(buildIntakeSearchQueries()[0].includes('-label:tipo:recomendacion'));
});

// ---------------------------------------------------------------------------
// R1 end-to-end sin red, vía `discoverWorkDryRun` (superficie exportada).
//
// GURU-3(c): con un `exec` inyectado el starvation NO ocurre solo — el corte de
// 50 y el `-label:` los aplica GitHub server-side. Por eso el fake SIMULA esa
// semántica: parsea el `--search` y el `--limit` del comando y recorta como lo
// haría el índice. Sin el simulador, la aserción pasaría trivialmente.
//
// GURU-3(b): `discoverWorkDryRun` es side-effect-free por contrato — NO encola.
// Se afirma sobre `discovered`, que es lo que esta superficie realmente produce.
// ---------------------------------------------------------------------------

function makeGithubFake(allIssues) {
  const seen = [];
  return {
    seen,
    exec(cmd) {
      seen.push(cmd);
      const search = (cmd.match(/--search "([^"]*)"/) || [, ''])[1];
      const limit = Number((cmd.match(/--limit (\d+)/) || [, '0'])[1]) || allIssues.length;
      const excluded = (search.match(/-label:(\S+)/g) || []).map((t) => t.slice('-label:'.length));
      // Positivos: `label:X` NO precedido por `-`. Son los que hacen posible el
      // pase de rescate; sin simularlos el rescate parecería traer todo.
      const required = (search.match(/(?:^|\s)label:(\S+)/g) || []).map((t) => t.trim().slice('label:'.length));
      // El `--label "X"` de gh es un AND más, igual que un `label:X` del search.
      const flagLabel = (cmd.match(/--label "([^"]*)"/) || [])[1];
      if (flagLabel) required.push(flagLabel);
      // Server-side: primero filtra por el search, DESPUÉS corta en --limit.
      const filtered = allIssues.filter((it) => (
        !it.labels.some((l) => excluded.includes(l))
        && required.every((r) => it.labels.includes(r))
      ));
      return JSON.stringify(filtered.slice(0, limit).map((it) => ({ number: it.number, title: it.title })));
    },
  };
}

const DRY_RUN_CONFIG = { intake: { definicion: { label: 'needs-definition' } } };

test('R1 (a) el --search que llega a gh incluye el filtro anti-starvation', () => {
  const gh = makeGithubFake([]);
  pulpo.discoverWorkDryRun(DRY_RUN_CONFIG, {
    exec: gh.exec,
    getIntakeRepos: () => ['intrale/platform'],
    isRepoAllowed: () => true,
  });
  assert.equal(gh.seen.length, 2, 'un comando por pase: base + rescate');
  assert.ok(gh.seen[0].includes('-label:tipo:recomendacion'), gh.seen[0]);
  assert.ok(gh.seen[0].includes('-label:needs-human'), gh.seen[0]);
  // rev-1: el segundo pase es el que rescata las recos aprobadas.
  assert.ok(gh.seen[1].includes('label:recommendation:approved'), gh.seen[1]);
});

test('R1 (b) con 60 recomendaciones abiertas, el issue de definición real IGUAL aparece en discovered', () => {
  // 60 > el --limit 50: sin el filtro, las recomendaciones copan los 50 slots
  // y el issue real (que va último) nunca vuelve de GitHub.
  const recos = Array.from({ length: 60 }, (_, i) => ({
    number: 1000 + i,
    title: `[guru] recomendación ${i}`,
    labels: ['needs-definition', 'tipo:recomendacion'],
  }));
  const real = { number: 5689, title: 'issue de definición real', labels: ['needs-definition'] };
  const gh = makeGithubFake([...recos, real]);

  const res = pulpo.discoverWorkDryRun(DRY_RUN_CONFIG, {
    exec: gh.exec,
    getIntakeRepos: () => ['intrale/platform'],
    isRepoAllowed: () => true,
  });

  assert.equal(res.sideEffects, false, 'discoverWorkDryRun no puede tener efectos de lado');
  assert.ok(
    res.discovered.some((w) => w.number === 5689),
    'el issue de definición real quedó ahogado por el backlog de recomendaciones (R1)',
  );
  assert.equal(res.discovered.length, 1, 'ninguna recomendación debería haber vuelto');
});

test('rev-1 (e2e) con el backlog ahogando, una reco YA APROBADA igual entra', () => {
  // El caso vivo que rompía rev-1: #5055 (needs-definition + tipo:recomendacion
  // + recommendation:approved, sin needs-human). El pase base la excluye por
  // `tipo:recomendacion`; el de rescate la trae.
  const recos = Array.from({ length: 60 }, (_, i) => ({
    number: 1000 + i,
    title: `[guru] recomendación ${i}`,
    labels: ['needs-definition', 'tipo:recomendacion'],
  }));
  const aprobada = {
    number: 5055,
    title: '[guru] recomendación aprobada por un humano',
    labels: ['needs-definition', 'tipo:recomendacion', 'source:recommendation', 'recommendation:approved'],
  };
  const real = { number: 5689, title: 'issue de definición real', labels: ['needs-definition'] };
  const gh = makeGithubFake([...recos, aprobada, real]);

  const res = pulpo.discoverWorkDryRun(DRY_RUN_CONFIG, {
    exec: gh.exec,
    getIntakeRepos: () => ['intrale/platform'],
    isRepoAllowed: () => true,
  });

  const nums = res.discovered.map((w) => w.number).sort((a, b) => a - b);
  assert.deepEqual(nums, [5055, 5689], `esperado [5055, 5689], vino ${JSON.stringify(nums)}`);
});

test('rev-1 (e2e) una reco aprobada Y bloqueada de verdad NO entra (breaker vivo)', () => {
  const aprobadaBloqueada = {
    number: 5055,
    title: '[guru] aprobada pero bloqueada',
    labels: ['needs-definition', 'tipo:recomendacion', 'recommendation:approved', 'needs-human'],
  };
  const gh = makeGithubFake([aprobadaBloqueada]);
  const res = pulpo.discoverWorkDryRun(DRY_RUN_CONFIG, {
    exec: gh.exec,
    getIntakeRepos: () => ['intrale/platform'],
    isRepoAllowed: () => true,
  });
  assert.deepEqual(res.discovered, [], 'el rescate no puede ser un bypass del circuit breaker');
});

test('rev-1 (e2e) el mismo issue en los dos pases se devuelve UNA sola vez', () => {
  // El índice de GitHub es eventualmente consistente: un issue recién aprobado
  // puede volver por los dos pases. Sin dedup se encolaría/contaría dos veces.
  const gh = {
    seen: [],
    exec(cmd) {
      gh.seen.push(cmd);
      return JSON.stringify([{ number: 5055, title: 'reco aprobada' }]);
    },
  };
  const res = pulpo.discoverWorkDryRun(DRY_RUN_CONFIG, {
    exec: gh.exec,
    getIntakeRepos: () => ['intrale/platform'],
    isRepoAllowed: () => true,
  });
  assert.equal(gh.seen.length, 2, 'los dos pases se ejecutaron');
  assert.deepEqual(res.discovered.map((w) => w.number), [5055], 'debe estar deduplicado');
});

test('rev-1 un pase que falla no tumba al otro', () => {
  // Degradación parcial: si el pase base explota, el rescate igual devuelve lo
  // suyo (y viceversa). Antes un throw dejaba `issues = []` para todo el repo.
  let n = 0;
  const gh = {
    exec() {
      n += 1;
      if (n === 1) throw new Error('gh se cayó en el pase base');
      return JSON.stringify([{ number: 5055, title: 'reco aprobada' }]);
    },
  };
  const res = pulpo.discoverWorkDryRun(DRY_RUN_CONFIG, {
    exec: gh.exec,
    getIntakeRepos: () => ['intrale/platform'],
    isRepoAllowed: () => true,
  });
  assert.deepEqual(res.discovered.map((w) => w.number), [5055]);
});

test('rev-1 el gate ADMITE lo que el pase de rescate trae (las dos capas cierran)', () => {
  // Composición explícita de las dos capas: disponibilidad (search) + control
  // autoritativo (gate). La regresión fue precisamente que cerraban en
  // contradicción — el gate decía "admitir" y el search ya lo había descartado.
  const labelsAprobada = ['needs-definition', 'tipo:recomendacion', 'recommendation:approved'];
  assert.equal(isPendingRecommendationIssue(labelsAprobada), false, 'el gate la admite');
  assert.ok(
    /(^|\s)label:recommendation:approved(\s|$)/.test(buildIntakeSearchRescueQuery()),
    'y el search la trae — si no, el gate nunca la ve',
  );
});

test('R1 (b-control) el mismo fixture SÍ se ahoga si el search no filtra recomendaciones', () => {
  // Control negativo: demuestra que el fake reproduce el starvation de verdad y
  // que la aserción anterior no pasa por casualidad.
  const recos = Array.from({ length: 60 }, (_, i) => ({
    number: 1000 + i,
    title: `[guru] recomendación ${i}`,
    labels: ['needs-definition', 'tipo:recomendacion'],
  }));
  const real = { number: 5689, title: 'issue de definición real', labels: ['needs-definition'] };
  const gh = makeGithubFake([...recos, real]);

  const soloNeedsHuman = gh.exec(
    '"gh" issue list --repo intrale/platform --label "needs-definition" --state open --json number,title --limit 50 --search "-label:needs-human"',
  );
  const ahogado = JSON.parse(soloNeedsHuman);
  assert.equal(ahogado.length, 50);
  assert.ok(!ahogado.some((it) => it.number === 5689), 'el fixture debe ahogar al issue real sin el filtro nuevo');
});

// ---------------------------------------------------------------------------
// REQ-SEC-3 — invariante del dry-run: no puede evaluar el gate porque no trae
// `labels`. Queda fijada para que un futuro "reusemos el dry-run para encolar"
// no abra un bypass total del control autoritativo sin que nadie lo note.
// ---------------------------------------------------------------------------

test('REQ-SEC-3 discoverWorkDryRun sigue sin traer labels y sigue sin encolar', () => {
  const gh = makeGithubFake([]);
  const res = pulpo.discoverWorkDryRun(DRY_RUN_CONFIG, {
    exec: gh.exec,
    getIntakeRepos: () => ['intrale/platform'],
    isRepoAllowed: () => true,
  });
  assert.equal(res.sideEffects, false);
  const json = (gh.seen[0].match(/--json (\S+)/) || [, ''])[1];
  assert.ok(
    !json.split(',').includes('labels'),
    'si el dry-run pasa a traer labels, DEBE además pasar por el gate isPendingRecommendationIssue() antes de alimentar cualquier encolado',
  );
});
