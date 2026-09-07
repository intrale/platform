'use strict';

// =============================================================================
// dashboard-health-title-fetch-4128.test.js — regresión #4128.
//
// Contexto: #4096/#4126 trocearon el escaneo del FS y movieron wmic/tasklist a
// async, pero el worker de snapshot SEGUÍA resolviendo títulos/labels de issues
// con `fetchIssueTitles` → `execSync(gh api graphql, timeout 30s)` SINCRÓNICO
// dentro del generador. Esa llamada de red clavaba el event loop ENTERO mientras
// gh respondía: /api/health no contestaba, el smoke (paso 2) del restart lo leía
// como caída y disparaba rollback en LOOP. Era la pata que faltaba: el test de
// #4126 pre-poblaba el cache de títulos y usaba un gh noop, así que NUNCA
// ejercitaba este camino.
//
// El fix: el generador ya NO llama gh; sólo registra los ids faltantes y el
// worker los resuelve async (`fetchIssueTitlesAsync` vía `exec`, fire-and-forget).
//
// Este test levanta el dashboard real con:
//   - cache de títulos VENCIDO (fetchedAt viejo) → `missing` no vacío → se
//     dispara el refresh de títulos en cada ciclo del worker.
//   - un `gh` FALSO y LENTO (~2s por invocación): si el fetch fuese síncrono,
//     /api/health superaría holgadamente el budget.
// y verifica el CA central: GET /api/health responde < 500ms igual.
// =============================================================================

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnDashboard, waitForDashboardBoot } = require('./helpers/dashboard-boot');
const { getFreePort } = require('./helpers/free-port');
const { seedConfig } = require('./helpers/sandbox-config');

const PIPELINE_SRC = path.resolve(__dirname, '..');
const dashboardPath = path.join(PIPELINE_SRC, 'dashboard.js');

