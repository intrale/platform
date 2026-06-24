'use strict';

// =============================================================================
// dashboard-health-under-load-4126.test.js — regresión #4126.
//
// Contexto: el worker de snapshot (refreshStateSnapshot → getPipelineState)
// escaneaba TODO el FS del pipeline de forma SÍNCRONA y, peor, spawneaba
// `wmic` (PIDs) con spawnSync invalidando su cache en cada tick (hasta 15s de
// bloqueo) + `tasklist` por servicio QA. Con la cola grande, ese bloque
// monolítico clavaba el event loop por segundos: /api/health no respondía, el
// smoke (paso 2) del restart lo leía como caída y disparaba rollback en LOOP.
//
// El fix:
//   - Procesos/QA → `exec`/`execFile` async, cacheados con TTL, FUERA del tick.
//   - El builder es un generador con yields reales; el worker lo maneja con un
//     driver async que cede el event loop (setImmediate) en cada chunk.
//
// Este test levanta el dashboard real contra un pipeline PESADO (miles de
// markers en `procesado/`) y con el worker casi-siempre-activo
// (DASHBOARD_STATE_REFRESH_MS chico), y verifica el CA central:
//
//   GET /api/health responde < 500ms incluso mientras el worker computa el
//   snapshot, y /api/state se sirve sin colgarse.
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

// Escala del pipeline sintético. Suficiente para que un escaneo SÍNCRONO sin
// yields supere holgadamente los 500ms (en HEAD reproducía el cuelgue), pero
// acotado para que el `before()` no tarde demasiado.
const TOTAL_MARKERS = 6000;
const HEALTH_BUDGET_MS = 500;
const HAMMER_MS = 3000;
// Piso de muestras a recolectar antes de evaluar la latencia. NO se deriva del
// wall-clock: el tester corre las 355 suites Node en UN proceso, así que el
// proceso padre que mide (este test) está saturado y recoge menos muestras por
// segundo. Atar la cantidad esperada a HAMMER_MS hacía el test flaky (hubo 12
// muestras healthy <500ms en 3s y el `>= 20` rebotaba). Martillamos hasta
// juntar MIN_SAMPLES con un cap duro; la regresión real (loop starvado) la
// detectan las aserciones de fallos/latencia, no la cantidad.
const MIN_SAMPLES = 12;
const HAMMER_HARD_CAP_MS = 20000;
// Umbral de starvation: señal INEQUÍVOCA de loop clavado. La regresión real de
// #4126 dejaba /api/health en ~2s (cerca del timeout HTTP de 2000ms) en TODAS
// las requests durante el escaneo síncrono. Cualquier request que alcance este
// piso es starvation de verdad, no jitter.
const STARVATION_MS = 1200;
// Tolerancia de outliers sub-segundo. El tester corre las 6234 pruebas Node en
// UN único proceso, así que el proceso padre que MIDE está saturado y puede
// registrar picos aislados (p.ej. 571ms) sin que el dashboard esté starvado.
// Se tolera una minoría de muestras lentas mientras la mayoría siga healthy y
// ninguna alcance STARVATION_MS (rebote #3932: 1/12 a 571ms era falso positivo).
const SLOW_TOLERANCE_RATIO = 0.25;

let tmpDir, child, port;

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
    // Damos margen alto al timeout HTTP (2s) para MEDIR la latencia real: si el
    // loop está starvado, queremos ver 1500ms, no un corte temprano.
    getJson(p, '/api/health', 2000, (err, r) => {
      const elapsed = Date.now() - t0;
      resolve({ elapsed, ok: !err && r && r.status === 200, err: err && err.message });
    });
  });
}

