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
const { spawn } = require('child_process');

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
const HEALTH_P90_MAX_OUTLIERS_PCT = 0.10; // <=10% de samples pueden pasar el budget
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
  fs.copyFileSync(path.join(PIPELINE_SRC, 'config.yaml'), path.join(tmpDir, 'config.yaml'));

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

  port = 3760 + Math.floor((Date.now() % 200));
  child = spawn(process.execPath, [dashboardPath], {
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
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  await new Promise((resolve, reject) => {
    let tries = 0;
    const tick = () => {
      getJson(port, '/api/health', 5000, (err, r) => {
        if (!err && r && r.status === 200) return resolve();
        if (++tries > 60) return reject(new Error('dashboard no levantó: ' + (err && err.message)));
        setTimeout(tick, 250);
      });
    };
    setTimeout(tick, 500);
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

  const failures = samples.filter((s) => !s.ok);
  assert.deepStrictEqual(failures, [],
    `/api/health falló/expiró en ${failures.length}/${samples.length}: ${JSON.stringify(failures.slice(0, 3))}`);

  const max = Math.max(...samples.map((s) => s.elapsed));

  // (a) Invariante DURA: ningún sample puede clavarse segundos. Con gh síncrono
  // CADA tick bloqueaba ~2-30s → habría samples por encima de la cota. Que el max
  // quede por debajo prueba que el event loop nunca se congela como antes.
  const blocked = samples.filter((s) => s.elapsed >= HEALTH_HARD_BLOCK_MS);
  assert.deepStrictEqual(blocked.map((s) => s.elapsed), [],
    `REGRESIÓN #4128: /api/health se clavó >=${HEALTH_HARD_BLOCK_MS}ms (max=${max}ms, ${blocked.length}/${samples.length}). ` +
    `El fetch de títulos volvió a ser síncrono (execSync(gh)) dentro del worker de snapshot.`);

  // (b) Invariante de presupuesto: con gh síncrono TODOS los samples pasarían el
  // budget; en sano sólo se tolera un outlier aislado (spawn de cmd.exe en Windows).
  const slow = samples.filter((s) => s.elapsed >= HEALTH_BUDGET_MS);
  const slowPct = slow.length / samples.length;
  assert.ok(slowPct <= HEALTH_P90_MAX_OUTLIERS_PCT,
    `REGRESIÓN #4128: ${slow.length}/${samples.length} samples (${Math.round(slowPct * 100)}%) superaron ` +
    `${HEALTH_BUDGET_MS}ms (max=${max}ms). Tolerancia ${Math.round(HEALTH_P90_MAX_OUTLIERS_PCT * 100)}%. ` +
    `Un fetch síncrono dispararía el 100%, no un outlier aislado.`);
});