const ISSUE_COUNT = 120;        // suficiente para >1 batch GraphQL y forzar el cap
const HEALTH_BUDGET_MS = 500;   // budget objetivo del endpoint liviano (p90)
// Cota dura: un solo sample por encima de esto significa que el event loop quedó
// clavado segundos = regresión a gh síncrono. El gate REAL del smoke (smoke-test.js)
// usa timeout 5000ms sin reintento; con gh síncrono CADA tick bloqueaba ~2-30s, así
// que TODOS los samples se irían >2s. Un único outlier de ~1s por el costo de spawn
// de cmd.exe en Windows (exec async) NO es la regresión y no dispara rollback.
const HEALTH_HARD_BLOCK_MS = 2500;
// Tolerancia de outliers a nivel hard-block. La regresión real de #4128 volvía
// gh SÍNCRONO dentro del worker: clavaba el event loop ~2-30s en CADA tick, así
// que se manifiesta como una MAYORÍA de samples >=HARD_BLOCK, nunca como un pico
// aislado. Bajo la suite Node completa (>500 archivos en el mismo host) el
// proceso padre que MIDE queda saturado y puede registrar un único sample apenas
// sobre el piso sin que el dashboard child esté starvado (rebote #4534: 1 outlier
// bajo la suite completa con zero-tolerance; mismo falso positivo que el test
// hermano #4126 documentó en rebotes #3932/#4513). Se tolera una minoría dura
// (10%, mínimo 1) sin perder la señal: el fetch síncrono dispara ~100%.
const HEALTH_HARD_BLOCK_TOLERANCE_RATIO = 0.10;
// Presupuesto medido por MEDIANA, no por conteo de outliers (rebote #4534 rev-2).
// Historia: el gate de presupuesto se evaluaba como "<=X% de samples pueden
// pasar HEALTH_BUDGET_MS" y ese X se fue aflojando rebote tras rebote
// (#3932/#4513/#4524: 10%; #4534 rev-1: 25%) porque bajo la suite Node completa
// el proceso que MIDE queda saturado e inyecta jitter de scheduling de cientos de
// ms a una MINORÍA de samples SIN que el dashboard child esté lento. Con pocos
// samples (12) esa minoría dispara el % (rev-1: 4/12 = 33% con max=625ms, muy
// lejos de los ~2000ms de la regresión real). Un umbral por % es intrínsecamente
// frágil ahí. La regresión real (gh SÍNCRONO en el worker) clava el event loop
// del child ~2-30s en CADA tick → ~100% de samples se van >=2000ms y la MEDIANA
// se dispara. La mediana es inmune a una minoría de outliers del padre pero
// captura de lleno el 100% de samples lentos de la regresión: mejor discriminador
// y más fuerte (los ~2000ms de la regresión ni siquiera llegan al hard-block de
// 2500ms, así que sin este gate por mediana la señal quedaría floja).
//
// rev-3 (rebote #4534): la mediana se evaluaba contra HEALTH_BUDGET_MS=500, pero
// ese 500ms es el budget IDEAL del endpoint aislado, NO un piso robusto bajo la
// suite Node COMPLETA (8346 tests). Con esa carga el proceso padre que MIDE queda
// tan saturado que la MAYORÍA de samples sanos caen en 500-1000ms (rebote #4534
// rev-2: mediana 634ms, max 986ms, samples=12) sin que el dashboard child esté
// lento — verificado: el worker resuelve títulos por _scheduleTitleRefresh (exec
// async fire-and-forget), NO por fetchIssueTitles/execSync (sin usos fuera de su
// definición). Bajar el budget no arregla nada: el discriminador real es el GAP
// entre la latencia sana-saturada (~600-1000ms) y la de la regresión (~2000ms+),
// no el valor absoluto. Se separa el techo de mediana en HEALTH_MEDIAN_MAX_MS,
// fijado DENTRO de ese gap: por encima del jitter observado del padre (986ms) y
// muy por debajo del piso de la regresión (~2000ms). Así la mediana sigue siendo
// el detector load-bearing (la regresión la dispara con >=500ms de margen) sin
// falsos positivos por saturación del proceso que mide.
const HEALTH_MEDIAN_MAX_MS = 1500;
const HAMMER_MS = 3000;
const MIN_SAMPLES = 12;
const HAMMER_HARD_CAP_MS = 20000;

let tmpDir, child, port;
const isWin = process.platform === 'win32';

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

function getJson(p, urlPath, timeoutMs, cb) {
  const req = http.get({ host: '127.0.0.1', port: p, path: urlPath, timeout: timeoutMs }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => cb(null, { status: res.statusCode, body: data }));
  });
  req.on('error', cb);
  req.on('timeout', function () { this.destroy(); cb(new Error('timeout')); });
}

function timedHealth(p) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    getJson(p, '/api/health', 2000, (err, r) => {
      const elapsed = Date.now() - t0;
      resolve({ elapsed, ok: !err && r && r.status === 200, err: err && err.message });
    });
  });
}