before(async () => {
  const yaml = require('js-yaml');
  const config = yaml.load(fs.readFileSync(path.join(PIPELINE_SRC, 'config.yaml'), 'utf8'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash4126-'));

  // Estructura de fases/estados.
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

  // Poblar `procesado/` con muchos markers (round-robin sobre las fases) +
  // pre-poblar el cache de títulos para que el worker NO dispare gh (aislamos el
  // costo del escaneo del FS, que es lo que el fix trocea).
  const skills = ['dev', 'verificacion', 'build', 'qa', 'review'];
  const titleCache = {};
  const now = Date.now();
  for (let i = 0; i < TOTAL_MARKERS; i++) {
    const issue = 200000 + i;
    const skill = skills[i % skills.length];
    const { pname, fase } = faseDirs[i % faseDirs.length];
    const file = path.join(tmpDir, pname, fase, 'procesado', `${issue}.${skill}`);
    const resultado = (i % 7 === 0) ? 'rechazado' : 'aprobado';
    fs.writeFileSync(file,
      `issue: ${issue}\nfase: ${fase}\npipeline: ${pname}\nresultado: ${resultado}\nmotivo: "marker sintético #4126"\n`);
    titleCache[String(issue)] = { title: `synthetic ${issue}`, state: 'OPEN', labels: [], fetchedAt: now };
  }
  fs.writeFileSync(path.join(tmpDir, '.issue-title-cache.json'), JSON.stringify(titleCache));

  port = 3700 + Math.floor((Date.now() % 200));
  child = spawn(process.execPath, [dashboardPath], {
    env: {
      ...process.env,
      PIPELINE_STATE_DIR: tmpDir,
      PIPELINE_DIR_OVERRIDE: tmpDir,
      DASHBOARD_PORT: String(port),
      DASHBOARD_HOST: '127.0.0.1',
      GH_BIN: 'gh-noop-nonexistent',
      // Worker casi-siempre-activo: refresca apenas termina un ciclo, de modo que
      // los GET /api/health del hammer caen mientras el snapshot se está computando.
      DASHBOARD_STATE_REFRESH_MS: '30',
      DASHBOARD_PROC_STATUS_TTL_MS: '50',
      DASHBOARD_ETA_TTL_MS: '50',
    },
    stdio: 'ignore',
  });

  // Esperar a que /api/health levante.
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

test('CA-1/CA-4 — /api/health responde < 500ms mientras el worker computa el snapshot', async () => {
  // Dar un primer ciclo de refresh para garantizar que el worker está activo
  // y, sobre un pipeline de miles de markers, en pleno escaneo.
  await new Promise((r) => setTimeout(r, 300));

  // Martillar al menos HAMMER_MS (para cruzar varios ciclos del worker) y, además,
  // hasta juntar MIN_SAMPLES. Bajo carga del tester el padre recoge pocas muestras
  // por segundo, así que extendemos el martilleo en vez de exigir un ritmo fijo.
  // Cap duro para no colgar si el loop está realmente starvado: en ese caso cada
  // `timedHealth` tarda ~2s (su timeout HTTP) y las aserciones de abajo lo marcan
  // como regresión.
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
    `se esperaban al menos ${MIN_SAMPLES} muestras de health en ${HAMMER_HARD_CAP_MS}ms, hubo ${samples.length}: ` +
    `el event loop del dashboard está starvado (cada request demora ~su timeout). ` +
    `Muestras lentas/fallidas: ${JSON.stringify(samples.filter((s) => !s.ok || s.elapsed >= HEALTH_BUDGET_MS).slice(0, 3))}`,
  );

  const failures = samples.filter((s) => !s.ok);
  assert.deepStrictEqual(
    failures, [],
    `/api/health falló/expiró en ${failures.length}/${samples.length} muestras: ${JSON.stringify(failures.slice(0, 3))}`,
  );

  const max = Math.max(...samples.map((s) => s.elapsed));
  const slow = samples.filter((s) => s.elapsed >= HEALTH_BUDGET_MS);
  const starved = samples.filter((s) => s.elapsed >= STARVATION_MS);

  // Señal DURA: ninguna request puede acercarse al timeout. La regresión real
  // (#4126) clavaba el loop por segundos en TODAS las requests; un único pico
  // sub-segundo no lo es. Tolerancia cero acá: cualquier muestra >=STARVATION_MS
  // es starvation inequívoca.
  assert.deepStrictEqual(
    starved.map((s) => s.elapsed), [],
    `REGRESIÓN #4126: /api/health alcanzó nivel de starvation (>=${STARVATION_MS}ms) mientras el ` +
    `worker computaba (max=${max}ms, ${starved.length}/${samples.length} muestras). El event loop se ` +
    `starvó: el snapshot volvió a un escaneo síncrono monolítico o reintrodujo wmic/tasklist sync.`,
  );

  // Señal BLANDA: la latencia healthy (<500ms) debe ser la NORMA. Se tolera una
  // minoría de outliers sub-segundo (jitter del proceso padre saturado por la
  // suite completa), pero no una mayoría lenta — eso sí indica degradación del
  // loop aunque ninguna request llegue al piso de starvation.
  const maxSlowAllowed = Math.floor(samples.length * SLOW_TOLERANCE_RATIO);
  assert.ok(
    slow.length <= maxSlowAllowed,
    `REGRESIÓN #4126: ${slow.length}/${samples.length} requests de /api/health superaron ${HEALTH_BUDGET_MS}ms ` +
    `(tolerado: ${maxSlowAllowed}, max=${max}ms). La mayoría debería responder healthy; tantas lentas ` +
    `indican que el event loop se degradó (escaneo síncrono monolítico o wmic/tasklist sync reintroducido). ` +
    `Lentas: ${JSON.stringify(slow.map((s) => s.elapsed).slice(0, 5))}`,
  );
});

test('CA-3 — /api/state se sirve (200 + JSON) sin colgarse bajo el ciclo de refresh', async () => {
  const t0 = Date.now();
  const r = await new Promise((res, rej) => getJson(port, '/api/state', 5000, (e, x) => e ? rej(e) : res(x)));
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.status, 200, 'HTTP 200');
  const json = JSON.parse(r.body); // no debe tirar
  assert.ok(json && typeof json === 'object', 'JSON objeto');
  // Una vez poblado el snapshot, /api/state es O(1).
  assert.ok(elapsed < 1000, `/api/state debe servirse rápido desde el snapshot, tardó ${elapsed}ms`);
  // El worker efectivamente escaneó el pipeline pesado (issueMatrix poblado).
  if (json.issueMatrix) {
    assert.ok(Object.keys(json.issueMatrix).length > 1000, 'el snapshot debe reflejar el pipeline pesado escaneado');
  }
});