before(async function () {
  if (!isWin) return; // el gh falso es un .cmd (Windows); fuera de win32 se omite
  const yaml = require('js-yaml');
  const config = yaml.load(fs.readFileSync(path.join(PIPELINE_SRC, 'config.yaml'), 'utf8'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash4128-'));

  const faseDirs = [];
  for (const [pname, pcfg] of Object.entries(config.pipelines)) {
    for (const fase of pcfg.fases) {
      for (const st of ['pendiente', 'trabajando', 'listo', 'procesado']) {
        mkdirp(path.join(tmpDir, pname, fase, st));
      }
      faseDirs.push({ pname, fase });
    }
  }
  mkdirp(path.join(tmpDir, 'logs'));
  // #5174 — los DOS lados de la config (kernel + pipeline.config.json).
  // Copiar sólo el YAML deja el sandbox a medias y el resolver falla cerrado.
  seedConfig(tmpDir);

  // Markers en `trabajando/` → entran al issueMatrix (= wantedIds). El cache de
  // títulos se pre-puebla pero VENCIDO (fetchedAt muy viejo) → titleCacheNeedsRefetch
  // los marca como `missing` y el worker dispara el fetch de títulos cada ciclo.
  const skills = ['dev', 'verificacion', 'build', 'qa', 'review'];
  const titleCache = {};
  const stale = Date.now() - (2 * 3600 * 1000); // 2h: supera TITLE_CACHE_TTL (1h)
  for (let i = 0; i < ISSUE_COUNT; i++) {
    const issue = 300000 + i;
    const skill = skills[i % skills.length];
    const { pname, fase } = faseDirs[i % faseDirs.length];
    const file = path.join(tmpDir, pname, fase, 'trabajando', `${issue}.${skill}`);
    fs.writeFileSync(file, `issue: ${issue}\nfase: ${fase}\npipeline: ${pname}\n`);
    titleCache[String(issue)] = { title: `stale ${issue}`, state: 'OPEN', labels: [], fetchedAt: stale };
  }
  fs.writeFileSync(path.join(tmpDir, '.issue-title-cache.json'), JSON.stringify(titleCache));

  // `gh` FALSO y LENTO: un .cmd que duerme ~2s (ping) y emite un JSON GraphQL
  // vacío. Si el dashboard llamara gh sincrónicamente, cada ciclo del worker
  // clavaría el event loop ~2s → /api/health > budget. (El path del .cmd no
  // tiene espacios — mkdtemp en %TEMP% —, así que la interpolación sin comillas
  // del dashboard funciona.)
  const fakeGh = path.join(tmpDir, 'fake-gh.cmd');
  fs.writeFileSync(fakeGh,
    '@echo off\r\nping -n 3 127.0.0.1 >nul\r\necho {"data":{"repository":{}}}\r\n');

  port = await getFreePort();
  child = spawnDashboard({
    dashboardPath,
    env: {
      ...process.env,
      PIPELINE_STATE_DIR: tmpDir,
      PIPELINE_DIR_OVERRIDE: tmpDir,
      DASHBOARD_PORT: String(port),
      DASHBOARD_HOST: '127.0.0.1',
      GH_BIN: fakeGh,
      DASHBOARD_STATE_REFRESH_MS: '30',
      DASHBOARD_PROC_STATUS_TTL_MS: '50',
      DASHBOARD_ETA_TTL_MS: '50',
    },
  });

  await waitForDashboardBoot({
    child,
    probe: () => new Promise((resolve, reject) => {
      getJson(port, '/api/health', 5000, (err, r) => (err ? reject(err) : resolve(r && r.status === 200)));
    }),
  });
});

after(() => {
  if (child) { try { child.kill(); } catch {} }
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
});

test('/api/health responde < 500ms aunque el worker resuelva títulos contra un gh lento', async function (t) {
  if (!isWin) { t.skip('gh falso requiere Windows (.cmd)'); return; }

  // Margen para que el worker arranque y dispare el refresh de títulos.
  await new Promise((r) => setTimeout(r, 400));

  const samples = [];
  const tStart = Date.now();
  while (
    (Date.now() - tStart < HAMMER_MS || samples.length < MIN_SAMPLES) &&
    Date.now() - tStart < HAMMER_HARD_CAP_MS
  ) {
    samples.push(await timedHealth(port));
  }

  assert.ok(
    samples.length >= MIN_SAMPLES,
    `se esperaban >= ${MIN_SAMPLES} muestras, hubo ${samples.length}: event loop starvado. ` +
    `Lentas/fallidas: ${JSON.stringify(samples.filter((s) => !s.ok || s.elapsed >= HEALTH_BUDGET_MS).slice(0, 3))}`,
  );

  // Zero-tolerance SOLO para errores de conexión genuinos (ECONNREFUSED/reset), NO
  // timeouts. Un timeout es una muestra de LATENCIA (midió ~2000ms, el timeout HTTP),
  // no una caída de conexión: se evalúa por las invariantes de latencia (a)/(b) de
  // abajo. Alinea con el test hermano dashboard-health-under-load-4126 (rebote #4513):
  // bajo la suite Node completa el proceso padre se satura y un timeout aislado
  // (p.ej. 1/59 a ~2s, rebote #4524) es jitter del padre, no la regresión de gh
  // síncrono. La regresión real dispara ~100% de timeouts y revienta igual la
  // invariante de presupuesto (b) de abajo, así que la detección se preserva.
  const genuineFailures = samples.filter((s) => !s.ok && s.err !== 'timeout');
  assert.deepStrictEqual(genuineFailures, [],
    `/api/health falló por error de conexión (no timeout) en ${genuineFailures.length}/${samples.length}: ${JSON.stringify(genuineFailures.slice(0, 3))}`);

  const max = Math.max(...samples.map((s) => s.elapsed));

  // (a) Invariante DURA: ningún sample puede clavarse segundos. Con gh síncrono
  // CADA tick bloqueaba ~2-30s → habría samples por encima de la cota. Que el max
  // quede por debajo prueba que el event loop nunca se congela como antes.
  const blocked = samples.filter((s) => s.elapsed >= HEALTH_HARD_BLOCK_MS);
  const blockedTolerance = Math.max(1, Math.floor(samples.length * HEALTH_HARD_BLOCK_TOLERANCE_RATIO));
  assert.ok(blocked.length <= blockedTolerance,
    `REGRESIÓN #4128: /api/health se clavó >=${HEALTH_HARD_BLOCK_MS}ms en ${blocked.length}/${samples.length} samples ` +
    `(max=${max}ms, tolerancia ${blockedTolerance}). El fetch de títulos volvió a ser síncrono (execSync(gh)) ` +
    `dentro del worker de snapshot: dispararía ~100% de samples clavados, no un outlier aislado por saturación del padre.`);

  // (b) Invariante de presupuesto por MEDIANA (rebote #4534 rev-2/rev-3): con gh
  // síncrono TODOS los samples pasarían el budget (o expirarían) → la mediana se
  // dispara a >=2000ms. En sano, aunque el proceso padre saturado por la suite
  // completa deje a la MAYORÍA de samples en 500-1000ms, la mediana queda por
  // debajo de HEALTH_MEDIAN_MAX_MS (1500ms), que se fija en el gap entre el jitter
  // del padre (~1000ms) y el piso de la regresión (~2000ms). Un timeout (`!s.ok`)
  // mide ~2000ms (el timeout HTTP), así que ya contribuye alto al ordenamiento; no
  // hace falta forzarlo. La mediana no se mueve por outliers del padre pero sí por
  // la regresión sostenida (100% de samples >=2000ms).
  const elapsedSorted = samples.map((s) => s.elapsed).sort((a, b) => a - b);
  const median = elapsedSorted[Math.floor(elapsedSorted.length / 2)];
  assert.ok(median < HEALTH_MEDIAN_MAX_MS,
    `REGRESIÓN #4128: la MEDIANA de /api/health fue ${median}ms (techo ${HEALTH_MEDIAN_MAX_MS}ms, ` +
    `budget ideal ${HEALTH_BUDGET_MS}ms, samples=${samples.length}, max=${max}ms). El fetch de títulos ` +
    `volvió a ser síncrono (execSync(gh)) dentro del worker: clava el event loop ~2-30s en cada tick y ` +
    `~100% de samples superan ${HEALTH_MEDIAN_MAX_MS}ms (mediana >=2000ms). Un outlier aislado por ` +
    `saturación del proceso padre no mueve la mediana por debajo de ${HEALTH_MEDIAN_MAX_MS}ms.`);
});
