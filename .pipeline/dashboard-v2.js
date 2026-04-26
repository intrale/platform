#!/usr/bin/env node
// =============================================================================
// Dashboard V2 — Visualización completa del pipeline
// Issue Tracker Matrix + tooltips + links GitHub + logs + SSE live
// =============================================================================

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const yaml = require('js-yaml');
const {
  findPidByComponent,
  findPidByPort,
  pidAlive,
  invalidateCache,
} = require('./pid-discovery');
// #2337 CA8 — estado `reintentando` (anti-parpadeo FS-driven).
// Best-effort require: si el modulo no existe (pipeline antiguo), degradamos
// silenciosamente sin el estado `retrying`.
let retryingState = null;
try { retryingState = require('./retrying-state'); } catch { /* opcional */ }

// V3 — Métricas extendidas (issue #2477). Best-effort require por si el
// módulo todavía no existe en pipelines antiguos.
let v3Aggregator = null;
try { v3Aggregator = require('./metrics/aggregator'); } catch { /* V3 no disponible */ }

// Recomendaciones generadas por agentes (issue #2653). Best-effort require.
let recommendationsLib = null;
try { recommendationsLib = require('./lib/recommendations'); } catch { /* opcional */ }

const PORT = parseInt(process.env.DASHBOARD_PORT) || 3200;
const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);
const ROOT = process.env.PIPELINE_MAIN_ROOT || path.resolve(__dirname, '..');
const LOG_DIR = path.join(PIPELINE, 'logs');
const GITHUB_BASE = 'https://github.com/intrale/platform/issues';

// --- Componentes gestionables (start/stop) ---
const COMPONENTS = [
  { name: 'pulpo', script: 'pulpo.js', pid: 'pulpo.pid' },
  { name: 'listener', script: 'listener-telegram.js', pid: 'listener.pid' },
  { name: 'svc-telegram', script: 'servicio-telegram.js', pid: 'svc-telegram.pid' },
  { name: 'svc-github', script: 'servicio-github.js', pid: 'svc-github.pid' },
  { name: 'svc-drive', script: 'servicio-drive.js', pid: 'svc-drive.pid' },
  { name: 'svc-emulador', script: 'servicio-emulador.js', pid: 'svc-emulador.pid' },
  { name: 'outbox-drain', script: 'outbox-drain.js', pid: 'outbox-drain.pid' },
];
// Nota: dashboard no se incluye (no puede matarse a sí mismo)

// gh CLI: el proceso del dashboard no necesariamente tiene gh en PATH.
// Usamos un fallback hardcoded al binario en la instalación local.
const GH_BIN_DEFAULT = 'C:/Workspaces/gh-cli/bin/gh';
const GH_BIN = process.env.GH_BIN || process.env.GH_PATH || GH_BIN_DEFAULT;

// --- Issue title/label cache (persisted to disk, refreshed via gh CLI) ---
const TITLE_CACHE_FILE = path.join(PIPELINE, '.issue-title-cache.json');
const TITLE_CACHE_TTL = 3600000; // 1 hour

function loadIssueTitleCache() {
  try {
    const raw = fs.readFileSync(TITLE_CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
}

function saveIssueTitleCache(cache) {
  try { fs.writeFileSync(TITLE_CACHE_FILE, JSON.stringify(cache, null, 2)); } catch {}
}

function fetchIssueTitles(issueIds, cache) {
  const ghPath = GH_BIN;
  // GraphQL batch: up to 50 issues per query
  const batches = [];
  for (let i = 0; i < issueIds.length; i += 50) batches.push(issueIds.slice(i, i + 50));
  for (const batch of batches) {
    const tmpQuery = path.join(PIPELINE, '.gh-query-' + Date.now() + '.graphql');
    try {
      const fields = batch.map((id, i) => `i${i}: issue(number:${id}) { number title labels(first:10) { nodes { name } } }`).join(' ');
      const query = `{ repository(owner:"intrale",name:"platform") { ${fields} } }`;
      // Write query to temp file to avoid shell escaping issues on Windows
      fs.writeFileSync(tmpQuery, query);
      const cmd = `${ghPath} api graphql -F query=@${tmpQuery}`;
      const out = execSync(cmd, { encoding: 'utf8', timeout: 30000, windowsHide: true });
      const data = JSON.parse(out)?.data?.repository || {};
      // Negative cache: issues ausentes/null en la respuesta se marcan como notFound
      // para que no vuelvan a consultarse en cada refresh (evita loop gh api).
      batch.forEach((id, i) => {
        const val = data[`i${i}`];
        if (val?.number) {
          cache[String(val.number)] = {
            title: val.title,
            labels: (val.labels?.nodes || []).map(l => l.name),
            fetchedAt: Date.now()
          };
        } else {
          cache[String(id)] = { title: '', labels: [], notFound: true, fetchedAt: Date.now() };
        }
      });
    } catch (e) {
      // Fallback: fetch one by one
      for (const id of batch) {
        try {
          const cmd2 = `${ghPath} issue view ${id} --repo intrale/platform --json title,labels`;
          const out2 = execSync(cmd2, { encoding: 'utf8', timeout: 10000, windowsHide: true });
          const iss = JSON.parse(out2);
          cache[id] = { title: iss.title, labels: (iss.labels || []).map(l => l.name), fetchedAt: Date.now() };
        } catch {
          // Issue no resoluble: cachear como notFound para evitar re-consulta en cada refresh
          cache[String(id)] = { title: '', labels: [], notFound: true, fetchedAt: Date.now() };
        }
      }
    } finally {
      // Garantiza limpieza del tmp aunque execSync falle (evita acumulación .gh-query-*.graphql)
      try { fs.unlinkSync(tmpQuery); } catch {}
    }
  }
  saveIssueTitleCache(cache);
}

function isProcessAlive(pid) {
  return pidAlive(pid);
}

// Descubrimos el PID al vuelo desde el SO — el archivo .pid es sólo hint.
function getComponentPid(comp) {
  const found = findPidByComponent(comp.name);
  return found ? found.pid : null;
}

function stopComponent(name) {
  const comp = COMPONENTS.find(c => c.name === name);
  if (!comp) return { ok: false, msg: `Componente "${name}" no encontrado` };
  invalidateCache();
  const pid = getComponentPid(comp);
  if (!pid) return { ok: true, msg: `${name} no estaba corriendo` };
  try {
    execSync(`taskkill /PID ${pid} /F /T`, { timeout: 5000, windowsHide: true });
    try { fs.unlinkSync(path.join(PIPELINE, comp.pid)); } catch {}
    return { ok: true, msg: `${name} detenido (PID ${pid})` };
  } catch (e) { return { ok: false, msg: `Error deteniendo ${name}: ${e.message}` }; }
}

function startComponent(name) {
  const comp = COMPONENTS.find(c => c.name === name);
  if (!comp) return { ok: false, msg: `Componente "${name}" no encontrado` };
  invalidateCache();
  const pid = getComponentPid(comp);
  if (pid) return { ok: true, msg: `${name} ya está corriendo (PID ${pid})` };
  const scriptPath = path.join(PIPELINE, comp.script);
  if (!fs.existsSync(scriptPath)) return { ok: false, msg: `Script ${comp.script} no existe` };
  try {
    const logPath = path.join(LOG_DIR, `${comp.name}.log`);
    const logFd = fs.openSync(logPath, 'a');
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT, stdio: ['ignore', logFd, logFd], detached: true, windowsHide: true
    });
    child.unref();
    fs.closeSync(logFd);
    return { ok: true, msg: `${name} iniciado (PID ${child.pid})` };
  } catch (e) { return { ok: false, msg: `Error iniciando ${name}: ${e.message}` }; }
}

// QA Environment
const QA_ENV_SCRIPT = path.join(PIPELINE, 'qa-environment.js');

function qaAction(action, component) {
  if (!fs.existsSync(QA_ENV_SCRIPT)) return { ok: false, msg: 'qa-environment.js no existe' };
  try {
    const cmd = component
      ? `"${process.execPath}" "${QA_ENV_SCRIPT}" ${action} ${component}`
      : `"${process.execPath}" "${QA_ENV_SCRIPT}" ${action}`;
    const output = execSync(cmd, {
      cwd: ROOT, encoding: 'utf8', timeout: 60000, windowsHide: true
    });
    return { ok: true, msg: output.trim().slice(-200) };
  } catch (e) { return { ok: false, msg: `Error: ${(e.stderr || e.message || '').slice(0, 200)}` }; }
}

// --- Resource Monitor: CPU y Memoria ---
let lastCpuSnapshot = null;

function cpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) total += cpu.times[type];
    idle += cpu.times.idle;
  }
  return { idle, total };
}

function getSystemResourceUsage() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
  const memUsedGB = ((totalMem - freeMem) / (1024 ** 3)).toFixed(1);
  const memTotalGB = (totalMem / (1024 ** 3)).toFixed(1);

  const current = cpuSnapshot();
  let cpuPercent = 0;
  if (lastCpuSnapshot) {
    const idleDelta = current.idle - lastCpuSnapshot.idle;
    const totalDelta = current.total - lastCpuSnapshot.total;
    cpuPercent = totalDelta > 0 ? Math.round(((totalDelta - idleDelta) / totalDelta) * 100) : 0;
  }
  lastCpuSnapshot = current;

  return { cpuPercent, memPercent, memUsedGB, memTotalGB, cpuCores: os.cpus().length };
}

// Snapshot inicial
lastCpuSnapshot = cpuSnapshot();

// Ring buffer para sparklines de CPU/RAM (últimas ~10 min a 1 sample/10s = 60 puntos)
const RESOURCE_HISTORY_MAX = 60;
const resourceHistory = { cpu: [], mem: [], ts: [] };
function pushResourceSample(cpu, mem) {
  resourceHistory.cpu.push(cpu);
  resourceHistory.mem.push(mem);
  resourceHistory.ts.push(Date.now());
  if (resourceHistory.cpu.length > RESOURCE_HISTORY_MAX) {
    resourceHistory.cpu.shift();
    resourceHistory.mem.shift();
    resourceHistory.ts.shift();
  }
}

// Uptime de un proceso vía mtime del archivo .pid
function getProcessUptime(comp) {
  try {
    const s = fs.statSync(path.join(PIPELINE, `${comp}.pid`));
    return Date.now() - s.mtimeMs;
  } catch { return null; }
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [dashboard] ${msg}`);
}

function loadConfig() {
  try { return yaml.load(fs.readFileSync(path.join(PIPELINE, 'config.yaml'), 'utf8')); }
  catch { return { pipelines: {}, concurrencia: {} }; }
}

function listWorkFiles(dir) {
  try { return fs.readdirSync(dir).filter(f => !f.startsWith('.') && !f.endsWith('.gitkeep')); }
  catch { return []; }
}

function readYamlSafe(filepath) {
  try { return yaml.load(fs.readFileSync(filepath, 'utf8')) || {}; }
  catch { return {}; }
}

function fileStat(filepath) {
  try { const s = fs.statSync(filepath); return { ctimeMs: s.ctimeMs, mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs }; }
  catch { return null; }
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toISOString().slice(11, 19);
}

// --- Recolectar estado ---

function getPipelineState() {
  const config = loadConfig();
  const state = { config };

  // Todas las fases de ambos pipelines en orden
  const allFases = [];
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    for (const fase of pConfig.fases) {
      allFases.push({ pipeline: pName, fase });
    }
  }
  state.allFases = allFases;

  // Issue matrix: cruzar issue × fase con datos enriquecidos
  state.issueMatrix = {};
  for (const { pipeline: pName, fase } of allFases) {
    const baseDir = path.join(PIPELINE, pName, fase);
    for (const [estado, dir] of [['pendiente','pendiente'],['trabajando','trabajando'],['listo','listo'],['procesado','procesado']]) {
      for (const f of listWorkFiles(path.join(baseDir, dir))) {
        const issue = f.split('.')[0];
        const skill = f.split('.').slice(1).join('.');
        if (!state.issueMatrix[issue]) state.issueMatrix[issue] = { pipelines: new Set(), fases: {} };
        state.issueMatrix[issue].pipelines.add(pName);
        if (!state.issueMatrix[issue].fases[`${pName}/${fase}`]) state.issueMatrix[issue].fases[`${pName}/${fase}`] = [];

        const filepath = path.join(baseDir, dir, f);
        const stat = fileStat(filepath);
        const entry = { skill, estado, pipeline: pName, fase };

        if (stat) {
          entry.startedAt = stat.ctimeMs;
          entry.updatedAt = stat.mtimeMs;
          entry.durationMs = (estado === 'trabajando') ? Date.now() - stat.ctimeMs : stat.mtimeMs - stat.ctimeMs;
          entry.ageMin = Math.round((Date.now() - stat.mtimeMs) / 60000);
        }

        // Leer resultado/motivo de YAML para listo/procesado
        if (estado === 'listo' || estado === 'procesado') {
          const yamlData = readYamlSafe(filepath);
          entry.resultado = yamlData.resultado;
          entry.motivo = yamlData.motivo;
        }

        // Log disponible? Buscar {issue}-{skill}.log o build-{issue}.log
        let logFile = `${issue}-${skill}.log`;
        if (!fs.existsSync(path.join(LOG_DIR, logFile)) && skill === 'build') {
          logFile = `build-${issue}.log`;
        }
        entry.hasLog = fs.existsSync(path.join(LOG_DIR, logFile));
        entry.logFile = logFile;

        // PDF de reporte de rechazo disponible?
        const rejectionPdf = `rejection-${issue}-${skill}.pdf`;
        entry.hasRejectionPdf = fs.existsSync(path.join(LOG_DIR, rejectionPdf));
        entry.rejectionPdf = rejectionPdf;

        state.issueMatrix[issue].fases[`${pName}/${fase}`].push(entry);

        if (estado !== 'procesado') {
          // 'trabajando' tiene prioridad: no sobreescribir con 'listo' o 'pendiente'
          const prev = state.issueMatrix[issue].estadoActual;
          if (!prev || prev !== 'trabajando' || estado === 'trabajando') {
            state.issueMatrix[issue].faseActual = `${pName}/${fase}`;
            state.issueMatrix[issue].estadoActual = estado;
          }
        }
      }
    }
  }
  // Convert Sets to arrays for JSON + enriquecer con títulos/labels
  const issueIds = Object.keys(state.issueMatrix);
  const titleCache = loadIssueTitleCache();
  const missing = issueIds.filter(id => !titleCache[id]);
  if (missing.length > 0) fetchIssueTitles(missing, titleCache);
  state.issueTitles = titleCache;

  // #2337 CA8 — snapshot del estado `reintentando` activo en este refresh.
  // Timestamp absoluto (`retryingUntil`) persiste el anti-parpadeo entre
  // refreshes consecutivos del dashboard.
  /**
   * @typedef {Object} RetryingState
   * @property {number} retryingUntil  epoch ms hasta mostrar como reintentando (anti-parpadeo 2s)
   * @property {string} reason         causa del retry: "connectivity_restored" | otros futuros
   * @property {number} since          epoch ms de inicio del estado
   * @property {string} [previousState] estado previo para trazabilidad: "blocked:infra" | otros
   */
  const retryingMap = (() => {
    if (!retryingState || typeof retryingState.getActiveRetrying !== 'function') return {};
    try { return retryingState.getActiveRetrying({ now: Date.now() }); }
    catch { return {}; }
  })();
  state.retrying = retryingMap;

  for (const [id, data] of Object.entries(state.issueMatrix)) {
    data.pipelines = [...data.pipelines];
    data.title = titleCache[id]?.title || '';
    data.labels = titleCache[id]?.labels || [];
    // Calcular rebotes: contar runs rechazados por fase
    let bounces = 0;
    for (const entries of Object.values(data.fases)) {
      const rejected = entries.filter(e => e.resultado && e.resultado !== 'aprobado');
      bounces += rejected.length;
    }
    data.bounces = bounces;
    // Calcular stale: minutos desde última actividad en fase activa
    if (data.estadoActual === 'trabajando') {
      const currentEntries = data.fases[data.faseActual] || [];
      const workingEntry = currentEntries.find(e => e.estado === 'trabajando');
      data.staleMin = workingEntry?.ageMin || 0;
    } else {
      data.staleMin = 0;
    }
    // #2337 CA8 — enriquecer con ventana `retrying` si aplica
    if (retryingMap[id]) {
      data.retrying = retryingMap[id];
    }
  }

  // ETA: calcular promedios históricos por skill+fase desde archivos procesados
  // Usa mtime (escritura resultado) - ctime (creación archivo) como proxy de duración
  state.etaAverages = {}; // key: "fase/skill" → avgMs
  for (const { pipeline: pName, fase } of allFases) {
    const procesadoDir = path.join(PIPELINE, pName, fase, 'procesado');
    const listoDir = path.join(PIPELINE, pName, fase, 'listo');
    for (const dir of [procesadoDir, listoDir]) {
      for (const f of listWorkFiles(dir)) {
        const skill = f.split('.').slice(1).join('.');
        const st = fileStat(path.join(dir, f));
        if (!st) continue;
        // duración = ctime - birthtime (ctime = movido a procesado, birthtime = creación original)
        const dur = st.ctimeMs - st.birthtimeMs;
        if (dur <= 5000 || dur > 4 * 3600000) continue; // descartar <5s o >4h
        const key = `${fase}/${skill}`;
        if (!state.etaAverages[key]) state.etaAverages[key] = { total: 0, count: 0 };
        state.etaAverages[key].total += dur;
        state.etaAverages[key].count++;
      }
    }
  }
  // Calcular promedios y también por fase (sin skill)
  for (const [key, data] of Object.entries(state.etaAverages)) {
    data.avgMs = Math.round(data.total / data.count);
    const fase = key.split('/')[0];
    if (!state.etaAverages[fase]) state.etaAverages[fase] = { total: 0, count: 0 };
    state.etaAverages[fase].total += data.total;
    state.etaAverages[fase].count += data.count;
  }
  for (const [key, data] of Object.entries(state.etaAverages)) {
    if (!key.includes('/')) data.avgMs = Math.round(data.total / data.count);
  }

  // V3 — Bloqueados esperando humano (issue #2478)
  state.bloqueados = [];
  try {
    const humanBlock = require('./lib/human-block');
    state.bloqueados = humanBlock.listBlockedIssues().map(b => ({
      issue: b.issue,
      skill: b.skill,
      phase: b.phase,
      pipeline: b.pipeline,
      reason: b.reason,
      question: b.question,
      blocked_at: b.blocked_at,
      age_hours: b.age_hours,
      title: titleCache[String(b.issue)]?.title || '',
    }));
  } catch {}

  // Servicios
  state.servicios = {};
  try {
    for (const svc of fs.readdirSync(path.join(PIPELINE, 'servicios'))) {
      const svcDir = path.join(PIPELINE, 'servicios', svc);
      if (!fs.statSync(svcDir).isDirectory()) continue;
      state.servicios[svc] = {
        pendiente: listWorkFiles(path.join(svcDir, 'pendiente')).length,
        trabajando: listWorkFiles(path.join(svcDir, 'trabajando')).length,
        listo: listWorkFiles(path.join(svcDir, 'listo')).length
      };
    }
  } catch {}

  // Skill heatmap: carga actual vs concurrencia máxima
  state.skillLoad = {};
  const concurrencia = config.concurrencia || {};
  for (const [skill, max] of Object.entries(concurrencia)) {
    let running = 0;
    for (const { pipeline: pName, fase } of allFases) {
      running += listWorkFiles(path.join(PIPELINE, pName, fase, 'trabajando')).filter(f => f.endsWith(`.${skill}`)).length;
    }
    state.skillLoad[skill] = { running, max };
  }

  // Actividad reciente
  state.actividad = [];
  try {
    const lines = fs.readFileSync(path.join(PIPELINE, 'commander-history.jsonl'), 'utf8').trim().split('\n').slice(-20);
    for (const line of lines) {
      try { const e = JSON.parse(line); state.actividad.push({ dir: e.direction, from: e.from || '', text: (e.text || '').slice(0, 150), ts: e.timestamp }); } catch {}
    }
  } catch {}

  // Procesos — descubiertos al vuelo desde el SO, no desde archivos .pid.
  state.procesos = {};
  invalidateCache();
  for (const comp of ['pulpo', 'listener', 'svc-telegram', 'svc-github', 'svc-drive', 'outbox-drain', 'dashboard']) {
    const found = findPidByComponent(comp);
    if (found && pidAlive(found.pid)) {
      const uptime = getProcessUptime(comp);
      state.procesos[comp] = { pid: String(found.pid), alive: true, uptime };
    } else {
      state.procesos[comp] = { pid: null, alive: false };
    }
  }

  // QA Environment
  state.qaEnv = { emulator: false };
  state.qaRemote = { active: false, url: '', ref: '', startedAt: '' };
  try {
    const qaState = JSON.parse(fs.readFileSync(path.join(PIPELINE, 'qa-env-state.json'), 'utf8'));
    for (const [svc, pid] of Object.entries(qaState)) {
      if (pid) {
        try {
          const r = execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, { encoding: 'utf8', timeout: 3000, windowsHide: true });
          state.qaEnv[svc] = r.includes(`"${pid}"`);
        } catch {}
      }
    }
  } catch {}
  // QA Remote state
  try {
    const remoteStateFile = path.join(ROOT, 'qa', '.qa-remote-state');
    if (fs.existsSync(remoteStateFile)) {
      const lines = fs.readFileSync(remoteStateFile, 'utf8').split('\n');
      for (const line of lines) {
        const [k, ...vParts] = line.split('=');
        const v = vParts.join('=').trim();
        if (k === 'QA_MODE' && v === 'remote') state.qaRemote.active = true;
        if (k === 'QA_REMOTE_URL') state.qaRemote.url = v;
        if (k === 'DEPLOY_REF') state.qaRemote.ref = v;
        if (k === 'STARTED_AT') state.qaRemote.startedAt = v;
      }
    }
  } catch {}

  // Priority Windows (estado persistido por el Pulpo)
  state.priorityWindows = { qa: { active: false }, build: { active: false } };
  try {
    const pwData = JSON.parse(fs.readFileSync(path.join(PIPELINE, 'priority-windows.json'), 'utf8'));
    if (pwData.qa) state.priorityWindows.qa = pwData.qa;
    if (pwData.build) state.priorityWindows.build = pwData.build;
  } catch {}

  // Rechazos recientes
  state.rechazos = [];
  for (const { pipeline: pName, fase } of allFases) {
    const procesadoDir = path.join(PIPELINE, pName, fase, 'procesado');
    for (const f of listWorkFiles(procesadoDir)) {
      const data = readYamlSafe(path.join(procesadoDir, f));
      if (data.resultado === 'rechazado') {
        const stat = fileStat(path.join(procesadoDir, f));
        state.rechazos.push({
          issue: f.split('.')[0], skill: f.split('.').slice(1).join('.'),
          fase, pipeline: pName, motivo: data.motivo || '',
          ts: stat?.mtimeMs || 0
        });
      }
    }
  }
  state.rechazos.sort((a, b) => b.ts - a.ts);
  state.rechazos = state.rechazos.slice(0, 10);

  // Bloqueos entre issues
  state.blockedIssues = { blockedBy: {}, blocks: {} };
  try {
    const blockedData = JSON.parse(fs.readFileSync(path.join(PIPELINE, 'blocked-issues.json'), 'utf8'));
    if (blockedData.blockedBy) state.blockedIssues.blockedBy = blockedData.blockedBy;
    if (blockedData.blocks) state.blockedIssues.blocks = blockedData.blocks;
  } catch {}

  // Salud de Infra — publicado por #2304 (healthcheck+retry) y #2305 (circuit breaker).
  // CA-11: feature flag implícito — si el archivo no existe, la sección no se renderiza.
  // CA-8 / Security: lectura defensiva con try/catch + límite de tamaño (10KB) para evitar DoS.
  state.infraHealth = null;
  try {
    const infraPath = path.join(PIPELINE, 'infra-health.json');
    if (fs.existsSync(infraPath)) {
      const stat = fs.statSync(infraPath);
      if (stat.size > 10240) {
        state.infraHealth = { error: 'file-too-large', mtimeMs: stat.mtimeMs };
      } else if (stat.size === 0) {
        state.infraHealth = { error: 'empty', mtimeMs: stat.mtimeMs };
      } else {
        const raw = fs.readFileSync(infraPath, 'utf8');
        const parsed = JSON.parse(raw);
        state.infraHealth = { data: parsed, mtimeMs: stat.mtimeMs };
      }
    }
  } catch (e) {
    state.infraHealth = { error: 'invalid-json', mtimeMs: Date.now() };
  }

  // Recursos del sistema
  const resourceLimits = config.resource_limits || {};
  const sys = getSystemResourceUsage();
  pushResourceSample(sys.cpuPercent, sys.memPercent);
  state.resources = {
    ...sys,
    maxCpu: resourceLimits.max_cpu_percent || 70,
    maxMem: resourceLimits.max_mem_percent || 70,
    cpuHistory: resourceHistory.cpu.slice(),
    memHistory: resourceHistory.mem.slice()
  };

  return state;
}

// --- HTML generation helpers ---

// SVG sparkline compacto para series numéricas (0-100)
function sparklineSVG(data, color, opts = {}) {
  const w = opts.w || 110, h = opts.h || 28, max = opts.max || 100;
  if (!data || data.length < 2) {
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><line x1="0" y1="${h/2}" x2="${w}" y2="${h/2}" stroke="${color}" stroke-opacity="0.2" stroke-dasharray="2 2"/></svg>`;
  }
  const n = data.length;
  const stepX = w / (n - 1);
  const pts = data.map((v, i) => {
    const y = h - (Math.min(v, max) / max) * (h - 2) - 1;
    return `${(i * stepX).toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const lastY = h - (Math.min(data[n-1], max) / max) * (h - 2) - 1;
  const areaPts = `0,${h} ${pts} ${w},${h}`;
  const gradId = 'grd-' + Math.random().toString(36).slice(2, 8);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="${areaPts}" fill="url(#${gradId})"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${(w).toFixed(1)}" cy="${lastY.toFixed(1)}" r="2" fill="${color}"/>
  </svg>`;
}

// Gauge radial tipo tacómetro (semicírculo 180°) — versión compacta
function radialGauge(value, max, thresh, color, label, detail) {
  const pct = Math.min(100, Math.max(0, (value / 100) * 100));
  const threshPct = Math.min(100, (thresh / 100) * 100);
  const r = 30, cx = 34, cy = 34;
  const ang = (p) => Math.PI + (p / 100) * Math.PI;
  const polar = (p) => ({ x: cx + r * Math.cos(ang(p)), y: cy + r * Math.sin(ang(p)) });
  const arcPath = (from, to) => {
    const a = polar(from), b = polar(to);
    const large = to - from > 50 ? 1 : 0;
    return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  };
  const needle = polar(pct);
  const isDanger = value >= thresh;
  const isWarn = value >= thresh * 0.8;
  const valColor = isDanger ? '#f85149' : isWarn ? '#d29922' : '#3fb950';
  return `<svg class="rgauge" width="68" height="44" viewBox="0 0 68 44">
    <path d="${arcPath(0, 100)}" fill="none" stroke="#30363d" stroke-width="5" stroke-linecap="round"/>
    <path d="${arcPath(0, Math.min(65, pct))}" fill="none" stroke="#3fb950" stroke-width="5" stroke-linecap="round" opacity="${pct>0?1:0.3}"/>
    ${pct > 65 ? `<path d="${arcPath(65, Math.min(85, pct))}" fill="none" stroke="#d29922" stroke-width="5" stroke-linecap="round"/>` : ''}
    ${pct > 85 ? `<path d="${arcPath(85, pct)}" fill="none" stroke="#f85149" stroke-width="5" stroke-linecap="round"/>` : ''}
    <line x1="${polar(threshPct).x.toFixed(1)}" y1="${polar(threshPct).y.toFixed(1)}" x2="${(cx + (r+4)*Math.cos(ang(threshPct))).toFixed(1)}" y2="${(cy + (r+4)*Math.sin(ang(threshPct))).toFixed(1)}" stroke="#f85149" stroke-width="1.5" opacity="0.7"/>
    <line x1="${cx}" y1="${cy}" x2="${needle.x.toFixed(1)}" y2="${needle.y.toFixed(1)}" stroke="${valColor}" stroke-width="2" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="2.5" fill="${valColor}"/>
    <text x="${cx}" y="${cy + 10}" text-anchor="middle" font-size="9" font-weight="800" fill="${valColor}" font-family="monospace">${value}%</text>
  </svg>`;
}

function fmtUptime(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

// Categorías semánticas de skills (para agrupación en Equipo Disponible)
const SKILL_CATEGORY = {
  po: 'product', ux: 'product', planner: 'product', scrum: 'product',
  'backend-dev': 'dev', 'android-dev': 'dev', 'web-dev': 'dev',
  tester: 'quality', qa: 'quality', review: 'quality', security: 'quality',
  guru: 'ops', perf: 'ops', build: 'ops', delivery: 'ops',
};
// Etiquetas cortas por fase (2 chars) para mostrar debajo de cada dot
const FASE_LABEL_SHORT = {
  analisis: 'An', criterios: 'Cr', sizing: 'Si',
  validacion: 'Va', dev: 'Dv', build: 'Bd',
  verificacion: 'Vf', linteo: 'Li', aprobacion: 'Ap', entrega: 'En',
};

const CATEGORY_META = {
  product:  { label: 'Producto', icon: '🎯', color: '#d29922' },
  dev:      { label: 'Desarrollo', icon: '🛠', color: '#3fb950' },
  quality:  { label: 'Calidad', icon: '🛡', color: '#d2a8ff' },
  ops:      { label: 'Operaciones', icon: '⚙', color: '#58a6ff' },
};

// Capas semánticas de servicios
const SERVICE_LAYER = {
  Telegram: 'intake', GitHub: 'intake',
  Drive: 'output', Emulador: 'output',
  pulpo: 'processing', 'outbox-drain': 'processing', dashboard: 'processing',
};
const LAYER_META = {
  intake:     { label: 'Ingesta', icon: '📥' },
  processing: { label: 'Procesamiento', icon: '⚙' },
  output:    { label: 'Salida', icon: '📤' },
};

// --- Salud de Infra (sección del /monitor, issue #2306) ---

// Escape HTML para datos leídos de .pipeline/infra-health.json antes de inyectar
// como innerHTML. Defensa en profundidad contra XSS (CA-8 · Security).
function escInfra(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Formatea un timestamp ISO-8601 como tiempo relativo ("hace 2m", "hace 35s")
// junto con el timestamp absoluto para tooltip (CA-4 · UX tooltips).
function formatInfraTs(iso) {
  if (!iso) return { rel: '—', abs: '', deltaMs: Infinity };
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return { rel: '—', abs: '', deltaMs: Infinity };
  const delta = Date.now() - t;
  let rel;
  if (delta < 0) rel = 'ahora';
  else if (delta < 60000) rel = 'hace ' + Math.floor(delta / 1000) + 's';
  else if (delta < 3600000) rel = 'hace ' + Math.floor(delta / 60000) + 'm';
  else if (delta < 86400000) rel = 'hace ' + Math.floor(delta / 3600000) + 'h';
  else rel = 'hace ' + Math.floor(delta / 86400000) + 'd';
  return { rel, abs: new Date(iso).toISOString(), deltaMs: delta };
}

// Determina el semáforo global a partir de los 3 criterios del PO (CA-3).
function computeInfraHealthLevel(h) {
  // Stale: sin lastCheck o último healthcheck hace > 5 min (300000 ms)
  const lastCheck = h && h.dns && h.dns.lastCheck;
  const dnsAge = lastCheck ? (Date.now() - new Date(lastCheck).getTime()) : Infinity;
  if (!isFinite(dnsAge) || dnsAge > 300000) return { level: 'stale', label: 'STALE' };

  // Alert (rojo): circuit breaker abierto, DNS FAIL o retries > 20%
  if (h.circuitBreaker && h.circuitBreaker.state === 'open') return { level: 'alert', label: 'CRITICO' };
  if (h.dns && h.dns.status === 'FAIL') return { level: 'alert', label: 'CRITICO' };
  const rate = h.retries && typeof h.retries.ratePercent === 'number' ? h.retries.ratePercent : 0;
  if (rate > 20) return { level: 'alert', label: 'CRITICO' };

  // Warn (amarillo): retries entre 5% y 20% o latencia DNS > 3s
  if (rate >= 5) return { level: 'warn', label: 'DEGRADADO' };
  const lat = h.dns && typeof h.dns.latencyMs === 'number' ? h.dns.latencyMs : 0;
  if (lat > 3000) return { level: 'warn', label: 'DEGRADADO' };

  return { level: 'ok', label: 'SALUDABLE' };
}

// Renderiza la sección "Salud de Infra" como HTML. Devuelve '' si no hay
// datos (feature flag OFF → CA-11).
function renderInfraHealth(state) {
  const ih = state.infraHealth;
  if (!ih) return ''; // archivo no existe → no renderizar

  // Error de lectura/parse o estructura inválida → estado stale, nunca romper el dashboard
  if (ih.error || !ih.data || typeof ih.data !== 'object') {
    const errMsg = ih.error === 'file-too-large' ? 'archivo excede 10KB'
      : ih.error === 'empty' ? 'archivo vacío'
      : ih.error === 'invalid-json' ? 'JSON inválido'
      : 'estructura inválida';
    return `<section class="infra-health infra-stale ih-collapsed" role="region" aria-label="Salud de Infra" aria-live="polite">
    <div class="ih-head" onclick="toggleInfraHealth()" title="Click para colapsar/expandir">
      <span class="ih-emoji" aria-hidden="true">⚪</span>
      <span class="ih-title">Salud de Infra</span>
      <span class="ih-status ih-status-stale">STALE · ${escInfra(errMsg)}</span>
      <span class="ih-chevron">▼</span>
    </div>
  </section>`;
  }

  const h = ih.data;

  // ── CA-8: validaciones defensivas + whitelists estrictas ──
  const dnsStatusRaw = h.dns && typeof h.dns.status === 'string' ? h.dns.status : null;
  const dnsStatus = (dnsStatusRaw === 'OK' || dnsStatusRaw === 'FAIL') ? dnsStatusRaw : null;

  const cbStateRaw = h.circuitBreaker && typeof h.circuitBreaker.state === 'string' ? h.circuitBreaker.state : null;
  const cbState = (cbStateRaw === 'closed' || cbStateRaw === 'open') ? cbStateRaw : null;

  const lastIssueObj = h.circuitBreaker && typeof h.circuitBreaker.lastIssue === 'object' ? h.circuitBreaker.lastIssue : null;
  const lastIssueNumRaw = lastIssueObj ? lastIssueObj.number : null;
  const lastIssueNum = Number.isInteger(lastIssueNumRaw) && lastIssueNumRaw > 0 && lastIssueNumRaw < 1000000
    ? lastIssueNumRaw : null;

  const lastIssueReasonFull = lastIssueObj && typeof lastIssueObj.reason === 'string' ? lastIssueObj.reason : '';
  // CA-6: truncar a 50 chars — sin stack trace, sin paths, sin IPs
  const lastIssueReason = lastIssueReasonFull.length > 50
    ? lastIssueReasonFull.slice(0, 50)
    : lastIssueReasonFull;
  const wasTruncated = lastIssueReasonFull.length > 50;

  const consecutiveFailures = h.circuitBreaker && Number.isInteger(h.circuitBreaker.consecutiveFailures)
    ? h.circuitBreaker.consecutiveFailures : null;
  const openedAtRaw = h.circuitBreaker && typeof h.circuitBreaker.openedAt === 'string' ? h.circuitBreaker.openedAt : null;

  const retriesLastHour = h.retries && Number.isInteger(h.retries.lastHour) ? h.retries.lastHour : 0;
  const retriesPreviousHour = h.retries && Number.isInteger(h.retries.previousHour) ? h.retries.previousHour : 0;
  const retriesRate = h.retries && typeof h.retries.ratePercent === 'number' && isFinite(h.retries.ratePercent)
    ? h.retries.ratePercent : 0;

  const dnsLatency = h.dns && typeof h.dns.latencyMs === 'number' && isFinite(h.dns.latencyMs)
    ? h.dns.latencyMs : null;

  // Caso especial: archivo creado pero sin datos todavía (UX punto 5 — Inicializando)
  const isInitializing = !dnsStatus && !cbState && !h.retries;
  if (isInitializing) {
    return `<section class="infra-health infra-init ih-collapsed" role="region" aria-label="Salud de Infra" aria-live="polite">
    <div class="ih-head" onclick="toggleInfraHealth()" title="Click para colapsar/expandir">
      <span class="ih-emoji" aria-hidden="true">🔄</span>
      <span class="ih-title">Salud de Infra</span>
      <span class="ih-status ih-status-init">Inicializando healthchecks…</span>
      <span class="ih-chevron">▼</span>
    </div>
  </section>`;
  }

  // ── Timestamps ──
  const dnsTs = formatInfraTs(h.dns && h.dns.lastCheck);

  // ── Semáforo global ──
  const effective = {
    dns: { status: dnsStatus, lastCheck: h.dns && h.dns.lastCheck, latencyMs: dnsLatency },
    retries: { ratePercent: retriesRate },
    circuitBreaker: { state: cbState }
  };
  const sem = computeInfraHealthLevel(effective);
  const emoji = sem.level === 'ok' ? '🟢' : sem.level === 'warn' ? '🟡' : sem.level === 'alert' ? '🔴' : '⚪';
  const sectionCls = 'infra-' + sem.level;

  // Fila 1 (prioridad alta · CA-2): Circuit breaker
  let cbEmoji = '⚪';
  let cbText = 'sin datos';
  let cbExtra = '';
  if (cbState === 'closed') {
    cbEmoji = '🟢';
    cbText = 'cerrado · lanzamientos habilitados';
  } else if (cbState === 'open') {
    cbEmoji = '🔴';
    // UX punto 9: estructura narrativa del mensaje rojo (qué · por qué · evidencia · cómo salir)
    const nFailures = consecutiveFailures && consecutiveFailures > 0 ? consecutiveFailures : '?';
    const ultParte = lastIssueNum
      ? '<span class="ih-cb-ult">Último: <a href="' + GITHUB_BASE + '/' + lastIssueNum + '" target="_blank" rel="noopener noreferrer">#' + lastIssueNum + '</a>'
        + (lastIssueReason ? ' · ' + escInfra(lastIssueReason) : '')
        + (wasTruncated ? '…' : '')
        + (dnsTs.rel !== '—' ? ' · ' + escInfra(dnsTs.rel) : '')
        + '</span>'
      : '';
    cbText = 'PIPELINE PAUSADO';
    cbExtra = '<div class="ih-cb-body">'
      + '<div class="ih-cb-line">' + escInfra(nFailures) + ' issues consecutivos fallaron por red</div>'
      + (ultParte ? '<div class="ih-cb-line">' + ultParte + '</div>' : '')
      + '<div class="ih-cb-cta">Reanudar: <code>node .pipeline/restart.js</code>'
      + ' <button type="button" class="ih-copy" data-copy="node .pipeline/restart.js" title="Copiar comando" aria-label="Copiar comando de reanudación">📋</button>'
      + '</div>'
      + '</div>';
  }
  const cbTooltipTxt = openedAtRaw ? 'Abierto desde ' + openedAtRaw : '';
  const cbTitle = cbTooltipTxt ? ' title="' + escInfra(cbTooltipTxt) + '"' : '';

  // Fila 2: DNS
  let dnsEmoji = '⚪';
  let dnsText = 'sin datos';
  if (dnsStatus === 'OK') { dnsEmoji = '🟢'; dnsText = 'OK'; }
  else if (dnsStatus === 'FAIL') { dnsEmoji = '🔴'; dnsText = 'FAIL'; }
  // UX punto 4: mostrar latencia solo si > 500ms para evitar ruido en estado sano
  let dnsExtra = '';
  if (dnsLatency != null && dnsLatency > 500) {
    dnsExtra = ' · ' + dnsLatency + 'ms' + (dnsLatency > 3000 ? ' ⚠' : '');
  }
  const dnsTitle = dnsTs.abs ? ' title="' + escInfra(dnsTs.abs) + '"' : '';

  // Fila 3: Retries
  const retriesDelta = retriesLastHour - retriesPreviousHour;
  const arrow = retriesDelta > 0 ? '↑' : retriesDelta < 0 ? '↓' : '→';
  const deltaTxt = retriesDelta === 0 ? '=' : (retriesDelta > 0 ? '+' : '') + retriesDelta;
  const retriesEmoji = retriesRate > 20 ? '🔴' : retriesRate >= 5 ? '🟡' : '🟢';
  const retriesRateTxt = retriesRate > 0 ? ' (' + retriesRate.toFixed(1) + '%)' : '';
  const retriesTitle = ' title="Hora actual: ' + retriesLastHour + ' retries · Hora anterior: ' + retriesPreviousHour + '"';

  // Fila 4: Último issue afectado
  let lastEmoji = '⚪';
  let lastText = 'sin rebotes registrados';
  let lastTitle = '';
  if (lastIssueNum) {
    lastEmoji = '🔴';
    const reasonDisplay = lastIssueReason || 'motivo desconocido';
    lastText = '<a href="' + GITHUB_BASE + '/' + lastIssueNum + '" target="_blank" rel="noopener noreferrer">#' + lastIssueNum + '</a>'
      + ' · ' + escInfra(reasonDisplay)
      + (wasTruncated ? '<span class="ih-trunc" aria-hidden="true">…</span>' : '');
    if (wasTruncated) lastTitle = ' title="' + escInfra(lastIssueReasonFull) + '"';
  }

  return `<section class="infra-health ${sectionCls} ih-collapsed" role="region" aria-label="Salud de Infra" aria-live="polite">
  <div class="ih-head" onclick="toggleInfraHealth()" title="Click para colapsar/expandir">
    <span class="ih-emoji" aria-hidden="true">${emoji}</span>
    <span class="ih-title">Salud de Infra</span>
    <span class="ih-status ih-status-${sem.level}">${sem.label}</span>
    ${dnsTs.rel !== '—' ? '<span class="ih-ts" title="' + escInfra(dnsTs.abs) + '">última señal ' + escInfra(dnsTs.rel) + '</span>' : ''}
    <span class="ih-chevron">▼</span>
  </div>
  <div class="ih-body">
  <div class="ih-rows">
    <div class="ih-row ih-row-cb"${cbTitle}>
      <span class="ih-row-emoji" aria-hidden="true">${cbEmoji}</span>
      <span class="ih-row-lbl">Circuit breaker</span>
      <span class="ih-row-val">${cbText}</span>
    </div>
    ${cbExtra}
    <div class="ih-row ih-row-dns"${dnsTitle}>
      <span class="ih-row-emoji" aria-hidden="true">${dnsEmoji}</span>
      <span class="ih-row-lbl">DNS</span>
      <span class="ih-row-val">${dnsText}${dnsExtra} · ${escInfra(dnsTs.rel)}</span>
    </div>
    <div class="ih-row ih-row-retries"${retriesTitle}>
      <span class="ih-row-emoji" aria-hidden="true">${retriesEmoji}</span>
      <span class="ih-row-lbl">Retries (última hora)</span>
      <span class="ih-row-val">${retriesLastHour} retries · ${arrow} ${deltaTxt} vs hora anterior${retriesRateTxt}</span>
    </div>
    <div class="ih-row ih-row-last"${lastTitle}>
      <span class="ih-row-emoji" aria-hidden="true">${lastEmoji}</span>
      <span class="ih-row-lbl">Último issue afectado</span>
      <span class="ih-row-val">${lastText}</span>
    </div>
  </div>
  </div>
</section>`;
}

// --- Recomendaciones de agentes (issue #2653) ---
function renderRecommendationsSection() {
  if (!recommendationsLib) return '';
  const cache = recommendationsLib.readCache();
  const items = (cache.items || []).slice().sort((a, b) => {
    if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    return b.number - a.number;
  });
  const updatedAtTxt = cache.updatedAt
    ? new Date(cache.updatedAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })
    : 'nunca';
  const errorTxt = cache.error ? `<div class="reco-err">⚠ ${escapeHtml(cache.error)}</div>` : '';
  const summary = `<summary>💡 Recomendaciones pendientes <span class="reco-count" data-count="${items.length}">${items.length}</span> <span class="reco-meta">· última sync: ${updatedAtTxt}</span></summary>`;
  if (items.length === 0) {
    return `<details class="collapse-section reco-section">${summary}<div class="collapse-body">${errorTxt}<p class="dim" style="margin:6px 0">Sin recomendaciones pendientes. Los agentes guru/security/po/ux/review crean issues con label <code>tipo:recomendacion</code> + <code>needs-human</code> que aparecen acá hasta que las apruebes o rechaces.</p><div style="margin-top:8px"><button class="reco-btn" onclick="recoRefresh()">🔄 Refrescar desde GitHub</button></div></div></details>`;
  }
  const rows = items.map(it => {
    const fromTxt = it.fromIssue ? `desde #${it.fromIssue}` : '';
    const agentBadge = `<span class="reco-agent reco-agent-${escapeHtml(it.sourceAgent)}">${escapeHtml(it.sourceAgent)}</span>`;
    const created = it.createdAt
      ? new Date(it.createdAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '';
    return `<tr data-issue="${it.number}">
      <td class="reco-num"><a href="${escapeHtml(it.url)}" target="_blank" rel="noopener">#${it.number}</a></td>
      <td>${agentBadge}</td>
      <td class="reco-title" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</td>
      <td class="reco-from">${fromTxt}</td>
      <td class="reco-created dim">${created}</td>
      <td class="reco-actions">
        <button class="reco-btn reco-btn-approve" onclick="recoApprove(${it.number})">✓ Aprobar</button>
        <button class="reco-btn reco-btn-reject" onclick="recoReject(${it.number})">✗ Rechazar</button>
      </td>
    </tr>`;
  }).join('');
  return `<details class="collapse-section reco-section" open>${summary}<div class="collapse-body">${errorTxt}<div style="margin:6px 0 10px"><button class="reco-btn" onclick="recoRefresh()">🔄 Refrescar</button></div><table class="reco-table"><thead><tr><th>Issue</th><th>Agente</th><th>Título</th><th>Origen</th><th>Creado</th><th>Acciones</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- HTML generation ---

function generateHTML(state) {
  const config = state.config;
  const allFases = state.allFases;
  const GH = (num) => `${GITHUB_BASE}/${num}`;

  // Build timestamps para el encabezado
  const fmtDate = (filepath) => {
    try {
      const st = fs.statSync(filepath);
      return st.mtime.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return '—'; }
  };
  const dashboardBuild = fmtDate(path.join(PIPELINE, 'dashboard-v2.js'));
  const pulpoBuild = fmtDate(path.join(PIPELINE, 'pulpo.js'));
  let pulpoUptime = '—';
  try { const lr = JSON.parse(fs.readFileSync(path.join(PIPELINE, 'last-restart.json'), 'utf8')); if (lr.timestamp) { const ms = Date.now() - new Date(lr.timestamp).getTime(); const h = Math.floor(ms / 3600000); const m = Math.floor((ms % 3600000) / 60000); pulpoUptime = h > 0 ? h + 'h ' + m + 'm' : m + 'm'; } } catch {}
  const isPaused = fs.existsSync(path.join(PIPELINE, '.paused'));

  // #2490 — Pausa parcial (allowlist de issues)
  let partialPauseState = { mode: 'running', allowedIssues: [] };
  try {
    const pp = require('./lib/partial-pause');
    partialPauseState = pp.getPipelineMode();
  } catch {}
  const isPartialPause = partialPauseState.mode === 'partial_pause';

  // V3 detection: workers determinísticos en .pipeline/workers/*.js
  let v3Workers = [];
  try {
    const workersDir = path.join(PIPELINE, 'workers');
    if (fs.existsSync(workersDir)) {
      v3Workers = fs.readdirSync(workersDir)
        .filter(f => f.endsWith('.js'))
        .map(f => f.replace(/\.js$/, ''));
    }
  } catch {}
  const v3Active = v3Workers.length > 0;

  // Agentes con personalidad — referentes del mercado
  const AGENT_PERSONA = {
    guru:          { icon: '🧠', name: 'Guru',        tagline: 'Rich Hickey · Kevlin Henney · Kleppmann', color: '#bc8cff' },
    security:      { icon: '🔒', name: 'Security',    tagline: 'Troy Hunt · Bruce Schneier · OWASP',      color: '#f85149' },
    po:            { icon: '📋', name: 'PO',           tagline: 'Marty Cagan · Teresa Torres · Jeff Patton', color: '#d29922' },
    ux:            { icon: '🎨', name: 'UX',           tagline: 'Don Norman · Jakob Nielsen · Wroblewski',  color: '#f778ba' },
    planner:       { icon: '📐', name: 'Planner',     tagline: 'Ryan Singer · Allen Ward · Reinertsen',    color: '#a371f7' },
    'backend-dev': { icon: '⚡', name: 'BackendDev',  tagline: 'Martin Fowler · Uncle Bob · Sam Newman',   color: '#3fb950' },
    'android-dev': { icon: '📱', name: 'AndroidDev',  tagline: 'Jake Wharton · Romain Guy · Chet Haase',   color: '#58a6ff' },
    'web-dev':     { icon: '🌐', name: 'WebDev',      tagline: 'Addy Osmani · Alex Russell · Archibald',   color: '#79c0ff' },
    tester:        { icon: '🧪', name: 'Tester',      tagline: 'Kent Beck · Meszaros · Martin Fowler',     color: '#d2a8ff' },
    qa:            { icon: '✅', name: 'QA',           tagline: 'James Bach · Lisa Crispin · Bolton',       color: '#3fb950' },
    review:        { icon: '👁️', name: 'Review',      tagline: 'Michaela Greiler · Google Eng Practices',  color: '#ffa657' },
    delivery:      { icon: '🚀', name: 'Delivery',    tagline: 'Jez Humble · Dave Farley �� Forsgren',      color: '#f0883e' },
    scrum:         { icon: '📊', name: 'Scrum',       tagline: 'Sutherland · Vacanti · Mike Cohn',         color: '#79c0ff' },
    perf:          { icon: '⚡', name: 'Perf',         tagline: 'Brendan Gregg · Colt McAnlis · Wharton',   color: '#d29922' },
    build:         { icon: '🏗️', name: 'Builder',     tagline: 'Build pipeline',                           color: '#8b949e' },
    commander:     { icon: '🤖', name: 'Commander',   tagline: 'Pipeline orchestrator',                    color: '#8b949e' },
  };
  const skillIcon = (skill) => (AGENT_PERSONA[skill] || {}).icon || '⚙';
  const skillColor = (skill) => (AGENT_PERSONA[skill] || {}).color || 'var(--dim)';

  // KPIs
  const matrixEntries = Object.entries(state.issueMatrix);

  // Orden manual del Issue Tracker: única fuente de prioridad. Issues nuevos
  // (que aún no tienen entrada) se insertan al tope para que el usuario los vea.
  let manualOrderState = { version: 1, order: [] };
  try {
    const issueOrder = require('./lib/issue-order');
    manualOrderState = issueOrder.load();
    const activeIssueNums = matrixEntries
      .filter(([_, d]) => d.estadoActual)
      .map(([n]) => String(n));
    issueOrder.syncWith(manualOrderState, activeIssueNums);
  } catch (e) {}
  const manualOrderIndex = new Map(manualOrderState.order.map((n, i) => [String(n), i]));

  const activosList = matrixEntries.filter(([_, d]) => d.estadoActual);
  const activos = activosList.length;
  const totalIssues = matrixEntries.length;
  const trabajandoList = matrixEntries.filter(([_, d]) => d.estadoActual === 'trabajando');
  const trabajando = trabajandoList.length;
  const pendientesList = matrixEntries.filter(([_, d]) => d.estadoActual === 'pendiente');
  const pendientes = pendientesList.length;
  const staleList = matrixEntries.filter(([_, d]) => {
    if (d.estadoActual !== 'trabajando' || !d.faseActual) return false;
    const entries = d.fases[d.faseActual] || [];
    return entries.some(e => e.ageMin > 30);
  });
  const stale = staleList.length;
  // Bloqueados = issues con blockedBy declarado y aún activos (no completados)
  const blockedList = matrixEntries.filter(([num, d]) => {
    return state.blockedIssues.blockedBy[num] != null && d.estadoActual;
  });
  const blockedCount = blockedList.length;
  // IDs de las deps que están bloqueando (issues nuevos de los cuales dependen los bloqueados)
  const blockingDepsSet = new Set();
  for (const [num] of blockedList) {
    const deps = state.blockedIssues.blockedBy[num] || [];
    for (const d of deps) blockingDepsSet.add(String(d));
  }
  const blockedIdsJson = JSON.stringify(blockedList.map(([n]) => String(n)));
  const blockingDepsJson = JSON.stringify(Array.from(blockingDepsSet));
  const staleDetail = staleList.map(([id, d]) => {
    const entries = d.fases[d.faseActual] || [];
    const staleEntry = entries.find(e => e.estado === 'trabajando' && e.ageMin > 30);
    const skill = staleEntry ? staleEntry.skill : d.faseActual;
    const mins = staleEntry ? staleEntry.ageMin : '?';
    return `#${id} (${skill}, ${mins} min)`;
  }).join(', ');

  // Helpers para tooltips (JSON embebido, el HTML lo arma el cliente)
  const buildTtData = (title, list, labelFn) => {
    const items = list.map(([id, d]) => ({ id, label: labelFn ? labelFn(id, d) : '' }));
    return JSON.stringify({ title, items }).replace(/'/g, '&#39;');
  };
  // Extraer skills activos de un issue en su fase actual
  const activeSkills = (d) => {
    if (!d.faseActual) return '';
    const entries = d.fases[d.faseActual] || [];
    const skills = entries.filter(e => e.estado === 'trabajando' || e.estado === 'pendiente').map(e => e.skill);
    return skills.length > 0 ? skills.join(', ') : '';
  };
  const ttLabel = (d) => {
    const parts = [];
    if (d.faseActual) parts.push(d.faseActual);
    const skills = activeSkills(d);
    if (skills) parts.push(skills);
    if (d.estadoActual) parts.push(d.estadoActual);
    return parts.join(' · ');
  };
  const ttActivos   = buildTtData('Issues activos',       activosList,   (_, d) => ttLabel(d));
  const ttTrabajando= buildTtData('En ejecución',          trabajandoList,(_, d) => ttLabel(d));
  const ttPendientes= buildTtData('En cola',               pendientesList,(_, d) => ttLabel(d));
  const ttStale     = buildTtData('Stale >30m',            staleList,     (_, d) => ttLabel(d));
  const ttBlocked   = buildTtData('Bloqueados por dependencias', blockedList, (num, d) => {
    const deps = state.blockedIssues.blockedBy[num] || [];
    const depTxt = deps.length > 0 ? 'dep: ' + deps.map(x => '#' + x).join(', ') : 'sin deps declaradas';
    return depTxt;
  });

  // Definidos = completaron la fase final de definición (sizing/procesado)
  const defFasesKpi = config.pipelines?.definicion?.fases || [];
  const lastDefFase = defFasesKpi[defFasesKpi.length - 1];
  const definidosList = lastDefFase ? matrixEntries.filter(([_, d]) => {
    const entries = d.fases[`definicion/${lastDefFase}`] || [];
    return entries.some(e => e.estado === 'procesado');
  }) : [];
  const definidos = definidosList.length;

  // Entregados = completaron la fase final de desarrollo (entrega/procesado)
  const devFasesKpi = config.pipelines?.desarrollo?.fases || [];
  const lastDevFase = devFasesKpi[devFasesKpi.length - 1];
  const entregadosList = lastDevFase ? matrixEntries.filter(([_, d]) => {
    const entries = d.fases[`desarrollo/${lastDevFase}`] || [];
    return entries.some(e => e.estado === 'procesado');
  }) : [];
  const entregados = entregadosList.length;

  const ttDefinidos  = buildTtData('Definidos listos',        definidosList, (_, d) => {
    const label = ttLabel(d);
    return label || 'definición completada';
  });
  const ttEntregados = buildTtData('Entregados a producción',  entregadosList, (_, d) => {
    // Para entregados, buscar el skill que hizo la entrega
    const entregaEntries = d.fases[`desarrollo/${lastDevFase}`] || [];
    const proc = entregaEntries.find(e => e.estado === 'procesado');
    const skill = proc?.skill || '';
    const label = ttLabel(d);
    return skill ? `${skill}` + (label ? ` · ${label}` : '') : (label || 'entregado');
  });
  const now24 = Date.now();
  const entregados24hList = lastDevFase ? matrixEntries.filter(([_, d]) => { const ee = d.fases['desarrollo/' + lastDevFase] || []; return ee.some(e => e.estado === 'procesado' && e.updatedAt && (now24 - e.updatedAt) < 86400000); }) : [];
  const entregados24h = entregados24hList.length;
  const ttEntregados24h = buildTtData('Entregados 24h', entregados24hList, (_, d) => { const ee = d.fases['desarrollo/' + lastDevFase] || []; const p = ee.find(e => e.estado === 'procesado'); return p ? p.skill || 'entregado' : 'entregado'; });

  // --- Issue Tracker Matrix (unified) ---
  // Headers: definición phases | separator | desarrollo phases
  const defFases = config.pipelines?.definicion?.fases || [];
  const devFases = config.pipelines?.desarrollo?.fases || [];

  // Contadores por fase: pendiente/trabajando/listo con lista de issues
  const faseCounts = {};
  for (const { pipeline: pName, fase } of allFases) {
    const key = `${pName}/${fase}`;
    faseCounts[key] = { pendiente: [], trabajando: [], listo: [] };
  }
  for (const [issueNum, data] of matrixEntries) {
    for (const [key, entries] of Object.entries(data.fases)) {
      if (!faseCounts[key]) continue;
      for (const e of entries) {
        if (e.estado === 'pendiente' || e.estado === 'trabajando' || e.estado === 'listo') {
          if (!faseCounts[key][e.estado].includes(issueNum)) {
            faseCounts[key][e.estado].push(issueNum);
          }
        }
      }
    }
  }

  // Sort: issues incompletos primero (trabajando > pendiente > listo entre ellos),
  // luego finalizados. Dentro del mismo grupo, más avanzados en pipeline primero.
  const faseIndex = (data) => {
    if (!data.faseActual) return -1;
    return allFases.findIndex(f => `${f.pipeline}/${f.fase}` === data.faseActual);
  };
  const isComplete = (data) => {
    const hasAnyActive = allFases.some(({ pipeline, fase }) => {
      const entries = data.fases[`${pipeline}/${fase}`] || [];
      return entries.some(e => e.estado === 'pendiente' || e.estado === 'trabajando');
    });
    if (hasAnyActive) return false;
    const lastDev = devFases[devFases.length - 1];
    const lastEntries = data.fases[`desarrollo/${lastDev}`] || [];
    return lastEntries.some(e => e.estado === 'listo' || e.estado === 'procesado');
  };
  // Risk score: issues más problemáticos arriba
  const riskScore = (data) => {
    let score = 0;
    if (data.staleMin > 60) score += 100;
    else if (data.staleMin > 30) score += 50;
    score += (data.bounces || 0) * 20;
    if (data.estadoActual === 'trabajando') score += 10;
    else if (data.estadoActual === 'pendiente') score += 5;
    return score;
  };
  // Score del pulpo (mirror de calcularPrioridad en pulpo.js:1811)
  // Menor score = más prioritario de lanzar. Usado para ordenar lane cards
  // de modo que el primero de cada columna sea el que se está ejecutando
  // (o el próximo a lanzarse según el pulpo).
  const pulpoPrioLabels = config.prioridad_labels || [];
  const pulpoFeaturePrio = config.feature_priority || {};
  const calcPulpoScore = (labels) => {
    const ls = labels || [];
    let prioScore = pulpoPrioLabels.indexOf('priority:medium');
    if (prioScore === -1) prioScore = 999;
    for (let i = 0; i < pulpoPrioLabels.length; i++) {
      if (ls.includes(pulpoPrioLabels[i])) { prioScore = i; break; }
    }
    let featureScore = 999;
    for (const [nivel, featureLabels] of Object.entries(pulpoFeaturePrio)) {
      const nivelIdx = pulpoPrioLabels.indexOf(`priority:${nivel}`);
      if (nivelIdx === -1) continue;
      for (const fl of featureLabels) {
        if (ls.includes(fl)) { featureScore = Math.min(featureScore, nivelIdx); break; }
      }
    }
    const effectivePrio = Math.min(prioScore, featureScore);
    const tiebreaker = featureScore < 999 ? 0 : 1;
    return effectivePrio * 10 + tiebreaker;
  };
  const sorted = matrixEntries.sort((a, b) => {
    const aComplete = isComplete(a[1]);
    const bComplete = isComplete(b[1]);
    if (aComplete !== bComplete) return aComplete ? 1 : -1;
    // Among active: sort by risk (highest first)
    const aRisk = riskScore(a[1]);
    const bRisk = riskScore(b[1]);
    if (aRisk !== bRisk) return bRisk - aRisk;
    // Same risk: more advanced in pipeline first
    const aF = faseIndex(a[1]);
    const bF = faseIndex(b[1]);
    if (aF !== bF) return bF - aF;
    return parseInt(b[0]) - parseInt(a[0]);
  });

  // Helper: genera chips de un phase entry (reutilizado en detalle expandido)
  const renderChip = (e, issueNum, fase, pipeline) => {
    const isRejected = e.resultado && e.resultado !== 'aprobado';
    const cls = isRejected ? 'st-rejected' :
                e.estado === 'trabajando' ? 'st-working' :
                e.estado === 'listo' ? 'st-done' :
                e.estado === 'procesado' ? 'st-processed' : 'st-pending';
    const icon = isRejected ? '✗' :
                 e.estado === 'trabajando' ? '⚙' :
                 e.estado === 'listo' ? '✓' :
                 e.estado === 'procesado' ? '✔' : '○';
    const staleClass = (e.estado === 'trabajando' && e.ageMin > 30) ? ' stale-chip' : '';
    const retryBadge = e._isRetry ? `<sup class="retry-badge" title="${e._runTotal} intentos">×${e._runTotal}</sup>` : '';

    let etaBadge = '';
    let ttEta = '';
    if (e.estado === 'trabajando' && e.durationMs) {
      const avgKey = `${fase}/${e.skill}`;
      const avg = state.etaAverages[avgKey] || state.etaAverages[fase];
      if (avg?.avgMs) {
        const remaining = Math.max(0, avg.avgMs - e.durationMs);
        if (remaining > 0) {
          etaBadge = `<span class="eta-badge">~${fmtDuration(remaining)}</span>`;
          ttEta = `ETA: ~${fmtDuration(remaining)} (promedio: ${fmtDuration(avg.avgMs)})`;
        } else {
          const over = e.durationMs - avg.avgMs;
          etaBadge = `<span class="eta-badge eta-over">+${fmtDuration(over)}</span>`;
          ttEta = `Excedido: +${fmtDuration(over)} sobre promedio de ${fmtDuration(avg.avgMs)}`;
        }
      }
    }

    const ttStart = e.startedAt ? `Inicio: ${fmtTime(e.startedAt)}` : '';
    const ttDur = e.durationMs ? `Duración: ${fmtDuration(e.durationMs)}` : '';
    const ttResStr = e.resultado ? `Resultado: ${e.resultado === 'aprobado' ? '✓' : '✗'} ${e.resultado}` : '';
    const ttMot = e.motivo ? `Motivo: ${e.motivo.slice(0, 80)}` : '';
    const ttRun = e._isRetry ? `Intentos: ${e._runTotal} (mostrando último)` : '';
    const ttEtaStr = ttEta || '';
    const ttLines = [e.skill, ttRun, ttStart, ttDur, ttEtaStr, ttResStr, ttMot].filter(Boolean);
    const titleAttr = ttLines.join('\n').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const logIcon = e.hasLog ? `<span class="chip-log-icon" title="Ver logs">📄</span>` : '';
    const chipContent = `${icon} ${skillIcon(e.skill)} ${e.skill}${retryBadge}${etaBadge}${logIcon}`;
    const killBtn = e.estado === 'trabajando'
      ? `<span class="kill-btn" title="Cancelar agente" onclick="event.preventDefault();event.stopPropagation();killAgent('${issueNum}','${e.skill}','${pipeline}','${fase}')">&times;</span>`
      : '';
    const pdfBtn = e.hasRejectionPdf
      ? `<a href="/logs/${e.rejectionPdf}" class="rejection-pdf-btn" title="Descargar reporte de rechazo (PDF)" target="_blank" onclick="event.stopPropagation()">📑</a>`
      : '';

    const inner = `<span class="chip ${cls}${staleClass}${e.hasLog ? ' chip-has-log' : ''}" title="${titleAttr}">${chipContent}${killBtn}${pdfBtn}</span>`;
    if (e.hasLog) {
      const isLive = e.estado === 'trabajando';
      return `<a href="/logs/view/${e.logFile}${isLive ? '?live=1' : ''}" class="log-link" target="_blank" onclick="event.stopPropagation()">${inner}</a>`;
    }
    return inner;
  };

  // Helper: preprocesa entries de una fase (colapsa runs repetidos)
  const preprocessEntries = (entries) => {
    const skillRunCount = {};
    for (const e of entries) {
      skillRunCount[e.skill] = (skillRunCount[e.skill] || 0) + 1;
    }
    const skillRunIndex = {};
    const sortedEntries = [...entries].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    for (const e of sortedEntries) {
      skillRunIndex[e.skill] = (skillRunIndex[e.skill] || 0) + 1;
      e._runIndex = skillRunIndex[e.skill];
      e._runTotal = skillRunCount[e.skill];
      e._isRetry = skillRunCount[e.skill] > 1;
      e._isLatestRun = skillRunIndex[e.skill] === skillRunCount[e.skill];
    }
    return entries.filter(e => e._isLatestRun);
  };

  // --- Card-based Issue Tracker ---
  const activeIssues = sorted.filter(([, d]) => !isComplete(d));
  const completedIssues = sorted.filter(([, d]) => isComplete(d));

  // ── Issue Tracker Lanes (Opción E): 3 lanes balanceadas con sub-breakdown ──
  // Definición (análisis+criterios+sizing) → Desarrollo+Build (val+dev+build) → QA+Entrega (verif+aprob+entrega)
  function macroLane(d) {
    if (isComplete(d)) return 'done';
    const fa = d.faseActual;
    if (!fa) return 'def';
    const [pipe, fase] = fa.split('/');
    if (pipe === 'definicion') return 'def';
    if (fase === 'validacion' || fase === 'dev' || fase === 'build') return 'dev';
    return 'qa'; // verificacion, linteo, aprobacion, entrega
  }
  const laneMeta = {
    def: { label: 'Definición',        color: '#bc8cff', sub: 'análisis · criterios · sizing', subFases: ['analisis', 'criterios', 'sizing'], subLabels: { analisis: 'Análisis', criterios: 'Criterios', sizing: 'Sizing' } },
    dev: { label: 'Desarrollo + Build', color: '#3fb950', sub: 'validación · dev · build',     subFases: ['validacion', 'dev', 'build'],       subLabels: { validacion: 'Validación', dev: 'Dev', build: 'Build' } },
    qa:  { label: 'QA + Entrega',      color: '#2dd4bf', sub: 'verif · linteo · aprob · entrega', subFases: ['verificacion', 'linteo', 'aprobacion', 'entrega'], subLabels: { verificacion: 'Verif', linteo: 'Linteo', aprobacion: 'Aprob', entrega: 'Entrega' } },
  };
  const laneCards = { def: [], dev: [], qa: [], done: [] };
  const laneCounts = { def: 0, dev: 0, qa: 0, done: 0 };
  const laneStats = {
    def: { running: 0, failed: 0, stale: 0, subCounts: {} },
    dev: { running: 0, failed: 0, stale: 0, subCounts: {} },
    qa:  { running: 0, failed: 0, stale: 0, subCounts: {} },
  };

  let issueCards = '';
  for (const [issueNum, data] of sorted) {
    const complete = isComplete(data);

    // Progress
    const totalFases = defFases.length + devFases.length;
    const completedFasesCount = allFases.filter(({ pipeline, fase }) => {
      const entries = data.fases[`${pipeline}/${fase}`] || [];
      const hasPendingOrWorking = entries.some(e => e.estado === 'pendiente' || e.estado === 'trabajando');
      return !hasPendingOrWorking && entries.some(e => e.estado === 'listo' || e.estado === 'procesado');
    }).length;
    const pct = totalFases > 0 ? Math.round(completedFasesCount / totalFases * 100) : 0;

    // ETA
    let issueEtaMs = 0;
    let hasEta = false;
    for (const pl of ['definicion', 'desarrollo']) {
      const fasesList = pl === 'definicion' ? defFases : devFases;
      for (const faseName of fasesList) {
        const key = `${pl}/${faseName}`;
        const entries = data.fases[key] || [];
        const hasPendingOrWorking = entries.some(e => e.estado === 'pendiente' || e.estado === 'trabajando');
        const isDone = !hasPendingOrWorking && entries.some(e => e.estado === 'listo' || e.estado === 'procesado');
        if (isDone) continue;
        const isWorking = entries.some(e => e.estado === 'trabajando');
        if (isWorking) {
          const workingEntry = entries.find(e => e.estado === 'trabajando');
          const avgKey = `${faseName}/${workingEntry.skill}`;
          const avg = state.etaAverages[avgKey] || state.etaAverages[faseName];
          if (avg?.avgMs && workingEntry.durationMs) {
            issueEtaMs += Math.max(0, avg.avgMs - workingEntry.durationMs);
            hasEta = true;
          }
        } else {
          const avg = state.etaAverages[faseName];
          if (avg?.avgMs) { issueEtaMs += avg.avgMs; hasEta = true; }
        }
      }
    }
    let etaHTML = '';
    if (hasEta && issueEtaMs > 0) {
      etaHTML = `<span class="ic-eta" title="ETA estimado">⏱ ~${fmtDuration(issueEtaMs)}</span>`;
    } else if (pct === 100) {
      let minTs = Infinity, maxTs = 0;
      for (const entries of Object.values(data.fases)) {
        for (const e of entries) {
          if (e.startedAt && e.startedAt < minTs) minTs = e.startedAt;
          if (e.updatedAt && e.updatedAt > maxTs) maxTs = e.updatedAt;
        }
      }
      if (maxTs > minTs && minTs < Infinity) {
        etaHTML = `<span class="ic-eta ic-done-time" title="Tiempo total">✓ ${fmtDuration(maxTs - minTs)}</span>`;
      }
    }

    // Block icons
    const blockedBy = state.blockedIssues.blockedBy[issueNum];
    const blocksOthers = state.blockedIssues.blocks[issueNum] || [];
    let blockIcons = '';
    if (blockedBy != null) {
      let depText;
      if (blockedBy.length > 0) {
        depText = blockedBy.map(d => `#${d}`).join(', ');
      } else {
        depText = 'sin dependencias especificadas';
      }
      blockIcons += `<span class="block-icon block-locked" title="Bloqueado">🚫<span class="block-tt">Bloqueado por: ${depText}</span></span>`;
    }
    if (blocksOthers.length > 0) {
      const blockLinks = blocksOthers.map(d => {
        const t = state.issueTitles?.[String(d)]?.title;
        return t ? `#${d} — ${t}` : `#${d}`;
      }).join(', ');
      blockIcons += `<span class="block-icon block-blocking">⛓️<span class="block-tt">Bloquea a: ${blockLinks}</span></span>`;
    }

    // Pipeline stepper — compact dots for each phase
    let stepperDots = '';
    let currentSkillLabel = '';
    for (let i = 0; i < allFases.length; i++) {
      const { pipeline, fase } = allFases[i];
      const key = `${pipeline}/${fase}`;
      const rawEntries = data.fases[key] || [];
      const entries = rawEntries.length > 0 ? preprocessEntries(rawEntries) : rawEntries;
      const isCurrent = data.faseActual === key;

      let dotCls = 'dot-empty';
      let dotIcon = '';
      let dotTitle = fase;
      if (entries.length > 0) {
        const hasWorking = entries.some(e => e.estado === 'trabajando');
        const hasPending = entries.some(e => e.estado === 'pendiente');
        const hasRejected = entries.some(e => e.resultado && e.resultado !== 'aprobado' && (e.estado !== 'procesado' || isCurrent));
        const allDone = entries.every(e => e.estado === 'listo' || e.estado === 'procesado');
        const allApproved = entries.every(e => !e.resultado || e.resultado === 'aprobado');

        if (hasRejected && !hasWorking) {
          dotCls = 'dot-rejected';
          dotIcon = '✗';
        } else if (hasWorking) {
          dotCls = 'dot-working';
          dotIcon = '⚙';
          const ws = entries.filter(e => e.estado === 'trabajando').map(e => e.skill);
          currentSkillLabel = ws.map(s => `${skillIcon(s)} ${s}`).join(', ');
        } else if (allDone && allApproved) {
          dotCls = 'dot-done';
          dotIcon = '✓';
        } else if (allDone && !allApproved) {
          dotCls = 'dot-rejected';
          dotIcon = '✗';
        } else if (hasPending) {
          dotCls = 'dot-pending';
          dotIcon = '○';
        } else {
          dotCls = 'dot-done';
          dotIcon = '✓';
        }
        const skills = [...new Set(entries.map(e => e.skill))].join(', ');
        const retryInfo = entries.some(e => e._isRetry) ? ` (${entries.filter(e => e._isRetry).map(e => e.skill + '×' + e._runTotal).join(', ')})` : '';
        dotTitle = `${fase}: ${skills}${retryInfo}`;
      }

      const escapedTitle = dotTitle.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      const isDefLast = pipeline === 'definicion' && i === defFases.length - 1;
      const connector = i < allFases.length - 1
        ? `<span class="stepper-conn${isDefLast ? ' stepper-conn-sep' : ''}"></span>`
        : '';
      // Data para popup solo si la fase tiene entries
      let popupAttr = '';
      if (entries.length > 0) {
        const popupSkills = entries.map(e => ({
          skill: e.skill,
          estado: e.estado,
          resultado: e.resultado || null,
          dur: e.durationMs ? fmtDuration(e.durationMs) : null,
          log: e.hasLog ? '/logs/view/' + e.logFile + (e.estado === 'trabajando' ? '?live=1' : '') : null,
          pdf: e.hasRejectionPdf ? '/logs/' + e.rejectionPdf : null,
          motivo: e.motivo ? e.motivo.slice(0, 160) : null,
          retry: e._isRetry ? e._runTotal : null,
        }));
        const popupJson = JSON.stringify({ fase, pipeline, issue: issueNum, skills: popupSkills });
        popupAttr = ` data-popup="${popupJson.replace(/"/g, '&quot;').replace(/'/g, '&#39;')}"`;
      }
      const clickable = entries.length > 0 ? ' dot-clickable' : '';
      const onclick = entries.length > 0 ? ` onclick="event.preventDefault();event.stopPropagation();showDotPopup(event,this)"` : '';
      const initial = FASE_LABEL_SHORT[fase] || fase.slice(0, 2);
      stepperDots += `<span class="stepper-cell">`
        + `<span class="stepper-dot ${dotCls}${isCurrent ? ' dot-current' : ''}${clickable}" title="${escapedTitle}"${popupAttr}${onclick}>${dotIcon}</span>`
        + `<span class="stepper-initial${isCurrent ? ' stepper-initial-current' : ''}">${initial}</span>`
        + `</span>${connector}`;
    }

    // Current phase label for the card
    let phaseLabel = '';
    if (data.faseActual) {
      const faseName = data.faseActual.split('/')[1] || data.faseActual;
      if (currentSkillLabel) {
        phaseLabel = `<span class="ic-phase-label">${faseName} · ${currentSkillLabel}</span>`;
      } else {
        phaseLabel = `<span class="ic-phase-label">${faseName}</span>`;
      }
    } else if (complete) {
      phaseLabel = `<span class="ic-phase-label ic-phase-done">completado</span>`;
    }

    // Expanded detail: phase grid (2 columns: DEFINICIÓN | DESARROLLO)
    const renderPhaseDetail = (pName, fases) => {
      return fases.map(fase => {
        const key = `${pName}/${fase}`;
        const entries = data.fases[key] || [];
        const isCurrent = data.faseActual === key;
        if (entries.length === 0) {
          return `<div class="pd-phase${isCurrent ? ' pd-current' : ''}">
            <span class="pd-name">${fase}</span><span class="pd-empty">—</span>
          </div>`;
        }
        const allProcessed = entries.every(e => e.estado === 'procesado');
        const allApproved = entries.every(e => !e.resultado || e.resultado === 'aprobado');
        const completedClass = allProcessed && allApproved && !isCurrent ? ' pd-completed' : '';
        const visible = preprocessEntries(entries);
        const chips = visible.map(e => renderChip(e, issueNum, fase, pName)).join(' ');
        return `<div class="pd-phase${isCurrent ? ' pd-current' : ''}${completedClass}">
          <span class="pd-name">${fase}</span><div class="pd-chips">${chips}</div>
        </div>`;
      }).join('');
    };

    const detailHTML = `<div class="ic-detail" id="detail-${issueNum}" aria-hidden="true">
      <div class="pd-grid">
        <div class="pd-pipeline">
          <div class="pd-pipeline-label pd-def-label">DEFINICIÓN</div>
          ${renderPhaseDetail('definicion', defFases)}
        </div>
        <div class="pd-pipeline">
          <div class="pd-pipeline-label pd-dev-label">DESARROLLO</div>
          ${renderPhaseDetail('desarrollo', devFases)}
        </div>
      </div>
    </div>`;

    const blockedClass = blockedBy != null ? ' ic-blocked' : '';
    const completedClass = complete ? ' ic-completed' : '';
    const workingClass = data.estadoActual === 'trabajando' ? ' ic-working' : '';
    const staleClass = data.staleMin > 60 ? ' ic-dead' : data.staleMin > 30 ? ' ic-stale' : '';

    // Title (truncated)
    const titleText = data.title ? data.title.replace(/"/g, '&quot;').replace(/'/g, '&#39;') : '';
    const titleHTML = titleText ? `<span class="ic-title" title="${titleText}">${titleText.length > 55 ? titleText.substring(0, 52) + '…' : titleText}</span>` : '';

    // Bounce badge
    const bounceHTML = data.bounces > 0 ? `<span class="ic-bounce${data.bounces >= 2 ? ' ic-bounce-warn' : ''}" title="${data.bounces} rebotes">↺${data.bounces}</span>` : '';

    // Stale indicator
    const staleHTML = data.staleMin > 60 ? `<span class="ic-stale-badge ic-stale-dead" title="Sin actividad: ${data.staleMin}min">⚠ ${data.staleMin}m</span>`
                    : data.staleMin > 30 ? `<span class="ic-stale-badge ic-stale-warn" title="Sin actividad: ${data.staleMin}min">⏳ ${data.staleMin}m</span>`
                    : '';

    // QA label badge for completed issues
    const qaLabel = data.labels?.find(l => l.startsWith('qa:'));
    const qaHTML = qaLabel ? `<span class="ic-qa-badge ic-qa-${qaLabel.split(':')[1]}">${qaLabel}</span>` : '';

    issueCards += `
    <div class="ic-card${completedClass}${blockedClass}${workingClass}${staleClass}" data-issue="${issueNum}" data-status="${complete ? 'completed' : 'active'}">
      <div class="ic-header" role="button" tabindex="0" aria-expanded="false" onclick="toggleIssueDetail('${issueNum}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleIssueDetail('${issueNum}')}">
        <div class="ic-left">
          <a href="${GH(issueNum)}" target="_blank" class="ic-issue-link" onclick="event.stopPropagation()">#${issueNum}</a>
          ${bounceHTML}${blockIcons}${staleHTML}
          ${titleHTML}
        </div>
        <div class="ic-stepper" aria-label="Pipeline progress">${stepperDots}</div>
        <div class="ic-meta">
          ${phaseLabel}
          ${qaHTML}
          <span class="ic-pct${pct === 100 ? ' ic-pct-done' : ''}">${pct}%</span>
          ${etaHTML}
        </div>
        <span class="ic-expand-btn" id="expand-btn-${issueNum}" aria-hidden="true">▾</span>
      </div>
      <div class="ic-progress-track" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div class="ic-progress-fill${data.estadoActual === 'trabajando' ? ' ic-progress-active' : ''}" style="width:${pct}%"></div></div>
      ${detailHTML}
    </div>`;

    // ── Lane card Opción E+polish (3 lanes + rich cards + logs + bloqueos) ──
    const lane = macroLane(data);
    const working = data.estadoActual === 'trabajando';
    const hasRejection = data.labels?.some(l => l === 'qa:failed');
    const isStale = data.staleMin > 30;
    const isBlocked = blockedBy != null;
    const blocksSomething = blocksOthers.length > 0;
    // #2337 CA8 — ventana `reintentando` activa: timestamp absoluto compara vs
    // momento del render. Durante esta ventana el visual override es `lc-retrying`,
    // aunque el estado real sea `trabajando` (CA7.4 anti-parpadeo).
    const isRetrying = !!(data.retrying && Number(data.retrying.retryingUntil) > Date.now());
    const laneCardCls = complete ? 'lc-done'
      : isRetrying ? 'lc-retrying'
      : isStale ? 'lc-stale'
      : hasRejection ? 'lc-failed'
      : isBlocked ? 'lc-blocked'
      : working ? 'lc-running' : '';
    // Sub-fase actual (para filtros y stats)
    const currentFase = data.faseActual ? data.faseActual.split('/')[1] : '';
    // Stats agregadas
    if (lane !== 'done' && laneStats[lane]) {
      if (working) laneStats[lane].running++;
      if (hasRejection) laneStats[lane].failed++;
      if (isStale) laneStats[lane].stale++;
      if (currentFase) laneStats[lane].subCounts[currentFase] = (laneStats[lane].subCounts[currentFase] || 0) + 1;
    }
    const laneElapsedCls = isStale ? 'lc-warn' : working ? 'lc-teal' : '';
    const laneElapsedTxt = complete ? 'completado'
      : data.staleMin > 60 ? `${data.staleMin}m 🚩`
      : data.staleMin > 30 ? `${data.staleMin}m`
      : working ? `${data.staleMin}m` : '—';
    // Avatares de skills: prioriza trabajando, fallback al último que ejecutó en la fase actual
    const currentSkills = [];
    const currentFaseEntries = (data.faseActual && data.fases[data.faseActual]) || [];
    for (const e of currentFaseEntries) {
      if (e.estado === 'trabajando' && !currentSkills.includes(e.skill)) currentSkills.push(e.skill);
    }
    let isFallbackAvatar = false;
    if (currentSkills.length === 0 && currentFaseEntries.length > 0) {
      // Fallback: último skill que ejecutó (ordenado por updatedAt desc)
      const sortedEntries = [...currentFaseEntries].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      for (const e of sortedEntries) {
        if (!currentSkills.includes(e.skill)) currentSkills.push(e.skill);
        if (currentSkills.length >= 2) break;
      }
      isFallbackAvatar = true;
    }
    const avatarsHTML = currentSkills.length > 0
      ? `<div class="lc-avatars${isFallbackAvatar ? ' lc-avatars-dim' : ''}">` + currentSkills.slice(0, 3).map(s => {
          const p = AGENT_PERSONA[s] || { icon: '\u2699', name: s, color: 'var(--dim)' };
          return `<span class="lc-av" style="background:${p.color}" title="${p.name}${isFallbackAvatar ? ' (último ejecutado)' : ''}">${p.icon}</span>`;
        }).join('') + (currentSkills.length > 3 ? `<span class="lc-av-more">+${currentSkills.length - 3}</span>` : '') + '</div>'
      : '';
    const multiSkillTag = currentSkills.length > 1 && !isFallbackAvatar ? ` <span class="lc-pill-x">×${currentSkills.length}</span>` : '';
    const lanePill = complete
      ? '<span class="lc-pill lc-pill-done">✓ entregado</span>'
      : hasRejection
      ? `<span class="lc-pill lc-pill-fail">qa:failed</span>`
      : working
      ? `<span class="lc-pill lc-pill-run">${currentFase}${multiSkillTag}</span>`
      : `<span class="lc-pill lc-pill-wait">${currentFase || 'pendiente'}</span>`;
    // Icons de bloqueo: 🚫 (bloqueado) + ⛓ (bloquea a otros)
    let lcBlockIcons = '';
    if (isBlocked) {
      const depTxt = blockedBy.length > 0 ? blockedBy.map(d => `#${d}`).join(', ') : 'dep sin especificar';
      lcBlockIcons += `<span class="lc-block-icon lc-block-locked" title="Bloqueado por: ${depTxt}" onclick="event.stopPropagation()">🚫</span>`;
    }
    if (blocksSomething) {
      const blockTxt = blocksOthers.map(d => `#${d}`).join(', ');
      lcBlockIcons += `<span class="lc-block-icon lc-block-blocking" title="Bloquea a: ${blockTxt}" onclick="event.stopPropagation()">⛓</span>`;
    }
    // #2337 CA8 — icono `🔁` durante la ventana `reintentando`. El estado es
    // mutuamente excluyente con `blocked`, asi que no aparecen los dos iconos
    // a la vez. Aria-label con timestamp legible. Escape via textContent-safe
    // (valores server-generated, sin input de usuario — REQ-SEC-1).
    let lcRetryingIcon = '';
    if (isRetrying) {
      const since = Number(data.retrying.since) || Date.now();
      const sinceIso = new Date(since).toISOString().slice(11, 19); // HH:MM:SS UTC
      const ariaLabel = `Reintentando tras recuperacion de red desde ${sinceIso}`;
      const tooltipText = `Reintentando tras recuperacion de red (desde ${sinceIso})`;
      lcRetryingIcon = `<span class="lc-retry-icon" role="img" aria-hidden="true">🔁</span>`
        + `<span class="lc-retry-label" role="status" aria-label="${ariaLabel}" title="${tooltipText}" tabindex="0" onclick="event.stopPropagation()"></span>`;
    }
    const laneTitle = (data.title || `Issue #${issueNum}`).replace(/"/g, '&quot;');
    const flagSpan = data.staleMin > 60 ? '<span class="lc-flag">🚩</span>' : '';
    // Data atributos para búsqueda client-side
    const searchKey = (issueNum + ' ' + (data.title || '')).toLowerCase().replace(/"/g, '&quot;');
    // Prioridad para sort: orden manual del Issue Tracker es la única fuente.
    // Position 0 = más prioritario; cuanto menor el index, más arriba en la lane.
    // Sort es `b.priority - a.priority` (desc) → mayor priority = más arriba,
    // así que invertimos el index. Issues sin entrada (no debería pasar tras
    // syncWith pero por defensa) van al fondo.
    const manualPos = manualOrderIndex.has(String(issueNum)) ? manualOrderIndex.get(String(issueNum)) : 999999;
    const priority = -manualPos;
    const posLabel = manualPos < 999999 ? `<span class="lc-pos" title="Posición en el orden manual (1 = más prioritario)">#${manualPos + 1}</span>` : '';
    const cardHTML = `<div class="lc-card ${laneCardCls}" data-issue="${issueNum}" data-lane="${lane}" data-status="${complete ? 'completed' : 'active'}" data-subfase="${currentFase}" data-search="${searchKey}" data-retrying-until="${isRetrying ? Number(data.retrying.retryingUntil) : ''}" title="${laneTitle}" aria-live="polite" draggable="${complete ? 'false' : 'true'}" ondragstart="onCardDragStart(event)" ondragover="onCardDragOver(event)" ondragleave="onCardDragLeave(event)" ondrop="onCardDrop(event)" ondragend="onCardDragEnd(event)">
      <div class="lc-card-main">
        <div class="lc-top">
          <div class="lc-top-left">
            ${posLabel}
            <a class="lc-num" href="${GH(issueNum)}" target="_blank" title="Ver issue en GitHub" onclick="event.stopPropagation()">#${issueNum}</a>
            ${lcBlockIcons}${lcRetryingIcon}
          </div>
          <div class="lc-top-right">
            <span class="lc-prio-actions">
              <button class="lc-prio-btn lc-prio-up" onclick="event.stopPropagation();issueMoveUp(${issueNum})" title="Subir una posición">▲</button>
              <button class="lc-prio-btn lc-prio-down" onclick="event.stopPropagation();issueMoveDown(${issueNum})" title="Bajar una posición">▼</button>
            </span>
            <span class="lc-elapsed ${laneElapsedCls}">${laneElapsedTxt}</span>
          </div>
        </div>
        <div class="lc-title">${flagSpan}${laneTitle}</div>
        <div class="lc-foot">
          <div class="lc-foot-left">
            <span class="lc-ps">${stepperDots}</span>
            ${lanePill}
          </div>
          ${avatarsHTML}
        </div>
      </div>
    </div>`;
    laneCards[lane].push({ html: cardHTML, priority });
    laneCounts[lane]++;
  }
  // Sort dentro de cada lane por criticidad desc
  for (const k of Object.keys(laneCards)) {
    laneCards[k].sort((a, b) => b.priority - a.priority);
    laneCards[k] = laneCards[k].map(x => x.html).join('');
  }

  // Render 3 lanes (Opción E) con sub-breakdown + cards ricas
  const laneOrder = ['def', 'dev', 'qa'];
  const lanesHTML = laneOrder.map(k => {
    const m = laneMeta[k];
    const stats = laneStats[k];
    const cards = laneCards[k] || '<div class="lane-empty">Sin issues</div>';
    // Sub-breakdown: chips clickeables por sub-fase (filtra cards del lane)
    const maxSubCount = Math.max(...m.subFases.map(sf => stats.subCounts[sf] || 0), 1);
    const subBreakdown = '<div class="it-sub-breakdown">' +
      `<div class="it-sub-chip it-sub-all" data-lane="${k}" data-subfase="" onclick="filterLaneBySubFase('${k}','')" title="Mostrar todos">Todos <b>${laneCounts[k]}</b></div>` +
      m.subFases.map(sf => {
        const c = stats.subCounts[sf] || 0;
        const isHot = c === maxSubCount && c > 0 && m.subFases.some(other => other !== sf && (stats.subCounts[other] || 0) < c);
        const disabled = c === 0 ? ' it-sub-disabled' : '';
        return `<div class="it-sub-chip${isHot ? ' hot' : ''}${disabled}" data-lane="${k}" data-subfase="${sf}" onclick="filterLaneBySubFase('${k}','${sf}')" title="Filtrar por ${m.subLabels[sf]}">${m.subLabels[sf]} <b>${c}</b></div>`;
      }).join('') + '</div>';
    // Meta: badges
    const metaBadges = [];
    if (stats.running > 0) metaBadges.push(`<span class="it-badge run">${stats.running} activo${stats.running > 1 ? 's' : ''}</span>`);
    if (stats.failed > 0) metaBadges.push(`<span class="it-badge fail">${stats.failed} failed</span>`);
    if (stats.stale > 0) metaBadges.push(`<span class="it-badge warn">${stats.stale} stale</span>`);
    return `<div class="it-lane it-lane-${k}" data-lane="${k}" style="--lane-color:${m.color}">
      <div class="it-lane-head">
        <span class="it-lane-name"><span class="it-lane-dot"></span>${m.label} <span class="it-lane-sub">${m.sub}</span></span>
        <div class="it-lane-meta">
          <span class="it-lane-count"><b>${laneCounts[k]}</b></span>
          ${metaBadges.join('')}
        </div>
      </div>
      ${subBreakdown}
      <div class="it-lane-cards">${cards}</div>
    </div>`;
  }).join('');
  const doneLaneHTML = laneCounts.done > 0 ? `<details class="it-done-section" data-lane="done">
    <summary class="it-done-head">
      <span class="it-done-arrow">▸</span>
      <span>✓ Completados recientes</span>
      <span class="it-done-count"><b>${laneCounts.done}</b></span>
    </summary>
    <div class="it-done-grid">${laneCards.done}</div>
  </details>` : '';

  // V3 — Bloqueados esperando humano (issue #2478, refuerzo visual #2549)
  const bloqueados = Array.isArray(state.bloqueados) ? state.bloqueados : [];
  const escHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const bloqueadosHTML = bloqueados.length === 0 ? '' : `
    <div class="matrix-section needs-human-panel" id="bloqueados-humano">
      <h2 class="needs-human-header" onclick="toggleNeedsHumanPanel()" title="Click para colapsar/expandir">
        <span class="needs-human-pulse">🚨</span>
        Necesitan intervención humana
        <span class="needs-human-badge">${bloqueados.length}</span>
        <span class="needs-human-chevron">▼</span>
      </h2>
      <div class="needs-human-body">
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px">
        ${bloqueados.map(b => {
          const ageStr = b.age_hours < 1 ? Math.max(1, Math.round(b.age_hours * 60)) + 'min' : Math.round(b.age_hours) + 'h';
          const ageCls = b.age_hours >= 4 ? 'needs-human-age-old' : 'needs-human-age-fresh';
          const titleHtml = b.title ? ` — <span style="color:var(--dim)">${escHtml(b.title)}</span>` : '';
          const reasonTxt = (b.question || b.reason || '').toString();
          return `<div class="needs-human-row">
            <div class="needs-human-row-head">
              <div class="needs-human-row-info">
                <a href="https://github.com/intrale/platform/issues/${b.issue}" target="_blank" rel="noopener"><b>#${b.issue}</b></a>${titleHtml}
                <span style="color:var(--dim)"> · ${escHtml(b.skill)} en ${escHtml(b.phase)}</span>
                <span class="${ageCls}"> · hace ${ageStr}</span>
              </div>
              <div class="needs-human-row-actions">
                <button class="nh-btn nh-btn-reactivate" onclick="needsHumanReactivate(${b.issue})" title="Quitar el label needs-human y devolver el issue a la cola del pipeline">▶ Reactivar</button>
                <button class="nh-btn nh-btn-dismiss" onclick="needsHumanDismiss(${b.issue})" title="Cerrar el issue como desestimado y limpiarlo del panel">✕ Desestimar</button>
              </div>
            </div>
            ${reasonTxt ? `<div class="needs-human-reason">❓ ${escHtml(reasonTxt.slice(0, 280))}${reasonTxt.length > 280 ? '…' : ''}</div>` : ''}
          </div>`;
        }).join('')}
      </div>
      <div style="margin-top:10px;font-size:0.82em;color:var(--dim)">
        Desbloquear desde Telegram: <code>/unblock &lt;issue&gt; &lt;orientación&gt;</code> · o quitá el label <code>needs-human</code> en GitHub
      </div>
      </div>
    </div>`;

  const matrixHTML = `
    ${bloqueadosHTML}
    <div class="matrix-section" id="issue-tracker">
      <div class="matrix-header">
        <h2>📊 Issue Tracker</h2>
        <div class="it-search-box">
          <input type="text" class="it-search" id="it-search-input" placeholder="🔍 Buscar por # o título…" oninput="filterIssuesBySearch(this.value)" />
          <span class="it-search-clear" onclick="clearIssueSearch()" title="Limpiar">×</span>
        </div>
        <div class="ic-tabs" role="tablist" aria-label="Issue filter">
          <button class="ic-tab ic-tab-active" role="tab" aria-selected="true" data-filter="active" onclick="filterIssueTab(this,'active')">En progreso <span class="ic-tab-count">${activeIssues.length}</span></button>
          <button class="ic-tab" role="tab" aria-selected="false" data-filter="completed" onclick="filterIssueTab(this,'completed')">Completados <span class="ic-tab-count">${completedIssues.length}</span></button>
          <button class="ic-tab" role="tab" aria-selected="false" data-filter="all" onclick="filterIssueTab(this,'all')">Todos <span class="ic-tab-count">${sorted.length}</span></button>
        </div>
      </div>
      <div class="it-lanes">${lanesHTML}</div>
      ${doneLaneHTML}
      <div id="dot-popup" class="dot-popup" style="display:none">
        <div class="dp-head"><span class="dp-title"></span><span class="dp-close" onclick="closeDotPopup()">×</span></div>
        <div class="dp-body"></div>
      </div>
    </div>`;

  // Skill capacity — versión reducida: solo activos/parciales, idle como resumen
  // Calcular frecuencia de uso y últimos issues por skill
  const skillUsageCount = {};
  const recentBySkill = {}; // skill → [{ issue, resultado, logFile, hasLog, ts }] (últimos 3)
  for (const [issue, data] of matrixEntries) {
    for (const [, faseEntries] of Object.entries(data.fases || {})) {
      for (const e of faseEntries) {
        skillUsageCount[e.skill] = (skillUsageCount[e.skill] || 0) + 1;
        // Recolectar issues completados (listo/procesado) para historial reciente
        if (e.estado === 'listo' || e.estado === 'procesado') {
          if (!recentBySkill[e.skill]) recentBySkill[e.skill] = [];
          recentBySkill[e.skill].push({
            issue, resultado: e.resultado, logFile: e.logFile,
            hasLog: e.hasLog, hasRejectionPdf: e.hasRejectionPdf,
            rejectionPdf: e.rejectionPdf, ts: e.updatedAt || e.startedAt || 0
          });
        }
      }
    }
  }
  // Ordenar cada skill por timestamp desc y quedarse con los últimos 3
  for (const sk of Object.keys(recentBySkill)) {
    // Deduplicar por issue (quedarse con el más reciente)
    const byIssue = {};
    for (const r of recentBySkill[sk]) {
      if (!byIssue[r.issue] || r.ts > byIssue[r.issue].ts) byIssue[r.issue] = r;
    }
    recentBySkill[sk] = Object.values(byIssue).sort((a, b) => b.ts - a.ts).slice(0, 3);
  }
  // Ordenar: 1) más agentes activos (running desc), 2) más usados históricamente (usage desc)
  const skillEntries = Object.entries(state.skillLoad)
    .sort((a, b) => {
      const diff = b[1].running - a[1].running;
      if (diff !== 0) return diff;
      return (skillUsageCount[b[0]] || 0) - (skillUsageCount[a[0]] || 0);
    });
  // Helper: genera mini-historial de los últimos 3 issues para un skill
  function skillRecentHTML(skill) {
    const recents = recentBySkill[skill];
    if (!recents || recents.length === 0) return '';
    return '<div class="skill-recent">' + recents.map(r => {
      const icon = r.resultado === 'aprobado' ? '\u2705' : r.resultado === 'rechazado' ? '\u274C' : '\u23F3';
      const inner = '#' + r.issue;
      const pdfLink = r.hasRejectionPdf
        ? ' <a class="skill-recent-pdf" href="/logs/' + r.rejectionPdf + '" target="_blank" title="Reporte de rechazo PDF" onclick="event.stopPropagation()">\u{1F4C4}</a>'
        : '';
      if (r.hasLog) {
        const isLive = !r.resultado || r.resultado === 'en curso';
        return '<a class="skill-recent-item" href="/logs/view/' + r.logFile + (isLive ? '?live=1' : '') + '" target="_blank" title="' + (r.resultado || 'en curso') + '">' + icon + ' ' + inner + '</a>' + pdfLink;
      }
      return '<span class="skill-recent-item" title="' + (r.resultado || 'sin log') + '">' + icon + ' ' + inner + '</span>' + pdfLink;
    }).join('') + '</div>';
  }

  // ── Equipo disponible: agrupado por categoría (Producto/Dev/Calidad/Ops) ──
  // Calcular tasa de éxito histórica por skill (para la tarjeta persona)
  const skillStats = {};
  for (const [skill, recents] of Object.entries(recentBySkill)) {
    const ok = recents.filter(r => r.resultado === 'aprobado').length;
    const bad = recents.filter(r => r.resultado === 'rechazado').length;
    skillStats[skill] = { ok, bad, total: recents.length };
  }
  // Agrupar todas las skills conocidas por categoría
  const skillsByCategory = { product: [], dev: [], quality: [], ops: [] };
  for (const [skill, load] of skillEntries) {
    const cat = SKILL_CATEGORY[skill] || 'ops';
    skillsByCategory[cat].push([skill, load]);
  }
  // Mini strip histórico (últimos 5 issues con color)
  function skillHistoryStrip(skill) {
    const recents = (recentBySkill[skill] || []).slice(0, 5);
    if (recents.length === 0) {
      return '<div class="persona-strip persona-strip-empty" title="Sin historial">—</div>';
    }
    const dots = recents.map(r => {
      const cls = r.resultado === 'aprobado' ? 'ok' : r.resultado === 'rechazado' ? 'bad' : 'live';
      const icon = r.resultado === 'aprobado' ? '\u2713' : r.resultado === 'rechazado' ? '\u2717' : '\u25CF';
      const label = (r.resultado || 'en curso') + ' #' + r.issue;
      const href = r.hasLog ? '/logs/view/' + r.logFile + (r.resultado && r.resultado !== 'en curso' ? '' : '?live=1') : null;
      const content = `<span class="persona-dot persona-dot-${cls}" title="${label}">${icon}</span>`;
      return href ? `<a href="${href}" target="_blank" onclick="event.stopPropagation()">${content}</a>` : content;
    }).join('');
    return `<div class="persona-strip">${dots}</div>`;
  }
  // Render una tarjeta-persona por skill
  function personaCard(skill, load) {
    const p = AGENT_PERSONA[skill] || { icon: '⚙', name: skill, tagline: '', color: 'var(--dim2)' };
    const pct = load.max > 0 ? load.running / load.max : 0;
    const state = pct >= 1 ? 'full' : pct > 0 ? 'partial' : 'idle';
    const statusLabel = pct >= 1 ? `${load.running}/${load.max} ocupado` : pct > 0 ? `${load.running}/${load.max} en trabajo` : `${load.max} libre${load.max === 1 ? '' : 's'}`;
    const stats = skillStats[skill] || { ok: 0, bad: 0, total: 0 };
    const successRate = stats.total > 0 ? Math.round((stats.ok / stats.total) * 100) : null;
    const usage = skillUsageCount[skill] || 0;
    return `<div class="persona-card persona-${state}" style="--agent-color:${p.color}" title="${skill} — ${p.tagline || ''}">
      <div class="persona-head">
        <span class="persona-avatar">${p.icon}</span>
        <div class="persona-id">
          <div class="persona-name">${p.name || skill}</div>
          <div class="persona-tagline">${(p.tagline || '').split(' · ').slice(0, 2).join(' · ') || '\u00A0'}</div>
        </div>
        <span class="persona-pill persona-pill-${state}">${statusLabel}</span>
      </div>
      <div class="persona-body">
        ${skillHistoryStrip(skill)}
        <div class="persona-meta">
          ${successRate !== null ? `<span class="persona-meta-item" title="Tasa de aprobación histórica">\u2713 ${successRate}%</span>` : ''}
          <span class="persona-meta-item persona-meta-usage" title="Issues trabajados">\u{1F4C8} ${usage}</span>
        </div>
      </div>
    </div>`;
  }
  // Heatmap legacy mantenido para compatibilidad (puede eliminarse luego)
  let heatmapHTML = '';
  const catOrder = ['product', 'dev', 'quality', 'ops'];

  // ── Option B: Areas grid 2x2 con chips compactos ──
  let eqAreaGridHTML = '';
  let eqTotalSkills = 0, eqTotalBusy = 0;
  for (const cat of catOrder) {
    const list = skillsByCategory[cat];
    if (!list || list.length === 0) continue;
    const m = CATEGORY_META[cat];
    list.sort((a, b) => b[1].running - a[1].running || (skillUsageCount[b[0]] || 0) - (skillUsageCount[a[0]] || 0));
    // Contar skills (no slots): busy = skills con al menos 1 running
    const busySkills = list.filter(([_, l]) => (l.running || 0) > 0).length;
    const totalSkills = list.length;
    eqTotalBusy += busySkills; eqTotalSkills += totalSkills;
    const freeSkills = totalSkills - busySkills;
    const chips = list.map(([s, l]) => {
      const p = AGENT_PERSONA[s] || { icon: '\u2699', name: s, color: 'var(--dim)' };
      const running = l.running || 0;
      const stateCls = running > 0 ? 'eq-chip-busy' : '';
      const countBadge = running > 1 ? `<span class="eq-chip-badge">\u00D7${running}</span>` : '';
      const usage = skillUsageCount[s] || 0;
      const tip = running > 0
        ? `${p.name} \u2014 ${running} issue${running > 1 ? 's' : ''} en ejecución (${usage} runs)`
        : `${p.name} \u2014 libre (${usage} runs)`;
      return `<span class="eq-chip ${stateCls}" title="${tip.replace(/"/g, '&quot;')}">
        <span class="eq-chip-avatar" style="background:${p.color}">${p.icon}</span>
        <span class="eq-chip-name">${p.name}</span>
        ${countBadge}
        <span class="eq-chip-dot"></span>
      </span>`;
    }).join('');
    const subTxt = busySkills > 0
      ? `<b>${freeSkills}</b>/${totalSkills} libres \u00B7 <span class="eq-area-card-active">${busySkills} activo${busySkills > 1 ? 's' : ''}</span>`
      : `<b>${freeSkills}</b> libres`;
    eqAreaGridHTML += `<div class="eq-area-card">
      <div class="eq-area-card-head">
        <span class="eq-area-card-name"><span class="eq-area-card-dot" style="background:${m.color}"></span>${m.label}</span>
        <span class="eq-area-card-sub">${subTxt}</span>
      </div>
      <div class="eq-area-card-chips">${chips}</div>
    </div>`;
  }
  if (eqAreaGridHTML) eqAreaGridHTML = '<div class="eq-areas-grid">' + eqAreaGridHTML + '</div>';

  // ── Servicios agrupados por capa (Intake/Processing/Output) ──
  const fmtStat = (n) => n > 99 ? `<span title="${n}">99+</span>` : `${n}`;
  const SERVICE_GROUPS = [
    { name: 'Telegram', icon: '\u{1F4E8}', queues: ['commander', 'telegram'], processes: ['listener', 'svc-telegram'], layer: 'intake' },
    { name: 'GitHub',   icon: '\u{1F419}', queues: ['github'], processes: ['svc-github'], layer: 'intake' },
    { name: 'Drive',    icon: '\u{1F4C1}', queues: ['drive'], processes: ['svc-drive'], layer: 'output' },
    { name: 'Emulador', icon: '\u{1F4F1}', queues: ['emulador'], processes: ['svc-emulador'], layer: 'output' },
  ];
  const STANDALONE_PROCESSES = [
    { name: 'pulpo',        icon: '\u{1F419}', label: 'Pulpo',       layer: 'processing' },
    { name: 'outbox-drain', icon: '\u{1F4E4}', label: 'Outbox',      layer: 'processing' },
    { name: 'dashboard',    icon: '\u{1F4CA}', label: 'Dashboard',   layer: 'processing' },
  ];

  // Render de una "service pill" compacta
  function serviceRow({ name, icon, label, queues, processes, isGroup }) {
    label = label || name;
    processes = processes || [name];
    queues = queues || [];
    const procInfo = processes.map(p => state.procesos[p] || { pid: null, alive: false });
    const anyAlive = procInfo.some(p => p.alive);
    const allAlive = procInfo.every(p => p.alive);
    const anyDead = procInfo.some(p => !p.alive);
    // Queue stats
    let totalPend = 0, totalWork = 0, totalDone = 0;
    for (const q of queues) {
      const d = state.servicios[q];
      if (d) { totalPend += d.pendiente; totalWork += d.trabajando; totalDone += d.listo; }
    }
    const hasQueue = queues.length > 0;
    const busy = totalWork > 0;
    const status = !anyAlive ? 'dead' : anyDead ? 'degraded' : busy ? 'busy' : 'ok';
    const statusDot = { ok: '#3fb950', busy: '#d29922', degraded: '#f0883e', dead: '#f85149' }[status];
    const statusLabel = { ok: 'Saludable', busy: 'Procesando', degraded: 'Degradado', dead: 'Detenido' }[status];
    // Uptime del primero vivo
    const aliveUptime = procInfo.find(p => p.alive && p.uptime)?.uptime;
    const uptimeStr = aliveUptime ? fmtUptime(aliveUptime) : (anyAlive ? '—' : 'offline');
    // Control: si dashboard no; si todos vivos → stop; si alguno muerto → start
    const isDashboard = name === 'dashboard';
    let actionBtn = '';
    if (!isDashboard) {
      if (allAlive) {
        actionBtn = `<button class="svc-ctl svc-ctl-stop" onclick="event.stopPropagation();${processes.map(p => `ctlAction('${p}','stop')`).join(';')}" title="Detener ${label}">\u25A0</button>`;
      } else {
        actionBtn = `<button class="svc-ctl svc-ctl-start" onclick="event.stopPropagation();${processes.map(p => `ctlAction('${p}','start')`).join(';')}" title="Iniciar ${label}">\u25B6</button>`;
      }
    }
    // Subprocesos en tooltip
    const procDetail = procInfo.map((p, i) => `${processes[i]}: ${p.alive ? 'PID ' + p.pid : 'off'}`).join('\n');
    const queueDetail = queues.map(q => {
      const d = state.servicios[q]; if (!d) return '';
      return `${q}: \u25CB${d.pendiente} \u2699${d.trabajando} \u2713${d.listo}`;
    }).filter(Boolean).join('\n');
    const tooltip = [statusLabel, procDetail, queueDetail].filter(Boolean).join('\n');
    // Queues inline mini
    const queueHTML = hasQueue ? `
      <span class="svc-queue">
        <span class="svc-q svc-q-pend" title="Pendiente: ${totalPend}">\u25CB ${fmtStat(totalPend)}</span>
        <span class="svc-q svc-q-work ${busy ? 'svc-q-work-pulse' : ''}" title="Trabajando: ${totalWork}">\u2699 ${fmtStat(totalWork)}</span>
        <span class="svc-q svc-q-done" title="Listo: ${totalDone}">\u2713 ${fmtStat(totalDone)}</span>
      </span>` : '<span class="svc-queue svc-queue-none">—</span>';
    return `<div class="svc-row svc-row-${status}" title="${tooltip.replace(/"/g, '&quot;')}">
      <span class="svc-status-dot" style="background:${statusDot}${busy || status === 'ok' ? ';animation:svcPulse 2s infinite' : ''}"></span>
      <span class="svc-icon">${icon}</span>
      <span class="svc-name">${label}</span>
      ${queueHTML}
      <span class="svc-uptime" title="Tiempo en ejecución">${uptimeStr}</span>
      ${actionBtn}
    </div>`;
  }

  // Agrupar todo por capa
  const layers = { intake: [], processing: [], output: [] };
  for (const g of SERVICE_GROUPS) {
    layers[g.layer].push(serviceRow({ name: g.name, icon: g.icon, label: g.name, queues: g.queues, processes: g.processes, isGroup: true }));
  }
  for (const s of STANDALONE_PROCESSES) {
    layers[s.layer].push(serviceRow({ name: s.name, icon: s.icon, label: s.label }));
  }

  // QA Remote o Emulador local → layer output
  if (state.qaRemote && state.qaRemote.active) {
    layers.output.push(`<div class="svc-row svc-row-ok svc-row-cloud" title="QA remoto en Lambda AWS\n${state.qaRemote.ref || ''}">
      <span class="svc-status-dot" style="background:#3fb950;animation:svcPulse 2s infinite"></span>
      <span class="svc-icon">\u2601\uFE0F</span>
      <span class="svc-name">QA Remoto</span>
      <span class="svc-queue svc-queue-none">Lambda</span>
      <span class="svc-uptime">${state.qaRemote.ref || 'AWS'}</span>
    </div>`);
  } else {
    for (const [name, alive] of Object.entries(state.qaEnv)) {
      const statusColor = alive ? '#3fb950' : '#f85149';
      const btn = alive
        ? `<button class="svc-ctl svc-ctl-stop" onclick="event.stopPropagation();qaComponentAction('${name}','stop')" title="Detener Emulador">\u25A0</button>`
        : `<button class="svc-ctl svc-ctl-start" onclick="event.stopPropagation();qaComponentAction('${name}','start')" title="Iniciar Emulador">\u25B6</button>`;
      layers.output.push(`<div class="svc-row svc-row-${alive ? 'ok' : 'dead'}" title="Emulador Android: ${alive ? 'activo' : 'detenido'}">
        <span class="svc-status-dot" style="background:${statusColor}${alive ? ';animation:svcPulse 2s infinite' : ''}"></span>
        <span class="svc-icon">\u{1F4F1}</span>
        <span class="svc-name">Emulador</span>
        <span class="svc-queue svc-queue-none">${alive ? 'activo' : 'offline'}</span>
        <span class="svc-uptime">—</span>
        ${btn}
      </div>`);
    }
  }

  let svcCardsHTML = '';
  for (const layerKey of ['intake', 'processing', 'output']) {
    const rows = layers[layerKey];
    if (rows.length === 0) continue;
    const m = LAYER_META[layerKey];
    svcCardsHTML += `<div class="svc-layer">
      <div class="svc-layer-head"><span class="svc-layer-icon">${m.icon}</span><span class="svc-layer-label">${m.label}</span></div>
      <div class="svc-layer-rows">${rows.join('')}</div>
    </div>`;
  }

  // ── System Resources: gauges radiales + sparkline trend + headroom ──
  const res = state.resources;
  const cpuHist = res.cpuHistory || [];
  const memHist = res.memHistory || [];
  const cpuPeak = cpuHist.length ? Math.max(...cpuHist) : res.cpuPercent;
  const memPeak = memHist.length ? Math.max(...memHist) : res.memPercent;
  const cpuAvg = cpuHist.length ? Math.round(cpuHist.reduce((a, b) => a + b, 0) / cpuHist.length) : res.cpuPercent;
  const memAvg = memHist.length ? Math.round(memHist.reduce((a, b) => a + b, 0) / memHist.length) : res.memPercent;
  // Trend = delta entre muestra actual y promedio reciente (USE method: saturation proxy)
  const cpuTrend = cpuHist.length > 3 ? res.cpuPercent - cpuAvg : 0;
  const memTrend = memHist.length > 3 ? res.memPercent - memAvg : 0;
  const trendArrow = (t) => t > 5 ? '<span class="trend-up">\u2197</span>' : t < -5 ? '<span class="trend-down">\u2198</span>' : '<span class="trend-flat">\u2192</span>';
  const cpuHeadroom = Math.max(0, res.maxCpu - res.cpuPercent);
  const memHeadroom = Math.max(0, res.maxMem - res.memPercent);
  const cpuStatus = res.cpuPercent >= res.maxCpu ? 'danger' : res.cpuPercent >= res.maxCpu * 0.8 ? 'warn' : 'ok';
  const memStatus = res.memPercent >= res.maxMem ? 'danger' : res.memPercent >= res.maxMem * 0.8 ? 'warn' : 'ok';
  const cpuColor = cpuStatus === 'danger' ? '#f85149' : cpuStatus === 'warn' ? '#d29922' : '#3fb950';
  const memColor = memStatus === 'danger' ? '#f85149' : memStatus === 'warn' ? '#d29922' : '#3fb950';
  // Health score combinado (0-100, 100 = óptimo)
  const worstUtil = Math.max(res.cpuPercent / res.maxCpu, res.memPercent / res.maxMem);
  const healthScore = Math.max(0, Math.round((1 - worstUtil) * 100));
  const healthLabel = healthScore > 60 ? 'Óptimo' : healthScore > 30 ? 'Presionado' : healthScore > 10 ? 'Crítico' : 'Saturado';
  const healthColor = healthScore > 60 ? '#3fb950' : healthScore > 30 ? '#d29922' : '#f85149';
  const blocked = res.cpuPercent >= res.maxCpu || res.memPercent >= res.maxMem;
  const resourcesHTML = `
    <div class="sys-health">
      <div class="sys-health-score" style="--hcolor:${healthColor}">
        <div class="sys-health-value">${healthScore}</div>
        <div class="sys-health-label">${healthLabel}</div>
      </div>
      <div class="sys-health-meta">
        <div class="sys-health-title">Salud del sistema</div>
        <div class="sys-health-sub">${state.cpuCores || res.cpuCores} cores \u00B7 ${res.memTotalGB} GB RAM \u00B7 headroom ${Math.min(cpuHeadroom, memHeadroom)}%</div>
      </div>
    </div>
    <div class="gauge-row">
      <div class="rgauge-cell rgauge-${cpuStatus}">
        <div class="rgauge-top">
          ${radialGauge(res.cpuPercent, 100, res.maxCpu, cpuColor)}
          <div class="rgauge-info">
            <div class="rgauge-title">CPU <span class="rgauge-trend">${trendArrow(cpuTrend)}</span></div>
            <div class="rgauge-sub">${res.cpuCores} cores \u00B7 límite ${res.maxCpu}%</div>
            <div class="rgauge-kpis">
              <span title="Promedio últimos ${cpuHist.length} samples">avg <b>${cpuAvg}%</b></span>
              <span title="Pico reciente">peak <b>${cpuPeak}%</b></span>
              <span title="Espacio disponible antes de bloquear">free <b>${cpuHeadroom}%</b></span>
            </div>
          </div>
        </div>
        <div class="rgauge-spark" title="Tendencia CPU últimos minutos">${sparklineSVG(cpuHist, cpuColor, { w: 220, h: 32, max: 100 })}</div>
      </div>
      <div class="rgauge-cell rgauge-${memStatus}">
        <div class="rgauge-top">
          ${radialGauge(res.memPercent, 100, res.maxMem, memColor)}
          <div class="rgauge-info">
            <div class="rgauge-title">RAM <span class="rgauge-trend">${trendArrow(memTrend)}</span></div>
            <div class="rgauge-sub">${res.memUsedGB}/${res.memTotalGB} GB \u00B7 límite ${res.maxMem}%</div>
            <div class="rgauge-kpis">
              <span title="Promedio">avg <b>${memAvg}%</b></span>
              <span title="Pico reciente">peak <b>${memPeak}%</b></span>
              <span title="Espacio disponible">free <b>${memHeadroom}%</b></span>
            </div>
          </div>
        </div>
        <div class="rgauge-spark" title="Tendencia RAM últimos minutos">${sparklineSVG(memHist, memColor, { w: 220, h: 32, max: 100 })}</div>
      </div>
    </div>
    ${stale > 0 ? `<div class="resource-alert">\u26A0\uFE0F ${stale} issue${stale > 1 ? 's' : ''} con más de 30 min trabajando — posible huérfano: ${staleDetail}</div>` : ''}`;

  // Rechazos recientes
  let rechazosHTML = '';
  if (state.rechazos.length > 0) {
    rechazosHTML = state.rechazos.map(r => {
      const ts = fmtTime(r.ts);
      return `<div class="rechazo-row">✗ <a href="${GH(r.issue)}" target="_blank" class="issue-link">#${r.issue}</a> ${r.skill} en ${r.fase} — <span class="rechazo-motivo">${(r.motivo || '').slice(0, 80)}</span> <span class="ts">${ts}</span></div>`;
    }).join('');
  }

  // Actividad
  // --- Agent Team: agentes activos con personalidad ---
  const activeAgents = {};
  for (const [issueNum, data] of matrixEntries) {
    if (!data.faseActual) continue;
    const entries = data.fases[data.faseActual] || [];
    for (const e of entries) {
      if (e.estado === 'trabajando') {
        if (!activeAgents[e.skill]) activeAgents[e.skill] = [];
        const [pline, fse] = data.faseActual.split('/');
        activeAgents[e.skill].push({ issue: issueNum, pipeline: pline, fase: fse, skill: e.skill, duration: e.durationMs, hasLog: !!e.hasLog, logFile: e.logFile });
      }
    }
  }

  // Título corto del issue (desde issueMatrix si lo tiene)
  const issueTitle = (num) => {
    const d = state.issueMatrix[num];
    const t = d && d.titulo ? d.titulo : '';
    return t ? t.slice(0, 48) : '';
  };
  // Clasificar estado del agente por duración
  const agentHealth = (ms) => {
    const min = (ms || 0) / 60000;
    if (min > 30) return { cls: 'critical', label: '\u26A0 stale >30m' };
    if (min > 15) return { cls: 'warn',     label: '\u23F1 lento >15m' };
    if (min < 0.5) return { cls: 'fresh',   label: '\u2728 recién' };
    return { cls: 'active', label: '\u25CF activo' };
  };
  // Ordenar: stale primero, después más lentos, después recientes
  const sortedAgents = Object.entries(activeAgents).map(([skill, issues]) => {
    const maxDur = Math.max(...issues.map(i => i.duration || 0));
    return { skill, issues, maxDur };
  }).sort((a, b) => b.maxDur - a.maxDur);

  // Option B: Active Cards XL — cada agente activo es una card horizontal con work items (issue + fase + progreso)
  let agentTeamCards = '';
  let activeStripHTML = '';
  if (sortedAgents.length > 0) {
    const cards = sortedAgents.map(({ skill, issues }) => {
      const p = AGENT_PERSONA[skill] || { icon: '\u2699', name: skill, color: 'var(--dim)' };
      const count = issues.length;
      const badge = count > 1 ? `<span class="eq-card-badge">${count}</span>` : '';
      const workItems = issues.map(i => {
        const progressPct = Math.min(100, ((i.duration || 0) / (30 * 60 * 1000)) * 100);
        const href = i.hasLog && i.logFile
          ? `/logs/view/${i.logFile}?live=1`
          : GH(i.issue);
        const tip = i.hasLog ? `Ver log en vivo · ${i.skill} · #${i.issue}` : `Ver #${i.issue} en GitHub`;
        return `<a href="${href}" target="_blank" class="eq-work-item" title="${tip}">
          <span class="eq-work-issue">#${i.issue}${i.hasLog ? ' 📄' : ' ↗'}</span>
          <span class="eq-work-fase">${i.fase}</span>
          <span class="eq-work-dur">${fmtDuration(i.duration)}</span>
          <span class="eq-work-bar"><span class="eq-work-bar-fill" style="width:${progressPct.toFixed(0)}%"></span></span>
        </a>`;
      }).join('');
      const killGroupData = JSON.stringify(issues.map(i => ({ issue: i.issue, skill: i.skill, pipeline: i.pipeline, fase: i.fase }))).replace(/"/g, '&quot;');
      const subTxt = count > 1 ? ` \u00B7 <span class="eq-card-sub">${count} issues</span>` : '';
      return `<div class="eq-card">
        <span class="eq-card-avatar" style="background:${p.color}">${p.icon}${badge}</span>
        <div class="eq-card-body">
          <div class="eq-card-name"><span class="eq-card-ring"></span>${p.name}${subTxt}</div>
          <div class="eq-card-work">${workItems}</div>
        </div>
        <span class="eq-card-kill" title="Cancelar agentes ${p.name}" onclick="event.stopPropagation();killSkillGroup('${skill}',${killGroupData})">\u00D7</span>
      </div>`;
    }).join('');
    activeStripHTML = `<div class="eq-active-cards">${cards}</div>`;
  }

  // agentTeamCards se usa inline en la sección "Equipo y Skills"

  // --- Historial de ejecuciones de agentes ---
  const agentHistory = [];
  for (const [issueNum, data] of matrixEntries) {
    for (const [faseKey, faseEntries] of Object.entries(data.fases || {})) {
      for (const e of faseEntries) {
        // Incluir trabajando (en ejecución) + listo + procesado (finalizados)
        if (e.estado === 'trabajando' || e.estado === 'listo' || e.estado === 'procesado') {
          const [pline, fse] = faseKey.split('/');
          agentHistory.push({
            issue: issueNum,
            titulo: data.titulo || '',
            skill: e.skill,
            pipeline: pline,
            fase: fse,
            estado: e.estado,
            resultado: e.resultado || null,
            duration: e.durationMs || 0,
            startedAt: e.startedAt || 0,
            finishedAt: (e.estado !== 'trabajando') ? (e.updatedAt || 0) : 0,
            hasLog: !!e.hasLog,
            logFile: e.logFile,
            hasRejectionPdf: !!e.hasRejectionPdf,
            rejectionPdf: e.rejectionPdf,
          });
        }
      }
    }
  }
  // Ordenar: en ejecución primero, luego por timestamp desc
  agentHistory.sort((a, b) => {
    if (a.estado === 'trabajando' && b.estado !== 'trabajando') return -1;
    if (b.estado === 'trabajando' && a.estado !== 'trabajando') return 1;
    const tsA = a.estado === 'trabajando' ? a.startedAt : a.finishedAt;
    const tsB = b.estado === 'trabajando' ? b.startedAt : b.finishedAt;
    return tsB - tsA;
  });

  // Generar HTML del historial (máximo 30 entradas visibles, el resto en toggle)
  const HIST_VISIBLE = 15;
  let historyHTML = '';
  if (agentHistory.length > 0) {
    const renderHistCard = (h, idx) => {
      const p = AGENT_PERSONA[h.skill] || { icon: '\u2699', name: h.skill, color: 'var(--dim)' };
      const isRunning = h.estado === 'trabajando';
      const isOk = h.resultado === 'aprobado';
      const isFail = h.resultado === 'rechazado';
      const statusCls = isRunning ? 'ah-running' : isOk ? 'ah-ok' : isFail ? 'ah-fail' : 'ah-neutral';
      const statusIcon = isRunning ? '\u25CF' : isOk ? '\u2713' : isFail ? '\u2717' : '\u2014';
      const statusLabel = isRunning ? 'En ejecución' : (h.resultado || 'finalizado');
      const ts = isRunning ? h.startedAt : h.finishedAt;
      const timeStr = ts ? new Date(ts).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      const durStr = fmtDuration(h.duration);
      const href = h.hasLog ? `/logs/view/${h.logFile}${isRunning ? '?live=1' : ''}` : GH(h.issue);
      const tip = h.hasLog ? `Ver log · ${h.skill} · #${h.issue}` : `Ver #${h.issue} en GitHub`;
      const title = h.titulo ? ` · ${h.titulo.slice(0, 40)}` : '';
      const pdfLink = h.hasRejectionPdf
        ? ` <a class="ah-pdf" href="/logs/${h.rejectionPdf}" target="_blank" title="Reporte de rechazo" onclick="event.stopPropagation()">\u{1F4C4}</a>`
        : '';
      const prioActions = isRunning
        ? `<span class="ah-prio-actions">
            <button class="lc-prio-btn lc-prio-up" onclick="event.preventDefault();event.stopPropagation();issueMoveUp(${h.issue})" title="Subir una posición">▲</button>
            <button class="lc-prio-btn lc-prio-down" onclick="event.preventDefault();event.stopPropagation();issueMoveDown(${h.issue})" title="Bajar una posición">▼</button>
          </span>`
        : '';
      const ahPos = manualOrderIndex.has(String(h.issue)) ? manualOrderIndex.get(String(h.issue)) : null;
      const ahPosLabel = ahPos !== null ? `<span class="lc-pos" title="Posición en el orden manual (1 = más prioritario)">#${ahPos + 1}</span>` : '';
      return `<a href="${href}" target="_blank" class="ah-card ${statusCls}" title="${tip}">
        <span class="ah-avatar" style="background:${p.color}">${p.icon}</span>
        <span class="ah-skill">${p.name}</span>
        ${ahPosLabel}
        <span class="ah-issue">#${h.issue}${title}</span>
        <span class="ah-fase">${h.fase}</span>
        <span class="ah-status">${statusIcon} ${statusLabel}</span>
        <span class="ah-dur">${durStr}</span>
        <span class="ah-time">${timeStr}</span>
        ${prioActions}
        ${pdfLink}
      </a>`;
    };

    const visible = agentHistory.slice(0, HIST_VISIBLE).map(renderHistCard).join('');
    const hidden = agentHistory.length > HIST_VISIBLE
      ? agentHistory.slice(HIST_VISIBLE, 50).map(renderHistCard).join('')
      : '';
    const moreToggle = hidden
      ? `<details class="ah-more"><summary class="ah-more-btn">Ver ${Math.min(agentHistory.length - HIST_VISIBLE, 35)} más…</summary><div class="ah-more-list">${hidden}</div></details>`
      : '';

    historyHTML = `
    <div class="matrix-section" id="agent-history">
      <div class="matrix-header">
        <h2>\u{1F4DC} Historial de Ejecuciones</h2>
        <span class="ah-count">${agentHistory.length} ejecuciones</span>
      </div>
      <div class="ah-list">
        ${visible}
        ${moreToggle}
      </div>
    </div>`;
  }

  // --- Mini DORA metrics on main dashboard ---
  let doraMinHTML = '';
  try {
    const metricsData = getMetricsData();
    const { entregas: doraEntregas, totalProcessed: doraTP, totalRejected: doraRej, etaAverages: doraEta } = metricsData;
    const doraDelivered7d = doraEntregas.filter(e => Date.now() - e.ts < 7 * 86400000).length;
    const doraThroughput = (doraDelivered7d / 7).toFixed(1);
    const doraFailRate = doraTP > 0 ? Math.round(doraRej / doraTP * 100) : 0;
    // Lead time: promedio de duración completa de issues entregados en los últimos 7 días
    const recentDeliveries = doraEntregas.filter(e => Date.now() - e.ts < 7 * 86400000);
    let doraLeadTime = 0;
    if (recentDeliveries.length > 0) {
      // Estimar lead time sumando promedios de fases
      let totalAvg = 0;
      for (const [key, data] of Object.entries(doraEta)) {
        if (!key.includes('/') && data.avgMs) totalAvg += data.avgMs;
      }
      doraLeadTime = totalAvg;
    }

    const ltColor = doraLeadTime > 0 && doraLeadTime < 6 * 3600000 ? 'var(--gn)' : doraLeadTime > 0 ? 'var(--yl)' : 'var(--dim)';
    const tpColor = parseFloat(doraThroughput) >= 2 ? 'var(--gn)' : parseFloat(doraThroughput) > 0 ? 'var(--yl)' : 'var(--dim)';
    const frColor = doraFailRate <= 15 ? 'var(--gn)' : doraFailRate <= 30 ? 'var(--yl)' : 'var(--rd)';

    doraMinHTML = `
    <div class="dora-mini">
      <div class="matrix-header">
        <h2>📐 DORA Metrics <span style="font-size:0.7em;color:var(--dim);text-transform:none;letter-spacing:0">(rolling 7d · Nicole Forsgren)</span></h2>
        <a href="/metrics#dora" class="matrix-count" style="text-decoration:none">Ver detalle →</a>
      </div>
      <div class="dora-mini-grid">
        <div class="dora-mini-card">
          <div class="dora-mini-value" style="color:${ltColor}">${doraLeadTime > 0 ? fmtDuration(doraLeadTime) : '—'}</div>
          <div class="dora-mini-label">Lead Time</div>
          <div class="dora-mini-target">target &lt; 6h</div>
        </div>
        <div class="dora-mini-card">
          <div class="dora-mini-value" style="color:${tpColor}">${doraThroughput}/d</div>
          <div class="dora-mini-label">Throughput</div>
          <div class="dora-mini-target">target &gt; 2/día</div>
        </div>
        <div class="dora-mini-card">
          <div class="dora-mini-value" style="color:${frColor}">${doraFailRate}%</div>
          <div class="dora-mini-label">Failure Rate</div>
          <div class="dora-mini-target">target &lt; 15%</div>
        </div>
        <div class="dora-mini-card">
          <div class="dora-mini-value" style="color:var(--ac)">${doraDelivered7d}</div>
          <div class="dora-mini-label">Entregas 7d</div>
          <div class="dora-mini-target">${recentDeliveries.length > 0 ? Math.round(doraDelivered7d / 7 * 30) + '/mes proyectado' : 'sin datos'}</div>
        </div>
      </div>
    </div>`;
  } catch {}

  let actHTML = state.actividad.slice(-15).reverse().map(a => {
    const ts = a.ts ? a.ts.slice(11, 19) : '??';
    const dir = a.dir === 'in' ? '→' : '←';
    const cls = a.dir === 'in' ? 'msg-in' : 'msg-out';
    const text = (a.text || '').replace(/</g, '&lt;');
    return `<div class="act-row ${cls}"><span class="ts">${ts}</span> ${dir} ${a.from ? '['+a.from+']' : ''} ${text}</div>`;
  }).join('') || '<div class="empty-label">Sin actividad</div>';

  return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pipeline V2 — Intrale</title>
<style>
/* ── Variables ──────────────────────────────────────────────────────────── */
:root{
  --bg:#0d1117;--sf:#161b22;--sf2:#1c2128;--bd:#30363d;--bd2:#21262d;
  --tx:#e6edf3;--dim:#8b949e;--dim2:#6e7681;
  --ac:#58a6ff;--ac2:#1f6feb;
  --gn:#3fb950;--gn2:#196c2e;
  --yl:#d29922;--yl2:#9e6a03;
  --rd:#f85149;--rd2:#8b1a14;
  --or:#db6d28;--or2:#7d3410;
  --pu:#bc8cff;
  /* #2337 CA8 — ambar dorado para estado reintentando.
   * Diferenciado del amarillo --yl (stale). Contraste >=5.2:1 sobre --sf
   * (ver analisis guru/UX). Seguro en protanopia/deuteranopia con emoji
   * flechas circulares como discriminador de forma. */
  --retry:#F59E0B;
  --radius:10px;--radius-sm:6px;
}
/* ── Reset ──────────────────────────────────────────────────────────────── */
*{margin:0;padding:0;box-sizing:border-box}
body{
  background:var(--bg);color:var(--tx);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  padding:20px 24px;font-size:15px;line-height:1.5;
}
a{color:var(--ac);text-decoration:none}a:hover{text-decoration:underline}

/* ── Header ─────────────────────────────────────────────────────────────── */
h1{
  color:var(--tx);font-size:1.5em;font-weight:700;
  margin-bottom:20px;display:flex;align-items:center;gap:10px;
  border-bottom:1px solid var(--bd);padding-bottom:14px;
}
h1 .subtitle{color:var(--dim);font-size:0.6em;font-weight:400;letter-spacing:1px}
.hdr-bar{display:flex;align-items:center;justify-content:space-between;padding:10px 0 8px;margin-bottom:0}
.hdr-left{display:flex;align-items:center;gap:12px}
.hdr-title{margin:0;font-size:1.3em;font-weight:700;white-space:nowrap;border-bottom:none;padding-bottom:0}
.hdr-status-badge{font-size:0.7em;font-weight:700;letter-spacing:1.5px;padding:3px 12px;border-radius:20px;cursor:pointer;border:none;transition:all 0.2s;text-transform:uppercase}
.badge-running{background:rgba(63,185,80,0.15);color:var(--gn);border:1px solid rgba(63,185,80,0.4)}
.badge-running:hover{background:rgba(63,185,80,0.25)}
.badge-paused{background:rgba(240,165,0,0.2);color:#f0a500;border:1px solid rgba(240,165,0,0.5);animation:pausePulse 2s infinite}
@keyframes pausePulse{0%,100%{opacity:1}50%{opacity:0.6}}
.badge-autorefresh{font-size:0.7em;font-weight:700;letter-spacing:1px;padding:3px 12px;border-radius:20px;cursor:pointer;border:1px solid var(--bd);transition:all 0.2s;background:var(--sf);color:var(--dim)}
.badge-autorefresh.ar-on{background:rgba(88,166,255,0.15);color:var(--ac);border-color:rgba(88,166,255,0.4)}
.badge-autorefresh.ar-on:hover{background:rgba(88,166,255,0.25)}
.badge-autorefresh.ar-off{background:var(--sf);color:var(--dim);border-color:var(--bd)}
.badge-autorefresh.ar-off:hover{background:rgba(255,255,255,0.05)}
.hdr-meta{font-size:0.75em;color:var(--dim);white-space:nowrap}
.hdr-meta-sep{color:var(--bd);margin:0 2px}
.hdr-uptime{font-size:0.75em;color:var(--dim);font-weight:500;cursor:help;padding:2px 8px;background:var(--sf);border-radius:10px;border:1px solid var(--bd)}
.hdr-v3-badge{font-size:0.7em;font-weight:700;letter-spacing:1.2px;padding:3px 10px;border-radius:20px;background:linear-gradient(90deg,rgba(45,212,191,0.18),rgba(88,166,255,0.18));color:var(--teal,#2dd4bf);border:1px solid rgba(45,212,191,0.45);text-transform:uppercase;cursor:help}
.hdr-right{display:flex;flex-direction:column;align-items:flex-end;line-height:1}
.hdr-clock{font-size:1.6em;font-weight:700;font-family:'SF Mono',Consolas,monospace;color:var(--tx);letter-spacing:2px;font-variant-numeric:tabular-nums}
.hdr-clock .clock-sec{font-size:0.55em;color:var(--dim);vertical-align:super;margin-left:1px}
.hdr-date{font-size:0.75em;color:var(--dim);margin-top:2px;letter-spacing:0.5px}
.hdr-status-line{display:none}
.health-dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-left:6px}
.health-active{background:var(--gn);box-shadow:0 0 8px var(--gn);animation:healthPulse 2s infinite}
.health-warn{background:var(--yl);box-shadow:0 0 8px var(--yl);animation:healthPulse 1s infinite}
.health-idle{background:var(--dim2)}
@keyframes healthPulse{0%,100%{opacity:1}50%{opacity:0.4}}
h2{color:var(--dim);font-size:0.8em;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px;font-weight:600}

/* ── Alert ──────────────────────────────────────────────────────────────── */
.alert{
  background:rgba(248,81,73,0.12);border:1px solid rgba(248,81,73,0.4);
  border-left:4px solid var(--rd);border-radius:var(--radius-sm);
  padding:12px 16px;margin-bottom:20px;color:var(--rd);font-size:0.95em;
  display:flex;align-items:center;gap:10px;
}

/* ── Salud de Infra (issue #2306) ───────────────────────────────────────── */
.infra-health{
  background:var(--sf);border:1px solid var(--bd);
  border-left:4px solid var(--bd);border-radius:var(--radius);
  padding:12px 16px;margin-bottom:16px;
  transition:border-color 250ms ease,background 250ms ease,box-shadow 250ms ease;
}
.infra-health.infra-ok{
  border-left-color:var(--gn);
  background:linear-gradient(90deg,color-mix(in srgb,var(--gn) 6%,var(--sf)) 0%,var(--sf) 120px);
}
.infra-health.infra-warn{
  border-left-color:var(--yl);
  background:linear-gradient(90deg,color-mix(in srgb,var(--yl) 9%,var(--sf)) 0%,var(--sf) 120px);
}
.infra-health.infra-alert{
  border-left:4px solid var(--rd);
  border-color:color-mix(in srgb,var(--rd) 45%,var(--bd));
  background:linear-gradient(90deg,color-mix(in srgb,var(--rd) 12%,var(--sf)) 0%,var(--sf) 180px);
  box-shadow:0 0 0 1px color-mix(in srgb,var(--rd) 20%,transparent);
}
.infra-health.infra-stale,.infra-health.infra-init{
  border-left-color:var(--dim2);
  background:var(--sf);
}
.ih-head{
  display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  cursor:pointer;user-select:none;
}
.ih-head:hover{opacity:0.9}
.ih-chevron{
  margin-left:auto;font-size:0.7em;color:var(--dim);
  transition:transform 0.18s ease;display:inline-block;
}
.infra-health.ih-collapsed .ih-chevron{transform:rotate(-90deg)}
.infra-health.ih-collapsed .ih-body{display:none}
.ih-emoji{font-size:1.15em;line-height:1}
.ih-title{
  font-size:0.82em;color:var(--dim);font-weight:700;
  text-transform:uppercase;letter-spacing:1.5px;
}
.ih-status{
  font-size:0.72em;font-weight:700;letter-spacing:1.5px;
  padding:2px 10px;border-radius:20px;text-transform:uppercase;
}
.ih-status-ok{background:rgba(63,185,80,0.15);color:var(--gn);border:1px solid rgba(63,185,80,0.4)}
.ih-status-warn{background:rgba(210,153,34,0.15);color:var(--yl);border:1px solid rgba(210,153,34,0.4)}
.ih-status-alert{background:rgba(248,81,73,0.18);color:var(--rd);border:1px solid rgba(248,81,73,0.5)}
.ih-status-stale,.ih-status-init{background:rgba(139,148,158,0.12);color:var(--dim);border:1px solid rgba(139,148,158,0.3)}
.ih-ts{margin-left:auto;font-size:0.72em;color:var(--dim);cursor:help;font-variant-numeric:tabular-nums}
.ih-rows{
  display:flex;flex-direction:column;gap:6px;
  margin-top:10px;
}
.ih-row{
  display:grid;grid-template-columns:22px 180px 1fr;gap:10px;
  align-items:center;padding:6px 0;
  border-top:1px solid var(--bd2);
  font-size:0.9em;
}
.ih-row:first-child{border-top:none;padding-top:0}
.ih-row-emoji{font-size:0.95em;line-height:1;text-align:center}
.ih-row-lbl{color:var(--dim);font-size:0.82em;font-weight:600;text-transform:uppercase;letter-spacing:0.5px}
.ih-row-val{color:var(--tx);font-variant-numeric:tabular-nums}
.ih-row-val a{color:var(--ac)}
.ih-row-val a:hover{text-decoration:underline}
.ih-row-cb .ih-row-val{font-weight:700}
.infra-alert .ih-row-cb .ih-row-val{color:var(--rd)}
.ih-cb-body{
  grid-column:1/-1;
  margin:4px 0 2px;padding:10px 12px;
  background:rgba(248,81,73,0.08);
  border:1px solid rgba(248,81,73,0.25);
  border-radius:var(--radius-sm);
}
.ih-cb-line{font-size:0.88em;color:var(--tx);margin:2px 0}
.ih-cb-ult{color:var(--tx)}
.ih-cb-cta{
  margin-top:6px;font-size:0.88em;color:var(--dim);
  display:flex;align-items:center;gap:6px;flex-wrap:wrap;
}
.ih-cb-cta code{
  background:var(--bg);border:1px solid var(--bd);border-radius:4px;
  padding:2px 8px;font-family:'SF Mono',Consolas,monospace;color:var(--yl);
  font-size:0.92em;
}
.ih-copy{
  background:var(--bg);border:1px solid var(--bd);border-radius:4px;
  color:var(--dim);cursor:pointer;padding:2px 6px;
  font-size:0.95em;line-height:1;transition:all 150ms ease;
}
.ih-copy:hover{border-color:var(--ac);color:var(--ac);background:rgba(88,166,255,0.1)}
.ih-copy:focus-visible{outline:2px solid var(--ac);outline-offset:2px}
.ih-copy.ih-copy-ok{border-color:var(--gn);color:var(--gn);background:rgba(63,185,80,0.12)}
.ih-trunc{color:var(--dim);margin-left:2px}
@media (max-width:480px){
  .ih-row{grid-template-columns:22px 1fr;gap:6px}
  .ih-row-lbl{grid-column:1/-1;padding-left:32px}
  .ih-row-val{grid-column:1/-1;padding-left:32px}
  .ih-ts{display:none}
}
@media (prefers-reduced-motion:reduce){
  .infra-health{transition:none}
  .infra-health.infra-alert{box-shadow:0 0 0 2px var(--rd)}
  .ih-copy{transition:none}
}

/* ── KPI Grid ───────────────────────────────────────────────────────────── */
.kpis-row{
  display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;
  margin-bottom:20px;align-items:stretch;
}
.kpis{
  display:grid;
  grid-template-columns:repeat(6,1fr);
  gap:10px;margin-bottom:20px;
}
.kpis.kpis-5{
  grid-template-columns:repeat(5,minmax(0,1fr));
  gap:8px;margin-bottom:0;padding:6px;
  background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);
}
.kpis.kpis-6{
  grid-template-columns:repeat(6,minmax(0,1fr));
  gap:8px;margin-bottom:0;padding:6px;
  background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);
}
.kpis.kpis-5 .kpi,.kpis.kpis-6 .kpi{padding:10px 12px;min-width:0}
.kpis.kpis-5 .kpi-value,.kpis.kpis-6 .kpi-value{font-size:1.7em}
.kpis.kpis-5 .kpi-label,.kpis.kpis-6 .kpi-label{margin-bottom:4px;font-size:0.64em}
.kpi.kpi-needs-human{--kpi-accent:#B60205}
.kpi.kpi-needs-human.has-blocked{
  background:linear-gradient(135deg,rgba(182,2,5,0.18),rgba(182,2,5,0.04));
  border-color:rgba(182,2,5,0.55);
}
.kpi-trend{
  font-size:0.62em;color:var(--dim);margin-top:3px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;
  text-transform:none;letter-spacing:0;font-weight:400;
}
.kpi{
  background:linear-gradient(135deg,color-mix(in srgb,var(--kpi-accent,var(--ac)) 10%,var(--sf)) 0%,var(--sf) 60%);
  border:1px solid var(--bd);
  border-left:3px solid var(--kpi-accent,var(--ac));
  border-radius:var(--radius);
  padding:14px 16px;display:flex;flex-direction:column;align-items:flex-start;
  gap:0;position:relative;overflow:hidden;
  transition:border-color 0.2s,box-shadow 0.2s;
}
.kpi:hover{border-color:var(--kpi-accent,var(--ac));box-shadow:0 4px 14px rgba(0,0,0,0.3)}
.kpi::before{content:none}
.kpi-icon{
  position:absolute;top:12px;right:12px;
  font-size:1.1em;line-height:1;opacity:0.35;
}
.kpi-label{
  font-size:0.68em;color:var(--dim);font-weight:700;
  text-transform:uppercase;letter-spacing:1px;line-height:1;
  margin-bottom:8px;
}
.kpi-value{
  font-size:2.1em;font-weight:800;color:var(--kpi-accent,var(--ac));
  font-variant-numeric:tabular-nums;line-height:1;
}

/* ── Mini Sistema Card (junto a KPIs) ───────────────────────────────────── */
.sys-mini-card{
  display:flex;align-items:center;gap:14px;
  background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);
  padding:8px 16px;
}
.sys-mini-card.sys-mini-ok{border-color:color-mix(in srgb,var(--gn) 35%,var(--bd))}
.sys-mini-card.sys-mini-warn{border-color:color-mix(in srgb,var(--yl) 40%,var(--bd))}
.sys-mini-card.sys-mini-crit{border-color:color-mix(in srgb,var(--rd) 50%,var(--bd));animation:pulse 1.8s infinite}
.sys-mini-score{
  display:flex;flex-direction:column;align-items:center;gap:2px;
  padding-right:12px;border-right:1px solid var(--bd);min-width:68px;
}
.sys-mini-lbl{font-size:0.6em;color:var(--dim);text-transform:uppercase;letter-spacing:0.8px;font-weight:700}
.sys-mini-val{font-size:1.6em;font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
.sys-mini-val.sys-mini-ok{color:var(--gn)}
.sys-mini-val.sys-mini-warn{color:var(--yl)}
.sys-mini-val.sys-mini-crit{color:var(--rd)}
.sys-mini-tag{font-size:0.58em;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;line-height:1}
.sys-mini-tag.sys-mini-ok{color:var(--gn)}
.sys-mini-tag.sys-mini-warn{color:var(--yl)}
.sys-mini-tag.sys-mini-crit{color:var(--rd)}
.sys-mini-gauge{
  position:relative;width:62px;height:62px;flex-shrink:0;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
}
.sys-mini-svg{position:absolute;top:0;left:0;width:62px;height:62px;transform:rotate(-90deg)}
.sys-mini-track{fill:none;stroke:rgba(255,255,255,0.07);stroke-width:6}
.sys-mini-fill{fill:none;stroke-width:6;stroke-linecap:round;transition:stroke-dashoffset 0.4s}
.sys-mini-fill.sys-mini-ok{stroke:var(--gn)}
.sys-mini-fill.sys-mini-warn{stroke:var(--yl)}
.sys-mini-fill.sys-mini-danger{stroke:var(--rd)}
.sys-mini-center{text-align:center;line-height:1;position:relative;z-index:1}
.sys-mini-center .v{font-size:0.82em;font-weight:800;color:var(--tx);font-variant-numeric:tabular-nums}
.sys-mini-center .l{font-size:0.58em;color:var(--dim);text-transform:uppercase;letter-spacing:0.4px;margin-top:1px}

.kpi-value.warn{color:var(--yl);--kpi-accent:var(--yl)}
.kpi-value.danger{color:var(--rd);--kpi-accent:var(--rd)}
.kpi-value.success{color:var(--gn);--kpi-accent:var(--gn)}
.kpi-value.muted{color:var(--dim2)}

/* ── KPI accent colors per type ─────────────────────────────────────────── */
.kpi.kpi-activos{--kpi-accent:var(--ac)}
.kpi.kpi-working{--kpi-accent:var(--yl)}
.kpi.kpi-pendientes{--kpi-accent:var(--or)}
.kpi.kpi-blocked{--kpi-accent:var(--rd)}
.kpi.kpi-definidos{--kpi-accent:var(--pu)}
.kpi.kpi-entregados{--kpi-accent:var(--gn)}
.kpi.kpi-throughput{--kpi-accent:var(--ac)}

/* ── Separador de pipeline KPIs ─────────────────────────────────────────── */
.kpi-divider{
  grid-column:1/-1;height:1px;background:var(--bd);
  margin:2px 0;
}

/* ── Matrix Section ─────────────────────────────────────────────────────── */
.matrix-section{
  background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);
  padding:18px 20px;margin-bottom:20px;
}

/* ── Needs-Human Panel (#2549) — alta visibilidad ───────────────────────── */
.matrix-section.needs-human-panel{
  background:linear-gradient(135deg,rgba(182,2,5,0.18),rgba(182,2,5,0.06));
  border:2px solid #B60205;border-left:6px solid #B60205;
  box-shadow:0 0 0 1px rgba(182,2,5,0.25),0 4px 18px rgba(182,2,5,0.18);
  padding:14px 18px;margin-bottom:18px;border-radius:8px;
}
.needs-human-pulse{
  display:inline-block;animation:needs-human-pulse 1.6s ease-in-out infinite;
  margin-right:6px;
}
@keyframes needs-human-pulse{
  0%,100%{transform:scale(1);opacity:1}
  50%{transform:scale(1.18);opacity:0.7}
}
.needs-human-badge{
  display:inline-block;background:#B60205;color:#fff;font-weight:700;
  font-size:0.62em;padding:2px 10px;border-radius:14px;
  margin-left:8px;vertical-align:middle;letter-spacing:0.4px;
}
.needs-human-row{
  background:rgba(0,0,0,0.18);border-radius:5px;
  padding:8px 10px;font-size:0.92em;
  border-left:3px solid rgba(182,2,5,0.7);
}
.needs-human-reason{
  margin:4px 0 0 14px;color:#FFB3B3;font-size:0.92em;line-height:1.35;
}
.needs-human-age-fresh{color:var(--yl)}
.needs-human-age-old{color:#FF6B6B;font-weight:700}
.needs-human-header{
  margin:0 0 8px 0;color:#fff;cursor:pointer;user-select:none;
  display:flex;align-items:center;gap:6px;
}
.needs-human-header:hover{opacity:0.85}
.needs-human-chevron{
  margin-left:auto;font-size:0.7em;color:var(--dim);
  transition:transform 0.18s ease;display:inline-block;
}
.needs-human-panel.nh-collapsed .needs-human-chevron{transform:rotate(-90deg)}
.needs-human-panel.nh-collapsed .needs-human-body{display:none}
.needs-human-panel.nh-collapsed .needs-human-header{margin-bottom:0}
.needs-human-row-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.needs-human-row-info{flex:1 1 auto;min-width:200px}
.needs-human-row-actions{display:flex;gap:6px;flex:0 0 auto}
.nh-btn{
  background:var(--card,#1a1f2e);color:var(--fg,#e0e6ed);
  border:1px solid var(--bd,#2a3560);padding:4px 10px;border-radius:4px;
  cursor:pointer;font-size:0.78em;font-family:inherit;white-space:nowrap;
}
.nh-btn:hover{background:rgba(255,255,255,0.06)}
.nh-btn:disabled{opacity:0.5;cursor:wait}
.nh-btn-reactivate{border-color:#3fb950;color:#3fb950}
.nh-btn-reactivate:hover{background:rgba(63,185,80,0.12)}
.nh-btn-dismiss{border-color:#f85149;color:#f85149}
.nh-btn-dismiss:hover{background:rgba(248,81,73,0.12)}
.matrix-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:12px;flex-wrap:wrap}
.matrix-count{
  font-size:0.8em;color:var(--dim);font-weight:400;
  background:var(--bg);border:1px solid var(--bd);border-radius:20px;
  padding:2px 10px;
}
/* ── Issue Tracker: Tabs ────────────────────────────────────────────────── */
.ic-tabs{display:flex;gap:4px}
.ic-tab{
  background:var(--bg);border:1px solid var(--bd);border-radius:6px;
  padding:4px 14px;color:var(--dim);font-size:0.82em;cursor:pointer;
  font-weight:500;transition:all 0.15s;display:inline-flex;align-items:center;gap:5px;
}
.ic-tab:hover{background:var(--sf2);color:var(--tx)}
.ic-tab-active{background:var(--ac2);color:var(--tx);border-color:var(--ac);font-weight:600}
.ic-tab-count{
  font-size:0.85em;background:rgba(255,255,255,0.1);border-radius:10px;
  padding:0 6px;min-width:18px;text-align:center;font-weight:700;
}

/* ── Issue Tracker: Card list ──────────────────────────────────────────── */
.ic-list{display:flex;flex-direction:column;gap:6px}

/* ── Issue Card ────────────────────────────────────────────────────────── */
.ic-card{
  background:var(--bg);border:1px solid var(--bd2);border-radius:8px;
  overflow:hidden;transition:border-color 0.2s,opacity 0.3s;
}
.ic-card:hover{border-color:var(--bd)}
.ic-card.ic-completed{opacity:0.45}
.ic-card.ic-completed:hover{opacity:0.75}
.ic-card.ic-blocked{border-left:3px solid var(--rd);background:rgba(248,81,73,0.04)}
.ic-card.ic-working{border-left:3px solid var(--ac)}
.ic-card.ic-stale{border-left:3px solid var(--yl);background:rgba(210,153,34,0.04)}
.ic-card.ic-dead{border-left:3px solid var(--rd);background:rgba(248,81,73,0.06);animation:deadPulse 3s infinite}
@keyframes deadPulse{0%,100%{opacity:1}50%{opacity:0.85}}

/* ── Card header (clickable, grid layout for alignment) ──────────────── */
.ic-header{
  display:grid;
  grid-template-columns:minmax(200px,420px) 1fr minmax(240px,340px) auto;
  align-items:center;gap:8px;
  padding:10px 14px;cursor:pointer;transition:background 0.1s;
  min-height:42px;
}
.ic-header:hover{background:rgba(255,255,255,0.02)}

/* ── Left section (issue + badges + title) ──────────────────────────── */
.ic-left{
  display:flex;align-items:center;gap:6px;
  overflow:hidden;min-width:0;
}
.ic-issue-link{
  color:var(--ac);font-weight:700;font-size:1.05em;
  text-decoration:none;white-space:nowrap;flex-shrink:0;
}
.ic-issue-link:hover{text-decoration:underline}

/* ── Title ──────────────────────────────────────────────────────────── */
.ic-title{
  font-size:0.82em;color:var(--dim);font-weight:400;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  min-width:0;flex:1;
}

/* ── Bounce badge ───────────────────────────────────────────────────── */
.ic-bounce{
  font-size:0.75em;font-weight:700;color:var(--yl);
  background:rgba(210,153,34,0.12);border:1px solid rgba(210,153,34,0.3);
  border-radius:10px;padding:1px 7px;flex-shrink:0;
}
.ic-bounce-warn{color:var(--rd);background:rgba(248,81,73,0.12);border-color:rgba(248,81,73,0.3)}

/* ── Stale badge ────────────────────────────────────────────────────── */
.ic-stale-badge{
  font-size:0.72em;font-weight:600;padding:1px 6px;border-radius:8px;flex-shrink:0;
}
.ic-stale-warn{color:var(--yl);background:rgba(210,153,34,0.1)}
.ic-stale-dead{color:var(--rd);background:rgba(248,81,73,0.1);animation:pulse 2s infinite}

/* ── QA label badge ─────────────────────────────────────────────────── */
.ic-qa-badge{font-size:0.7em;font-weight:600;padding:1px 7px;border-radius:8px;flex-shrink:0}
.ic-qa-passed{color:var(--gn);background:rgba(63,185,80,0.12);border:1px solid rgba(63,185,80,0.25)}
.ic-qa-skipped{color:var(--dim);background:rgba(139,148,158,0.1);border:1px solid rgba(139,148,158,0.2)}
.ic-qa-pending{color:var(--yl);background:rgba(210,153,34,0.1);border:1px solid rgba(210,153,34,0.25)}
.ic-qa-failed{color:var(--rd);background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.25)}

/* ── Affordance (hover ya en .ic-header arriba) ────────────────────── */

/* ── Pipeline Stepper (compact dots) ──────────────────────────────────── */
.ic-stepper{
  display:flex;align-items:center;gap:0;
  flex-shrink:0;margin:0 4px;
}
.stepper-dot{
  width:18px;height:18px;border-radius:50%;
  display:inline-flex;align-items:center;justify-content:center;
  font-size:0.65em;font-weight:700;cursor:default;
  border:2px solid var(--bd);background:var(--bg);
  transition:all 0.2s;flex-shrink:0;
}
.stepper-conn{
  width:8px;height:2px;background:var(--bd2);flex-shrink:0;
}
.stepper-conn-sep{
  background:var(--or);width:10px;height:2px;
  box-shadow:0 0 4px rgba(210,153,34,0.3);
}
.dot-empty{color:var(--dim2);border-color:var(--bd2)}
.dot-pending{color:var(--dim);border-color:var(--bd);background:rgba(139,148,158,0.08)}
.dot-working{
  color:var(--ac);border-color:var(--ac);
  background:rgba(88,166,255,0.15);
  animation:pulseBlue 2s infinite;
  box-shadow:0 0 6px rgba(88,166,255,0.3);
}
.dot-done{color:var(--gn);border-color:var(--gn);background:rgba(63,185,80,0.15)}
.dot-rejected{color:var(--rd);border-color:var(--rd);background:rgba(248,81,73,0.12)}
.dot-current{transform:scale(1.2);z-index:1}

/* ── Card meta (phase + pct + eta) ────────────────────────────────────── */
.ic-meta{
  display:flex;align-items:center;gap:8px;
  justify-content:flex-end;white-space:nowrap;
}
.ic-phase-label{
  font-size:0.78em;color:var(--dim);font-weight:500;
  background:rgba(139,148,158,0.08);border-radius:4px;padding:2px 8px;
  max-width:180px;overflow:hidden;text-overflow:ellipsis;
}
.ic-phase-done{color:var(--gn);background:rgba(63,185,80,0.1)}
.ic-pct{
  font-size:0.85em;font-weight:700;color:var(--dim);
  font-variant-numeric:tabular-nums;min-width:32px;text-align:right;
}
.ic-pct-done{color:var(--gn)}
.ic-eta{font-size:0.78em;color:var(--dim);font-weight:500}
.ic-done-time{color:var(--gn)}
.ic-expand-btn{
  font-size:0.85em;color:var(--dim);transition:transform 0.2s;flex-shrink:0;
  width:20px;text-align:center;
}
.ic-expand-btn.expanded{transform:rotate(180deg)}

/* ── Progress track (thin bar under header) ──────────────────────────── */
.ic-progress-track{
  height:3px;background:var(--bd2);
}
.ic-progress-fill{
  height:100%;background:var(--gn);border-radius:0 2px 2px 0;
  transition:width 0.4s;
}
.ic-progress-active{
  background:linear-gradient(90deg,var(--gn),var(--ac));
  animation:progressPulse 2s infinite;
}
@keyframes progressPulse{0%,100%{opacity:1}50%{opacity:0.6}}

/* ── Expanded detail panel ────────────────────────────────────────────── */
.ic-detail{
  display:none;padding:0 14px 14px;
  border-top:1px solid var(--bd2);
  animation:slideDown 0.2s ease-out;
}
.ic-detail.open{display:block}
@keyframes slideDown{from{opacity:0;max-height:0}to{opacity:1;max-height:500px}}

.pd-grid{
  display:grid;grid-template-columns:1fr 2fr;gap:12px;
  margin-top:10px;
}
@media(max-width:700px){.pd-grid{grid-template-columns:1fr}}

.pd-pipeline-label{
  font-size:0.72em;font-weight:700;text-transform:uppercase;
  letter-spacing:2px;padding:4px 0 6px;
}
.pd-def-label{color:var(--or)}
.pd-dev-label{color:var(--ac)}

.pd-phase{
  display:flex;align-items:flex-start;gap:8px;
  padding:5px 8px;border-radius:4px;margin-bottom:2px;
}
.pd-phase:hover{background:rgba(255,255,255,0.02)}
.pd-current{background:rgba(88,166,255,0.07);border-left:3px solid var(--ac)}
.pd-completed{opacity:0.5}
.pd-name{
  font-size:0.82em;font-weight:600;color:var(--dim);
  min-width:80px;flex-shrink:0;padding-top:3px;
}
.pd-empty{color:var(--bd);font-size:0.85em}
.pd-chips{display:flex;flex-wrap:wrap;gap:4px}

/* ── Block icons (shared) ──────────────────────────────────────────────── */
.block-icon{position:relative;margin-left:2px;cursor:help;font-size:0.8em;flex-shrink:0}
.block-icon .block-tt{display:none;position:absolute;left:0;top:calc(100% + 6px);background:var(--sf);color:var(--fg);padding:6px 10px;border-radius:6px;font-size:0.82em;white-space:normal;max-width:320px;z-index:100;border:1px solid var(--bd);box-shadow:0 4px 12px rgba(0,0,0,0.4);pointer-events:none;line-height:1.4}
.block-icon:hover .block-tt{display:block}

/* ── Chips ──────────────────────────────────────────────────────────────── */
.chip{
  position:relative;cursor:default;
  padding:4px 10px;border-radius:5px;font-size:0.95em;
  display:inline-flex;align-items:center;gap:5px;
  border:1px solid transparent;font-family:inherit;
  font-weight:500;
}
.st-working{
  color:var(--ac);background:rgba(88,166,255,0.12);border-color:rgba(88,166,255,0.3);
  font-weight:600;animation:pulseBlue 2s infinite;
}
.st-done{color:var(--gn);background:rgba(63,185,80,0.1);border-color:rgba(63,185,80,0.25)}
.st-processed{color:var(--gn);opacity:0.55}
.st-pending{color:var(--dim);background:rgba(139,148,158,0.08);border-color:rgba(139,148,158,0.2)}
.st-rejected{color:var(--rd);background:rgba(248,81,73,0.1);border-color:rgba(248,81,73,0.3);opacity:0.7}
.retry-badge{
  font-size:0.7em;font-weight:700;color:var(--yl);
  margin-left:2px;vertical-align:super;line-height:1;
  opacity:0.85;
}
.phase-done{color:var(--gn);opacity:0.4;font-size:1.1em;cursor:default}
.stale-chip{
  color:var(--ac)!important;background:rgba(88,166,255,0.15)!important;
  border-color:rgba(88,166,255,0.5)!important;animation:pulseBlue 1.8s infinite;
}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
@keyframes pulseBlue{0%,100%{opacity:1;box-shadow:0 0 4px rgba(88,166,255,0.3)}50%{opacity:0.5;box-shadow:none}}
.log-link{text-decoration:none}
.log-link:hover .chip{text-decoration:underline;filter:brightness(1.15)}

/* ── Log Viewer Panel ──────────────────────────────────────────────────── */
.log-overlay{
  display:none;position:fixed;top:0;right:0;bottom:0;left:0;z-index:500;
  background:rgba(0,0,0,0.5);backdrop-filter:blur(2px);
}
.log-overlay.open{display:block}
.log-panel{
  position:fixed;top:0;right:0;bottom:0;width:55%;min-width:480px;max-width:900px;
  background:var(--bg);border-left:2px solid var(--bd);z-index:501;
  display:flex;flex-direction:column;
  transform:translateX(100%);transition:transform 0.25s ease-out;
  box-shadow:-8px 0 32px rgba(0,0,0,0.6);
}
.log-overlay.open .log-panel{transform:translateX(0)}

.log-header{
  display:flex;align-items:center;gap:10px;
  padding:12px 16px;border-bottom:1px solid var(--bd);
  background:var(--sf);flex-shrink:0;
}
.log-title{font-weight:700;font-size:1.05em;color:var(--tx);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.log-live-badge{
  display:inline-flex;align-items:center;gap:4px;
  font-size:0.75em;font-weight:700;color:var(--rd);
  padding:2px 8px;border-radius:10px;
  background:rgba(248,81,73,0.12);border:1px solid rgba(248,81,73,0.3);
}
.log-live-dot{
  width:6px;height:6px;border-radius:50%;background:var(--rd);
  animation:pulse 1.5s infinite;
}
.log-done-badge{
  font-size:0.75em;font-weight:600;color:var(--dim);
  padding:2px 8px;border-radius:10px;
  background:rgba(139,148,158,0.12);border:1px solid rgba(139,148,158,0.25);
}
.log-close{
  background:none;border:1px solid var(--bd);color:var(--dim);
  width:28px;height:28px;border-radius:6px;cursor:pointer;
  font-size:1.1em;display:flex;align-items:center;justify-content:center;
  transition:all 0.15s;
}
.log-close:hover{background:var(--rd);color:var(--tx);border-color:var(--rd)}
.log-open-tab{
  background:none;border:1px solid var(--bd);color:var(--dim);
  padding:3px 8px;border-radius:6px;cursor:pointer;
  font-size:0.78em;transition:all 0.15s;
}
.log-open-tab:hover{background:var(--sf2);color:var(--tx)}

.log-toolbar{
  display:flex;align-items:center;gap:8px;
  padding:8px 16px;border-bottom:1px solid var(--bd2);
  background:var(--sf);flex-shrink:0;
}
.log-search{
  flex:1;background:var(--bg);border:1px solid var(--bd);border-radius:6px;
  padding:5px 10px;color:var(--tx);font-size:0.88em;font-family:inherit;
  outline:none;
}
.log-search:focus{border-color:var(--ac)}
.log-search::placeholder{color:var(--dim2)}
.log-filter{
  background:var(--bg);border:1px solid var(--bd);border-radius:6px;
  padding:5px 8px;color:var(--tx);font-size:0.82em;cursor:pointer;
}
.log-match-count{font-size:0.78em;color:var(--dim);white-space:nowrap;min-width:60px;text-align:center}
.log-btn{
  background:var(--bg);border:1px solid var(--bd);border-radius:6px;
  padding:4px 10px;color:var(--dim);font-size:0.82em;cursor:pointer;
  transition:all 0.15s;white-space:nowrap;
}
.log-btn:hover{background:var(--sf2);color:var(--tx)}
.log-btn.active{background:var(--ac2);color:var(--tx);border-color:var(--ac)}

.log-body{
  flex:1;overflow-y:auto;overflow-x:hidden;
  padding:0;font-family:'SF Mono','Cascadia Code','Fira Code',Consolas,monospace;
  font-size:0.82em;line-height:1.65;
  scroll-behavior:smooth;
}
.log-line{
  padding:1px 16px;display:flex;gap:8px;
  border-bottom:1px solid rgba(48,54,61,0.3);
  transition:background 0.1s;white-space:pre-wrap;word-break:break-all;
}
.log-line:hover{background:rgba(88,166,255,0.04)}
.log-line-num{
  color:var(--dim2);font-size:0.85em;min-width:40px;text-align:right;
  user-select:none;flex-shrink:0;padding-top:1px;
}
.log-line-text{flex:1;min-width:0}
.log-line.log-error{color:var(--rd);background:rgba(248,81,73,0.05)}
.log-line.log-error:hover{background:rgba(248,81,73,0.1)}
.log-line.log-warning{color:var(--yl)}
.log-line.log-success{color:var(--gn)}
.log-line.log-tool{color:var(--ac)}
.log-line.log-meta{color:var(--dim)}
.log-line.log-highlight{background:rgba(210,153,34,0.15)!important}
.log-line.log-highlight-current{background:rgba(210,153,34,0.3)!important}
.log-empty{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  height:100%;color:var(--dim);gap:10px;
}
.log-empty-spinner{
  width:24px;height:24px;border:2px solid var(--bd);border-top-color:var(--ac);
  border-radius:50%;animation:spin 1s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}

.log-footer{
  display:flex;align-items:center;justify-content:space-between;
  padding:6px 16px;border-top:1px solid var(--bd);
  background:var(--sf);flex-shrink:0;font-size:0.78em;color:var(--dim);
}
.log-scroll-btn{
  background:var(--ac2);color:var(--tx);border:none;border-radius:6px;
  padding:3px 10px;cursor:pointer;font-size:0.85em;
  display:none;
}
.log-scroll-btn.visible{display:inline-block}

/* ── Issue card visibility by tab filter ────────────────────────────────── */
.ic-card.ic-hidden{display:none}

/* ── Dual row: Equipo | Sistema ──────────────────────────────────────── */
/* Siempre repartir 50/50 el ancho; sólo apilar en móvil muy angosto. */
.dual-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;margin-bottom:20px;align-items:start}
.dual-col{min-width:0;overflow-y:visible}
.dual-col::-webkit-scrollbar{width:6px}
.dual-col::-webkit-scrollbar-track{background:transparent}
.dual-col::-webkit-scrollbar-thumb{background:var(--bd2);border-radius:3px}
.dual-col::-webkit-scrollbar-thumb:hover{background:var(--bd)}
@media(max-width:640px){.dual-row{grid-template-columns:1fr}.dual-col{max-height:none;overflow-y:visible}}

/* ══ Agent Card v2 (En Ejecución) ════════════════════════════════════ */
.agent-card{
  --card-tint: color-mix(in srgb, var(--agent-color) 14%, transparent);
  background:linear-gradient(145deg, var(--card-tint) 0%, var(--bg) 55%);
  border:1px solid var(--bd2);border-radius:var(--radius);
  border-left:4px solid var(--agent-color);
  padding:12px 14px;display:flex;flex-direction:column;gap:10px;
  position:relative;overflow:hidden;flex:1 1 280px;min-width:0;max-width:520px;
  transition:transform 0.15s, box-shadow 0.2s, border-color 0.2s;
  box-shadow:0 1px 0 rgba(255,255,255,0.02) inset;
}
.agent-card::after{
  content:'';position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(circle at 100% 0%, color-mix(in srgb, var(--agent-color) 18%, transparent) 0%, transparent 55%);
  opacity:0.6;
}
.agent-card:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(0,0,0,0.35), 0 0 0 1px var(--agent-color)}
.agent-card.agent-critical{border-left-color:var(--rd);animation:critPulse 1.8s ease-in-out infinite}
.agent-card.agent-warn{border-left-color:var(--yl)}
.agent-card.agent-fresh{border-left-color:var(--gn)}
@keyframes critPulse{0%,100%{box-shadow:0 0 0 0 rgba(248,81,73,0.35)}50%{box-shadow:0 0 0 6px rgba(248,81,73,0)}}
.agent-header{display:flex;gap:10px;align-items:center;position:relative;z-index:1}
.agent-avatar-xl{
  font-size:1.8em;line-height:1;
  width:42px;height:42px;display:flex;align-items:center;justify-content:center;
  background:color-mix(in srgb, var(--agent-color) 18%, var(--bg));
  border:1px solid color-mix(in srgb, var(--agent-color) 35%, var(--bd2));
  border-radius:10px;
}
.agent-identity{flex:1;min-width:0}
.agent-name-row{display:flex;align-items:center;gap:8px}
.agent-name{font-weight:800;font-size:1em;color:var(--agent-color);letter-spacing:0.2px}
.agent-health{font-size:0.65em;padding:2px 7px;border-radius:10px;font-weight:700;letter-spacing:0.3px;text-transform:uppercase;white-space:nowrap}
.agent-health-fresh{background:rgba(63,185,80,0.14);color:#3fb950}
.agent-health-active{background:rgba(88,166,255,0.14);color:#58a6ff}
.agent-health-warn{background:rgba(210,153,34,0.16);color:#d29922}
.agent-health-critical{background:rgba(248,81,73,0.18);color:#f85149}
.agent-tagline{font-size:0.7em;color:var(--dim);margin-top:2px;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agent-badge{
  font-size:0.72em;font-weight:700;color:var(--tx);
  background:var(--sf2);padding:3px 8px;border-radius:10px;
  border:1px solid var(--bd);white-space:nowrap;
}
.agent-badge-lbl{font-weight:500;color:var(--dim);font-size:0.9em}
.agent-work{display:flex;flex-direction:column;gap:4px;position:relative;z-index:1}
.work-item{
  display:grid;grid-template-columns:auto 1fr auto auto;gap:8px;align-items:center;
  padding:5px 8px;border-radius:var(--radius-sm);
  background:var(--bg);border:1px solid var(--bd2);
  text-decoration:none;font-size:0.78em;color:var(--tx);
  position:relative;transition:background 0.15s, border-color 0.15s;
}
.work-item:hover{background:var(--sf2);border-color:var(--agent-color);text-decoration:none}
.work-issue{font-weight:700;color:var(--ac);font-variant-numeric:tabular-nums}
.work-title{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.work-fase{font-size:0.85em;color:var(--dim2);padding:1px 6px;border-radius:6px;background:var(--sf2);white-space:nowrap}
.work-dur{font-size:0.85em;color:var(--dim);font-variant-numeric:tabular-nums;white-space:nowrap}
.work-progress{
  grid-column:1 / -1;height:2px;background:var(--bd);border-radius:2px;overflow:hidden;margin-top:3px;
}
.work-progress-fill{display:block;height:100%;background:var(--agent-color);transition:width 0.6s ease}
.work-warn .work-progress-fill{background:var(--yl)}
.work-critical .work-progress-fill{background:var(--rd)}
.agent-heartbeat{
  position:absolute;top:10px;right:42px;display:flex;gap:3px;z-index:1;
}
.agent-heartbeat .heartbeat-dot{
  width:5px;height:5px;border-radius:50%;background:var(--agent-color);
  animation:heartbeatPulse 1.6s ease-in-out infinite;
}
.agent-heartbeat .heartbeat-dot:nth-child(2){animation-delay:0.2s}
.agent-heartbeat .heartbeat-dot:nth-child(3){animation-delay:0.4s}
@keyframes heartbeatPulse{0%,100%{opacity:0.25;transform:scale(0.9)}50%{opacity:1;transform:scale(1.15)}}

/* ══ Persona Card (Equipo Disponible) ══════════════════════════════════ */
.persona-stack{display:flex;flex-direction:column;gap:6px}
.persona-group{margin-bottom:10px}
.persona-group:last-child{margin-bottom:0}
.persona-group-head{
  display:flex;align-items:center;gap:8px;
  font-size:0.72em;color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;
  font-weight:700;margin-bottom:8px;
}
.persona-group-icon{font-size:1.05em}
.persona-group-label{color:var(--tx)}
.persona-group-count{margin-left:auto;color:var(--dim);font-variant-numeric:tabular-nums;text-transform:none;letter-spacing:0}
.persona-group-active{color:var(--gn);font-weight:700}
.persona-group-grid{display:grid;grid-template-columns:repeat(auto-fill, minmax(min(180px, 100%), 1fr));gap:8px}
.persona-card{
  background:var(--bg);border:1px solid var(--bd2);border-radius:var(--radius-sm);
  border-top:2px solid color-mix(in srgb, var(--agent-color) 70%, var(--bd2));
  padding:8px 10px;display:flex;flex-direction:column;gap:6px;
  transition:transform 0.15s, border-color 0.15s, box-shadow 0.2s;position:relative;overflow:hidden;
}
.persona-card:hover{transform:translateY(-1px);border-color:var(--agent-color);box-shadow:0 3px 10px rgba(0,0,0,0.25)}
.persona-card.persona-full{border-top-color:var(--rd)}
.persona-card.persona-partial{border-top-color:var(--yl);box-shadow:0 0 0 1px color-mix(in srgb, var(--agent-color) 25%, transparent) inset}
.persona-card.persona-idle{opacity:0.62}
.persona-card.persona-idle:hover{opacity:1}
.persona-head{display:flex;align-items:center;gap:8px}
.persona-avatar{
  font-size:1.25em;width:28px;height:28px;display:flex;align-items:center;justify-content:center;
  background:color-mix(in srgb, var(--agent-color) 14%, var(--sf2));border-radius:8px;flex-shrink:0;
}
.persona-id{flex:1;min-width:0}
.persona-name{font-size:0.82em;font-weight:700;color:var(--agent-color);line-height:1.1}
.persona-tagline{font-size:0.62em;color:var(--dim2);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.persona-pill{
  font-size:0.58em;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;
  padding:2px 6px;border-radius:8px;white-space:nowrap;
}
.persona-pill-full{background:rgba(248,81,73,0.15);color:var(--rd)}
.persona-pill-partial{background:rgba(210,153,34,0.15);color:var(--yl)}
.persona-pill-idle{background:rgba(63,185,80,0.12);color:var(--gn)}
.persona-body{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:0.7em}
.persona-strip{display:flex;gap:3px}
.persona-strip-empty{color:var(--dim2);font-style:italic}
.persona-dot{
  display:inline-flex;align-items:center;justify-content:center;
  width:14px;height:14px;border-radius:3px;font-size:0.75em;font-weight:700;
  background:var(--sf2);border:1px solid var(--bd2);line-height:1;
}
.persona-dot-ok{background:rgba(63,185,80,0.18);color:var(--gn);border-color:rgba(63,185,80,0.35)}
.persona-dot-bad{background:rgba(248,81,73,0.18);color:var(--rd);border-color:rgba(248,81,73,0.35)}
.persona-dot-live{background:rgba(88,166,255,0.18);color:var(--ac);border-color:rgba(88,166,255,0.35);animation:agentPulse 1.4s ease-in-out infinite}
.persona-strip a{text-decoration:none}
.persona-meta{display:flex;gap:8px;color:var(--dim);font-variant-numeric:tabular-nums}
.persona-meta-item{white-space:nowrap}
.persona-meta-usage{color:var(--dim2)}

/* ══ System Resources v2 ══════════════════════════════════════════════ */
.sys-health{
  display:flex;align-items:center;gap:14px;margin-bottom:14px;
  padding:10px 12px;background:var(--bg);border:1px solid var(--bd2);
  border-left:3px solid var(--hcolor,var(--gn));border-radius:var(--radius-sm);
}
.sys-health-score{
  --hcolor:var(--gn);
  width:54px;height:54px;border-radius:50%;
  background:conic-gradient(var(--hcolor) calc(var(--score,100)*1%), var(--bd) 0);
  display:flex;align-items:center;justify-content:center;position:relative;
}
.sys-health-score::before{
  content:'';position:absolute;inset:5px;border-radius:50%;background:var(--bg);
}
.sys-health-value{position:relative;font-size:1em;font-weight:800;color:var(--hcolor);font-variant-numeric:tabular-nums}
.sys-health-label{position:absolute;top:100%;left:50%;transform:translate(-50%,4px);font-size:0.6em;color:var(--dim);text-transform:uppercase;letter-spacing:1px;white-space:nowrap}
.sys-health-meta{flex:1}
.sys-health-title{font-size:0.82em;font-weight:700;color:var(--tx)}
.sys-health-sub{font-size:0.72em;color:var(--dim);margin-top:2px}
.rgauge-cell{
  flex:1;min-width:0;background:var(--bg);border:1px solid var(--bd2);
  border-radius:var(--radius-sm);padding:8px 10px;display:flex;flex-direction:column;gap:4px;
  border-left:3px solid var(--gn);
}
.rgauge-cell.rgauge-warn{border-left-color:var(--yl)}
.rgauge-cell.rgauge-danger{border-left-color:var(--rd);animation:pulse 1.8s infinite}
.rgauge-top{display:flex;align-items:center;gap:12px}
.rgauge{flex-shrink:0}
.rgauge-info{flex:1;min-width:0}
.rgauge-title{font-size:0.78em;font-weight:800;color:var(--tx);text-transform:uppercase;letter-spacing:1.2px;display:flex;align-items:center;gap:6px}
.rgauge-trend{font-size:1.2em;line-height:1}
.trend-up{color:var(--rd)}
.trend-down{color:var(--gn)}
.trend-flat{color:var(--dim)}
.rgauge-sub{font-size:0.72em;color:var(--dim);margin-top:2px}
.rgauge-kpis{display:flex;gap:10px;margin-top:6px;font-size:0.7em;color:var(--dim);font-variant-numeric:tabular-nums}
.rgauge-kpis b{color:var(--tx);font-weight:700;margin-left:3px}
.rgauge-spark{margin-top:2px;line-height:0}
.rgauge-spark svg{display:block;width:100%;height:18px}

/* ══ Service Layer v2 ══════════════════════════════════════════════════ */
.svc-grid{display:flex;flex-direction:column;gap:10px}
.svc-layer{background:var(--bg);border:1px solid var(--bd2);border-radius:var(--radius-sm);padding:8px 10px}
.svc-layer-head{
  display:flex;align-items:center;gap:6px;
  font-size:0.65em;color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;
  font-weight:700;margin-bottom:6px;
}
.svc-layer-icon{font-size:0.95em}
.svc-layer-rows{display:flex;flex-direction:column;gap:3px}
.svc-row{
  display:grid;grid-template-columns:auto auto 1fr auto auto auto;gap:8px;align-items:center;
  padding:5px 8px;border-radius:var(--radius-sm);
  background:var(--sf2);border:1px solid transparent;font-size:0.78em;
  transition:background 0.15s, border-color 0.15s;cursor:default;
}
.svc-row:hover{background:var(--bd2);border-color:var(--bd)}
.svc-row-dead{opacity:0.6}
.svc-row-dead .svc-name{color:var(--dim)}
.svc-row-busy{border-color:rgba(210,153,34,0.25)}
.svc-row-degraded{border-color:rgba(240,136,62,0.3)}
.svc-status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
@keyframes svcPulse{0%,100%{box-shadow:0 0 0 0 currentColor;opacity:1}50%{box-shadow:0 0 0 3px currentColor;opacity:0.7}}
.svc-icon{font-size:1em;line-height:1}
.svc-name{font-weight:600;color:var(--tx);white-space:nowrap}
.svc-queue{display:flex;gap:6px;font-variant-numeric:tabular-nums;font-size:0.9em}
.svc-queue-none{color:var(--dim2);font-style:italic}
.svc-q{color:var(--dim);white-space:nowrap}
.svc-q-work{color:var(--yl)}
.svc-q-work-pulse{animation:svcPulse 1.6s infinite}
.svc-q-done{color:var(--gn)}
.svc-uptime{font-size:0.75em;color:var(--dim);font-variant-numeric:tabular-nums;white-space:nowrap;padding:1px 6px;border-radius:6px;background:var(--bg)}
.svc-ctl{
  border:none;cursor:pointer;border-radius:4px;font-size:0.72em;
  padding:2px 8px;font-weight:700;line-height:1;transition:transform 0.1s;
}
.svc-ctl:hover{transform:scale(1.1)}
.svc-ctl-start{background:var(--gn2);color:var(--gn)}
.svc-ctl-stop{background:var(--rd2);color:var(--rd)}
.svc-row-cloud{background:linear-gradient(90deg, rgba(9,132,227,0.15), rgba(108,92,231,0.1))}

.bar-section{
  background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);
  padding:16px 18px;position:relative;overflow:hidden;
}
.bar-section::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:var(--radius) var(--radius) 0 0}
.bar-section.panel-equipo::before{background:linear-gradient(90deg,var(--ac),var(--pu),var(--gn))}
.bar-section.panel-sistema::before{background:linear-gradient(90deg,var(--gn),var(--yl),var(--rd))}
.sys-chips-row{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px}
/* ── Service Cards ──────────────────────────────────────────────────────── */
.svc-grid{display:flex;flex-wrap:wrap;gap:8px}
.svc-card{
  background:var(--bg);border:1px solid var(--bd2);border-radius:var(--radius-sm);
  padding:8px 10px;min-width:90px;flex:1;max-width:140px;
  border-left:3px solid var(--dim2);transition:box-shadow 0.2s;
}
.svc-card:hover{box-shadow:0 2px 8px rgba(88,166,255,0.12);transform:translateY(-1px)}
.svc-card-ok{border-left-color:var(--gn)}
.svc-card-busy{border-left-color:var(--yl)}
.svc-card-dead{border-left-color:var(--rd)}
.svc-card-header{display:flex;align-items:center;gap:4px}
.svc-card-name{font-size:0.78em;font-weight:600;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.svc-card-pulse{width:5px;height:5px;border-radius:50%;background:var(--gn);animation:agentPulse 2s infinite;margin-left:auto;flex-shrink:0}
.svc-card-busy .svc-card-pulse{background:var(--yl)}
.svc-card-stats{display:flex;gap:6px;margin-top:4px;overflow:hidden}
.svc-stat{font-size:0.75em;font-weight:700;color:var(--dim);font-variant-numeric:tabular-nums;white-space:nowrap;cursor:default}
.svc-stat-work{color:var(--yl)}
.svc-stat-done{color:var(--gn)}
.svc-card-pid{font-size:0.68em;color:var(--dim2);margin-top:2px;font-variant-numeric:tabular-nums}
.svc-card-group{min-width:160px;max-width:220px}
.svc-group-procs{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.svc-group-proc{font-size:0.65em;color:var(--dim);white-space:nowrap;cursor:default}
.proc-chip{
  display:inline-flex;align-items:center;gap:5px;
  font-size:0.82em;padding:4px 8px;margin:3px;
  border-radius:5px;background:var(--bg);border:1px solid var(--bd2);
}
.proc-alive{color:var(--gn)}.proc-dead{color:var(--rd)}
.pid-num{font-size:0.8em;color:var(--dim2)}

/* ── Control buttons ───────────────────────────────────────────────────── */
.ctl-btn{
  border:none;cursor:pointer;border-radius:4px;font-size:0.72em;
  padding:2px 6px;margin-right:4px;font-weight:700;line-height:1;
  vertical-align:middle;transition:opacity 0.2s,transform 0.1s;
}
.ctl-btn:hover{opacity:0.85;transform:scale(1.1)}
.ctl-btn:active{transform:scale(0.95)}
.ctl-btn.loading{opacity:0.4;pointer-events:none}
.ctl-start{background:var(--gn2);color:var(--gn)}
.ctl-stop{background:var(--rd2);color:var(--rd)}
.ctl-wide{padding:4px 12px;font-size:0.78em;margin-top:8px;display:inline-block}
/* Priority Windows (inline toggles — used en barra de control global) */
.pw-toggles{display:inline-flex;gap:6px;vertical-align:middle;align-items:center}
.pw-toggle{padding:3px 11px;border-radius:14px;cursor:pointer;font-weight:600;letter-spacing:0.2px;transition:all 0.2s ease;border:1px solid var(--bd);user-select:none;font-size:0.82em;min-height:24px;display:inline-flex;align-items:center;line-height:1;backdrop-filter:blur(4px)}
.pw-toggle-active{background:rgba(210,153,34,0.15);color:var(--yl);border-color:rgba(210,153,34,0.5);box-shadow:0 0 8px rgba(210,153,34,0.2);animation:pwPulse 2.5s ease-in-out infinite}
.pw-toggle-inactive{background:color-mix(in srgb,var(--sf) 80%,transparent);color:var(--dim);border-color:color-mix(in srgb,var(--bd) 60%,transparent)}
.pw-toggle-inactive:hover{background:var(--bd2);color:var(--fg);transform:translateY(-1px);box-shadow:0 2px 4px rgba(0,0,0,0.1)}
.pw-toggle.pw-build.pw-toggle-active{background:rgba(88,166,255,0.15);color:var(--ac);border-color:rgba(88,166,255,0.5);box-shadow:0 0 8px rgba(88,166,255,0.2)}
@keyframes pwPulse{0%,100%{opacity:1}50%{opacity:0.65}}

/* ── Pipeline control bar (global status + Priority Windows) ─────────── */
.pipeline-ctrl-bar{padding:6px 20px;display:flex;align-items:center;gap:16px;font-size:0.82em;border-bottom:none;min-height:36px;background:linear-gradient(90deg,var(--sf) 0%,color-mix(in srgb,var(--sf) 92%,var(--ac)) 100%);position:sticky;top:56px;z-index:9;transition:all 0.3s ease;flex-wrap:wrap;border-radius:0 0 8px 8px;margin:0 12px;box-shadow:0 2px 8px rgba(0,0,0,0.15)}
.pipeline-ctrl-bar.ctrl-ok{background:linear-gradient(90deg,var(--sf) 0%,color-mix(in srgb,var(--sf) 88%,var(--gn)) 100%);color:var(--dim)}
.pipeline-ctrl-bar.ctrl-priority-qa{background:linear-gradient(90deg,rgba(210,153,34,0.08) 0%,rgba(210,153,34,0.18) 100%);color:var(--yl)}
.pipeline-ctrl-bar.ctrl-priority-build{background:linear-gradient(90deg,rgba(88,166,255,0.06) 0%,rgba(88,166,255,0.16) 100%);color:var(--ac)}
.pipeline-ctrl-bar.ctrl-paused{background:linear-gradient(90deg,rgba(251,188,5,0.06) 0%,rgba(251,188,5,0.14) 100%);color:#f0a500}
.pipeline-ctrl-bar.ctrl-blocked{background:linear-gradient(90deg,rgba(248,81,73,0.06) 0%,rgba(248,81,73,0.14) 100%);color:var(--rd);animation:pausePulse 2s infinite}
.pipeline-ctrl-bar.ctrl-stale{background:linear-gradient(90deg,rgba(210,153,34,0.05) 0%,rgba(210,153,34,0.12) 100%);color:var(--yl)}
.ctrl-bar-status{display:inline-flex;align-items:center;gap:8px;font-weight:500;letter-spacing:0.2px}
.ctrl-bar-status-icon{font-size:0.95em;opacity:0.85}
.ctrl-bar-sep{width:1px;height:14px;background:color-mix(in srgb,currentColor 20%,transparent);margin:0 4px;border-radius:1px}
.ctrl-bar-spacer{margin-left:auto}
.ctrl-bar-btn{padding:4px 14px;border-radius:14px;cursor:pointer;font-size:0.88em;border:1px solid color-mix(in srgb,currentColor 40%,transparent);background:color-mix(in srgb,currentColor 8%,transparent);color:inherit;font-family:inherit;font-weight:600;min-height:26px;display:inline-flex;align-items:center;gap:5px;transition:all 0.2s ease;backdrop-filter:blur(4px)}
.ctrl-bar-btn:hover{background:color-mix(in srgb,currentColor 18%,transparent);border-color:color-mix(in srgb,currentColor 50%,transparent);transform:translateY(-1px);box-shadow:0 2px 6px rgba(0,0,0,0.12)}
.ctrl-bar-btn:active{transform:scale(0.97) translateY(0)}
.ctrl-bar-label{font-size:0.72em;text-transform:uppercase;letter-spacing:1.2px;color:color-mix(in srgb,var(--dim) 70%,transparent);font-weight:700}
.ctrl-bar-spacer{flex:1}
/* Kill agent button */
.kill-btn{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--rd2);color:var(--rd);font-size:12px;font-weight:700;cursor:pointer;margin-left:4px;opacity:0.6;transition:opacity 0.15s,background 0.15s;line-height:1;vertical-align:middle}
.kill-btn:hover{opacity:1;background:var(--rd);color:#fff}
.kill-group-btn{display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--rd2);color:var(--rd);font-size:14px;font-weight:700;cursor:pointer;opacity:0;transition:opacity 0.2s,background 0.15s;line-height:1;flex-shrink:0;margin-left:auto}
.agent-card:hover .kill-group-btn{opacity:0.6}
.kill-group-btn:hover{opacity:1!important;background:var(--rd);color:#fff}
/* ETA badges */
.eta-badge{font-size:0.7em;padding:1px 5px;border-radius:8px;background:var(--ac2);color:var(--ac);margin-left:4px;font-weight:600;white-space:nowrap}
.eta-over{background:var(--or2);color:var(--or)}
.issue-eta{display:block;font-size:0.72em;color:var(--ac);margin-top:2px;white-space:nowrap}
.issue-done-time{color:var(--gn)}

/* Toast notification */
.toast{
  position:fixed;bottom:20px;right:20px;z-index:999;
  background:var(--sf2);border:1px solid var(--bd);border-radius:var(--radius-sm);
  padding:10px 16px;font-size:0.88em;color:var(--tx);
  box-shadow:0 4px 12px rgba(0,0,0,0.4);
  animation:slideIn 0.3s ease;max-width:350px;
}
.toast.toast-ok{border-left:4px solid var(--gn)}
.toast.toast-err{border-left:4px solid var(--rd)}
@keyframes slideIn{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}

/* ── Resource Gauges ───────────────────────────────────────────────────── */
.gauge-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.gauge{flex:1;min-width:180px}
.gauge-label{font-size:0.82em;font-weight:700;color:var(--dim);margin-bottom:6px;text-transform:uppercase;letter-spacing:1px}
.gauge-bar{
  position:relative;height:10px;background:var(--bd);border-radius:5px;overflow:visible;
}
.gauge-fill{
  height:100%;border-radius:5px;transition:width 0.6s ease;
}
.gauge-threshold{
  position:absolute;top:-2px;bottom:-2px;width:2px;
  background:var(--rd);opacity:0.6;border-radius:1px;
}
.gauge-ok .gauge-fill{background:linear-gradient(90deg,var(--gn2),var(--gn))}
.gauge-warn .gauge-fill{background:linear-gradient(90deg,var(--yl2),var(--yl))}
.gauge-danger .gauge-fill{background:linear-gradient(90deg,var(--rd2),var(--rd));animation:pulse 1.8s infinite}
.gauge-danger{box-shadow:inset 0 0 8px rgba(248,81,73,0.15)}
.gauge-value{
  font-size:0.9em;font-weight:600;margin-top:6px;
  font-variant-numeric:tabular-nums;
}
.gauge-ok .gauge-value{color:var(--gn)}
.gauge-warn .gauge-value{color:var(--yl)}
.gauge-danger .gauge-value{color:var(--rd)}
.gauge-detail{font-weight:400;color:var(--dim);font-size:0.85em;margin-left:4px}
.resource-alert{
  margin-top:10px;padding:8px 12px;
  background:rgba(248,81,73,0.12);border:1px solid rgba(248,81,73,0.4);
  border-left:4px solid var(--rd);border-radius:var(--radius-sm);
  color:var(--rd);font-size:0.88em;font-weight:600;
}

/* ── Rechazos / Actividad ───────────────────────────────────────────────── */
.rechazo-row{font-size:0.85em;padding:5px 2px;border-bottom:1px solid var(--bd2);color:var(--rd);display:flex;gap:8px;align-items:baseline}
.rechazo-motivo{color:var(--dim);font-style:italic}
.ts{color:var(--dim);font-size:0.82em}
.act-row{font-size:0.82em;padding:4px 2px;border-bottom:1px solid var(--bd2);font-family:'SF Mono','Fira Code',monospace;display:flex;gap:8px}
.msg-in{color:var(--ac)}.msg-out{color:var(--gn)}

/* ── Collapse / details ─────────────────────────────────────────────────── */
.collapse-section{
  background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);
  padding:0;margin-bottom:14px;overflow:hidden;
}
.collapse-section summary{
  color:var(--dim);font-size:0.82em;cursor:pointer;
  padding:12px 18px;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;
  list-style:none;display:flex;justify-content:space-between;align-items:center;
  user-select:none;
}
.collapse-section summary::-webkit-details-marker{display:none}
.collapse-section summary::after{content:'▸';transition:transform 0.2s}
.collapse-section[open] summary::after{transform:rotate(90deg)}
.collapse-section summary:hover{background:rgba(255,255,255,0.03)}
.collapse-body{padding:10px 18px 14px;border-top:1px solid var(--bd2)}

/* ── Agent Team ────────────────────────────────────────────────────────── */
.team-section{
  background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);
  padding:18px 20px;margin-bottom:20px;
}
/* ── Agent Cards (compact) ──────────────────────────────────────────────── */
.agent-grid{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px}
.agent-card{
  background:var(--bg);border:1px solid var(--bd2);border-radius:var(--radius-sm);
  padding:8px 12px;display:flex;gap:8px;align-items:center;
  border-left:3px solid var(--agent-color);
  position:relative;overflow:hidden;flex:1;min-width:200px;max-width:320px;
  transition:border-color 0.2s,box-shadow 0.2s;
}
.agent-card:hover{border-color:var(--agent-color);box-shadow:0 0 8px rgba(88,166,255,0.1)}
.agent-avatar{font-size:1.2em;line-height:1}
.agent-info{flex:1;min-width:0}
.agent-name{font-weight:700;font-size:0.88em;color:var(--agent-color);line-height:1}
.agent-issues{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.agent-issue{
  font-size:0.72em;padding:2px 6px;border-radius:10px;
  background:rgba(88,166,255,0.08);border:1px solid rgba(88,166,255,0.2);
  color:var(--ac);display:inline-flex;align-items:center;gap:3px;
  text-decoration:none;transition:background 0.15s;
}
.agent-issue:hover{background:rgba(88,166,255,0.15);text-decoration:none}
.agent-issue-fase{color:var(--dim);font-size:0.9em}
.agent-issue-dur{color:var(--dim2);font-size:0.85em}
.agent-pulse{
  position:absolute;top:6px;right:6px;width:6px;height:6px;
  border-radius:50%;background:var(--agent-color);
  animation:agentPulse 2s ease-in-out infinite;
}
@keyframes agentPulse{0%,100%{opacity:1;box-shadow:0 0 4px var(--agent-color)}50%{opacity:0.3;box-shadow:none}}

/* ── Sub-section labels ─────────────────────────────────────────────────── */
.subsection-label{
  font-size:0.68em;color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;
  font-weight:600;margin-bottom:6px;margin-top:10px;
  display:flex;align-items:center;gap:8px;
}
.subsection-label::after{content:'';flex:1;height:1px;background:var(--bd2)}

/* ── Skill Capacity Chips (inline compact) ──────────────────────────────── */
.skill-cap-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.skill-cap-chip{
  display:inline-flex;flex-direction:column;gap:3px;
  background:var(--bg);border:1px solid var(--bd2);border-radius:var(--radius-sm);
  padding:6px 10px;border-left:3px solid var(--agent-color,var(--dim2));
  transition:box-shadow 0.2s;min-width:110px;
}
.skill-cap-chip:hover{box-shadow:0 0 6px rgba(88,166,255,0.08)}
.load-full.skill-cap-chip{border-left-color:var(--rd)}
.skill-cap-main{display:flex;align-items:center;gap:6px}
.skill-cap-icon{font-size:1em;line-height:1}
.skill-cap-name{font-size:0.78em;font-weight:600;color:var(--tx);white-space:nowrap}
.skill-cap-bar{width:32px;height:4px;background:var(--bd);border-radius:2px;overflow:hidden;display:inline-block}
.skill-cap-fill{display:block;height:100%;border-radius:2px;transition:width 0.6s ease}
.load-partial .skill-cap-fill{background:var(--yl)}
.load-full .skill-cap-fill{background:var(--rd)}
.skill-cap-count{font-size:0.72em;color:var(--dim);font-variant-numeric:tabular-nums}
.load-idle.skill-cap-chip{opacity:0.5;border-left-color:var(--dim2)}
.load-idle .skill-cap-name{color:var(--dim)}
.skill-idle-summary{font-size:0.75em;color:var(--dim);font-style:italic;padding:4px 8px}
.skill-recent{display:flex;gap:4px;flex-wrap:wrap}
.skill-recent-item{font-size:0.65em;color:var(--dim);text-decoration:none;cursor:pointer;padding:1px 4px;border-radius:4px;background:var(--sf2);white-space:nowrap;transition:background 0.15s}
a.skill-recent-item:hover{background:var(--bd2);color:var(--ac)}
.skill-recent-pdf{font-size:0.65em;text-decoration:none;cursor:pointer;opacity:0.7;transition:opacity 0.15s}
.skill-recent-pdf:hover{opacity:1}
.rejection-pdf-btn{text-decoration:none;font-size:0.7em;margin-left:2px;opacity:0.7;transition:opacity 0.15s;cursor:pointer}
.rejection-pdf-btn:hover{opacity:1}

/* ── DORA Mini ─────────────────────────────────────────────────────────── */
.dora-mini{
  background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);
  padding:18px 20px;margin-bottom:20px;
}
.dora-mini-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.dora-mini-card{
  background:var(--bg);border:1px solid var(--bd2);border-radius:var(--radius-sm);
  padding:14px 12px;text-align:center;
}
.dora-mini-value{font-size:1.8em;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1}
.dora-mini-label{color:var(--dim);font-size:0.78em;font-weight:600;margin-top:4px;text-transform:uppercase;letter-spacing:0.5px}
.dora-mini-target{font-size:0.7em;color:var(--dim2);margin-top:4px}
@media(max-width:700px){.dora-mini-grid{grid-template-columns:repeat(2,1fr)}}

/* ── Footer ──────────────────────────────────────────���──────────────────── */
.footer{margin-top:22px;font-size:0.75em;color:var(--dim2);text-align:center;padding-top:12px;border-top:1px solid var(--bd2)}

/* ── Empty state ────────────────────────────────────────────────────────── */
.empty-label{color:var(--dim);font-size:0.82em;font-style:italic}

/* ── KPI Tooltip ────────────────────────────────────────────────────────── */
.kpi[data-tooltip]{cursor:pointer;position:relative}
.kpi-tooltip{
  display:none;position:fixed;z-index:1000;
  background:var(--sf2);border:1px solid var(--bd);border-radius:var(--radius-sm);
  padding:10px 14px;font-size:0.82em;color:var(--tx);
  box-shadow:0 8px 24px rgba(0,0,0,0.4);max-width:320px;min-width:160px;
  pointer-events:none;white-space:nowrap;
}
.kpi-tooltip .tt-title{color:var(--dim);font-size:0.85em;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-weight:600}
.kpi-tooltip .tt-item{padding:2px 0;color:var(--ac)}
.kpi-tooltip .tt-item a{color:var(--ac)}
.kpi-tooltip .tt-more{color:var(--dim);font-style:italic;margin-top:4px}

/* ── Issue Tracker Lanes (Opción E): 3 columnas iguales ─────────────────── */
.it-lanes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:10px}
.it-lane.it-lane-empty-search{opacity:0.35}

/* Search input */
.it-search-box{position:relative;display:inline-flex;align-items:center;margin-right:auto;margin-left:14px;flex:1;max-width:320px}
.it-search{width:100%;padding:5px 26px 5px 10px;background:var(--sf2);border:1px solid var(--bd);border-radius:6px;font-size:0.82em;color:var(--tx);outline:none;transition:border-color 0.15s}
.it-search:focus{border-color:var(--ac);box-shadow:0 0 0 1px rgba(88,166,255,0.3)}
.it-search::placeholder{color:var(--dim)}
.it-search-clear{position:absolute;right:8px;color:var(--dim);cursor:pointer;font-size:1.1em;padding:0 4px}
.it-search-clear:hover{color:var(--rd)}

/* Stepper cell (dot + initial) */
.stepper-cell{display:inline-flex;flex-direction:column;align-items:center;gap:1px;position:relative}
.stepper-initial{font-size:0.58em;color:var(--dim);text-transform:uppercase;letter-spacing:0.3px;font-weight:500;line-height:1;margin-top:1px;font-variant-numeric:tabular-nums}
.stepper-initial-current{color:var(--teal,#2dd4bf);font-weight:700}
.stepper-dot.dot-clickable{cursor:pointer;transition:transform 0.1s}
.stepper-dot.dot-clickable:hover{transform:scale(1.25)}

/* Dot popup */
.dot-popup{background:var(--sf);border:1px solid var(--ac);border-radius:8px;padding:0;min-width:240px;max-width:360px;box-shadow:0 8px 24px rgba(0,0,0,0.5);z-index:10000;font-size:0.82em}
.dp-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--bd);background:var(--sf2);border-radius:8px 8px 0 0}
.dp-title{font-size:0.95em;color:var(--tx);text-transform:capitalize}
.dp-title b{color:var(--ac);text-transform:capitalize}
.dp-close{color:var(--dim);cursor:pointer;font-size:1.2em;padding:0 4px;line-height:1}
.dp-close:hover{color:var(--rd)}
.dp-body{padding:8px 12px}
.dp-empty{color:var(--dim);font-style:italic;padding:6px 0;font-size:0.85em;text-align:center}
.dp-row{padding:6px 0;border-bottom:1px dashed rgba(255,255,255,0.05)}
.dp-row:last-child{border-bottom:none}
.dp-row-top{display:flex;align-items:center;gap:6px;margin-bottom:2px}
.dp-state{font-weight:700;font-size:0.95em;min-width:14px;text-align:center}
.dp-ok .dp-state{color:var(--gn)}
.dp-fail .dp-state{color:var(--rd)}
.dp-run .dp-state{color:var(--teal,#2dd4bf)}
.dp-pending .dp-state{color:var(--dim)}
.dp-skill{font-weight:700;color:var(--tx);text-transform:capitalize}
.dp-retry{background:rgba(251,191,36,0.15);color:var(--yl);padding:0 5px;border-radius:4px;font-size:0.82em;font-weight:700}
.dp-dur{color:var(--dim);font-variant-numeric:tabular-nums;font-size:0.9em;margin-left:auto}
.dp-motivo{color:var(--rd);font-size:0.85em;line-height:1.3;margin:3px 0 4px 20px;font-style:italic;opacity:0.9}
.dp-links{display:flex;gap:8px;margin-left:20px;margin-top:3px}
.dp-log{color:var(--ac);text-decoration:none;font-size:0.85em;padding:1px 0}
.dp-log:hover{text-decoration:underline}
.it-lane{background:var(--sf2);border:1px solid var(--bd);border-radius:8px;padding:10px 10px 8px 10px;display:flex;flex-direction:column;min-width:0}
.it-lane-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--bd);gap:8px;flex-wrap:wrap}
.it-lane-name{font-size:0.78em;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;display:flex;align-items:center;gap:6px;color:var(--lane-color);min-width:0}
.it-lane-dot{width:6px;height:6px;border-radius:50%;background:var(--lane-color);flex-shrink:0}
.it-lane-sub{font-size:0.78em;color:var(--dim);font-weight:400;text-transform:none;letter-spacing:0;margin-left:2px}
.it-lane-meta{display:flex;gap:5px;align-items:center;font-size:0.7em;flex-wrap:wrap}
.it-lane-count{background:var(--sf);color:var(--tx);padding:2px 8px;border-radius:10px;font-weight:700}
.it-lane-count b{color:var(--tx);font-weight:800}
.it-badge{padding:1px 6px;border-radius:6px;font-weight:700}
.it-badge.run{color:#2dd4bf;background:rgba(45,212,191,0.12)}
.it-badge.fail{color:var(--rd);background:rgba(248,113,113,0.12)}
.it-badge.warn{color:var(--yl);background:rgba(251,191,36,0.12)}

/* Sub-breakdown chips (clickeables) */
.it-sub-breakdown{display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap}
.it-sub-chip{flex:1;padding:4px 8px;background:var(--sf);border-radius:5px;text-align:center;color:var(--dim);font-size:0.68em;display:flex;align-items:center;justify-content:center;gap:4px;font-weight:500;cursor:pointer;border:1px solid transparent;transition:background 0.15s,border-color 0.15s}
.it-sub-chip:hover{background:var(--panel);border-color:rgba(109,140,255,0.3)}
.it-sub-chip b{color:var(--tx);font-weight:800;font-variant-numeric:tabular-nums}
.it-sub-chip.hot{color:var(--yl);border-color:rgba(251,191,36,0.3)}
.it-sub-chip.active{background:rgba(109,140,255,0.15);border-color:var(--ac);color:var(--ac)}
.it-sub-chip.active b{color:var(--ac)}
.it-sub-chip.it-sub-disabled{opacity:0.45;cursor:default}
.it-sub-chip.it-sub-disabled:hover{background:var(--sf);border-color:transparent}
.it-sub-all{flex:0 0 auto;min-width:56px}

.it-lane-cards{display:flex;flex-direction:column;gap:6px;max-height:640px;overflow-y:auto;padding-right:2px}
.it-lane-cards::-webkit-scrollbar{width:5px}
.it-lane-cards::-webkit-scrollbar-thumb{background:var(--bd);border-radius:3px}
.lane-empty{font-size:0.72em;color:var(--dim);text-align:center;padding:14px 0;font-style:italic}

/* Lane card rica (Opción E + polish) */
.lc-card{display:block;background:var(--sf);border:1px solid var(--bd);border-left:3px solid var(--bd);border-radius:7px;font-size:0.78em;color:var(--tx);transition:transform 0.15s,border-color 0.15s,box-shadow 0.15s;overflow:hidden;flex-shrink:0}
.lc-card:hover{transform:translateY(-1px);box-shadow:0 3px 10px rgba(0,0,0,0.3);border-left-color:var(--ac)}
.lc-card.lc-running{border-left-color:#2dd4bf}
.lc-card.lc-failed{border-left-color:var(--rd)}
.lc-card.lc-stale{border-left-color:var(--yl);background:linear-gradient(90deg,rgba(251,191,36,0.04),var(--sf) 30%)}
.lc-card.lc-blocked{border-left-color:var(--rd);background:linear-gradient(90deg,rgba(248,113,113,0.03),var(--sf) 30%)}
.lc-card.lc-done{border-left-color:var(--gn);opacity:0.75}
/* #2337 CA8 — estado reintentando. Ambar dorado (--retry), fade 400ms en
 * transiciones (bloqueado->reintentando y reintentando->en-curso). */
.lc-card.lc-retrying{
  border-left-color:var(--retry);
  background:linear-gradient(90deg,rgba(245,158,11,0.07),var(--sf) 35%);
  transition:background 400ms ease,border-color 400ms ease;
}
.lc-card.lc-retrying .lc-retry-icon{
  display:inline-block;font-size:0.95em;line-height:1;margin-left:3px;color:var(--retry);
  animation:retrySpin 1.8s linear infinite;
  /* Anti-urgencia: no se vuelve opaco ni parpadea — solo rota suave */
}
@keyframes retrySpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
/* CA8 — respetar prefers-reduced-motion para usuarios con trastornos
 * vestibulares o TDAH: fallback estatico con borde punteado. */
@media (prefers-reduced-motion: reduce){
  .lc-card.lc-retrying .lc-retry-icon{animation:none}
  .lc-card.lc-retrying{border-left-style:dashed}
}
/* CA8 — label oculto a la vista pero alcanzable por lector de pantalla y
 * focus por teclado (para tooltip accesible via :focus-visible). */
.lc-card.lc-retrying .lc-retry-label{
  display:inline-block;width:0;height:0;overflow:hidden;color:transparent;
  outline:none;
}
.lc-card.lc-retrying .lc-retry-label:focus-visible{
  width:auto;height:auto;color:var(--retry);outline:2px solid var(--retry);
  outline-offset:2px;margin-left:4px;padding:0 4px;border-radius:4px;
  background:rgba(245,158,11,0.1);
}
.lc-card.lc-filtered-out-sub,.lc-card.lc-filtered-out-search,.lc-card.lc-filtered-blocked{display:none}
.lc-card.lc-hl-blocked{border-left-color:var(--rd) !important;box-shadow:0 0 0 1px rgba(248,113,113,0.5)}
.lc-card.lc-hl-blocking{border-left-color:var(--yl) !important;box-shadow:0 0 0 1px rgba(251,191,36,0.5)}
.lc-card.lc-hl-blocking::after{content:'▸ bloquea';display:inline-block;margin-left:6px;font-size:0.6em;background:rgba(251,191,36,0.15);color:var(--yl);padding:1px 5px;border-radius:8px;font-weight:700;text-transform:uppercase;letter-spacing:0.3px}

/* Refresh pill flotante (cambios pendientes) */
.refresh-pill{position:fixed;bottom:20px;right:20px;z-index:9999;display:flex;align-items:center;gap:8px;padding:10px 14px;background:linear-gradient(135deg,var(--ac),#4a6cf7);color:#fff;border-radius:999px;box-shadow:0 6px 20px rgba(88,166,255,0.45),0 2px 8px rgba(0,0,0,0.3);cursor:pointer;font-size:0.85em;font-weight:600;opacity:0;transform:translateY(12px) scale(0.95);pointer-events:none;transition:opacity 0.25s,transform 0.25s}
.refresh-pill.rp-visible{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;animation:rp-pulse 2.5s ease-in-out infinite}
.refresh-pill:hover{box-shadow:0 8px 26px rgba(88,166,255,0.6),0 2px 8px rgba(0,0,0,0.4);transform:translateY(-2px) scale(1.02);animation:none}
.refresh-pill .rp-icon{font-size:1.1em;line-height:1}
.refresh-pill .rp-text{white-space:nowrap}
.refresh-pill .rp-close{margin-left:4px;opacity:0.75;padding:0 4px;border-radius:50%;font-size:1.1em;line-height:1}
.refresh-pill .rp-close:hover{opacity:1;background:rgba(0,0,0,0.2)}
@keyframes rp-pulse{0%,100%{box-shadow:0 6px 20px rgba(88,166,255,0.45),0 2px 8px rgba(0,0,0,0.3)}50%{box-shadow:0 6px 24px rgba(88,166,255,0.7),0 2px 10px rgba(0,0,0,0.4)}}

/* KPI clickeable (filter mode) */
.kpi-clickable{cursor:pointer;transition:transform 0.15s,box-shadow 0.15s}
.kpi-clickable:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,0.3)}
.kpi.kpi-active-filter{box-shadow:0 0 0 2px var(--rd),0 4px 12px rgba(248,113,113,0.3)}
.kpi.kpi-active-filter .kpi-trend::after{content:' · activo';color:var(--rd);font-weight:700}
.lc-card.lc-expanded{background:var(--sf2);border-left-color:var(--ac)}
.lc-card-main{padding:8px 10px;cursor:pointer}
.lc-top{display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:4px}
.lc-top-left{display:flex;align-items:center;gap:5px;min-width:0}
.lc-top-right{display:flex;align-items:center;gap:6px}
.lc-num{color:var(--ac);font-weight:700;font-size:0.95em;font-variant-numeric:tabular-nums;text-decoration:none}
.lc-num:hover{text-decoration:underline}
.lc-elapsed{font-size:0.82em;color:var(--dim);font-variant-numeric:tabular-nums}
.lc-elapsed.lc-warn{color:var(--yl);font-weight:700}
.lc-elapsed.lc-teal{color:#2dd4bf;font-weight:700}
.lc-prio-actions,.ah-prio-actions{display:inline-flex;gap:2px;margin-right:4px}
.lc-prio-btn{
  background:transparent;color:var(--dim);
  border:1px solid var(--bd);padding:0 4px;border-radius:3px;
  cursor:pointer;font-size:0.7em;font-family:inherit;line-height:1.4;
  min-width:18px;height:18px;
}
.lc-prio-btn:hover{background:rgba(255,255,255,0.06)}
.lc-prio-btn:disabled{opacity:0.4;cursor:wait}
.lc-prio-up:hover{border-color:#3fb950;color:#3fb950}
.lc-prio-down:hover{border-color:#f85149;color:#f85149}
.lc-card[draggable="true"]{cursor:grab}
.lc-card[draggable="true"]:active{cursor:grabbing}
.lc-card-dragging{opacity:0.4;outline:1px dashed var(--ac,#6d8cff)}
.lc-card.lc-drop-above{box-shadow:0 -3px 0 0 var(--ac,#6d8cff)}
.lc-card.lc-drop-below{box-shadow:0 3px 0 0 var(--ac,#6d8cff)}
.lc-pos{
  display:inline-block;background:var(--sf2,#1a1f2e);color:var(--dim,#9aa6c2);
  font-size:0.7em;font-weight:700;padding:1px 6px;border-radius:8px;
  border:1px solid var(--bd,#2a3560);font-variant-numeric:tabular-nums;
  margin-right:4px;line-height:1.4;
}
@keyframes prio-flash-ok-anim{
  0%{box-shadow:0 0 0 0 rgba(63,185,80,0.0);background:transparent}
  30%{box-shadow:0 0 0 3px rgba(63,185,80,0.45);background:rgba(63,185,80,0.10)}
  100%{box-shadow:0 0 0 0 rgba(63,185,80,0.0);background:transparent}
}
@keyframes prio-flash-err-anim{
  0%{box-shadow:0 0 0 0 rgba(248,81,73,0.0);background:transparent}
  30%{box-shadow:0 0 0 3px rgba(248,81,73,0.45);background:rgba(248,81,73,0.10)}
  100%{box-shadow:0 0 0 0 rgba(248,81,73,0.0);background:transparent}
}
.prio-flash-ok{animation:prio-flash-ok-anim 1.2s ease-out}
.prio-flash-err{animation:prio-flash-err-anim 1.2s ease-out}
#toast-host{
  position:fixed;bottom:18px;right:18px;z-index:9999;
  display:flex;flex-direction:column;gap:6px;pointer-events:none;
  max-width:min(420px,calc(100vw - 36px));
}
.toast{
  background:var(--card,#1a1f2e);color:var(--fg,#e0e6ed);
  border:1px solid var(--bd,#2a3560);border-radius:6px;
  padding:9px 14px;font-size:0.86em;font-family:inherit;
  box-shadow:0 4px 14px rgba(0,0,0,0.35);
  opacity:0;transform:translateY(8px);
  transition:opacity 0.18s ease,transform 0.18s ease;
}
.toast-show{opacity:1;transform:translateY(0)}
.toast-ok{border-left:3px solid #3fb950}
.toast-err{border-left:3px solid #f85149}
.toast-info{border-left:3px solid var(--ac,#6d8cff)}
.lc-gh{color:var(--dim);text-decoration:none;font-size:0.9em;padding:1px 4px;border-radius:3px;line-height:1}
.lc-gh:hover{color:var(--ac);background:rgba(109,140,255,0.1)}
.lc-title{font-size:0.95em;line-height:1.35;color:var(--tx);margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;font-weight:500;min-height:2.7em}
.lc-flag{color:var(--yl);margin-right:3px}
.lc-foot{display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap}
.lc-foot-left{display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-width:0}
.lc-ps{display:inline-flex;align-items:center;gap:2px;padding:2px 4px;background:rgba(255,255,255,0.02);border-radius:5px;flex-shrink:0}
.lc-pill{display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:10px;font-size:0.82em;font-weight:700;letter-spacing:0.2px}
.lc-pill-run{background:rgba(45,212,191,0.15);color:#2dd4bf;text-transform:lowercase}
.lc-pill-fail{background:rgba(248,113,113,0.15);color:var(--rd);text-transform:lowercase}
.lc-pill-wait{background:rgba(251,191,36,0.12);color:var(--yl);text-transform:lowercase}
.lc-pill-done{background:rgba(52,211,153,0.12);color:var(--gn);text-transform:lowercase}
.lc-pill-x{opacity:0.6;font-weight:400;margin-left:2px}
.lc-avatars{display:flex}
.lc-avatars-dim{opacity:0.55}
.lc-av{width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:0.85em;line-height:1;color:#fff;border:1.5px solid var(--sf);margin-right:-5px}
.lc-av:last-child{margin-right:0}
.lc-av-more{width:18px;height:18px;border-radius:50%;background:var(--sf2);color:var(--dim);display:inline-flex;align-items:center;justify-content:center;font-size:0.7em;font-weight:700;border:1.5px solid var(--sf);margin-right:0}
/* Block icons */
.lc-block-icon{font-size:0.85em;cursor:help;line-height:1}
.lc-block-locked{color:var(--rd)}
.lc-block-blocking{color:var(--yl)}
/* Detail inline (compacto) — expansion dentro de lane card */
.lc-detail{display:none;padding:8px 10px;border-top:1px solid var(--bd);background:var(--sf2);font-size:1em}
.lc-detail.lc-detail-open{display:block}
.lc-detail .pd-grid{display:block !important;margin-top:0;gap:0}
.lc-detail .pd-pipeline{margin-bottom:8px}
.lc-detail .pd-pipeline:last-child{margin-bottom:0}
.lc-detail .pd-pipeline-label{font-size:0.62em;letter-spacing:1.2px;padding:0 0 4px 0;opacity:0.7}
.lc-detail .pd-phase{gap:6px;padding:2px 4px;margin-bottom:1px;font-size:0.85em;align-items:center}
.lc-detail .pd-name{min-width:64px;font-size:0.72em;padding-top:0;text-transform:uppercase;letter-spacing:0.4px}
.lc-detail .pd-chips{gap:3px}
.lc-detail .chip{padding:2px 6px;font-size:0.78em;gap:3px}
.lc-detail .pd-current{background:rgba(45,212,191,0.08);border-left:2px solid var(--teal,#2dd4bf)}
.lc-detail .pd-empty{font-size:0.72em;color:var(--dim)}

/* Chip con log link — indicador visual */
.chip-log-icon{margin-left:3px;opacity:0.55;font-size:0.78em;line-height:1}
.log-link{text-decoration:none}
.log-link:hover .chip-log-icon{opacity:1}
.log-link:hover .chip.chip-has-log{box-shadow:0 0 0 1px rgba(88,166,255,0.4);cursor:pointer}

/* Completados section — collapsible */
.it-done-section{margin-top:12px;background:var(--sf2);border:1px dashed rgba(52,211,153,0.3);border-radius:8px;padding:8px 12px}
.it-done-section[open]{padding:10px 12px}
.it-done-head{display:flex;align-items:center;gap:8px;font-size:0.78em;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:var(--gn);cursor:pointer;list-style:none;user-select:none}
.it-done-head::-webkit-details-marker{display:none}
.it-done-arrow{color:var(--dim);font-size:0.9em;transition:transform 0.2s}
.it-done-section[open] .it-done-arrow{transform:rotate(90deg)}
.it-done-count{margin-left:auto;background:rgba(52,211,153,0.15);padding:1px 7px;border-radius:8px;font-size:0.82em}
.it-done-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:6px;margin-top:10px}
.it-done-grid .lc-card{opacity:0.75}

@media(max-width:900px){.it-lanes{grid-template-columns:1fr}}

.ic-hidden{display:none !important}

/* Oculta el legacy ic-list cards (conservamos estilos pero no los usamos en la vista principal) */
.ic-list{display:none}

/* ── Panel Equipo Option B ─────────────────────────────────────────────── */
.panel-equipo-full{margin-bottom:20px}
.eq-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--bd);gap:14px;flex-wrap:wrap}
.eq-title{margin:0;font-size:1.05em;font-weight:700}
.eq-summary{display:flex;gap:8px;align-items:center;font-size:0.76em;color:var(--dim)}
.eq-summary b{color:var(--tx);font-weight:700;margin:0 2px}

/* Active Cards XL */
.eq-active-cards{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.eq-card{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:8px 12px;background:linear-gradient(90deg,rgba(45,212,191,0.08),rgba(45,212,191,0.02));border:1px solid rgba(45,212,191,0.3);border-left:3px solid var(--teal,#2dd4bf);border-radius:var(--radius)}
.eq-card-avatar{position:relative;width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:1em;line-height:1;color:#fff;flex-shrink:0}
.eq-card-badge{position:absolute;top:-4px;right:-5px;min-width:14px;height:14px;padding:0 3px;background:var(--rd);color:#fff;border-radius:7px;font-size:0.6em;font-weight:800;display:inline-flex;align-items:center;justify-content:center;border:1.5px solid var(--sf)}
.eq-card-body{min-width:0}
.eq-card-name{font-size:0.88em;font-weight:700;color:var(--teal,#2dd4bf);display:flex;align-items:center;gap:6px}
.eq-card-ring{width:7px;height:7px;border-radius:50%;background:var(--teal,#2dd4bf);box-shadow:0 0 0 0 rgba(45,212,191,0.6);animation:pulse 1.5s infinite}
.eq-card-sub{font-size:0.85em;color:var(--dim);font-weight:400}
.eq-card-work{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;font-size:0.72em}
.eq-work-item{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;background:rgba(45,212,191,0.08);border-radius:5px;color:var(--dim);text-decoration:none;transition:background 0.15s}
.eq-work-item:hover{background:rgba(45,212,191,0.15)}
.eq-work-issue{color:var(--ac);font-weight:700;font-variant-numeric:tabular-nums}
.eq-work-fase{color:var(--dim);font-size:0.85em}
.eq-work-dur{color:var(--teal,#2dd4bf);font-weight:700;font-variant-numeric:tabular-nums}
.eq-work-bar{width:40px;height:3px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden}
.eq-work-bar-fill{height:100%;background:var(--teal,#2dd4bf);border-radius:2px}
.eq-card-kill{color:var(--dim);cursor:pointer;font-weight:700;font-size:1.2em;padding:4px 8px;border-radius:6px}
.eq-card-kill:hover{color:var(--rd);background:rgba(248,81,73,0.1)}

/* Agent History */
#agent-history .matrix-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--bd)}
#agent-history h2{margin:0;font-size:1.05em;font-weight:700}
.ah-count{font-size:0.76em;color:var(--dim)}
.ah-list{display:flex;flex-direction:column;gap:4px}
.ah-card{display:grid;grid-template-columns:28px 80px 1fr 80px 110px 60px 90px auto;gap:8px;align-items:center;padding:6px 12px;border-radius:var(--radius);border:1px solid var(--bd);border-left:3px solid var(--dim);text-decoration:none;font-size:0.78em;transition:background 0.15s,border-color 0.15s}
.ah-card:hover{background:rgba(255,255,255,0.04);border-color:var(--ac)}
.ah-running{border-left-color:var(--teal,#2dd4bf);background:rgba(45,212,191,0.05)}
.ah-ok{border-left-color:var(--gn,#3fb950)}
.ah-fail{border-left-color:var(--rd,#f85149)}
.ah-neutral{border-left-color:var(--dim)}
.ah-avatar{width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:0.9em;color:#fff;flex-shrink:0}
.ah-skill{font-weight:700;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ah-issue{color:var(--ac);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ah-fase{color:var(--dim);font-size:0.9em}
.ah-status{font-weight:600;white-space:nowrap}
.ah-running .ah-status{color:var(--teal,#2dd4bf)}
.ah-ok .ah-status{color:var(--gn,#3fb950)}
.ah-fail .ah-status{color:var(--rd,#f85149)}
.ah-neutral .ah-status{color:var(--dim)}
.ah-dur{color:var(--teal,#2dd4bf);font-weight:700;font-variant-numeric:tabular-nums;text-align:right}
.ah-time{color:var(--dim);font-size:0.9em;font-variant-numeric:tabular-nums;text-align:right}
.ah-pdf{text-decoration:none;font-size:1.1em}
.ah-more{margin-top:4px}
.ah-more-btn{font-size:0.78em;color:var(--ac);cursor:pointer;padding:6px 12px;text-align:center;border-radius:var(--radius);background:rgba(88,166,255,0.06);border:1px solid rgba(88,166,255,0.15);list-style:none}
.ah-more-btn:hover{background:rgba(88,166,255,0.12)}
.ah-more-list{display:flex;flex-direction:column;gap:4px;margin-top:4px}
@media(max-width:900px){.ah-card{grid-template-columns:24px 60px 1fr 70px 50px 70px auto;font-size:0.72em}}
@media(max-width:600px){.ah-card{grid-template-columns:24px 1fr 80px auto;}.ah-fase,.ah-dur,.ah-time{display:none}}

/* Areas grid 2×2 */
.eq-areas-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.eq-area-card{background:var(--sf2);border:1px solid var(--bd);border-radius:var(--radius);padding:8px 10px}
.eq-area-card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:0.66em;text-transform:uppercase;letter-spacing:0.7px;font-weight:700}
.eq-area-card-name{display:flex;align-items:center;gap:5px;color:var(--muted,#8b949e)}
.eq-area-card-dot{width:5px;height:5px;border-radius:50%;flex-shrink:0}
.eq-area-card-sub{font-size:0.92em;color:var(--dim);font-weight:400}
.eq-area-card-sub b{color:var(--tx);font-weight:700}
.eq-area-card-active{color:var(--teal,#2dd4bf);font-weight:700}
.eq-area-card-chips{display:flex;flex-wrap:wrap;gap:3px}

/* Chips compactos */
.eq-chip{position:relative;display:inline-flex;align-items:center;gap:4px;padding:2px 7px 2px 3px;background:var(--sf);border:1px solid var(--bd);border-radius:999px;font-size:0.68em;cursor:help;transition:border-color 0.15s,transform 0.15s}
.eq-chip:hover{border-color:var(--teal,#2dd4bf);transform:translateY(-1px)}
.eq-chip-avatar{width:16px;height:16px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:0.82em;line-height:1;color:#fff;flex-shrink:0}
.eq-chip-name{font-weight:500;color:var(--tx);white-space:nowrap}
.eq-chip-dot{width:5px;height:5px;border-radius:50%;background:var(--gn);flex-shrink:0}
.eq-chip-busy{border-color:rgba(45,212,191,0.5);background:rgba(45,212,191,0.07)}
.eq-chip-busy .eq-chip-dot{background:var(--teal,#2dd4bf);box-shadow:0 0 0 0 rgba(45,212,191,0.6);animation:pulse 1.5s infinite}
.eq-chip-busy .eq-chip-name{color:var(--teal,#2dd4bf);font-weight:700}
.eq-chip-badge{min-width:14px;height:14px;padding:0 3px;background:var(--teal,#2dd4bf);color:#001a1a;border-radius:7px;font-size:0.82em;font-weight:800;display:inline-flex;align-items:center;justify-content:center}

/* Servicios abajo */
.eq-svc-section{margin-top:14px;padding-top:12px;border-top:1px solid var(--bd)}
.eq-svc-head{font-size:0.72em;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--dim);margin-bottom:8px}
.eq-svc-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
@media(max-width:900px){.eq-svc-grid{grid-template-columns:1fr}}
@media(max-width:720px){.eq-areas-grid{grid-template-columns:1fr}}

/* Recomendaciones de agentes (issue #2653) */
.reco-section summary{position:relative}
.reco-count{display:inline-block;background:#bc8cff;color:#0d1117;border-radius:10px;padding:1px 8px;font-size:0.75em;font-weight:700;margin-left:6px}
.reco-count[data-count="0"]{background:var(--dim);color:#0d1117}
.reco-meta{font-size:0.72em;color:var(--dim);font-weight:400;margin-left:6px}
.reco-err{background:rgba(248,81,73,0.12);border:1px solid var(--rd);color:var(--rd);padding:6px 10px;border-radius:4px;font-size:0.85em;margin-bottom:8px}
.reco-table{width:100%;border-collapse:collapse;font-size:0.85em}
.reco-table th{text-align:left;padding:6px 8px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:0.4px;font-size:0.72em;border-bottom:1px solid var(--bd)}
.reco-table td{padding:6px 8px;border-bottom:1px solid rgba(255,255,255,0.04);vertical-align:top}
.reco-table tr:hover td{background:rgba(255,255,255,0.02)}
.reco-num a{color:var(--ac);text-decoration:none;font-weight:700}
.reco-title{max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reco-from{color:var(--dim);font-size:0.85em}
.reco-created{font-size:0.78em}
.reco-agent{display:inline-block;padding:1px 7px;border-radius:8px;font-size:0.7em;font-weight:700;text-transform:uppercase;background:rgba(188,140,255,0.15);color:#bc8cff}
.reco-agent-security{background:rgba(248,81,73,0.15);color:#f85149}
.reco-agent-po{background:rgba(210,153,34,0.15);color:#d29922}
.reco-agent-ux{background:rgba(247,120,186,0.15);color:#f778ba}
.reco-agent-review{background:rgba(255,166,87,0.15);color:#ffa657}
.reco-actions{white-space:nowrap;text-align:right}
.reco-btn{background:var(--card,#1a1f2e);color:var(--fg,#e0e6ed);border:1px solid var(--bd,#2a3560);padding:4px 10px;border-radius:4px;cursor:pointer;font-size:0.78em;margin-left:4px;font-family:inherit}
.reco-btn:hover{background:rgba(255,255,255,0.06)}
.reco-btn-approve{border-color:#3fb950;color:#3fb950}
.reco-btn-approve:hover{background:rgba(63,185,80,0.12)}
.reco-btn-reject{border-color:#f85149;color:#f85149}
.reco-btn-reject:hover{background:rgba(248,81,73,0.12)}

</style></head>
<body>
  <div class="hdr-bar">
    <div class="hdr-left">
      <h1 class="hdr-title">🐙 Pipeline ${v3Active ? 'V2+V3' : 'V2'}</h1>
      ${v3Active ? `<span class="hdr-v3-badge" title="V3 activo · workers determinísticos: ${v3Workers.join(', ')}">⚙ V3 (${v3Workers.length})</span>` : ''}
      <a href="/consumo" class="hdr-v3-badge" style="text-decoration:none;cursor:pointer;" title="V3 · Consumo de tokens / tiempo / TTS por agente, fase e issue (#2477)">📊 Consumo</a>
      <button class="hdr-status-badge ${isPaused ? 'badge-paused' : isPartialPause ? 'badge-paused' : 'badge-running'}" onclick="pauseAction('${isPaused || isPartialPause ? 'resume' : 'pause'}')" title="${isPaused ? 'Pipeline pausado — click para reanudar' : isPartialPause ? 'Pausa parcial — click para reanudar completo' : 'Click para pausar el pipeline'}">${isPaused ? '⏸ PAUSADO' : isPartialPause ? `⏸ PARCIAL (${partialPauseState.allowedIssues.length})` : '▶ RUNNING'}</button>
      ${isPartialPause ? `<span class="hdr-v3-badge" title="Pausa parcial — solo estos issues procesan" style="background:rgba(240,165,0,0.15);color:#f0a500;border-color:rgba(240,165,0,0.4);">🎯 ${partialPauseState.allowedIssues.map(i => '#' + i).join(', ')}</span>` : ''}
      <button id="autorefresh-btn" class="badge-autorefresh ar-off" onclick="toggleAutoRefresh()" title="Auto-refresh desactivado — click para activar">↻ AUTO</button>
      <span class="hdr-uptime">UP ${pulpoUptime}</span>
      <span class="hdr-meta">📊 ${dashboardBuild}<span class="hdr-meta-sep">|</span>🐙 ${pulpoBuild}</span>
    </div>
    <div class="hdr-right">
      <div class="hdr-clock" id="hdr-clock">--:--<span class="clock-sec">--</span></div>
      <div class="hdr-date" id="hdr-date"></div>
    </div>
  </div>
  <div class="hdr-status-line ${stale > 0 ? 'sl-danger' : isPaused ? 'sl-warn' : trabajando > 0 ? 'sl-active' : 'sl-idle'}"></div>
  ${(() => {
    const pw = state.priorityWindows || {};
    const qaActive = pw.qa && pw.qa.active;
    const buildActive = pw.build && pw.build.active;
    const blockedNow = (typeof blocked !== 'undefined') && blocked;
    let barCls = 'ctrl-ok';
    if (blockedNow) barCls = 'ctrl-blocked';
    else if (isPaused) barCls = 'ctrl-paused';
    else if (qaActive) barCls = 'ctrl-priority-qa';
    else if (buildActive) barCls = 'ctrl-priority-build';
    else if (stale > 0) barCls = 'ctrl-stale';

    let statusHtml;
    if (blockedNow) {
      statusHtml = '<span class="ctrl-bar-status"><span class="ctrl-bar-status-icon">\u26D4</span>Recursos al l\u00EDmite \u2014 nuevos lanzamientos en espera</span>';
    } else if (isPaused) {
      statusHtml = '<span class="ctrl-bar-status"><span class="ctrl-bar-status-icon">\u23F8\uFE0F</span>Pipeline en pausa</span>'
        + '<button class="ctrl-bar-btn" onclick="pauseAction(\'resume\')" title="Reanudar lanzamientos">\u25B6 Reanudar</button>';
    } else if (isPartialPause) {
      const allowedList = partialPauseState.allowedIssues.map(i => '#' + i).join(', ');
      statusHtml = '<span class="ctrl-bar-status"><span class="ctrl-bar-status-icon">\u{1F3AF}</span>Pausa parcial \u00B7 allowed: ' + allowedList + '</span>'
        + '<button class="ctrl-bar-btn" onclick="pauseAction(\'resume\')" title="Desactivar pausa parcial y reanudar todo">\u25B6 Reanudar</button>';
    } else if (qaActive) {
      const elapsed = pw.qa.activatedAt ? Math.round((Date.now() - pw.qa.activatedAt) / 60000) : 0;
      statusHtml = '<span class="ctrl-bar-status"><span class="ctrl-bar-status-icon">\u{1F50D}</span>Ventana QA activa \u00B7 ' + elapsed + ' min</span>'
        + '<button class="ctrl-bar-btn" onclick="pwAction(\'qa\',\'off\')" title="Desactivar ventana QA">\u2715 Cerrar</button>';
    } else if (buildActive) {
      const elapsed = pw.build.activatedAt ? Math.round((Date.now() - pw.build.activatedAt) / 60000) : 0;
      statusHtml = '<span class="ctrl-bar-status"><span class="ctrl-bar-status-icon">\u{1F528}</span>Ventana Build activa \u00B7 ' + elapsed + ' min</span>'
        + '<button class="ctrl-bar-btn" onclick="pwAction(\'build\',\'off\')" title="Desactivar ventana Build">\u2715 Cerrar</button>';
    } else if (stale > 0) {
      statusHtml = '<span class="ctrl-bar-status"><span class="ctrl-bar-status-icon">\u26A0\uFE0F</span>' + stale + ' issue' + (stale > 1 ? 's' : '') + ' sin avance (+30 min)</span>';
    } else {
      const msg = trabajando > 0 ? trabajando + ' agente' + (trabajando > 1 ? 's' : '') + ' trabajando' : 'Sin actividad';
      statusHtml = '<span class="ctrl-bar-status"><span class="ctrl-bar-status-icon">\u2713</span>' + msg + '</span>';
    }

    // Toggles de Priority Windows (siempre visibles a la derecha, salvo si ya hay una activa en el status)
    let pwThreshold = 3;
    try {
      const cfgYaml = yaml.load(fs.readFileSync(path.join(ROOT, '.pipeline', 'config.yaml'), 'utf8'));
      pwThreshold = (cfgYaml.resource_limits || {}).priority_windows_activation_threshold || 3;
    } catch {}
    const items = [
      { key: 'qa', emoji: '\u{1F50D}', label: 'QA', cls: '' },
      { key: 'build', emoji: '\u{1F528}', label: 'Build', cls: ' pw-build' }
    ];
    const otherActive = (k) => items.some(j => j.key !== k && pw[j.key] && pw[j.key].active);
    const togglesHtml = items.map(i => {
      const s = pw[i.key];
      const active = s && s.active;
      const elapsed = active && s.activatedAt ? Math.round((Date.now() - s.activatedAt) / 60000) : 0;
      const text = active ? i.emoji + ' ' + i.label + ' \u00B7 ' + elapsed + 'm' : i.emoji + ' ' + i.label;
      let tip = active
        ? i.label + ' Priority activa (' + elapsed + 'm) \u2014 click para desactivar'
        : 'Activar ' + i.label + ' Priority (umbral auto: ' + pwThreshold + ' issues)';
      if (!active && otherActive(i.key)) tip += ' \u2014 \u26A0 la otra ventana est\u00E1 activa (autoexcluyentes)';
      const action = active ? 'off' : 'on';
      const cls = active ? 'pw-toggle-active' : 'pw-toggle-inactive';
      return '<span class="pw-toggle ' + cls + i.cls + '" title="' + tip + '" onclick="pwAction(\'' + i.key + '\',\'' + action + '\')">' + text + '</span>';
    }).join('');

    // Toggle de pausa (solo cuando no está pausado ni bloqueado — si está pausado, ya hay botón Reanudar en el status)
    const pauseBtnHtml = (!isPaused && !blockedNow)
      ? '<button class="ctrl-bar-btn" onclick="pauseAction(\'pause\')" title="Pausar todos los lanzamientos">\u23F8 Pausar</button>'
      : '';

    return '<div class="pipeline-ctrl-bar ' + barCls + '">'
      + statusHtml
      + '<span class="ctrl-bar-spacer"></span>'
      + '<span class="ctrl-bar-label">Priority</span>'
      + '<span class="pw-toggles">' + togglesHtml + '</span>'
      + (pauseBtnHtml ? '<span class="ctrl-bar-sep"></span>' + pauseBtnHtml : '')
      + '</div>';
  })()}

  ${renderInfraHealth(state)}

  <div id="kpi-tooltip" class="kpi-tooltip"></div>
  <div class="kpis-row">
    <div class="kpis kpis-6">
      <div class="kpi kpi-definidos" data-tt='${ttDefinidos}'>
        <div class="kpi-label">Definidos</div>
        <div class="kpi-value" style="color:var(--pu)">${definidos}</div>
        <div class="kpi-trend">backlog total</div>
      </div>
      <div class="kpi kpi-pendientes" data-tt='${ttPendientes}'>
        <div class="kpi-label">En cola</div>
        <div class="kpi-value ${pendientes > 0 ? '' : 'muted'}" style="color:var(--or)">${pendientes}</div>
        <div class="kpi-trend">esperando agente</div>
      </div>
      <div class="kpi kpi-working" data-tt='${ttTrabajando}'>
        <div class="kpi-label">Ejecución</div>
        <div class="kpi-value ${trabajando > 0 ? 'warn' : 'muted'}">${trabajando}</div>
        <div class="kpi-trend">${trabajando > 0 ? 'agentes activos' : 'sin agentes'}</div>
      </div>
      <div class="kpi kpi-entregados" data-tt='${ttEntregados24h}'>
        <div class="kpi-label">Entregados 24h</div>
        <div class="kpi-value success">${entregados24h}</div>
        <div class="kpi-trend">últimas 24 horas</div>
      </div>
      <div class="kpi kpi-blocked kpi-clickable" data-tt='${ttBlocked}' data-blocked-ids='${blockedIdsJson}' data-blocking-deps='${blockingDepsJson}' onclick="toggleBlockedFilter(this)" title="${blockedCount > 0 ? 'Click para filtrar el Issue Tracker por bloqueados + deps' : 'No hay issues bloqueados'}">
        <div class="kpi-label">Bloqueados${blockedCount > 0 ? ' \u{1F6AB}' : ''}</div>
        <div class="kpi-value ${blockedCount > 0 ? 'danger' : 'muted'}">${blockedCount}</div>
        <div class="kpi-trend">${blockedCount > 0 ? 'click para filtrar' : 'sin bloqueos'}</div>
      </div>
      <div class="kpi kpi-needs-human ${bloqueados.length > 0 ? 'has-blocked kpi-clickable' : ''}" ${bloqueados.length > 0 ? 'onclick="toggleNeedsHumanPanel(true)" title="Click para colapsar/expandir el listado de incidentes"' : 'title="Sin incidentes esperando humano"'}>
        <div class="kpi-label">${bloqueados.length > 0 ? '\u{1F6A8} ' : ''}Necesitan humano</div>
        <div class="kpi-value ${bloqueados.length > 0 ? 'danger' : 'muted'}">${bloqueados.length}</div>
        <div class="kpi-trend">${bloqueados.length > 0 ? 'click para colapsar/expandir' : 'pipeline fluido'}</div>
      </div>
    </div>
    ${(() => {
      const scoreCls = healthScore > 60 ? 'ok' : healthScore > 30 ? 'warn' : 'crit';
      const circ = 163;
      const cpuOff = Math.round(circ - (circ * Math.min(100, res.cpuPercent) / 100));
      const memOff = Math.round(circ - (circ * Math.min(100, res.memPercent) / 100));
      return `
      <div class="sys-mini-card sys-mini-${scoreCls}">
        <div class="sys-mini-score">
          <div class="sys-mini-lbl">Salud</div>
          <div class="sys-mini-val sys-mini-${scoreCls}">${healthScore}</div>
          <div class="sys-mini-tag sys-mini-${scoreCls}">${healthLabel}</div>
        </div>
        <div class="sys-mini-gauge">
          <svg viewBox="0 0 62 62" class="sys-mini-svg"><circle class="sys-mini-track" cx="31" cy="31" r="26"/><circle class="sys-mini-fill sys-mini-${cpuStatus}" cx="31" cy="31" r="26" stroke-dasharray="${circ}" stroke-dashoffset="${cpuOff}"/></svg>
          <div class="sys-mini-center"><div class="v">${res.cpuPercent}%</div><div class="l">CPU</div></div>
        </div>
        <div class="sys-mini-gauge">
          <svg viewBox="0 0 62 62" class="sys-mini-svg"><circle class="sys-mini-track" cx="31" cy="31" r="26"/><circle class="sys-mini-fill sys-mini-${memStatus}" cx="31" cy="31" r="26" stroke-dasharray="${circ}" stroke-dashoffset="${memOff}"/></svg>
          <div class="sys-mini-center"><div class="v">${res.memPercent}%</div><div class="l">RAM</div></div>
        </div>
      </div>`;
    })()}
  </div>

  <div class="bar-section panel-equipo panel-equipo-full">
    <div class="eq-head">
      <h2 class="eq-title">🧠 Equipo</h2>
      <div class="eq-summary">
        <span>Activos <b>${eqTotalBusy}</b>/${eqTotalSkills}</span>
        <span>\u00B7</span>
        <span>Utilización <b>${eqTotalSkills > 0 ? Math.round(eqTotalBusy / eqTotalSkills * 100) : 0}%</b></span>
        <span>\u00B7</span>
        <span>Cola <b>${pendientes}</b></span>
      </div>
    </div>
    ${activeStripHTML}
    ${eqAreaGridHTML || '<span class="empty-label">Sin skills configurados</span>'}
    ${svcCardsHTML ? '<div class="eq-svc-section"><div class="eq-svc-head">⚙ Servicios</div><div class="svc-grid eq-svc-grid">' + svcCardsHTML + '</div></div>' : ''}
  </div>

  ${matrixHTML}

  ${historyHTML}

  ${renderRecommendationsSection()}

  ${state.rechazos.length > 0 ? `<details class="collapse-section"><summary>🚫 Rechazos recientes<span>${state.rechazos.length}</span></summary><div class="collapse-body">${rechazosHTML}</div></details>` : ''}

  <details class="collapse-section"><summary>💬 Actividad Commander</summary><div class="collapse-body" style="max-height:300px;overflow-y:auto">${actHTML}</div></details>

  <div class="footer" id="dash-footer">🟢 Live · Refresh on-demand &nbsp;|&nbsp; ${new Date().toLocaleString('es-AR')}</div>

<!-- Log Viewer Panel -->
<div id="log-overlay" class="log-overlay" onclick="if(event.target===this)closeLogViewer()">
  <div class="log-panel">
    <div class="log-header">
      <span id="log-title" class="log-title"></span>
      <span id="log-status-badge"></span>
      <button class="log-open-tab" onclick="openLogInTab()" title="Abrir en nueva pestaña">↗ Tab</button>
      <button class="log-close" onclick="closeLogViewer()" title="Cerrar (Esc)">✕</button>
    </div>
    <div class="log-toolbar">
      <input type="text" id="log-search" class="log-search" placeholder="Buscar en el log…" oninput="filterLog()" onkeydown="if(event.key==='Enter')jumpToMatch(event.shiftKey?-1:1)">
      <span id="log-match-count" class="log-match-count"></span>
      <select id="log-filter" class="log-filter" onchange="filterLog()">
        <option value="all">Todo</option>
        <option value="error">❌ Errores</option>
        <option value="warning">⚠ Warnings</option>
        <option value="tool">🔧 Tools</option>
        <option value="success">✓ Éxitos</option>
      </select>
      <button id="log-pause-btn" class="log-btn" onclick="togglePause()">⏸ Pause</button>
    </div>
    <div id="log-body" class="log-body"></div>
    <div class="log-footer">
      <span id="log-line-count"></span>
      <span id="log-last-update"></span>
      <button id="log-scroll-btn" class="log-scroll-btn" onclick="scrollLogToBottom()">⬇ Ir al final</button>
    </div>
  </div>
</div>

<script>
(function(){var c=document.getElementById('hdr-clock'),d=document.getElementById('hdr-date');if(!c)return;var D=['dom','lun','mar','mi\u00e9','jue','vie','s\u00e1b'],M=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];function t(){var n=new Date(),h=String(n.getHours()).padStart(2,'0'),m=String(n.getMinutes()).padStart(2,'0'),s=String(n.getSeconds()).padStart(2,'0');c.innerHTML=h+':'+m+'<span class="clock-sec">'+s+'</span>';d.textContent=D[n.getDay()]+' '+n.getDate()+' '+M[n.getMonth()]+' '+n.getFullYear()}t();setInterval(t,1000)})();
// Guardar estado del Issue Tracker en sessionStorage
let __itRestoring = false;
function saveIssueTrackerState() {
  if (__itRestoring) return;
  try {
    const expanded = [];
    document.querySelectorAll('.ic-detail.open').forEach(d => {
      const m = d.id.match(/detail-(\\d+)/);
      if (m) expanded.push(m[1]);
    });
    const laneExpanded = [];
    document.querySelectorAll('.lc-detail.lc-detail-open').forEach(d => {
      const m = d.id.match(/lc-detail-(\\d+)/);
      if (m) laneExpanded.push(m[1]);
    });
    const activeTab = document.querySelector('.ic-tab-active');
    const filter = activeTab ? activeTab.dataset.filter : 'active';
    // Sub-chip filters per lane (persist selection after SSE refresh)
    const subFilters = {};
    document.querySelectorAll('.it-sub-chip.active').forEach(c => {
      const lane = c.dataset.lane;
      const sf = c.dataset.subfase || '';
      if (lane) subFilters[lane] = sf;
    });
    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    sessionStorage.setItem('__it_state', JSON.stringify({ expanded, laneExpanded, filter, subFilters, scrollY }));
  } catch(_) {}
}

// Guardar estado en TODA recarga (F5, SSE, navegación, etc.)
window.addEventListener('beforeunload', saveIssueTrackerState);

// ── Salud de Infra (#2306): copy-to-clipboard pasivo del CTA de reanudación ──
// Solo copia texto al portapapeles — NO ejecuta acciones server-side (evita CSRF).
document.addEventListener('click', function(e) {
  const btn = e.target && e.target.closest && e.target.closest('.ih-copy');
  if (!btn) return;
  const text = btn.getAttribute('data-copy') || '';
  if (!text) return;
  const done = () => {
    const original = btn.textContent;
    btn.classList.add('ih-copy-ok');
    btn.textContent = '✓';
    setTimeout(() => {
      btn.classList.remove('ih-copy-ok');
      btn.textContent = original;
    }, 1500);
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {
        // Fallback legacy
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          done();
        } catch(_) {}
      });
    }
  } catch(_) {}
});

// ── Soft refresh: reemplaza secciones sin recargar la página (evita flash) ──
let __softRefreshInFlight = false;
async function softRefresh() {
  if (__softRefreshInFlight) return;
  // No refrescar si hay log overlay abierto
  const logOv = document.getElementById('log-overlay');
  if (logOv && logOv.classList.contains('open')) return;
  // Si el foco está en el input de búsqueda, diferimos el refresh — molesta mientras escribe
  const ae = document.activeElement;
  if (ae && ae.classList && ae.classList.contains('it-search')) return;
  __softRefreshInFlight = true;
  try {
    // Preservar state actual (scroll, tabs, sub-filters, search, expansiones)
    saveIssueTrackerState();
    const searchVal = (document.getElementById('it-search-input') || {}).value || '';
    // Cerrar popup de dots (puede quedar stale si el DOM cambia)
    closeDotPopup && closeDotPopup();
    const res = await fetch(window.location.href, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return;
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Reemplazar secciones clave
    const selectors = [
      '.hdr-bar',
      '.hdr-status-line',
      '.pipeline-ctrl-bar',
      '.infra-health',
      '.kpis-row',
      '.panel-equipo-full',
      '#issue-tracker',
      '#agent-history',
    ];
    for (const sel of selectors) {
      const newEl = doc.querySelector(sel);
      const oldEl = document.querySelector(sel);
      if (newEl && oldEl) oldEl.replaceWith(newEl);
    }
    // Re-aplicar valor de búsqueda si había
    const newInp = document.getElementById('it-search-input');
    if (newInp && searchVal) {
      newInp.value = searchVal;
      filterIssuesBySearch(searchVal);
    }
    // Rehidratar el resto del estado (tabs, sub-filters, scroll, expansiones legacy)
    restoreIssueTrackerState();
    // Re-atachar listeners sobre KPIs nuevos
    if (typeof attachKpiTooltips === 'function') attachKpiTooltips();
    // Restaurar estado del botón auto-refresh (el DOM swap trae el default del server)
    if (__autoRefresh) {
      const arBtn = document.getElementById('autorefresh-btn');
      if (arBtn) {
        arBtn.className = 'badge-autorefresh ar-on';
        arBtn.textContent = '↻ AUTO ' + AUTO_REFRESH_SECONDS + 's';
        arBtn.title = 'Auto-refresh cada ' + AUTO_REFRESH_SECONDS + 's — click para desactivar';
      }
    }
  } catch (_) { /* silenciar */ }
  finally { __softRefreshInFlight = false; }
}

// Auto-refresh toggle + pill on-demand
let lastHash = null;
let __pendingChanges = 0;
let __lastChangeTs = null;
let __autoRefresh = true;
let __autoRefreshInterval = null;
const AUTO_REFRESH_SECONDS = 10;

function toggleAutoRefresh() {
  __autoRefresh = !__autoRefresh;
  const btn = document.getElementById('autorefresh-btn');
  if (__autoRefresh) {
    btn.className = 'badge-autorefresh ar-on';
    btn.textContent = '↻ AUTO ' + AUTO_REFRESH_SECONDS + 's';
    btn.title = 'Auto-refresh cada ' + AUTO_REFRESH_SECONDS + 's — click para desactivar';
    dismissRefreshPill();
    softRefresh();
    __autoRefreshInterval = setInterval(() => softRefresh(), AUTO_REFRESH_SECONDS * 1000);
  } else {
    btn.className = 'badge-autorefresh ar-off';
    btn.textContent = '↻ AUTO';
    btn.title = 'Auto-refresh desactivado — click para activar';
    if (__autoRefreshInterval) { clearInterval(__autoRefreshInterval); __autoRefreshInterval = null; }
  }
  updateFooter();
}

function updateFooter() {
  const ft = document.getElementById('dash-footer');
  if (!ft) return;
  const ts = new Date().toLocaleString('es-AR');
  ft.innerHTML = __autoRefresh
    ? '🟢 Live · Auto-refresh cada ' + AUTO_REFRESH_SECONDS + 's &nbsp;|&nbsp; ' + ts
    : '🟢 Live · Refresh on-demand &nbsp;|&nbsp; ' + ts;
}

function showRefreshPill() {
  if (__autoRefresh) return;
  let pill = document.getElementById('refresh-pill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'refresh-pill';
    pill.className = 'refresh-pill';
    pill.innerHTML = '<span class="rp-icon">🔄</span><span class="rp-text"></span><span class="rp-close" title="Descartar" onclick="event.stopPropagation();dismissRefreshPill()">×</span>';
    pill.onclick = applyPendingRefresh;
    document.body.appendChild(pill);
  }
  const textEl = pill.querySelector('.rp-text');
  const ago = __lastChangeTs ? Math.max(0, Math.round((Date.now() - __lastChangeTs) / 1000)) : 0;
  const agoTxt = ago < 60 ? ago + 's' : Math.round(ago / 60) + 'm';
  textEl.textContent = __pendingChanges === 1
    ? '1 cambio nuevo · hace ' + agoTxt
    : __pendingChanges + ' cambios nuevos · último hace ' + agoTxt;
  pill.classList.add('rp-visible');
}
function dismissRefreshPill() {
  const pill = document.getElementById('refresh-pill');
  if (pill) pill.classList.remove('rp-visible');
  __pendingChanges = 0;
}
async function applyPendingRefresh() {
  await softRefresh();
  __pendingChanges = 0;
  __lastChangeTs = null;
  const pill = document.getElementById('refresh-pill');
  if (pill) pill.classList.remove('rp-visible');
}
// Actualizar el "hace Xs" cada 10s mientras el pill esté visible
setInterval(() => {
  const pill = document.getElementById('refresh-pill');
  if (pill && pill.classList.contains('rp-visible') && __pendingChanges > 0) showRefreshPill();
}, 10000);

const es = new EventSource('/events');
es.onmessage = e => {
  if (lastHash && e.data !== lastHash) {
    if (__autoRefresh) {
      // En modo auto, el interval se encarga — no acumular
    } else {
      __pendingChanges++;
      __lastChangeTs = Date.now();
      showRefreshPill();
    }
  }
  lastHash = e.data;
};
es.onerror = () => { /* silent */ };

// Auto-activar auto-refresh al cargar la página (default ON)
if (__autoRefresh) {
  const arBtn = document.getElementById('autorefresh-btn');
  if (arBtn) {
    arBtn.className = 'badge-autorefresh ar-on';
    arBtn.textContent = '↻ AUTO ' + AUTO_REFRESH_SECONDS + 's';
    arBtn.title = 'Auto-refresh cada ' + AUTO_REFRESH_SECONDS + 's — click para desactivar';
  }
  updateFooter();
  __autoRefreshInterval = setInterval(() => softRefresh(), AUTO_REFRESH_SECONDS * 1000);
}

// Restaurar estado UI — se invoca después de definir las funciones necesarias
function restoreIssueTrackerState() {
  try {
    const saved = sessionStorage.getItem('__it_state');
    if (!saved) return;
    const { expanded, laneExpanded, filter, subFilters, scrollY } = JSON.parse(saved);
    __itRestoring = true;
    if (expanded && expanded.length > 0) {
      expanded.forEach(id => {
        const detail = document.getElementById('detail-' + id);
        const btn = document.getElementById('expand-btn-' + id);
        const header = detail ? detail.closest('.ic-card')?.querySelector('.ic-header') : null;
        if (detail) { detail.classList.add('open'); detail.setAttribute('aria-hidden', 'false'); }
        if (btn) { btn.classList.add('expanded'); btn.setAttribute('aria-expanded', 'true'); }
        if (header) header.setAttribute('aria-expanded', 'true');
      });
    }
    // Restaurar expansiones de lane cards
    if (laneExpanded && laneExpanded.length > 0) {
      laneExpanded.forEach(id => {
        const d = document.getElementById('lc-detail-' + id);
        if (d) {
          d.classList.add('lc-detail-open');
          d.setAttribute('aria-hidden', 'false');
          const card = d.closest('.lc-card');
          if (card) card.classList.add('lc-expanded');
        }
      });
    }
    if (filter && filter !== 'active') {
      const tab = document.querySelector('.ic-tab[data-filter="' + filter + '"]');
      if (tab) filterIssueTab(tab, filter);
    }
    // Restaurar sub-chip filters
    if (subFilters) {
      for (const [lane, sf] of Object.entries(subFilters)) {
        filterLaneBySubFase(lane, sf);
      }
    }
    __itRestoring = false;
    if (scrollY > 0) requestAnimationFrame(() => window.scrollTo(0, scrollY));
  } catch(_) { __itRestoring = false; }
}

// KPI Tooltips
let tt = document.getElementById('kpi-tooltip');
const GH_BASE = 'https://github.com/intrale/platform/issues/';
const MAX_TT = 20;
function attachKpiTooltips() {
  tt = document.getElementById('kpi-tooltip');
  if (!tt) return;
  document.querySelectorAll('.kpi[data-tt]').forEach(el => {
    if (el.__ttAttached) return;
    el.__ttAttached = true;
    el.addEventListener('mouseenter', e => {
      try {
        const d = JSON.parse(el.dataset.tt);
        const shown = d.items.slice(0, MAX_TT);
        const rows = shown.map(it =>
          '<div class="tt-item"><a href="' + GH_BASE + it.id + '" target="_blank">#' + it.id + '</a>' +
          (it.label ? ' <span style="color:var(--dim)">— ' + it.label + '</span>' : '') + '</div>'
        ).join('');
        const more = d.items.length > MAX_TT
          ? '<div class="tt-more">+ ' + (d.items.length - MAX_TT) + ' más…</div>' : '';
        tt.innerHTML = '<div class="tt-title">' + d.title + ' (' + d.items.length + ')</div>' + rows + more;
        tt.style.display = 'block';
        positionTt(e);
      } catch(_) {}
    });
    el.addEventListener('mousemove', positionTt);
    el.addEventListener('mouseleave', () => { tt.style.display = 'none'; });
  });
}
attachKpiTooltips();
function positionTt(e) {
  const pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  const r = tt.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 10) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 10) y = e.clientY - r.height - pad;
  tt.style.left = x + 'px';
  tt.style.top = y + 'px';
}

// --- Start/Stop actions ---
async function ctlAction(target, action) {
  // Find the button that was clicked and show loading state
  const btns = document.querySelectorAll('.ctl-btn');
  btns.forEach(b => { if (b.onclick && b.onclick.toString().includes(target)) b.classList.add('loading'); });

  try {
    const resp = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, action })
    });
    const result = await resp.json();
    showToast(result.msg, result.ok);
    // Reload after a short delay to show updated state
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    showToast('Error de conexión: ' + e.message, false);
  }
  btns.forEach(b => b.classList.remove('loading'));
}

// Pause/resume pipeline
async function pauseAction(action) {
  try {
    const resp = await fetch('/api/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    const result = await resp.json();
    showToast(result.msg, result.ok);
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    showToast('Error de conexión: ' + e.message, false);
  }
}

// QA component action (individual or all)
async function qaComponentAction(component, action) {
  const btn = event && event.target ? event.target : null;
  if (btn) btn.classList.add('loading');
  try {
    const body = component === 'all'
      ? { target: 'qa', action }
      : { target: 'qa', action, component };
    const resp = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await resp.json();
    showToast(result.msg, result.ok);
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    showToast('Error: ' + e.message, false);
  }
  if (btn) btn.classList.remove('loading');
}

// Kill agent
async function killAgent(issue, skill, pipeline, fase) {
  if (!confirm('¿Cancelar agente ' + skill + ' en #' + issue + '?')) return;
  try {
    const resp = await fetch('/api/kill-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue, skill, pipeline, fase })
    });
    const result = await resp.json();
    showToast(result.msg, result.ok);
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    showToast('Error: ' + e.message, false);
  }
}

// Kill all agents of a skill group
async function killSkillGroup(skill, agents) {
  if (!confirm('¿Cancelar todos los agentes ' + skill + ' (' + agents.length + ' activos)?')) return;
  let ok = 0, fail = 0;
  for (const a of agents) {
    try {
      const resp = await fetch('/api/kill-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue: a.issue, skill: a.skill, pipeline: a.pipeline, fase: a.fase })
      });
      const result = await resp.json();
      if (result.ok) ok++; else fail++;
    } catch { fail++; }
  }
  showToast(skill + ': ' + ok + ' cancelados' + (fail > 0 ? ', ' + fail + ' fallaron' : ''), fail === 0);
  setTimeout(() => location.reload(), 1500);
}

// Priority Window toggle
async function pwAction(window, action) {
  try {
    const resp = await fetch('/api/priority-window', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ window, action })
    });
    const result = await resp.json();
    showToast(result.msg, result.ok);
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    showToast('Error de conexión: ' + e.message, false);
  }
}

function toggleIssueDetail(issueNum) {
  const detail = document.getElementById('detail-' + issueNum);
  const btn = document.getElementById('expand-btn-' + issueNum);
  const header = detail ? detail.closest('.ic-card')?.querySelector('.ic-header') : null;
  if (!detail) return;
  const isOpen = detail.classList.contains('open');
  const nowOpen = !isOpen;
  detail.classList.toggle('open', nowOpen);
  detail.setAttribute('aria-hidden', String(!nowOpen));
  if (btn) { btn.classList.toggle('expanded', nowOpen); btn.setAttribute('aria-expanded', String(nowOpen)); }
  if (header) header.setAttribute('aria-expanded', String(nowOpen));
  saveIssueTrackerState();
}

function filterLaneBySubFase(laneKey, subFase) {
  const lane = document.querySelector('.it-lane[data-lane="' + laneKey + '"]');
  if (!lane) return;
  lane.querySelectorAll('.it-sub-chip').forEach(c => {
    c.classList.toggle('active', (c.dataset.subfase || '') === (subFase || ''));
  });
  lane.querySelectorAll('.lc-card').forEach(c => {
    if (!subFase) { c.classList.remove('lc-filtered-out-sub'); return; }
    const sf = c.dataset.subfase || '';
    c.classList.toggle('lc-filtered-out-sub', sf !== subFase);
  });
  saveIssueTrackerState();
}

// Filtro de bloqueados desde el KPI — muestra blocked + sus deps bloqueantes
function toggleBlockedFilter(kpiEl) {
  if (!kpiEl) return;
  let blockedIds, blockingDeps;
  try {
    blockedIds = JSON.parse(kpiEl.dataset.blockedIds || '[]');
    blockingDeps = JSON.parse(kpiEl.dataset.blockingDeps || '[]');
  } catch (_) { return; }
  if (blockedIds.length === 0) return;
  const active = kpiEl.classList.toggle('kpi-active-filter');
  const relevant = new Set([...blockedIds, ...blockingDeps].map(String));
  document.querySelectorAll('.lc-card').forEach(c => {
    if (!active) { c.classList.remove('lc-filtered-blocked'); c.classList.remove('lc-hl-blocked'); c.classList.remove('lc-hl-blocking'); return; }
    const issue = c.dataset.issue;
    const isBlocked = blockedIds.includes(issue);
    const isBlocking = blockingDeps.includes(issue);
    c.classList.toggle('lc-filtered-blocked', !isBlocked && !isBlocking);
    c.classList.toggle('lc-hl-blocked', isBlocked);
    c.classList.toggle('lc-hl-blocking', isBlocking);
  });
  document.querySelectorAll('.it-lane').forEach(lane => {
    const visible = lane.querySelectorAll('.lc-card:not(.lc-filtered-blocked):not(.lc-filtered-out-sub):not(.lc-filtered-out-search)').length;
    lane.classList.toggle('it-lane-empty-search', active && visible === 0);
  });
  if (active) {
    const tracker = document.getElementById('issue-tracker');
    if (tracker) tracker.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// Búsqueda por # o título en todo el tracker
function filterIssuesBySearch(query) {
  const q = (query || '').trim().toLowerCase();
  document.querySelectorAll('.lc-card').forEach(c => {
    if (!q) { c.classList.remove('lc-filtered-out-search'); return; }
    const hay = (c.dataset.search || '').includes(q);
    c.classList.toggle('lc-filtered-out-search', !hay);
  });
  // Ocultar lanes sin matches
  document.querySelectorAll('.it-lane').forEach(lane => {
    const visible = lane.querySelectorAll('.lc-card:not(.lc-filtered-out-search):not(.lc-filtered-out-sub)').length;
    lane.classList.toggle('it-lane-empty-search', q && visible === 0);
  });
  saveIssueTrackerState();
}
function clearIssueSearch() {
  const inp = document.getElementById('it-search-input');
  if (inp) inp.value = '';
  filterIssuesBySearch('');
}

// Popup con detalle de la fase al click en un dot
function showDotPopup(event, dotEl) {
  let data;
  try { data = JSON.parse(dotEl.dataset.popup); } catch(_) { return; }
  const popup = document.getElementById('dot-popup');
  if (!popup) return;
  popup.querySelector('.dp-title').innerHTML = '<b>' + data.fase + '</b> · ' + data.pipeline + ' · #' + data.issue;
  const body = popup.querySelector('.dp-body');
  if (!data.skills || data.skills.length === 0) {
    body.innerHTML = '<div class="dp-empty">Sin actividad</div>';
  } else {
    body.innerHTML = data.skills.map(function(s){
      var icon, cls;
      if (s.resultado === 'aprobado') { icon = '✓'; cls = 'ok'; }
      else if (s.resultado) { icon = '✗'; cls = 'fail'; }
      else if (s.estado === 'trabajando') { icon = '▶'; cls = 'run'; }
      else if (s.estado === 'listo' || s.estado === 'procesado') { icon = '✓'; cls = 'ok'; }
      else { icon = '○'; cls = 'pending'; }
      var retry = s.retry ? '<span class="dp-retry">×'+s.retry+'</span>' : '';
      var dur = s.dur ? '<span class="dp-dur">'+s.dur+'</span>' : '';
      var log = s.log ? '<a href="'+s.log+'" target="_blank" class="dp-log" onclick="event.stopPropagation()">📄 ver log</a>' : '';
      var pdf = s.pdf ? '<a href="'+s.pdf+'" target="_blank" class="dp-log" onclick="event.stopPropagation()">📑 PDF rechazo</a>' : '';
      var motivo = s.motivo ? '<div class="dp-motivo">' + s.motivo + '</div>' : '';
      return '<div class="dp-row dp-'+cls+'"><div class="dp-row-top"><span class="dp-state">'+icon+'</span><span class="dp-skill">'+s.skill+'</span>'+retry+dur+'</div>'+motivo+'<div class="dp-links">'+log+pdf+'</div></div>';
    }).join('');
  }
  const rect = dotEl.getBoundingClientRect();
  popup.style.display = 'block';
  popup.style.position = 'fixed';
  popup.style.left = '0px';
  popup.style.top = '0px';
  const pr = popup.getBoundingClientRect();
  let left = rect.left + rect.width/2 - pr.width/2;
  let top = rect.bottom + 8;
  if (left < 8) left = 8;
  if (left + pr.width > window.innerWidth - 8) left = window.innerWidth - pr.width - 8;
  if (top + pr.height > window.innerHeight - 8) top = rect.top - pr.height - 8;
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
}
function closeDotPopup() {
  const p = document.getElementById('dot-popup');
  if (p) p.style.display = 'none';
}
document.addEventListener('click', function(e){
  const p = document.getElementById('dot-popup');
  if (!p || p.style.display === 'none') return;
  if (!p.contains(e.target) && !e.target.classList.contains('stepper-dot')) {
    p.style.display = 'none';
  }
});
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeDotPopup(); });

function filterIssueTab(tabEl, filter) {
  document.querySelectorAll('.ic-tab').forEach(t => {
    t.classList.remove('ic-tab-active');
    t.setAttribute('aria-selected', 'false');
  });
  tabEl.classList.add('ic-tab-active');
  tabEl.setAttribute('aria-selected', 'true');
  // Hide/show lanes container and completed section according to tab
  const lanesEl = document.querySelector('.it-lanes');
  const doneEl = document.querySelector('.it-done-section');
  if (lanesEl) lanesEl.classList.toggle('ic-hidden', filter === 'completed');
  if (doneEl) doneEl.classList.toggle('ic-hidden', filter === 'active');
  // Also honor legacy ic-card cards (if any remain)
  document.querySelectorAll('.ic-card, .lc-card').forEach(card => {
    const status = card.dataset.status;
    if (filter === 'all') card.classList.remove('ic-hidden');
    else card.classList.toggle('ic-hidden', status !== filter);
  });
  saveIssueTrackerState();
}

function showToast(msg, ok) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'toast ' + (ok ? 'toast-ok' : 'toast-err');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Restaurar estado del Issue Tracker (tabs, expansiones, scroll) ────
restoreIssueTrackerState();

// ── Log Viewer ────────────────────────────────────────────────────────
let logViewerES = null;
let logViewerFile = null;
let logViewerPaused = false;
let logAllLines = [];
let logMatchIndices = [];
let logCurrentMatch = -1;
let logAutoScroll = true;

function classifyLine(text) {
  if (/error|exception|fail|❌|CRASH|panic/i.test(text)) return 'log-error';
  if (/warn|⚠|WARNING/i.test(text)) return 'log-warning';
  if (/\[Tool:|tool_use|Edit\]|Read\]|Write\]|Bash\]|Grep\]|Glob\]/i.test(text)) return 'log-tool';
  if (/✓|passed|success|✔|completed|APROBADO/i.test(text)) return 'log-success';
  if (/^---\s|^\[.*\]\s*$|^=+$/.test(text)) return 'log-meta';
  return '';
}

/** Parsear una línea de stream-json de Claude CLI a texto legible para el log viewer */
function parseStreamJsonLine(raw) {
  if (!raw || !raw.startsWith('{')) return raw; // No es JSON, devolver tal cual
  try {
    const ev = JSON.parse(raw);
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') return '[init] modelo: ' + (ev.model || '?') + ' | tools: ' + (ev.tools || []).length;
        return '[system] ' + (ev.subtype || '') + ' ' + (ev.message || '');
      case 'assistant':
        if (ev.subtype === 'text') return ev.content || '';
        if (ev.subtype === 'tool_use') {
          var name = ev.tool_name || ev.name || '?';
          var inp = '';
          try {
            var input = ev.input || ev.tool_input || {};
            if (input.command) inp = ': ' + input.command.substring(0, 120);
            else if (input.pattern) inp = ': ' + input.pattern;
            else if (input.file_path) inp = ': ' + input.file_path;
            else if (input.skill) inp = ': ' + input.skill;
            else if (input.query) inp = ': ' + input.query.substring(0, 80);
          } catch(_) {}
          return '[Tool] ' + name + inp;
        }
        return ev.content || JSON.stringify(ev).substring(0, 200);
      case 'result':
        var cost = ev.cost_usd ? ' ($' + ev.cost_usd.toFixed(4) + ')' : '';
        var dur = ev.duration_ms ? ' ' + Math.round(ev.duration_ms / 1000) + 's' : '';
        return '[result] ' + (ev.subtype || 'done') + cost + dur;
      default:
        // Otros tipos: mostrar tipo + contenido resumido
        if (ev.content) return '[' + ev.type + '] ' + (typeof ev.content === 'string' ? ev.content.substring(0, 200) : JSON.stringify(ev.content).substring(0, 200));
        return raw.substring(0, 200);
    }
  } catch(_) {
    return raw; // Parse falló, devolver raw
  }
}

function renderLine(text, idx) {
  var display = parseStreamJsonLine(text);
  if (!display || !display.trim()) return ''; // Skip empty lines
  var cls = classifyLine(display);
  var escaped = display.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return '<div class="log-line ' + cls + '" data-idx="' + idx + '"><span class="log-line-num">' + (idx + 1) + '</span><span class="log-line-text">' + escaped + '</span></div>';
}

function openLogViewer(filename, title, isLive) {
  logViewerFile = filename;
  logAllLines = [];
  logMatchIndices = [];
  logCurrentMatch = -1;
  logAutoScroll = true;
  logViewerPaused = false;

  document.getElementById('log-title').textContent = title;
  document.getElementById('log-status-badge').innerHTML = isLive
    ? '<span class="log-live-badge"><span class="log-live-dot"></span> LIVE</span>'
    : '<span class="log-done-badge">Finalizado</span>';
  document.getElementById('log-body').innerHTML = '<div class="log-empty"><div class="log-empty-spinner"></div>Cargando log…</div>';
  document.getElementById('log-search').value = '';
  document.getElementById('log-match-count').textContent = '';
  document.getElementById('log-filter').value = 'all';
  document.getElementById('log-pause-btn').textContent = '⏸ Pause';
  document.getElementById('log-pause-btn').classList.toggle('active', false);
  document.getElementById('log-pause-btn').style.display = isLive ? '' : 'none';
  document.getElementById('log-line-count').textContent = '';
  document.getElementById('log-scroll-btn').classList.remove('visible');
  document.getElementById('log-overlay').classList.add('open');

  // Close SSE if open
  if (logViewerES) { logViewerES.close(); logViewerES = null; }

  // Open SSE stream
  logViewerES = new EventSource('/logs/stream/' + encodeURIComponent(filename));
  logViewerES.onmessage = function(e) {
    if (logViewerPaused) return;
    try {
      const msg = JSON.parse(e.data);
      const body = document.getElementById('log-body');
      if (msg.type === 'init') {
        logAllLines = msg.lines;
        body.innerHTML = msg.lines.map((l, i) => renderLine(l, i)).join('');
        scrollLogToBottom();
      } else if (msg.type === 'append') {
        const startIdx = logAllLines.length;
        logAllLines.push(...msg.lines);
        const html = msg.lines.map((l, i) => renderLine(l, startIdx + i)).join('');
        body.insertAdjacentHTML('beforeend', html);
        if (logAutoScroll) scrollLogToBottom();
      }
      updateLogFooter();
      // Re-apply filter/search if active
      const searchVal = document.getElementById('log-search').value;
      const filterVal = document.getElementById('log-filter').value;
      if (searchVal || filterVal !== 'all') applyFilterVisual();
    } catch(_) {}
  };
  logViewerES.onerror = function() {
    // Connection lost — show in status
    const badge = document.getElementById('log-status-badge');
    if (badge) badge.innerHTML = '<span class="log-done-badge">Desconectado</span>';
  };

  // Track scroll for auto-scroll toggle
  const body = document.getElementById('log-body');
  body.onscroll = function() {
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    logAutoScroll = atBottom;
    document.getElementById('log-scroll-btn').classList.toggle('visible', !atBottom);
  };
}

function closeLogViewer() {
  document.getElementById('log-overlay').classList.remove('open');
  if (logViewerES) { logViewerES.close(); logViewerES = null; }
}

function openLogInTab() {
  if (logViewerFile) window.open('/logs/' + logViewerFile, '_blank');
}

function scrollLogToBottom() {
  const body = document.getElementById('log-body');
  body.scrollTop = body.scrollHeight;
  logAutoScroll = true;
  document.getElementById('log-scroll-btn').classList.remove('visible');
}

function togglePause() {
  logViewerPaused = !logViewerPaused;
  const btn = document.getElementById('log-pause-btn');
  btn.textContent = logViewerPaused ? '▶ Resume' : '⏸ Pause';
  btn.classList.toggle('active', logViewerPaused);
}

function updateLogFooter() {
  document.getElementById('log-line-count').textContent = logAllLines.length + ' líneas';
  document.getElementById('log-last-update').textContent = 'Actualizado: ' + new Date().toLocaleTimeString('es-AR');
}

function filterLog() {
  applyFilterVisual();
}

function applyFilterVisual() {
  const searchVal = document.getElementById('log-search').value.toLowerCase();
  const filterVal = document.getElementById('log-filter').value;
  const body = document.getElementById('log-body');
  const lines = body.querySelectorAll('.log-line');
  logMatchIndices = [];

  lines.forEach((el, i) => {
    const text = logAllLines[i] || '';
    const textLower = text.toLowerCase();
    let visible = true;

    // Category filter
    if (filterVal !== 'all') {
      const cls = classifyLine(text);
      const filterMap = { error: 'log-error', warning: 'log-warning', tool: 'log-tool', success: 'log-success' };
      if (cls !== filterMap[filterVal]) visible = false;
    }

    // Search filter
    if (searchVal && visible) {
      if (textLower.includes(searchVal)) {
        logMatchIndices.push(i);
        el.classList.add('log-highlight');
      } else {
        el.classList.remove('log-highlight');
        visible = false;
      }
    } else {
      el.classList.remove('log-highlight');
    }

    el.style.display = visible ? '' : 'none';
    el.classList.remove('log-highlight-current');
  });

  // Update match count
  const countEl = document.getElementById('log-match-count');
  if (searchVal && logMatchIndices.length > 0) {
    logCurrentMatch = 0;
    highlightCurrentMatch();
    countEl.textContent = logMatchIndices.length + ' coincidencias';
  } else if (searchVal) {
    countEl.textContent = '0 coincidencias';
    logCurrentMatch = -1;
  } else {
    countEl.textContent = filterVal !== 'all' ? logMatchIndices.length + ' filtradas' : '';
    // When only filter, show matching lines without search
    if (filterVal !== 'all' && !searchVal) {
      lines.forEach((el, i) => {
        const text = logAllLines[i] || '';
        const cls = classifyLine(text);
        const filterMap = { error: 'log-error', warning: 'log-warning', tool: 'log-tool', success: 'log-success' };
        el.style.display = cls === filterMap[filterVal] ? '' : 'none';
      });
    }
  }
}

function highlightCurrentMatch() {
  if (logCurrentMatch < 0 || logMatchIndices.length === 0) return;
  const body = document.getElementById('log-body');
  body.querySelectorAll('.log-highlight-current').forEach(el => el.classList.remove('log-highlight-current'));
  const idx = logMatchIndices[logCurrentMatch];
  const target = body.querySelector('.log-line[data-idx="' + idx + '"]');
  if (target) {
    target.classList.add('log-highlight-current');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  document.getElementById('log-match-count').textContent = (logCurrentMatch + 1) + '/' + logMatchIndices.length;
}

function jumpToMatch(direction) {
  if (logMatchIndices.length === 0) return;
  logCurrentMatch = (logCurrentMatch + direction + logMatchIndices.length) % logMatchIndices.length;
  highlightCurrentMatch();
}

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
  if (!document.getElementById('log-overlay').classList.contains('open')) return;
  if (e.key === 'Escape') { closeLogViewer(); e.preventDefault(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    document.getElementById('log-search').focus();
  }
});

// Recomendaciones de agentes (issue #2653)
async function recoRefresh() {
  try {
    const r = await fetch('/api/recommendations/refresh', { method: 'POST' });
    const j = await r.json();
    if (j.ok) location.reload();
    else alert('Error refrescando: ' + (j.msg || 'desconocido'));
  } catch (e) { alert('Error refrescando: ' + e.message); }
}
async function recoApprove(num) {
  if (!confirm('Aprobar recomendación #' + num + '? Entrará al pipeline en el próximo ciclo.')) return;
  try {
    const r = await fetch('/api/recommendations/' + num + '/approve', { method: 'POST' });
    const j = await r.json();
    if (j.ok) { recoRefresh(); }
    else alert('Error: ' + (j.msg || 'desconocido'));
  } catch (e) { alert('Error: ' + e.message); }
}
async function recoReject(num) {
  const reason = prompt('Motivo del rechazo (opcional):', '');
  if (reason === null) return;
  try {
    const r = await fetch('/api/recommendations/' + num + '/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason || '' })
    });
    const j = await r.json();
    if (j.ok) { recoRefresh(); }
    else alert('Error: ' + (j.msg || 'desconocido'));
  } catch (e) { alert('Error: ' + e.message); }
}

// Quick actions de prioridad por issue (cards de Issue Tracker y Equipo en ejecución)
function _prioCallApi(issueNum, action) {
  return fetch('/api/issue/' + issueNum + '/' + action, { method: 'POST' })
    .then(r => r.json());
}
function _prioFindButtons(issueNum, action) {
  const fnName = (action === 'move-up' || action === 'up') ? 'issueMoveUp' : 'issueMoveDown';
  return Array.from(document.querySelectorAll('button.lc-prio-btn'))
    .filter(b => (b.getAttribute('onclick') || '').includes(fnName + '(' + issueNum + ')'));
}
function _prioSetLoading(issueNum, action, loading) {
  const btns = _prioFindButtons(issueNum, action);
  for (const b of btns) {
    if (loading) {
      b.dataset.origText = b.textContent;
      b.textContent = '⋯';
      b.disabled = true;
    } else {
      if (b.dataset.origText) b.textContent = b.dataset.origText;
      b.disabled = false;
    }
  }
}
function _prioFlashCards(issueNum, ok) {
  const cards = document.querySelectorAll('[data-issue="' + issueNum + '"]');
  cards.forEach(c => {
    c.classList.add(ok ? 'prio-flash-ok' : 'prio-flash-err');
    setTimeout(() => c.classList.remove('prio-flash-ok', 'prio-flash-err'), 1200);
  });
}
function showToast(msg, type) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = 'toast toast-' + (type || 'info');
  t.textContent = msg;
  host.appendChild(t);
  // forzar reflow para que la animación de entrada arranque
  void t.offsetWidth;
  t.classList.add('toast-show');
  setTimeout(() => {
    t.classList.remove('toast-show');
    setTimeout(() => t.remove(), 250);
  }, 2200);
}
// Encuentra al vecino visible dentro de la misma lane (def/dev/qa) del issue.
// Si el issue no está en una lane (ej: card en la sección Equipo), busca el
// vecino en CUALQUIER lane visible.
function _findLanePeer(issueNum, direction) {
  const target = document.querySelector('.lc-card[data-issue="' + issueNum + '"][data-status="active"]');
  if (!target) return { error: 'card-not-visible' };
  const lane = target.dataset.lane;
  // Cards de la misma lane, en orden DOM (que es el orden visual)
  const peers = Array.from(document.querySelectorAll(
    '.lc-card[data-lane="' + lane + '"][data-status="active"]'
  ));
  const idx = peers.findIndex(p => p.dataset.issue === String(issueNum));
  if (idx === -1) return { error: 'not-in-lane' };
  if (direction === 'up') {
    if (idx === 0) return { error: 'already-top' };
    return { peer: peers[idx - 1].dataset.issue };
  } else {
    if (idx === peers.length - 1) return { error: 'already-bottom' };
    return { peer: peers[idx + 1].dataset.issue };
  }
}
async function _issueMove(issueNum, direction) {
  const action = direction === 'up' ? 'move-up' : 'move-down';
  const arrow = direction === 'up' ? '▲' : '▼';
  // Resolver peer dentro de la lane visual (no del array global)
  const lookup = _findLanePeer(issueNum, direction);
  if (lookup.error === 'already-top' || lookup.error === 'already-bottom') {
    showToast('#' + issueNum + ' ya está en el ' + (lookup.error === 'already-top' ? 'tope' : 'fondo') + ' de la columna', 'info');
    return;
  }
  _prioSetLoading(issueNum, action, true);
  try {
    const r = await fetch('/api/issue/' + issueNum + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lookup.peer ? { peer: lookup.peer } : {})
    });
    const j = await r.json();
    if (j.ok) {
      _prioFlashCards(issueNum, true);
      showToast(arrow + ' #' + issueNum + ' ' + (j.msg || 'movido'), 'ok');
      setTimeout(() => location.reload(), 500);
    } else {
      _prioSetLoading(issueNum, action, false);
      if (j.msg === 'already-top' || j.msg === 'already-bottom') {
        showToast('#' + issueNum + ' ya está en el ' + (j.msg === 'already-top' ? 'tope' : 'fondo'), 'info');
      } else {
        _prioFlashCards(issueNum, false);
        showToast('Error: ' + (j.msg || 'desconocido'), 'err');
      }
    }
  } catch (e) {
    _prioSetLoading(issueNum, action, false);
    _prioFlashCards(issueNum, false);
    showToast('Error moviendo #' + issueNum + ': ' + e.message, 'err');
  }
}
function issueMoveUp(issueNum) { return _issueMove(issueNum, 'up'); }
function issueMoveDown(issueNum) { return _issueMove(issueNum, 'down'); }

// Drag-and-drop nativo HTML5 sobre las cards del Issue Tracker.
// Solo dentro de la misma lane: la lane se determina por estado del filesystem,
// no por decisión del usuario.
let _draggedCard = null;
let _draggedLane = null;
function onCardDragStart(e) {
  const card = e.currentTarget;
  if (card.getAttribute('draggable') === 'false') { e.preventDefault(); return; }
  _draggedCard = card;
  _draggedLane = card.dataset.lane;
  card.classList.add('lc-card-dragging');
  try {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.issue);
  } catch (err) {}
}
function onCardDragOver(e) {
  if (!_draggedCard) return;
  const card = e.currentTarget;
  if (card === _draggedCard) return;
  if (card.dataset.lane !== _draggedLane) return; // solo dentro de la misma lane
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  // Indicador visual: línea arriba o abajo según posición del cursor
  const rect = card.getBoundingClientRect();
  const isAbove = (e.clientY - rect.top) < rect.height / 2;
  card.classList.toggle('lc-drop-above', isAbove);
  card.classList.toggle('lc-drop-below', !isAbove);
}
function onCardDragLeave(e) {
  e.currentTarget.classList.remove('lc-drop-above', 'lc-drop-below');
}
function onCardDrop(e) {
  if (!_draggedCard) return;
  const card = e.currentTarget;
  if (card === _draggedCard) return;
  if (card.dataset.lane !== _draggedLane) return;
  e.preventDefault();
  const rect = card.getBoundingClientRect();
  const isAbove = (e.clientY - rect.top) < rect.height / 2;
  card.classList.remove('lc-drop-above', 'lc-drop-below');
  // Reorder DOM optimista: insertar la draggedCard arriba o abajo del target
  const parent = card.parentNode;
  if (isAbove) parent.insertBefore(_draggedCard, card);
  else parent.insertBefore(_draggedCard, card.nextSibling);
  // Mandar al server el orden completo de TODAS las cards activas (todas las lanes)
  _persistDragOrder();
}
function onCardDragEnd(e) {
  if (_draggedCard) _draggedCard.classList.remove('lc-card-dragging');
  document.querySelectorAll('.lc-drop-above, .lc-drop-below').forEach(c => {
    c.classList.remove('lc-drop-above', 'lc-drop-below');
  });
  _draggedCard = null;
  _draggedLane = null;
}
async function _persistDragOrder() {
  // Recolectar el orden actual de TODAS las cards activas (ordenadas como están
  // en el DOM, lane por lane, top→bottom). El server hace setOrder con esto.
  const allCards = Array.from(document.querySelectorAll('.lc-card[data-status="active"]'));
  const order = allCards.map(c => c.dataset.issue);
  try {
    const r = await fetch('/api/issues/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order })
    });
    const j = await r.json();
    if (j.ok) {
      showToast('✓ Orden actualizado (' + order.length + ' issues)', 'ok');
    } else {
      showToast('Error guardando orden: ' + (j.msg || 'desconocido'), 'err');
      setTimeout(() => location.reload(), 600);
    }
  } catch (e) {
    showToast('Error guardando orden: ' + e.message, 'err');
    setTimeout(() => location.reload(), 600);
  }
}

// Toggle de la sección "Salud de Infra" — colapsable + persistente (default: colapsada)
function toggleInfraHealth() {
  const sec = document.querySelector('section.infra-health');
  if (!sec) return;
  const willCollapse = !sec.classList.contains('ih-collapsed');
  sec.classList.toggle('ih-collapsed');
  try { localStorage.setItem('ih-collapsed', willCollapse ? '1' : '0'); } catch (e) {}
}
(function restoreInfraHealthState(){
  try {
    const sec = document.querySelector('section.infra-health');
    if (!sec) return;
    if (localStorage.getItem('ih-collapsed') === '0') {
      sec.classList.remove('ih-collapsed');
    }
  } catch (e) {}
})();

// Toggle del panel "Necesitan intervención humana" — colapsable + persistente
function toggleNeedsHumanPanel(scrollOnExpand) {
  const panel = document.getElementById('bloqueados-humano');
  if (!panel) return;
  const willCollapse = !panel.classList.contains('nh-collapsed');
  panel.classList.toggle('nh-collapsed');
  try { localStorage.setItem('nh-panel-collapsed', willCollapse ? '1' : '0'); } catch (e) {}
  if (!willCollapse && scrollOnExpand) {
    panel.scrollIntoView({behavior:'smooth', block:'start'});
  }
}
(function restoreNeedsHumanPanelState(){
  try {
    if (localStorage.getItem('nh-panel-collapsed') === '1') {
      const panel = document.getElementById('bloqueados-humano');
      if (panel) panel.classList.add('nh-collapsed');
    }
  } catch (e) {}
})();

// Quick actions sobre issues con label needs-human (panel "Necesitan intervención humana")
function nhDisableButtons(issueNum) {
  document.querySelectorAll('.needs-human-row button[onclick*="(' + issueNum + ')"]').forEach(b => { b.disabled = true; });
}
async function needsHumanReactivate(issueNum) {
  if (!confirm('Reactivar #' + issueNum + '? Volverá a la cola del pipeline sin orientación adicional.')) return;
  nhDisableButtons(issueNum);
  try {
    const r = await fetch('/api/needs-human/' + issueNum + '/reactivate', { method: 'POST' });
    const j = await r.json();
    if (j.ok) location.reload();
    else { alert('Error reactivando: ' + (j.msg || 'desconocido')); location.reload(); }
  } catch (e) { alert('Error reactivando: ' + e.message); location.reload(); }
}
async function needsHumanDismiss(issueNum) {
  const reason = prompt('Motivo para desestimar #' + issueNum + ' (opcional):', '');
  if (reason === null) return;
  if (!confirm('Cerrar #' + issueNum + ' como desestimado? Se quitará del panel y quedará cerrado en GitHub.')) return;
  nhDisableButtons(issueNum);
  try {
    const r = await fetch('/api/needs-human/' + issueNum + '/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason || '' })
    });
    const j = await r.json();
    if (j.ok) location.reload();
    else { alert('Error desestimando: ' + (j.msg || 'desconocido')); location.reload(); }
  } catch (e) { alert('Error desestimando: ' + e.message); location.reload(); }
}
</script>
</body></html>`;
}

// --- Metrics ---

/**
 * Inferir actividad histórica desde timestamps de archivos procesados y activity log.
 * Genera snapshots sintéticos para poblar /metrics cuando no hay datos del Pulpo.
 */
function inferHistoricalActivity() {
  const events = []; // { ts, type, fase, skill }

  // 1. Archivos procesados/listo de todas las fases — cada uno es un "agente terminó"
  const config = loadConfig();
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    for (const fase of pConfig.fases) {
      for (const estado of ['procesado', 'listo', 'trabajando', 'pendiente']) {
        const dir = path.join(PIPELINE, pName, fase, estado);
        for (const f of listWorkFiles(dir)) {
          const st = fileStat(path.join(dir, f));
          if (!st) continue;
          const skill = f.split('.').slice(1).join('.');
          // birthtime = creación, ctime = movido a este dir
          if (st.birthtimeMs > 0) events.push({ ts: st.birthtimeMs, type: 'start', fase, skill });
          if (st.ctimeMs > st.birthtimeMs) events.push({ ts: st.ctimeMs, type: 'end', fase, skill });
        }
      }
    }
  }

  // 2. Activity log — tool calls como proxy de actividad
  try {
    const archiveFile = path.join(path.dirname(PIPELINE), '.claude', 'activity-log.archive.jsonl');
    const lines = fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      try {
        const d = JSON.parse(l);
        const ts = typeof d.ts === 'string' ? new Date(d.ts).getTime() : d.ts;
        if (ts > 0) events.push({ ts, type: 'tool', fase: 'agent', skill: d.session?.slice(0, 8) || '' });
      } catch {}
    }
  } catch {}

  if (events.length === 0) return [];

  // Ordenar y agrupar en buckets de 5min
  events.sort((a, b) => a.ts - b.ts);
  const BUCKET_MS = 300000; // 5 minutos
  const minTs = events[0].ts;
  const maxTs = events[events.length - 1].ts;
  const snapshots = [];

  for (let t = minTs; t <= maxTs; t += BUCKET_MS) {
    const bucketEnd = t + BUCKET_MS;
    const inBucket = events.filter(e => e.ts >= t && e.ts < bucketEnd);
    const agents = new Set(inBucket.filter(e => e.type === 'start' || e.type === 'tool').map(e => e.skill)).size;
    const byFase = {};
    for (const e of inBucket) {
      if (!byFase[e.fase]) byFase[e.fase] = { working: 0, pending: 0 };
      if (e.type === 'start') byFase[e.fase].working++;
      if (e.type === 'end') byFase[e.fase].pending++;
    }
    // Estimar CPU/RAM basándose en cantidad de agentes activos
    const estCpu = Math.min(95, agents * 20 + (inBucket.length > 5 ? 15 : 5));
    const estMem = Math.min(95, 40 + agents * 12);
    const level = estCpu > 90 || estMem > 90 ? 'red' : estCpu > 80 || estMem > 80 ? 'orange' : estCpu > 65 || estMem > 65 ? 'yellow' : 'green';

    snapshots.push({
      ts: t,
      cpu: estCpu,
      mem: estMem,
      level,
      agents,
      byFase,
      inferred: true // Marcar como dato inferido
    });
  }

  return snapshots;
}

function getMetricsData() {
  const metricsFile = path.join(PIPELINE, 'metrics-history.jsonl');
  let snapshots = [];
  try {
    const lines = fs.readFileSync(metricsFile, 'utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      try { snapshots.push(JSON.parse(l)); } catch {}
    }
  } catch {}

  // Si no hay snapshots del Pulpo, inferir actividad histórica desde archivos procesados
  // Esto da una timeline de cuándo hubo trabajo en cada fase
  if (snapshots.length < 10) {
    const inferred = inferHistoricalActivity();
    if (inferred.length > snapshots.length) snapshots = inferred;
  }

  // Promedios de duración por fase/skill (reusar lógica de ETA)
  const state = getPipelineState();
  const etaAverages = state.etaAverages || {};

  // Throughput: issues completados por período (de archivos en entrega/procesado)
  const entregas = [];
  try {
    const dir = path.join(PIPELINE, 'desarrollo', 'entrega', 'procesado');
    for (const f of listWorkFiles(dir)) {
      const st = fileStat(path.join(dir, f));
      if (st) entregas.push({ issue: f.split('.')[0], ts: st.ctimeMs });
    }
  } catch {}
  entregas.sort((a, b) => a.ts - b.ts);

  // Cuota Anthropic estimada (del activity log)
  const tokenEstimates = { totalSessions: 0, totalTools: 0, totalEstimatedTokens: 0, bySession: [] };
  try {
    const archiveFile = path.join(path.dirname(PIPELINE), '.claude', 'activity-log.archive.jsonl');
    const lines = fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean);
    const sessions = {};
    for (const l of lines) {
      try {
        const d = JSON.parse(l);
        if (!d.session) continue;
        if (!sessions[d.session]) sessions[d.session] = { tools: 0, firstTs: d.ts, lastTs: d.ts };
        sessions[d.session].tools++;
        sessions[d.session].lastTs = d.ts;
      } catch {}
    }
    for (const [id, s] of Object.entries(sessions)) {
      const durSeg = typeof s.firstTs === 'string' && typeof s.lastTs === 'string'
        ? (new Date(s.lastTs) - new Date(s.firstTs)) / 1000
        : typeof s.firstTs === 'number' ? (s.lastTs - s.firstTs) / 1000 : 0;
      const estimated = Math.round((durSeg * 15) + (s.tools * 500));
      tokenEstimates.totalSessions++;
      tokenEstimates.totalTools += s.tools;
      tokenEstimates.totalEstimatedTokens += estimated;
      tokenEstimates.bySession.push({ id: id.slice(0, 8), tools: s.tools, durMin: Math.round(durSeg / 60), tokens: estimated });
    }
  } catch {}

  // Tasa de rebotes (rechazos / total)
  let totalProcessed = 0, totalRejected = 0;
  const config = loadConfig();
  const allFases = [];
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    for (const fase of pConfig.fases) allFases.push({ pipeline: pName, fase });
  }
  for (const { pipeline: pName, fase } of allFases) {
    for (const estado of ['procesado', 'listo']) {
      const dir = path.join(PIPELINE, pName, fase, estado);
      for (const f of listWorkFiles(dir)) {
        totalProcessed++;
        const data = readYamlSafe(path.join(dir, f));
        if (data.resultado === 'rechazado') totalRejected++;
      }
    }
  }

  // Agent performance: issues procesados por skill, duración promedio, rechazos
  const agentPerf = {};
  for (const { pipeline: pName, fase } of allFases) {
    for (const estado of ['procesado', 'listo']) {
      const dir = path.join(PIPELINE, pName, fase, estado);
      for (const f of listWorkFiles(dir)) {
        const skill = f.split('.').slice(1).join('.');
        if (!skill) continue;
        if (!agentPerf[skill]) agentPerf[skill] = { issues: 0, rejected: 0, totalDurMs: 0, durCount: 0, toolCalls: 0 };
        agentPerf[skill].issues++;
        const data = readYamlSafe(path.join(dir, f));
        if (data.resultado === 'rechazado') agentPerf[skill].rejected++;
        const st = fileStat(path.join(dir, f));
        if (st) {
          const dur = st.ctimeMs - st.birthtimeMs;
          if (dur > 5000 && dur < 4 * 3600000) {
            agentPerf[skill].totalDurMs += dur;
            agentPerf[skill].durCount++;
          }
        }
      }
    }
  }
  // Enriquecer con tool calls del activity log
  try {
    const archiveFile = path.join(path.dirname(PIPELINE), '.claude', 'activity-log.archive.jsonl');
    const lines = fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean);
    const sessionSkill = {};
    for (const l of lines) {
      try {
        const d = JSON.parse(l);
        if (d.session && d.skill) sessionSkill[d.session] = d.skill;
        if (d.session && d.tool) {
          const sk = sessionSkill[d.session] || d.session;
          if (agentPerf[sk]) agentPerf[sk].toolCalls++;
        }
      } catch {}
    }
  } catch {}

  return { snapshots, etaAverages, entregas, tokenEstimates, totalProcessed, totalRejected, agentPerf };
}

function generateMetricsHTML() {
  const data = getMetricsData();
  const { snapshots, etaAverages, entregas, tokenEstimates, totalProcessed, totalRejected, agentPerf } = data;

  // Últimas 1h, 6h, 24h de snapshots
  const now = Date.now();
  const snap1h = snapshots.filter(s => now - s.ts < 3600000);
  const snap6h = snapshots.filter(s => now - s.ts < 21600000);
  const snap24h = snapshots;

  // CPU/RAM promedios
  const avgCpu = (arr) => arr.length ? Math.round(arr.reduce((a, s) => a + s.cpu, 0) / arr.length) : 0;
  const avgMem = (arr) => arr.length ? Math.round(arr.reduce((a, s) => a + s.mem, 0) / arr.length) : 0;
  const maxCpu = (arr) => arr.length ? Math.max(...arr.map(s => s.cpu)) : 0;
  const maxMem = (arr) => arr.length ? Math.max(...arr.map(s => s.mem)) : 0;
  const avgAgents = (arr) => arr.length ? (arr.reduce((a, s) => a + s.agents, 0) / arr.length).toFixed(1) : 0;

  // Throughput
  const delivered24h = entregas.filter(e => now - e.ts < 86400000).length;
  const delivered7d = entregas.length;

  // Tiempo en cada nivel de presión (últimas 24h)
  const levelCounts = { green: 0, yellow: 0, orange: 0, red: 0 };
  for (const s of snap24h) levelCounts[s.level] = (levelCounts[s.level] || 0) + 1;
  const totalSnaps = snap24h.length || 1;
  const levelPct = {};
  for (const [l, c] of Object.entries(levelCounts)) levelPct[l] = Math.round(c / totalSnaps * 100);

  // Rebote rate
  const reboteRate = totalProcessed > 0 ? Math.round(totalRejected / totalProcessed * 100) : 0;

  // Cuota Anthropic
  const tokM = (tokenEstimates.totalEstimatedTokens / 1000000).toFixed(1);
  const costEst = (tokenEstimates.totalEstimatedTokens / 1000000 * 3).toFixed(2); // ~$3/MTok estimate

  // Sparkline y chart data
  const sparkData = snap1h.length > 2 ? snap1h.slice(-60) : snapshots.slice(-120);
  const cpuSpark = sparkData.map(s => s.cpu);
  const memSpark = sparkData.map(s => s.mem);
  const agentSpark = sparkData.map(s => s.agents);

  function sparkline(values, max, color) {
    if (values.length < 2) return '<span class="dim">sin datos</span>';
    const w = 300, h = 40;
    const step = w / (values.length - 1);
    const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max * h)).toFixed(1)}`).join(' ');
    return `<svg width="${w}" height="${h}" class="sparkline"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
  }

  // Gráfico grande (para sección de históricos)
  function chart(values, max, color, label, unit, thresholds) {
    if (values.length < 2) return '<div class="dim" style="padding:20px">Sin datos suficientes. El Pulpo genera snapshots cada 30s cuando corre.</div>';
    const w = 800, h = 160, pad = 40;
    const pw = w - pad * 2, ph = h - pad;
    const step = pw / (values.length - 1);
    const points = values.map((v, i) => `${(pad + i * step).toFixed(1)},${(h - pad - (v / max * ph)).toFixed(1)}`).join(' ');
    // Area fill
    const areaPoints = `${pad},${h - pad} ${points} ${(pad + (values.length - 1) * step).toFixed(1)},${h - pad}`;
    // Y axis labels
    const yLabels = [0, 25, 50, 75, 100].map(v => {
      const y = h - pad - (v / max * ph);
      return `<text x="${pad - 5}" y="${y + 4}" text-anchor="end" fill="#8b949e" font-size="10">${v}${unit}</text><line x1="${pad}" y1="${y}" x2="${w - pad}" y2="${y}" stroke="#21262d" stroke-width="0.5"/>`;
    }).join('');
    // X axis time labels (first, middle, last)
    const tsFirst = sparkData[0]?.ts;
    const tsLast = sparkData[sparkData.length - 1]?.ts;
    const fmtTs = (ts) => ts ? new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
    const xLabels = tsFirst ? `<text x="${pad}" y="${h - 5}" fill="#8b949e" font-size="10">${fmtTs(tsFirst)}</text><text x="${w - pad}" y="${h - 5}" text-anchor="end" fill="#8b949e" font-size="10">${fmtTs(tsLast)}</text>` : '';
    // Threshold lines
    let thresholdLines = '';
    if (thresholds) {
      for (const [val, col] of thresholds) {
        const y = h - pad - (val / max * ph);
        thresholdLines += `<line x1="${pad}" y1="${y}" x2="${w - pad}" y2="${y}" stroke="${col}" stroke-width="1" stroke-dasharray="4,4" opacity="0.5"/>`;
      }
    }
    // Avg line
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const avgY = h - pad - (avg / max * ph);

    return `<svg viewBox="0 0 ${w} ${h}" class="chart">
      ${yLabels}${xLabels}${thresholdLines}
      <polygon points="${areaPoints}" fill="${color}" opacity="0.1"/>
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2"/>
      <line x1="${pad}" y1="${avgY}" x2="${w - pad}" y2="${avgY}" stroke="${color}" stroke-width="1" stroke-dasharray="2,4" opacity="0.6"/>
      <text x="${w - pad + 5}" y="${avgY + 4}" fill="${color}" font-size="10">avg ${avg.toFixed(0)}${unit}</text>
      <text x="${pad}" y="14" fill="#e6edf3" font-size="12" font-weight="600">${label}</text>
    </svg>`;
  }

  const isInferred = snapshots.length > 0 && snapshots[0].inferred;
  const dataSourceLabel = isInferred
    ? '⚠️ Datos inferidos desde timestamps de archivos (el Pulpo no estaba corriendo). Precisión limitada.'
    : `📊 ${snapshots.length} snapshots reales del Pulpo (${snapshots.length > 0 ? fmtDuration(now - snapshots[0].ts) : '0'} de historia)`;

  // ETA averages table
  let etaRows = '';
  const faseOrder = ['analisis', 'criterios', 'sizing', 'validacion', 'dev', 'build', 'verificacion', 'linteo', 'aprobacion', 'entrega'];
  for (const fase of faseOrder) {
    const avg = etaAverages[fase];
    if (!avg?.avgMs) continue;
    // Skills detail
    const skills = Object.entries(etaAverages)
      .filter(([k]) => k.startsWith(fase + '/'))
      .map(([k, v]) => `${k.split('/')[1]}: ${fmtDuration(v.avgMs)}`)
      .join(', ');
    etaRows += `<tr><td>${fase}</td><td>${fmtDuration(avg.avgMs)}</td><td>${avg.count}</td><td class="dim">${skills}</td></tr>`;
  }

  // Session table (top 10 by tokens)
  const topSessions = tokenEstimates.bySession.sort((a, b) => b.tokens - a.tokens).slice(0, 10);
  let sessionRows = topSessions.map(s =>
    `<tr><td>${s.id}</td><td>${s.tools}</td><td>${s.durMin}min</td><td>${(s.tokens / 1000).toFixed(0)}K</td></tr>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Métricas — Pipeline V2</title>
<style>
:root{--bg:#0d1117;--sf:#161b22;--sf2:#1c2128;--bd:#30363d;--tx:#e6edf3;--dim:#8b949e;--ac:#58a6ff;--gn:#3fb950;--yl:#d29922;--or:#db6d28;--rd:#f85149;--radius:10px}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;padding:20px 24px;font-size:15px;line-height:1.5}
a{color:var(--ac);text-decoration:none}
h1{font-size:1.5em;margin-bottom:20px;display:flex;align-items:center;gap:10px}
h2{font-size:1.1em;color:var(--tx);margin-bottom:12px;border-bottom:1px solid var(--bd);padding-bottom:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:24px}
.card{background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);padding:16px}
.card-value{font-size:2em;font-weight:700}
.card-label{color:var(--dim);font-size:0.85em}
.card-sub{color:var(--dim);font-size:0.78em;margin-top:4px}
.green{color:var(--gn)}.yellow{color:var(--yl)}.orange{color:var(--or)}.red{color:var(--rd)}.blue{color:var(--ac)}
table{width:100%;border-collapse:collapse;font-size:0.88em}
th{text-align:left;color:var(--dim);padding:6px 10px;border-bottom:1px solid var(--bd);font-weight:600}
td{padding:6px 10px;border-bottom:1px solid var(--bd)}
.dim{color:var(--dim)}
.sparkline{display:block;margin-top:8px}
.level-bar{display:flex;height:20px;border-radius:6px;overflow:hidden;margin:8px 0}
.level-bar>div{height:100%;display:flex;align-items:center;justify-content:center;font-size:0.7em;font-weight:700;color:#000}
.back-link{margin-bottom:16px;display:inline-block}
.chart{width:100%;height:auto;max-height:200px}
.chart-grid{display:grid;grid-template-columns:1fr;gap:12px}
.section{margin-bottom:28px}
.section-ref{font-size:0.65em;color:var(--dim);font-weight:400;font-style:italic;letter-spacing:0;text-transform:none;margin-left:8px}
.bar-h{position:relative;height:12px;background:var(--bd);border-radius:4px;overflow:hidden;min-width:80px}
.bar-h-fill{height:100%;border-radius:4px;transition:width 0.4s}
.bar-h-label{font-size:0.82em;margin-right:8px;min-width:70px;display:inline-block}
.bar-h-value{font-size:0.82em;margin-left:8px;font-weight:600}
.dora-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:16px}
.dora-card{background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);padding:18px;text-align:center}
.dora-value{font-size:2.2em;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1}
.dora-target{font-size:0.78em;color:var(--dim);margin-top:8px;display:flex;align-items:center;justify-content:center;gap:6px}
.dora-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.reco-card p{margin-bottom:8px;line-height:1.5;font-size:0.9em}
.reco-card strong{font-weight:700}
.trend-up{color:var(--gn)}.trend-down{color:var(--rd)}.trend-flat{color:var(--dim)}
</style></head><body>
<a href="/" class="back-link">← Dashboard</a>
<h1>📊 Métricas del Pipeline</h1>

<div class="grid">
  <div class="card">
    <div class="card-value blue">${snap24h.length}</div>
    <div class="card-label">Snapshots (24h)</div>
    <div class="card-sub">${snap1h.length} última hora · ${snap6h.length} últimas 6h</div>
  </div>
  <div class="card">
    <div class="card-value">${avgCpu(snap1h)}%<span class="dim" style="font-size:0.5em"> / ${maxCpu(snap1h)}% max</span></div>
    <div class="card-label">CPU promedio (1h)</div>
    ${sparkline(cpuSpark, 100, '#f85149')}
  </div>
  <div class="card">
    <div class="card-value">${avgMem(snap1h)}%<span class="dim" style="font-size:0.5em"> / ${maxMem(snap1h)}% max</span></div>
    <div class="card-label">RAM promedio (1h)</div>
    ${sparkline(memSpark, 100, '#d29922')}
  </div>
  <div class="card">
    <div class="card-value">${avgAgents(snap1h)}</div>
    <div class="card-label">Agentes promedio (1h)</div>
    ${sparkline(agentSpark, 5, '#58a6ff')}
  </div>
</div>

<div class="grid">
  <div class="card">
    <div class="card-value green">${delivered24h}</div>
    <div class="card-label">Issues entregados (24h)</div>
    <div class="card-sub">${delivered7d} total histórico</div>
  </div>
  <div class="card">
    <div class="card-value ${reboteRate > 30 ? 'red' : reboteRate > 15 ? 'yellow' : 'green'}">${reboteRate}%</div>
    <div class="card-label">Tasa de rechazo</div>
    <div class="card-sub">${totalRejected} rechazados / ${totalProcessed} procesados</div>
  </div>
  <div class="card">
    <div class="card-value blue">${tokM}M</div>
    <div class="card-label">Tokens estimados (total)</div>
    <div class="card-sub">~$${costEst} USD · ${tokenEstimates.totalSessions} sesiones · ${tokenEstimates.totalTools} herramientas</div>
  </div>
  <div class="card">
    <div class="card-label">Presión de recursos (24h)</div>
    <div class="level-bar">
      ${levelPct.green > 0 ? `<div style="width:${levelPct.green}%;background:var(--gn)">${levelPct.green}%</div>` : ''}
      ${levelPct.yellow > 0 ? `<div style="width:${levelPct.yellow}%;background:var(--yl)">${levelPct.yellow}%</div>` : ''}
      ${levelPct.orange > 0 ? `<div style="width:${levelPct.orange}%;background:var(--or)">${levelPct.orange}%</div>` : ''}
      ${levelPct.red > 0 ? `<div style="width:${levelPct.red}%;background:var(--rd)">${levelPct.red}%</div>` : ''}
    </div>
    <div class="card-sub">🟢 ${levelPct.green || 0}% · 🟡 ${levelPct.yellow || 0}% · 🟠 ${levelPct.orange || 0}% · 🔴 ${levelPct.red || 0}%</div>
  </div>
</div>

<div class="section">
<h2>📈 Gráficos históricos</h2>
<div class="card-sub" style="margin-bottom:12px">${dataSourceLabel}</div>
<div class="chart-grid">
  <div class="card">${chart(snapshots.map(s => s.cpu), 100, '#f85149', 'CPU %', '%', [[65, '#d29922'], [80, '#db6d28'], [90, '#f85149']])}</div>
  <div class="card">${chart(snapshots.map(s => s.mem), 100, '#d29922', 'RAM %', '%', [[65, '#d29922'], [80, '#db6d28'], [90, '#f85149']])}</div>
  <div class="card">${chart(snapshots.map(s => s.agents), 6, '#58a6ff', 'Agentes activos', '', [])}</div>
</div>
</div>

<div class="section">
<h2>⏱ Velocidad por fase (promedios históricos)</h2>
<table>
<thead><tr><th>Fase</th><th>Promedio</th><th>Muestras</th><th>Detalle por skill</th></tr></thead>
<tbody>${etaRows || '<tr><td colspan="4" class="dim">Sin datos históricos</td></tr>'}</tbody>
</table>
</div>

<div class="section">
<h2>🤖 Cuota Anthropic — Top sesiones por consumo estimado</h2>
<table>
<thead><tr><th>Sesión</th><th>Herramientas</th><th>Duración</th><th>Tokens est.</th></tr></thead>
<tbody>${sessionRows || '<tr><td colspan="4" class="dim">Sin datos</td></tr>'}</tbody>
</table>
<div class="card-sub" style="margin-top:8px">⚠️ Tokens estimados por proxy: (duración_seg × 15) + (tools × 500). Calibrar con dashboard de Anthropic.</div>
</div>


${(() => {
  // --- Velocity Section ---
  const now7d = Date.now() - 7 * 86400000;
  const now14d = Date.now() - 14 * 86400000;
  const delivered7d_v = entregas.filter(e => e.ts >= now7d).length;
  const delivered14d_v = entregas.filter(e => e.ts >= now14d && e.ts < now7d).length;
  const throughput7d = (delivered7d_v / 7).toFixed(1);
  const throughputTrend = delivered14d_v > 0 ? Math.round((delivered7d_v - delivered14d_v) / delivered14d_v * 100) : 0;
  const trendIcon = throughputTrend > 5 ? '↑' : throughputTrend < -5 ? '↓' : '→';
  const trendColor = throughputTrend > 5 ? 'var(--gn)' : throughputTrend < -5 ? 'var(--rd)' : 'var(--dim)';

  // Cycle time estimado (suma promedios de fases)
  let cycleTimeMs = 0;
  for (const [key, d] of Object.entries(etaAverages)) {
    if (!key.includes('/') && d.avgMs) cycleTimeMs += d.avgMs;
  }

  // Daily series for sparkbar
  const dailySeries = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = Date.now() - (i + 1) * 86400000;
    const dayEnd = Date.now() - i * 86400000;
    const count = entregas.filter(e => e.ts >= dayStart && e.ts < dayEnd).length;
    const dayLabel = new Date(dayEnd).toLocaleDateString('es-AR', { weekday: 'short' }).slice(0, 2);
    dailySeries.push({ label: dayLabel, count });
  }
  const maxD = Math.max(1, ...dailySeries.map(d => d.count));
  const bars = dailySeries.map(d => {
    const h = Math.max(2, Math.round(d.count / maxD * 32));
    return '<div style="display:inline-flex;flex-direction:column;align-items:center;gap:2px;min-width:32px"><div style="height:' + h + 'px;width:16px;background:var(--ac);border-radius:3px 3px 0 0;opacity:' + (d.count > 0 ? '1' : '0.2') + '"></div><span style="font-size:0.7em;color:var(--dim)">' + d.label + '</span></div>';
  }).join('');

  return '<div id="velocidad" class="section"><h2>🚀 Velocidad de entrega <span class="section-ref">Jez Humble · DORA metrics</span></h2><div class="grid"><div class="card"><div class="card-value" style="color:' + trendColor + '">' + throughput7d + '<span class="dim" style="font-size:0.4em"> /día</span></div><div class="card-label">Throughput (7d) <span style="color:' + trendColor + '">' + trendIcon + ' ' + (throughputTrend > 0 ? '+' : '') + throughputTrend + '%</span></div><div style="display:flex;align-items:flex-end;gap:2px;margin-top:10px;height:40px">' + bars + '</div></div><div class="card"><div class="card-value blue">' + fmtDuration(cycleTimeMs) + '</div><div class="card-label">Cycle Time estimado</div><div class="card-sub">Suma de promedios por fase</div></div><div class="card"><div class="card-value green">' + delivered24h + '</div><div class="card-label">Entregados hoy</div><div class="card-sub">' + delivered7d + ' total histórico</div></div></div></div>';
})()}

${(() => {
  // --- Agent Performance Section ---
  const PERSONA = {
    guru: { icon: '🧠', color: '#bc8cff', ref: 'Hickey · Henney' },
    security: { icon: '🔒', color: '#f85149', ref: 'Hunt · Schneier' },
    po: { icon: '📋', color: '#d29922', ref: 'Cagan · Torres' },
    ux: { icon: '🎨', color: '#f778ba', ref: 'Norman · Nielsen' },
    planner: { icon: '📐', color: '#a371f7', ref: 'Singer · Ward' },
    'backend-dev': { icon: '⚡', color: '#3fb950', ref: 'Fowler · Martin' },
    'android-dev': { icon: '📱', color: '#58a6ff', ref: 'Wharton · Guy' },
    'web-dev': { icon: '🌐', color: '#79c0ff', ref: 'Osmani · Russell' },
    tester: { icon: '🧪', color: '#d2a8ff', ref: 'Beck · Meszaros' },
    qa: { icon: '✅', color: '#3fb950', ref: 'Bach · Crispin' },
    review: { icon: '👁️', color: '#ffa657', ref: 'Greiler · Google' },
    delivery: { icon: '🚀', color: '#f0883e', ref: 'Humble · Farley' },
    build: { icon: '🏗️', color: '#8b949e', ref: 'Pipeline' },
  };

  const perfEntries = Object.entries(agentPerf || {}).sort((a, b) => b[1].issues - a[1].issues);
  if (perfEntries.length === 0) return '';

  const maxIssues = Math.max(1, ...perfEntries.map(([, a]) => a.issues));
  const rows = perfEntries.map(([skill, a]) => {
    const p = PERSONA[skill] || { icon: '⚙', color: 'var(--dim)', ref: '' };
    const avgDur = a.durCount > 0 ? fmtDuration(Math.round(a.totalDurMs / a.durCount)) : '—';
    const failRate = a.issues > 0 ? Math.round(a.rejected / a.issues * 100) : 0;
    const failColor = failRate > 30 ? 'var(--rd)' : failRate > 15 ? 'var(--yl)' : 'var(--gn)';
    const bw = Math.max(2, Math.round(a.issues / maxIssues * 100));
    return '<tr><td><span style="color:' + p.color + '">' + p.icon + ' <strong>' + skill + '</strong></span><div style="font-size:0.7em;color:var(--dim);font-style:italic">' + p.ref + '</div></td><td>' + a.issues + '</td><td><div class="bar-h"><div class="bar-h-fill" style="width:' + bw + '%;background:' + p.color + '"></div></div></td><td>' + avgDur + '</td><td style="color:' + failColor + '">' + failRate + '%</td><td>' + a.toolCalls + '</td></tr>';
  }).join('');

  return '<div id="agentes" class="section"><h2>🤖 Rendimiento por agente</h2><table><thead><tr><th>Agente</th><th>Issues</th><th style="min-width:120px">Volumen</th><th>Duración avg</th><th>Rechazo %</th><th>Tool calls</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
})()}

${(() => {
  // --- DORA Section ---
  const now7d = Date.now() - 7 * 86400000;
  const d7 = entregas.filter(e => e.ts >= now7d).length;
  const doraTP = (d7 / 7).toFixed(1);
  const doraFR = totalProcessed > 0 ? Math.round(totalRejected / totalProcessed * 100) : 0;
  let doraLT = 0;
  for (const [key, d] of Object.entries(etaAverages)) {
    if (!key.includes('/') && d.avgMs) doraLT += d.avgMs;
  }

  const chk = (val, target, inv) => {
    if (!val) return { color: 'var(--dim)', label: 'SIN DATOS', cls: 'dim' };
    return (inv ? val <= target : val >= target)
      ? { color: 'var(--gn)', label: 'ELITE', cls: 'green' }
      : (inv ? val <= target * 2 : val >= target / 2)
        ? { color: 'var(--yl)', label: 'MEDIO', cls: 'yellow' }
        : { color: 'var(--rd)', label: 'BAJO', cls: 'red' };
  };

  const lt = chk(doraLT, 6 * 3600000, true);
  const tp = chk(parseFloat(doraTP), 2, false);
  const cfr = chk(100 - doraFR, 85, false);

  return '<div id="dora" class="section"><h2>📐 DORA Adaptado <span class="section-ref">Nicole Forsgren · Accelerate</span></h2><div class="card-sub" style="margin-bottom:12px">Métricas DORA adaptadas para pipeline de agentes AI · Ventana rolling 7d</div><div class="dora-grid"><div class="dora-card"><div class="dora-value" style="color:' + lt.color + '">' + (doraLT > 0 ? fmtDuration(doraLT) : '—') + '</div><div class="card-label">Lead Time</div><div class="dora-target"><span class="dora-dot" style="background:' + lt.color + '"></span>' + lt.label + ' · target < 6h</div></div><div class="dora-card"><div class="dora-value" style="color:' + tp.color + '">' + doraTP + '/día</div><div class="card-label">Throughput</div><div class="dora-target"><span class="dora-dot" style="background:' + tp.color + '"></span>' + tp.label + ' · target > 2/día</div></div><div class="dora-card"><div class="dora-value" style="color:' + cfr.color + '">' + doraFR + '%</div><div class="card-label">Change Failure Rate</div><div class="dora-target"><span class="dora-dot" style="background:' + cfr.color + '"></span>' + cfr.label + ' · target < 15%</div></div></div></div>';
})()}

<div class="section">
<h2>💡 Recomendaciones inteligentes</h2>
<div class="card reco-card">
${maxMem(snap1h) > 85 ? '<p class="red">⚠️ <strong>Perf (Brendan Gregg):</strong> RAM pico > 85% — Saturation alta. Reducir concurrencia o upgrade memoria.</p>' : ''}
${maxCpu(snap1h) > 90 ? '<p class="red">⚠️ <strong>Perf (Gregg):</strong> CPU pico > 90% — Utilization crítica. Reducir builds paralelos.</p>' : ''}
${reboteRate > 30 ? '<p class="orange">⚠️ <strong>QA (James Bach):</strong> Tasa de rechazo ${reboteRate}% — Explorar root cause en prompts de agentes dev.</p>' : ''}
${reboteRate > 15 && reboteRate <= 30 ? '<p class="yellow">⚠️ <strong>Delivery (Forsgren):</strong> Change failure rate ${reboteRate}% — Por encima del target DORA elite (< 15%).</p>' : ''}
${levelPct.red > 10 ? '<p class="red">⚠️ <strong>Planner (Reinertsen):</strong> Sistema en rojo ' + levelPct.red + '% del tiempo — Batch size excesivo, limitar WIP.</p>' : ''}
${levelPct.green > 80 ? '<p class="green">✅ <strong>Scrum (Vacanti):</strong> Flow saludable — recursos bien dimensionados para la carga actual.</p>' : ''}
${delivered24h === 0 && snap24h.length > 0 ? '<p class="yellow">⚠️ <strong>PO (Cagan):</strong> 0 entregas en 24h con pipeline activo — Verificar si el trabajo avanza hacia outcomes.</p>' : ''}
<p class="dim" style="margin-top:8px">${dataSourceLabel}</p>
</div>
</div>

<div style="color:var(--dim);font-size:0.8em;margin-top:20px">
🔴 Live · <a href="/api/metrics">API JSON</a> · <a href="/">← Dashboard</a> · ${new Date().toLocaleString('es-AR')}
</div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// V3 — /consumo: página con 3 tabs (Por agente | Por fase | Por issue)
// Contrato: issue #2477. Datos vienen de /metrics/* (buildSnapshot).
// ---------------------------------------------------------------------------
function renderConsumoHtml() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Consumo V3 — Pipeline Intrale</title>
<style>
  :root {
    --bg: #0a0e27; --fg: #e0e6ed; --card: #141b3a; --border: #2a3560;
    --accent: #4a9eff; --dim: #8592a8; --danger: #ff5a5a; --ok: #5aff8a;
  }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); margin: 0; padding: 20px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .subtitle { color: var(--dim); font-size: 13px; margin-bottom: 20px; }
  .controls { display: flex; gap: 10px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
  .controls label { color: var(--dim); font-size: 12px; }
  .controls select { background: var(--card); color: var(--fg); border: 1px solid var(--border); padding: 6px 10px; border-radius: 4px; }
  .controls button { background: var(--accent); color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .tabs { display: flex; gap: 4px; border-bottom: 2px solid var(--border); margin-bottom: 16px; }
  .tab { padding: 10px 18px; cursor: pointer; background: transparent; color: var(--dim); border: none; font-size: 14px; border-bottom: 2px solid transparent; margin-bottom: -2px; }
  .tab.active { color: var(--fg); border-bottom-color: var(--accent); font-weight: 600; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 18px; }
  .kpi { background: var(--card); padding: 12px; border-radius: 6px; border: 1px solid var(--border); }
  .kpi .label { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; }
  .kpi .value { font-size: 19px; font-weight: 700; color: var(--accent); margin-top: 4px; font-variant-numeric: tabular-nums; }
  .kpi .sub { font-size: 11px; color: var(--dim); margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 6px; overflow: hidden; border: 1px solid var(--border); }
  th { background: #1a2246; text-align: left; padding: 10px 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--dim); border-bottom: 1px solid var(--border); }
  td { padding: 9px 12px; border-bottom: 1px solid #1a2246; font-size: 13px; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.usd { text-align: right; font-weight: 600; color: var(--ok); font-variant-numeric: tabular-nums; }
  td.skill, td.issue, td.phase { font-weight: 600; color: var(--accent); }
  tr:hover td { background: #1a2246; cursor: pointer; }
  .panel { display: none; }
  .panel.active { display: block; }
  .drilldown { margin-top: 14px; background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 14px; display: none; }
  .drilldown.open { display: block; }
  .drilldown h3 { margin-top: 0; color: var(--accent); }
  .timeline-row { display: grid; grid-template-columns: 160px 120px 110px 1fr 100px 90px; gap: 10px; padding: 6px 0; border-bottom: 1px solid #1a2246; font-size: 12px; }
  .timeline-row:last-child { border-bottom: none; }
  .timeline-row .t-ts { color: var(--dim); }
  .timeline-row .t-skill { font-weight: 600; color: var(--accent); }
  .empty { color: var(--dim); padding: 20px; text-align: center; }
  .footer { color: var(--dim); font-size: 11px; margin-top: 24px; padding-top: 10px; border-top: 1px solid var(--border); }
  .footer a { color: var(--accent); }
</style>
</head>
<body>
  <h1>📊 Consumo V3 — Pipeline</h1>
  <div class="subtitle">Métricas extendidas (tokens, duración, TTS) por agente, fase e issue. Contrato issue #2477.</div>

  <div class="controls">
    <label>Ventana:</label>
    <select id="window">
      <option value="1h">Última hora</option>
      <option value="24h" selected>Últimas 24h</option>
      <option value="7d">Últimos 7 días</option>
      <option value="all">Histórico</option>
    </select>
    <button onclick="refresh()">Actualizar</button>
    <span id="last-refresh" style="color: var(--dim); font-size: 12px;"></span>
    <a href="/" style="color: var(--accent); font-size: 12px; margin-left: auto;">← Dashboard</a>
  </div>

  <div class="kpis" id="kpis"></div>

  <div class="tabs">
    <button class="tab active" data-panel="agents">Por agente</button>
    <button class="tab" data-panel="phases">Por fase</button>
    <button class="tab" data-panel="issues">Por issue</button>
    <button class="tab" data-panel="projections">Proyecciones</button>
    <button class="tab" data-panel="llmvsdet">LLM vs Determinístico</button>
    <button class="tab" data-panel="ttsissues">TTS por issue</button>
  </div>

  <div class="panel active" id="panel-agents">
    <table>
      <thead><tr><th>Skill</th><th class="num">Sesiones</th><th class="num">Tokens in+out</th><th class="num">Cache</th><th class="num">Dur. prom</th><th class="num">TTS chars</th><th class="num">TTS audio</th><th class="num">Costo</th></tr></thead>
      <tbody id="tbody-agents"><tr><td colspan="8" class="empty">Cargando…</td></tr></tbody>
    </table>
  </div>

  <div class="panel" id="panel-phases">
    <table>
      <thead><tr><th>Fase</th><th class="num">Sesiones</th><th class="num">Tokens in+out</th><th class="num">Cache</th><th class="num">Dur. prom</th><th class="num">TTS audio</th><th class="num">Costo</th></tr></thead>
      <tbody id="tbody-phases"><tr><td colspan="7" class="empty">Cargando…</td></tr></tbody>
    </table>
  </div>

  <div class="panel" id="panel-issues">
    <table>
      <thead><tr><th>Issue</th><th class="num">Sesiones</th><th class="num">Tokens in+out</th><th class="num">Dur. total</th><th class="num">Costo</th></tr></thead>
      <tbody id="tbody-issues"><tr><td colspan="5" class="empty">Cargando…</td></tr></tbody>
    </table>
    <div class="drilldown" id="drilldown">
      <h3 id="dd-title">Timeline</h3>
      <div id="dd-body"></div>
    </div>
  </div>

  <div class="panel" id="panel-projections">
    <div id="proj-cards"><div class="empty">Cargando…</div></div>
  </div>

  <div class="panel" id="panel-llmvsdet">
    <div class="card-sub" style="color:var(--dim);font-size:12px;margin-bottom:8px;">
      Comparativa por skill entre ejecución LLM (Claude) y determinística (Node puro). "Ahorro estimado" = sesiones_det × costo_promedio_llm.
    </div>
    <table>
      <thead><tr><th>Skill</th><th class="num">LLM sesiones</th><th class="num">LLM costo</th><th class="num">LLM prom/sesión</th><th class="num">Det sesiones</th><th class="num">Det costo</th><th class="num">Ahorro estimado</th><th>Estado</th></tr></thead>
      <tbody id="tbody-llmvsdet"><tr><td colspan="8" class="empty">Cargando…</td></tr></tbody>
    </table>
  </div>

  <div class="panel" id="panel-ttsissues">
    <div class="card-sub" style="color:var(--dim);font-size:12px;margin-bottom:8px;">
      Consumo de TTS (caracteres, audio, costo) desglosado por issue. Click en una fila para ver los providers usados.
    </div>
    <table>
      <thead><tr><th>Issue</th><th class="num">TTS count</th><th class="num">Caracteres</th><th class="num">Audio</th><th class="num">Costo</th></tr></thead>
      <tbody id="tbody-ttsissues"><tr><td colspan="5" class="empty">Cargando…</td></tr></tbody>
    </table>
    <div class="drilldown" id="tts-drilldown">
      <h3 id="tts-dd-title">Providers</h3>
      <div id="tts-dd-body"></div>
    </div>
  </div>

  <div class="footer">
    Schema V3 definido en <a href="https://github.com/intrale/platform/issues/2477" target="_blank">#2477</a> · Extensiones en <a href="https://github.com/intrale/platform/issues/2488" target="_blank">#2488</a>.<br>
    Endpoints JSON: <a href="/metrics/agents">/agents</a> · <a href="/metrics/phases">/phases</a> · <a href="/metrics/issues">/issues</a> · <a href="/metrics/tts">/tts</a> · <a href="/metrics/projections">/projections</a> · <a href="/metrics/llm-vs-deterministic">/llm-vs-deterministic</a> · <a href="/metrics/daily">/daily</a> · <a href="/metrics/snapshot">/snapshot</a>
  </div>

<script>
function fmtNum(n) {
  n = Number(n || 0);
  if (n >= 1e6) return (n/1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtDur(ms) {
  ms = Number(ms || 0);
  const s = Math.round(ms/1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s/60);
  const rem = s % 60;
  if (m < 60) return m + 'm ' + rem + 's';
  const h = Math.floor(m/60);
  return h + 'h ' + (m%60) + 'm';
}
function fmtUsd(n) { return '$' + Number(n || 0).toFixed(4); }
function fmtAudio(sec) {
  sec = Number(sec || 0);
  if (sec < 60) return sec.toFixed(1) + 's';
  return (sec/60).toFixed(1) + 'min';
}

function renderKpis(totals) {
  const el = document.getElementById('kpis');
  const cache = Number(totals.cache_read || 0) + Number(totals.cache_write || 0);
  el.innerHTML = [
    ['Sesiones', fmtNum(totals.sessions), ''],
    ['Tokens in+out', fmtNum(Number(totals.tokens_in||0) + Number(totals.tokens_out||0)), 'Cache: ' + fmtNum(cache)],
    ['Costo estimado', fmtUsd(totals.cost_usd), ''],
    ['TTS chars', fmtNum(totals.tts_chars), 'Audio: ' + fmtAudio(totals.tts_audio_seconds)],
    ['TTS costo', fmtUsd(totals.tts_cost_usd), ''],
    ['Eventos V3', fmtNum(totals.v3_events), 'log: ' + fmtNum(totals.total_log_lines)],
  ].map(([l,v,s]) => '<div class="kpi"><div class="label">'+l+'</div><div class="value">'+v+'</div>'+(s?'<div class="sub">'+s+'</div>':'')+'</div>').join('');
}

function renderAgents(rows) {
  const body = document.getElementById('tbody-agents');
  if (!rows || !rows.length) { body.innerHTML = '<tr><td colspan="8" class="empty">Sin datos en la ventana seleccionada</td></tr>'; return; }
  body.innerHTML = rows.map(a => {
    const cache = Number(a.cache_read||0)+Number(a.cache_write||0);
    return '<tr><td class="skill">'+(a.skill||'—')+'</td>'
      +'<td class="num">'+fmtNum(a.sessions)+'</td>'
      +'<td class="num">'+fmtNum(Number(a.tokens_in||0)+Number(a.tokens_out||0))+'</td>'
      +'<td class="num">'+fmtNum(cache)+'</td>'
      +'<td class="num">'+fmtDur(a.avg_duration_ms)+'</td>'
      +'<td class="num">'+fmtNum(a.tts_chars)+'</td>'
      +'<td class="num">'+fmtAudio(a.tts_audio_seconds)+'</td>'
      +'<td class="usd">'+fmtUsd(a.cost_usd)+'</td></tr>';
  }).join('');
}

function renderPhases(rows) {
  const body = document.getElementById('tbody-phases');
  if (!rows || !rows.length) { body.innerHTML = '<tr><td colspan="7" class="empty">Sin datos en la ventana seleccionada</td></tr>'; return; }
  body.innerHTML = rows.map(p => {
    const cache = Number(p.cache_read||0)+Number(p.cache_write||0);
    return '<tr><td class="phase">'+(p.phase||'—')+'</td>'
      +'<td class="num">'+fmtNum(p.sessions)+'</td>'
      +'<td class="num">'+fmtNum(Number(p.tokens_in||0)+Number(p.tokens_out||0))+'</td>'
      +'<td class="num">'+fmtNum(cache)+'</td>'
      +'<td class="num">'+fmtDur(p.avg_duration_ms)+'</td>'
      +'<td class="num">'+fmtAudio(p.tts_audio_seconds)+'</td>'
      +'<td class="usd">'+fmtUsd(p.cost_usd)+'</td></tr>';
  }).join('');
}

function renderIssues(rows) {
  const body = document.getElementById('tbody-issues');
  if (!rows || !rows.length) { body.innerHTML = '<tr><td colspan="5" class="empty">Sin issues con eventos V3 en la ventana</td></tr>'; return; }
  body.innerHTML = rows.map(i =>
    '<tr onclick="showTimeline('+i.issue+')"><td class="issue">#'+i.issue+'</td>'
    +'<td class="num">'+fmtNum(i.sessions)+'</td>'
    +'<td class="num">'+fmtNum(Number(i.tokens_in||0)+Number(i.tokens_out||0))+'</td>'
    +'<td class="num">'+fmtDur(i.duration_ms)+'</td>'
    +'<td class="usd">'+fmtUsd(i.cost_usd)+'</td></tr>'
  ).join('');
}

function projCard(title, dim) {
  if (!dim) return '';
  const q = dim.quota || {};
  const status = q.status || 'ok';
  const color = status === 'over' ? 'var(--rd, #f85149)' : (status === 'warning' ? 'var(--yl, #d29922)' : 'var(--gn, #3fb950)');
  const ratioPct = q.ratio != null ? Math.round(q.ratio * 100) + '%' : '—';
  const alert = q.alert ? '<div style="margin-top:8px;padding:8px;background:rgba(248,81,73,0.10);border-left:3px solid '+color+';font-size:12px;">⚠️ '+q.alert+'</div>' : '';
  const secondary = [];
  if (dim.dimension === 'tts') {
    if (dim.tts_chars_monthly_projection != null) secondary.push(['Caracteres/mes (proyectado)', fmtNum(dim.tts_chars_monthly_projection)]);
    if (dim.tts_audio_seconds_monthly_projection != null) secondary.push(['Audio/mes (proyectado)', fmtAudio(dim.tts_audio_seconds_monthly_projection)]);
    if (dim.tts_chars_month_to_date != null) secondary.push(['Caracteres MTD', fmtNum(dim.tts_chars_month_to_date)]);
  } else {
    if (dim.sessions_monthly_projection != null) secondary.push(['Sesiones/mes (proyectado)', fmtNum(dim.sessions_monthly_projection)]);
    if (dim.sessions_month_to_date != null) secondary.push(['Sesiones MTD', fmtNum(dim.sessions_month_to_date)]);
  }
  const secHtml = secondary.length ? '<div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px;color:var(--dim);">'
    + secondary.map(([l,v]) => '<div>'+l+': <span style="color:var(--fg);font-weight:600;">'+v+'</span></div>').join('') + '</div>' : '';
  return '<div class="kpi" style="border-left:3px solid '+color+';padding:14px;">'
    +'<div class="label" style="font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;">'+title+'</div>'
    +'<div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;">'
      +'<div><div style="color:var(--dim);font-size:11px;">Promedio diario</div><div style="font-weight:600;">'+fmtUsd(dim.daily_avg_usd)+'</div></div>'
      +'<div><div style="color:var(--dim);font-size:11px;">Proyección semanal</div><div style="font-weight:600;">'+fmtUsd(dim.weekly_projection_usd)+'</div></div>'
      +'<div><div style="color:var(--dim);font-size:11px;">Mes hasta hoy</div><div style="font-weight:600;">'+fmtUsd(dim.month_to_date_usd)+'</div></div>'
      +'<div><div style="color:var(--dim);font-size:11px;">Proyección fin de mes</div><div style="font-weight:600;color:'+color+';">'+fmtUsd(dim.monthly_forecast_usd)+'</div></div>'
      +'<div><div style="color:var(--dim);font-size:11px;">Cuota mensual</div><div style="font-weight:600;">'+fmtUsd(q.monthly_usd)+'</div></div>'
      +'<div><div style="color:var(--dim);font-size:11px;">% de cuota</div><div style="font-weight:600;color:'+color+';">'+ratioPct+'</div></div>'
    +'</div>'
    + secHtml
    + alert
    +'<div style="margin-top:8px;font-size:11px;color:var(--dim);">Basado en últimos '+(dim.samples||0)+' días · '+dim.days_remaining_this_month+' días restantes del mes</div>'
  +'</div>';
}

function renderProjections(projections) {
  const el = document.getElementById('proj-cards');
  if (!projections || (!projections.tokens && !projections.tts)) {
    el.innerHTML = '<div class="empty">Sin datos suficientes para proyectar.</div>';
    return;
  }
  el.innerHTML = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">'
    + projCard('Tokens (LLM)', projections.tokens)
    + projCard('TTS (audio)', projections.tts)
    + '</div>';
}

function renderLlmVsDet(rows) {
  const body = document.getElementById('tbody-llmvsdet');
  if (!rows || !rows.length) { body.innerHTML = '<tr><td colspan="8" class="empty">Sin sesiones registradas para comparar</td></tr>'; return; }
  body.innerHTML = rows.map(r => {
    const status = r.migrated
      ? '<span style="color:var(--gn, #3fb950);">✓ Migrado</span>'
      : '<span style="color:var(--dim);">— Solo LLM</span>';
    const savings = r.estimated_savings_usd > 0
      ? '<span style="color:var(--gn, #3fb950);font-weight:600;">'+fmtUsd(r.estimated_savings_usd)+'</span>'
      : fmtUsd(r.estimated_savings_usd);
    return '<tr><td class="skill">'+(r.skill||'—')+'</td>'
      +'<td class="num">'+fmtNum(r.llm_sessions)+'</td>'
      +'<td class="usd">'+fmtUsd(r.llm_cost_usd)+'</td>'
      +'<td class="usd">'+fmtUsd(r.llm_avg_cost_per_session)+'</td>'
      +'<td class="num">'+fmtNum(r.deterministic_sessions)+'</td>'
      +'<td class="usd">'+fmtUsd(r.deterministic_cost_usd)+'</td>'
      +'<td class="usd">'+savings+'</td>'
      +'<td>'+status+'</td></tr>';
  }).join('');
}

function renderTtsByIssue(rows) {
  const body = document.getElementById('tbody-ttsissues');
  if (!rows || !rows.length) { body.innerHTML = '<tr><td colspan="5" class="empty">Sin TTS registrado en la ventana</td></tr>'; return; }
  body.innerHTML = rows.map(r =>
    '<tr onclick="showTtsProviders('+r.issue+')"><td class="issue">#'+r.issue+'</td>'
    +'<td class="num">'+fmtNum(r.tts_count)+'</td>'
    +'<td class="num">'+fmtNum(r.tts_chars)+'</td>'
    +'<td class="num">'+fmtAudio(r.tts_audio_seconds)+'</td>'
    +'<td class="usd">'+fmtUsd(r.tts_cost_usd)+'</td></tr>'
  ).join('');
}

function showTtsProviders(issueNumber) {
  const list = (lastSnapshot && lastSnapshot.tts && lastSnapshot.tts.by_issue) || [];
  const issue = list.find(i => Number(i.issue) === Number(issueNumber));
  const dd = document.getElementById('tts-drilldown');
  const title = document.getElementById('tts-dd-title');
  const body = document.getElementById('tts-dd-body');
  if (!issue || !issue.by_provider || !issue.by_provider.length) {
    title.textContent = 'Providers TTS de #' + issueNumber;
    body.innerHTML = '<div class="empty">Sin breakdown por provider para este issue.</div>';
  } else {
    title.textContent = 'Providers TTS de #' + issue.issue + ' · ' + fmtNum(issue.tts_count) + ' generaciones · ' + fmtUsd(issue.tts_cost_usd);
    body.innerHTML = '<table style="width:100%;margin-top:6px;"><thead><tr><th>Provider</th><th class="num">Eventos</th><th class="num">Caracteres</th><th class="num">Audio</th><th class="usd">Costo</th></tr></thead><tbody>'
      + issue.by_provider.map(p =>
        '<tr><td>'+(p.provider||'—')+'</td>'
        +'<td class="num">'+fmtNum(p.tts_count)+'</td>'
        +'<td class="num">'+fmtNum(p.tts_chars)+'</td>'
        +'<td class="num">'+fmtAudio(p.tts_audio_seconds)+'</td>'
        +'<td class="usd">'+fmtUsd(p.tts_cost_usd)+'</td></tr>'
      ).join('')
      + '</tbody></table>';
  }
  dd.classList.add('open');
  dd.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

let lastSnapshot = null;

async function refresh() {
  const w = document.getElementById('window').value;
  try {
    const r = await fetch('/metrics/snapshot?window='+encodeURIComponent(w));
    const snap = await r.json();
    lastSnapshot = snap;
    renderKpis(snap.totals || {});
    renderAgents(snap.agents || []);
    renderPhases(snap.phases || []);
    renderIssues(snap.issues || []);
    renderProjections(snap.projections || null);
    renderLlmVsDet(snap.llm_vs_deterministic || []);
    renderTtsByIssue((snap.tts && snap.tts.by_issue) || []);
    document.getElementById('last-refresh').textContent = 'Actualizado: ' + new Date().toLocaleTimeString('es-AR');
  } catch (e) {
    document.getElementById('last-refresh').textContent = 'Error: ' + e.message;
  }
}

function showTimeline(issueNumber) {
  const issue = (lastSnapshot && lastSnapshot.issues || []).find(i => Number(i.issue) === Number(issueNumber));
  const dd = document.getElementById('drilldown');
  const title = document.getElementById('dd-title');
  const body = document.getElementById('dd-body');
  if (!issue || !issue.timeline || !issue.timeline.length) {
    title.textContent = 'Timeline de #' + issueNumber;
    body.innerHTML = '<div class="empty">Sin eventos para este issue en la ventana.</div>';
  } else {
    title.textContent = 'Timeline de #' + issue.issue + ' · ' + issue.sessions + ' sesiones · ' + fmtUsd(issue.cost_usd);
    body.innerHTML = '<div class="timeline-row" style="font-weight:600;color:var(--dim);"><div>Fecha</div><div>Skill</div><div>Fase</div><div>Evento</div><div class="num">Duración</div><div class="usd">Costo</div></div>'
      + issue.timeline.map(t =>
        '<div class="timeline-row"><div class="t-ts">'+(t.ts||'').replace('T',' ').slice(0,19)+'</div>'
        +'<div class="t-skill">'+(t.skill||'—')+'</div>'
        +'<div>'+(t.phase||'—')+'</div>'
        +'<div>'+t.event+(t.tts_chars!=null?' · '+fmtNum(t.tts_chars)+' chars':'')+'</div>'
        +'<div class="num">'+(t.duration_ms!=null?fmtDur(t.duration_ms):'—')+'</div>'
        +'<div class="usd">'+fmtUsd(t.cost_usd)+'</div></div>'
      ).join('');
  }
  dd.classList.add('open');
  dd.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  t.classList.add('active');
  document.getElementById('panel-' + t.dataset.panel).classList.add('active');
}));

document.getElementById('window').addEventListener('change', refresh);
refresh();
setInterval(refresh, 60000);
</script>
</body></html>`;
}

// --- Log Viewer (standalone page) ---

function generateLogViewerHTML(filename, isLive) {
  const title = filename.replace('.log', '').replace(/-/g, ' ');
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>${title} — Log Viewer</title>
<style>
:root{--bg:#0d1117;--sf:#161b22;--tx:#e6edf3;--dim:#8b949e;--bd:#30363d;--ac:#58a6ff;--gn:#3fb950;--rd:#f85149;--yl:#d29922;--or:#d18616}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font-family:'JetBrains Mono',Consolas,monospace;font-size:13px}
.header{position:sticky;top:0;z-index:10;background:var(--sf);border-bottom:1px solid var(--bd);padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.title{font-size:1.1em;font-weight:700;color:var(--ac)}
.badge{font-size:0.78em;padding:2px 10px;border-radius:10px;font-weight:600}
.badge-live{background:rgba(248,81,73,0.15);color:var(--rd);border:1px solid rgba(248,81,73,0.3);animation:pulse 2s infinite}
.badge-done{background:rgba(63,185,80,0.12);color:var(--gn);border:1px solid rgba(63,185,80,0.25)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
.controls{display:flex;gap:8px;margin-left:auto;align-items:center}
.filter-btn{background:var(--bg);border:1px solid var(--bd);color:var(--dim);padding:4px 10px;border-radius:4px;cursor:pointer;font-size:0.82em;font-family:inherit}
.filter-btn:hover{background:var(--bd);color:var(--tx)}
.filter-btn.active{background:var(--ac);color:#fff;border-color:var(--ac)}
input[type=text]{background:var(--bg);border:1px solid var(--bd);color:var(--tx);padding:5px 10px;border-radius:4px;font-size:0.85em;width:200px;font-family:inherit}
input[type=text]:focus{outline:none;border-color:var(--ac)}
.stats{font-size:0.78em;color:var(--dim);padding:2px 8px}
.log-body{padding:4px 0;overflow-y:auto;height:calc(100vh - 54px)}
.ll{display:flex;padding:1px 16px;min-height:20px;line-height:1.5}
.ll:hover{background:rgba(255,255,255,0.02)}
.ll-num{color:var(--dim);min-width:40px;text-align:right;margin-right:12px;user-select:none;font-size:0.85em;padding-top:1px}
.ll-ts{color:var(--dim);min-width:80px;margin-right:10px;font-size:0.85em;opacity:0.7;padding-top:1px}
.ll-text{flex:1;white-space:pre-wrap;word-break:break-word}
.ll-error .ll-text{color:var(--rd)}
.ll-warning .ll-text{color:var(--yl)}
.ll-tool .ll-text{color:var(--or)}
.ll-success .ll-text{color:var(--gn)}
.ll-meta .ll-text{color:var(--dim);font-style:italic}
.ll-agent .ll-text{color:var(--ac);font-weight:500}
.ll-hidden{display:none}
.highlight{background:rgba(210,153,34,0.3);border-radius:2px;padding:0 1px}
.scroll-btn{position:fixed;bottom:20px;right:20px;background:var(--ac);color:#fff;border:none;border-radius:20px;padding:8px 16px;cursor:pointer;font-size:0.85em;display:none;z-index:5;box-shadow:0 2px 8px rgba(0,0,0,0.4)}
.scroll-btn.visible{display:block}
</style>
</head><body>
<div class="header">
  <span class="title">${title}</span>
  <span class="badge ${isLive ? 'badge-live' : 'badge-done'}">${isLive ? '● LIVE' : '✓ Finalizado'}</span>
  <div class="controls">
    <button class="filter-btn active" data-f="relevant" onclick="setFilter(this,'relevant')">Relevante</button>
    <button class="filter-btn" data-f="tools" onclick="setFilter(this,'tools')">Tools</button>
    <button class="filter-btn" data-f="all" onclick="setFilter(this,'all')">Todo</button>
    <input type="text" id="search" placeholder="Buscar..." oninput="doSearch(this.value)">
    <span class="stats" id="stats"></span>
  </div>
</div>
<div class="log-body" id="body"></div>
<button class="scroll-btn" id="scrollBtn" onclick="scrollBottom()">⬇ Ir al final</button>
<script>
const body = document.getElementById('body');
const statsEl = document.getElementById('stats');
const scrollBtn = document.getElementById('scrollBtn');
let allLines = [];
let autoScroll = true;
let currentFilter = 'relevant';
let searchTerm = '';

function parseTimestamp(raw) {
  if (!raw || !raw.startsWith('{')) return '';
  try {
    const ev = JSON.parse(raw);
    // timestamp viene en user events y system events
    const ts = ev.timestamp || ev.message?.timestamp;
    if (ts) {
      const d = new Date(ts);
      return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
  } catch(_) {}
  return '';
}

function parseLine(raw) {
  if (!raw || !raw.trim()) return null;
  if (!raw.startsWith('{')) return { text: raw, cls: classifyText(raw), ts: '', relevance: 'relevant' };
  try {
    const ev = JSON.parse(raw);
    const ts = ev.timestamp || ev.message?.timestamp || '';
    const fmtTs = ts ? new Date(ts).toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '';
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') return { text: '[init] modelo: ' + (ev.model || '?'), cls: 'meta', ts: fmtTs, relevance: 'all' };
        if (ev.subtype === 'task_started') return { text: '[task] ' + (ev.description || ''), cls: 'tool', ts: fmtTs, relevance: 'tools' };
        return { text: '[system] ' + (ev.subtype || ''), cls: 'meta', ts: fmtTs, relevance: 'all' };
      case 'assistant': {
        const msg = ev.message;
        if (!msg || !msg.content) return null;
        const parts = [];
        for (const c of msg.content) {
          if (c.type === 'thinking') {
            // Solo mostrar el texto de thinking, no la signature
            const thought = c.thinking || '';
            if (thought && thought.length < 500) parts.push({ text: '[pensando] ' + thought, cls: 'meta', relevance: 'relevant' });
            else if (thought) parts.push({ text: '[pensando] ' + thought.substring(0, 300) + '...', cls: 'meta', relevance: 'all' });
          }
          if (c.type === 'text' && c.text) parts.push({ text: c.text, cls: 'agent', relevance: 'relevant' });
          if (c.type === 'tool_use') {
            const name = c.name || '?';
            let detail = '';
            const inp = c.input || {};
            if (inp.command) detail = inp.command.substring(0, 200);
            else if (inp.pattern) detail = inp.pattern;
            else if (inp.file_path) detail = inp.file_path;
            else if (inp.skill) detail = inp.skill + (inp.args ? ' ' + inp.args : '');
            else if (inp.query) detail = inp.query.substring(0, 120);
            else if (inp.prompt) detail = inp.prompt.substring(0, 120);
            parts.push({ text: '[' + name + '] ' + detail, cls: 'tool', relevance: 'tools' });
          }
        }
        if (parts.length === 0) return null;
        if (parts.length === 1) return { ...parts[0], ts: fmtTs };
        return parts.map((p, i) => ({ ...p, ts: i === 0 ? fmtTs : '' }));
      }
      case 'user': {
        // Tool results — extraer solo info útil
        const msg = ev.message;
        const fmtTs2 = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '';
        if (!msg?.content) return null;
        for (const c of msg.content) {
          if (c.type === 'tool_result') {
            const txt = typeof c.content === 'string' ? c.content : '';
            if (c.is_error) return { text: '[error] ' + txt.substring(0, 300), cls: 'error', ts: fmtTs2, relevance: 'relevant' };
            // Resumir outputs largos
            if (txt.length > 400) return { text: '[resultado] ' + txt.substring(0, 200) + '... (' + txt.length + ' chars)', cls: '', ts: fmtTs2, relevance: 'tools' };
            if (txt.length > 0) return { text: '[resultado] ' + txt.substring(0, 300), cls: '', ts: fmtTs2, relevance: 'tools' };
          }
        }
        return null;
      }
      case 'result': {
        const cost = ev.cost_usd ? ' $' + ev.cost_usd.toFixed(4) : '';
        const dur = ev.duration_ms ? ' ' + Math.round(ev.duration_ms / 1000) + 's' : '';
        return { text: '[fin]' + cost + dur, cls: 'success', ts: '', relevance: 'relevant' };
      }
      case 'rate_limit_event': return null; // Siempre ocultar
      default: return null;
    }
  } catch(_) { return { text: raw.substring(0, 300), cls: '', ts: '', relevance: 'all' }; }
}

function classifyText(text) {
  if (/error|exception|fail|❌|CRASH|panic/i.test(text)) return 'error';
  if (/warn|⚠|WARNING/i.test(text)) return 'warning';
  if (/\\[Tool:|tool_use/i.test(text)) return 'tool';
  if (/✓|passed|success|✔|APROBADO/i.test(text)) return 'success';
  if (/^---\\s|^\\[.*\\]\\s*$|^=+$/.test(text)) return 'meta';
  return '';
}

function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function renderAll() {
  const html = [];
  allLines.forEach((l, i) => {
    const visible = matchesFilter(l) && matchesSearch(l);
    const cls = 'll' + (l.cls ? ' ll-' + l.cls : '') + (!visible ? ' ll-hidden' : '');
    const textHtml = searchTerm ? highlightSearch(esc(l.text)) : esc(l.text);
    html.push('<div class="' + cls + '" data-r="' + l.relevance + '"><span class="ll-num">' + (i+1) + '</span><span class="ll-ts">' + (l.ts||'') + '</span><span class="ll-text">' + textHtml + '</span></div>');
  });
  body.innerHTML = html.join('');
  updateStats();
  if (autoScroll) scrollBottom();
}

function appendLines(newParsed) {
  const start = allLines.length;
  allLines.push(...newParsed);
  const frag = document.createDocumentFragment();
  newParsed.forEach((l, i) => {
    const idx = start + i;
    const visible = matchesFilter(l) && matchesSearch(l);
    const div = document.createElement('div');
    div.className = 'll' + (l.cls ? ' ll-' + l.cls : '') + (!visible ? ' ll-hidden' : '');
    div.dataset.r = l.relevance;
    div.innerHTML = '<span class="ll-num">' + (idx+1) + '</span><span class="ll-ts">' + (l.ts||'') + '</span><span class="ll-text">' + (searchTerm ? highlightSearch(esc(l.text)) : esc(l.text)) + '</span>';
    frag.appendChild(div);
  });
  body.appendChild(frag);
  updateStats();
  if (autoScroll) scrollBottom();
}

function matchesFilter(l) {
  if (currentFilter === 'all') return true;
  if (currentFilter === 'relevant') return l.relevance === 'relevant' || l.cls === 'error' || l.cls === 'warning' || l.cls === 'success';
  if (currentFilter === 'tools') return l.relevance !== 'all';
  return true;
}

function matchesSearch(l) {
  if (!searchTerm) return true;
  return l.text.toLowerCase().includes(searchTerm.toLowerCase());
}

function highlightSearch(html) {
  if (!searchTerm) return html;
  if (!searchTerm) return html;
  var idx = html.toLowerCase().indexOf(searchTerm.toLowerCase());
  if (idx === -1) return html;
  var result = '';
  var last = 0;
  while (idx !== -1 && last < html.length) {
    result += html.substring(last, idx) + '<span class="highlight">' + html.substring(idx, idx + searchTerm.length) + '</span>';
    last = idx + searchTerm.length;
    idx = html.toLowerCase().indexOf(searchTerm.toLowerCase(), last);
  }
  result += html.substring(last);
  return result;
}

function setFilter(btn, f) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.ll').forEach(el => {
    const r = el.dataset.r;
    const l = allLines[parseInt(el.querySelector('.ll-num')?.textContent) - 1];
    if (l) el.classList.toggle('ll-hidden', !matchesFilter(l) || !matchesSearch(l));
  });
  updateStats();
}

function doSearch(val) {
  searchTerm = val;
  renderAll();
}

function updateStats() {
  const total = allLines.length;
  const visible = document.querySelectorAll('.ll:not(.ll-hidden)').length;
  statsEl.textContent = visible + '/' + total + ' líneas';
}

function scrollBottom() {
  body.scrollTop = body.scrollHeight;
  autoScroll = true;
  scrollBtn.classList.remove('visible');
}

body.addEventListener('scroll', () => {
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  autoScroll = atBottom;
  scrollBtn.classList.toggle('visible', !atBottom);
});

function processRawLines(rawLines) {
  const parsed = [];
  for (const raw of rawLines) {
    const result = parseLine(raw);
    if (!result) continue;
    if (Array.isArray(result)) parsed.push(...result);
    else parsed.push(result);
  }
  return parsed;
}

// SSE stream
const es = new EventSource('/logs/stream/' + encodeURIComponent('${filename}'));
es.onmessage = function(e) {
  try {
    const msg = JSON.parse(e.data);
    if (msg.type === 'init') {
      allLines = processRawLines(msg.lines);
      renderAll();
    } else if (msg.type === 'append') {
      appendLines(processRawLines(msg.lines));
    }
  } catch(_) {}
};
es.onerror = function() {
  document.querySelector('.badge').className = 'badge badge-done';
  document.querySelector('.badge').textContent = '✓ Desconectado';
};
</script>
</body></html>`;
}

// --- Server ---

const server = http.createServer((req, res) => {
  // Log viewer en ventana dedicada
  if (req.url.startsWith('/logs/view/')) {
    const parts = req.url.slice(11).split('?');
    const filename = path.basename(parts[0]).replace(/[^a-zA-Z0-9\-\.]/g, '');
    const isLive = (parts[1] || '').includes('live=1');
    const logPath = path.join(LOG_DIR, filename);
    if (!fs.existsSync(logPath)) { res.writeHead(404); res.end('Log no encontrado'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(generateLogViewerHTML(filename, isLive));
    return;
  }

  // Servir logs y PDFs como archivos estáticos
  if (req.url.startsWith('/logs/') && !req.url.startsWith('/logs/stream/')) {
    const filename = path.basename(req.url.slice(6)).replace(/[^a-zA-Z0-9\-\.]/g, '');
    const logPath = path.join(LOG_DIR, filename);
    if (fs.existsSync(logPath)) {
      const isPdf = filename.endsWith('.pdf');
      const contentType = isPdf ? 'application/pdf' : 'text/plain; charset=utf-8';
      const headers = { 'Content-Type': contentType, 'Cache-Control': 'no-cache' };
      if (isPdf) headers['Content-Disposition'] = `inline; filename="${filename}"`;
      res.writeHead(200, headers);
      res.end(fs.readFileSync(logPath));
    } else {
      res.writeHead(404); res.end('Log no encontrado: ' + filename);
    }
    return;
  }

  // SSE log streaming — tail -f style
  if (req.url.startsWith('/logs/stream/')) {
    const filename = path.basename(req.url.slice(13)).replace(/[^a-zA-Z0-9\-\.]/g, '');
    const logPath = path.join(LOG_DIR, filename);
    if (!fs.existsSync(logPath)) {
      res.writeHead(404); res.end('Log no encontrado');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    // Send initial content (last 1000 lines)
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    const initialLines = lines.slice(-1000);
    res.write(`data: ${JSON.stringify({ type: 'init', lines: initialLines })}\n\n`);

    // Watch for changes
    let lastSize = fs.statSync(logPath).size;
    const interval = setInterval(() => {
      try {
        if (!fs.existsSync(logPath)) return;
        const stat = fs.statSync(logPath);
        if (stat.size > lastSize) {
          const fd = fs.openSync(logPath, 'r');
          const buf = Buffer.alloc(stat.size - lastSize);
          fs.readSync(fd, buf, 0, buf.length, lastSize);
          fs.closeSync(fd);
          const newLines = buf.toString('utf8').split('\n').filter(l => l.length > 0);
          if (newLines.length > 0) {
            res.write(`data: ${JSON.stringify({ type: 'append', lines: newLines })}\n\n`);
          }
          lastSize = stat.size;
        }
      } catch {}
    }, 800);

    req.on('close', () => clearInterval(interval));
    return;
  }

  // SSE endpoint para live refresh
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const send = () => {
      try {
        const state = getPipelineState();
        const hash = crypto.createHash('md5').update(JSON.stringify(state.issueMatrix)).digest('hex').slice(0, 8);
        res.write(`data: ${hash}\n\n`);
      } catch {}
    };
    send();
    const interval = setInterval(send, 5000);
    req.on('close', () => clearInterval(interval));
    return;
  }

  // API: acciones start/stop
  if (req.url === '/api/action' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { target, action, component } = JSON.parse(body);
        let result;
        if (target === 'qa') {
          result = qaAction(action, component); // component: 'emulator' (dynamo/backend are remote AWS)
        } else if (action === 'start') {
          result = startComponent(target);
        } else if (action === 'stop') {
          result = stopComponent(target);
        } else {
          result = { ok: false, msg: `Acción "${action}" no válida` };
        }
        log(`Action: ${action} ${target} → ${result.ok ? '✓' : '✗'} ${result.msg}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: e.message }));
      }
    });
    return;
  }

  // API: pause/resume pipeline
  if (req.url === '/api/pause' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { action } = JSON.parse(body);
        const pauseFile = path.join(PIPELINE, '.paused');
        if (action === 'resume' || action === 'remove') {
          // #2490 — resume limpia tanto pausa completa como parcial
          try { fs.unlinkSync(pauseFile); } catch {}
          try {
            const { resumeAll } = require('./lib/partial-pause');
            resumeAll();
          } catch {}
          log(`Pausa eliminada por dashboard (${action})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, msg: 'Pipeline reanudado — lanzamientos activos' }));
        } else if (action === 'pause') {
          fs.writeFileSync(pauseFile, new Date().toISOString());
          log('Pipeline pausado desde dashboard');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, msg: 'Pipeline pausado — solo Telegram activo' }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: `Acción "${action}" no válida` }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: e.message }));
      }
    });
    return;
  }

  // API: #2490 — Pausa parcial con allowlist de issues
  if (req.url === '/api/pause-partial' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { issues } = JSON.parse(body || '{}');
        const { setPartialPause, clearPartialPause, getPipelineMode } = require('./lib/partial-pause');
        const list = Array.isArray(issues) ? issues : [];
        if (list.length === 0) {
          clearPartialPause();
          log('Pausa parcial eliminada desde dashboard');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, msg: 'Pausa parcial desactivada', mode: 'running' }));
          return;
        }
        const result = setPartialPause(list, { source: 'dashboard' });
        const state = getPipelineMode();
        log(`Pausa parcial activada desde dashboard (${result.allowedIssues.join(',')})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          msg: result.msg,
          mode: state.mode,
          allowedIssues: state.allowedIssues,
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: e.message }));
      }
    });
    return;
  }

  // API: Kill agent (cancelar agente activo)
  if (req.url === '/api/kill-agent' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { issue, skill, pipeline: pl, fase } = JSON.parse(body);
        const trabajandoDir = path.join(PIPELINE, pl, fase, 'trabajando');
        const pendienteDir = path.join(PIPELINE, pl, fase, 'pendiente');
        const filename = `${issue}.${skill}`;

        // Buscar el archivo en trabajando/
        const filepath = path.join(trabajandoDir, filename);
        if (!fs.existsSync(filepath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: `No encontrado: ${filename} en ${pl}/${fase}/trabajando` }));
          return;
        }

        // #2486 — descubrimiento dinámico del PID vía pid-discovery.
        // Reemplaza la lectura de agent-registry.json (fuente duplicada con race conditions
        // y PIDs stale). pid-discovery cruza scan de procesos vivos por cmdline +
        // heartbeat reciente, con verificación cruzada antes de matar.
        let killed = false;
        let pidsKilled = [];
        try {
          const { discoverAgentPids } = require('./skills-deterministicos/lib/pid-discovery');
          const matches = discoverAgentPids({ issue, skill });
          for (const match of matches) {
            try {
              execSync(`taskkill /PID ${match.pid} /F /T`, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
              killed = true;
              pidsKilled.push(`${match.pid}(${match.source})`);
            } catch {}
          }
        } catch (e) {
          log(`pid-discovery error: ${e.message}`);
        }

        // Mover de trabajando/ a pendiente/ (para que pueda ser relanzado)
        try {
          const dest = path.join(pendienteDir, filename);
          fs.renameSync(filepath, dest);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: `Error moviendo archivo: ${e.message}` }));
          return;
        }

        const msg = killed
          ? `Agente ${skill} #${issue} cancelado (PIDs ${pidsKilled.join(', ')} + devuelto a pendiente)`
          : `Agente ${skill} #${issue} devuelto a pendiente (proceso no encontrado — ya terminó o nunca arrancó)`;
        log(`Kill agent: ${skill} #${issue} en ${pl}/${fase} — ${killed ? `killed ${pidsKilled.join(',')}` : 'no PID'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, msg }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: e.message }));
      }
    });
    return;
  }

  // API: Priority Windows toggle (on/off manual)
  if (req.url === '/api/priority-window' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { window: win, action } = JSON.parse(body);
        if (!['qa', 'build'].includes(win)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: `Window "${win}" no válida (qa|build)` }));
          return;
        }
        const pwFile = path.join(PIPELINE, 'priority-windows.json');
        let current = {};
        try { current = JSON.parse(fs.readFileSync(pwFile, 'utf8')); } catch {}
        if (!current.qa) current.qa = { active: false };
        if (!current.build) current.build = { active: false };

        // Escribir manualOverride para que el Pulpo lo consuma en su próximo ciclo
        // También actualizar active/manual inmediatamente para que el dashboard refleje el cambio
        // Ventanas autoexcluyentes: si activamos una, desactivamos la otra
        current[win].manualOverride = (action === 'on');
        if (action === 'on') {
          current[win].active = true;
          current[win].manual = true;
          current[win].activatedAt = Date.now();
          // Autoexclusión: desactivar la otra ventana
          const other = win === 'qa' ? 'build' : 'qa';
          if (current[other] && current[other].active) {
            current[other].manualOverride = false;
            current[other].active = false;
            current[other].manual = false;
            current[other].activatedAt = null;
          }
        } else {
          current[win].active = false;
          current[win].manual = false;
          current[win].activatedAt = null;
        }
        current.updatedAt = Date.now();
        fs.writeFileSync(pwFile, JSON.stringify(current, null, 2));

        const label = win === 'qa' ? 'QA Priority' : 'Build Priority';
        const verb = action === 'on' ? 'activada' : 'desactivada';
        log(`Priority Window: ${label} ${verb} manualmente`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, msg: `${label} Window ${verb} — surte efecto en el próximo ciclo del Pulpo` }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: e.message }));
      }
    });
    return;
  }

  // API recomendaciones (issue #2653)
  if (req.url === '/api/recommendations/refresh' && req.method === 'POST') {
    if (!recommendationsLib) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, msg: 'recommendations lib no disponible' }));
      return;
    }
    recommendationsLib.refreshCache().then(cache => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count: (cache.items || []).length, error: cache.error || null }));
    }).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, msg: e.message }));
    });
    return;
  }

  const recoMatch = req.url && req.url.match(/^\/api\/recommendations\/(\d+)\/(approve|reject)$/);
  if (recoMatch && req.method === 'POST') {
    if (!recommendationsLib) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, msg: 'recommendations lib no disponible' }));
      return;
    }
    const issueNum = Number(recoMatch[1]);
    const action = recoMatch[2];
    let body = '';
    req.on('data', c => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        let result;
        if (action === 'approve') {
          result = recommendationsLib.approve({ issue: issueNum });
        } else {
          result = recommendationsLib.reject({ issue: issueNum, reason: payload.reason || '' });
        }
        if (result.ok) {
          recommendationsLib.refreshCache().catch(() => {});
          log(`Recomendaciones: ${action} #${issueNum} — ${result.msg}`);
        }
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: e.message }));
      }
    });
    return;
  }

  // API needs-human quick actions (panel del dashboard)
  const needsHumanMatch = req.url && req.url.match(/^\/api\/needs-human\/(\d+)\/(reactivate|dismiss)$/);
  if (needsHumanMatch && req.method === 'POST') {
    const issueNum = Number(needsHumanMatch[1]);
    const action = needsHumanMatch[2];
    let body = '';
    req.on('data', c => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: 'JSON inválido: ' + e.message }));
        return;
      }
      let humanBlock;
      try { humanBlock = require('./lib/human-block'); }
      catch (e) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: 'human-block lib no disponible: ' + e.message }));
        return;
      }
      const ghBin = GH_BIN;
      const repo = 'intrale/platform';
      const { execFileSync } = require('child_process');
      const ghTry = (args) => {
        try {
          execFileSync(ghBin, args, { stdio: 'ignore', timeout: 15000 });
          return true;
        } catch { return false; }
      };

      if (action === 'reactivate') {
        let result;
        try { result = humanBlock.unblockIssue({ issue: issueNum, guidance: '', unlocker: 'commander:dashboard' }); }
        catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: 'Error desbloqueando: ' + e.message }));
          return;
        }
        if (!result.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: result.error }));
          return;
        }
        ghTry(['issue', 'edit', String(issueNum), '--repo', repo, '--remove-label', 'needs-human']);
        const comment = `## ▶ Reactivado desde el dashboard\n\n**Skill:** \`${result.skill}\` · **Fase:** \`${result.from_phase}\` → \`${result.to_phase}\`\n\nVuelve a la cola del pipeline sin orientación adicional.`;
        ghTry(['issue', 'comment', String(issueNum), '--repo', repo, '--body', comment]);
        log(`needs-human: reactivado #${issueNum} (skill=${result.skill}, ${result.from_phase}→${result.to_phase})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, msg: `Issue #${issueNum} reactivado`, ...result }));
        return;
      }

      // dismiss
      const reason = String(payload.reason || '').trim();
      let result;
      try { result = humanBlock.dismissBlockedIssue({ issue: issueNum, reason, unlocker: 'commander:dashboard' }); }
      catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: 'Error desestimando: ' + e.message }));
        return;
      }
      if (!result.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: result.error }));
        return;
      }
      ghTry(['issue', 'edit', String(issueNum), '--repo', repo, '--remove-label', 'needs-human']);
      const reasonLine = reason ? `\n\n**Motivo:** ${reason}` : '';
      const closeComment = `## ✕ Desestimado desde el dashboard\n\nIssue cerrado manualmente; no entrará al pipeline.${reasonLine}`;
      const closed = ghTry(['issue', 'close', String(issueNum), '--repo', repo, '--reason', 'not planned', '--comment', closeComment]);
      log(`needs-human: desestimado #${issueNum} (skill=${result.skill}, closed=${closed})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, msg: `Issue #${issueNum} desestimado y cerrado`, closed, ...result }));
    });
    return;
  }

  // API orden manual de issues (drag-drop + botones ▲/▼ del Issue Tracker).
  // Si el body incluye `peer`, hace swap con ese issue (caso del frontend que
  // resuelve el vecino de la misma lane). Si no, fallback al swap con el vecino
  // del array global (legacy / clientes sin contexto de lane).
  const moveMatch = req.url && req.url.match(/^\/api\/issue\/(\d+)\/(move-up|move-down)$/);
  if (moveMatch && req.method === 'POST') {
    const issueNum = String(moveMatch[1]);
    const action = moveMatch[2];
    let body = '';
    req.on('data', c => { body += c; if (body.length > 16 * 1024) req.destroy(); });
    req.on('end', () => {
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: 'JSON inválido: ' + e.message }));
        return;
      }
      let issueOrder;
      try { issueOrder = require('./lib/issue-order'); }
      catch (e) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: 'issue-order lib no disponible: ' + e.message }));
        return;
      }
      const state = issueOrder.load();
      const peer = payload.peer != null ? String(payload.peer) : null;
      let result;
      if (peer) {
        result = issueOrder.swap(state, issueNum, peer);
      } else {
        result = action === 'move-up'
          ? issueOrder.moveUp(state, issueNum)
          : issueOrder.moveDown(state, issueNum);
      }
      log(`order: ${action} #${issueNum}${peer ? ` ↔ #${peer}` : ''} → ${result.ok ? `${result.from}↔${result.to}` : result.reason}`);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      if (result.ok) {
        const newPos = state.order.indexOf(issueNum);
        res.end(JSON.stringify({ ok: true, msg: `Issue #${issueNum} ${action === 'move-up' ? 'subió' : 'bajó'} a posición ${newPos + 1}`, ...result, position: newPos }));
      } else {
        res.end(JSON.stringify({ ok: false, msg: result.reason }));
      }
    });
    return;
  }

  if (req.url === '/api/issues/reorder' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 256 * 1024) req.destroy(); });
    req.on('end', () => {
      let payload;
      try { payload = body ? JSON.parse(body) : {}; }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: 'JSON inválido: ' + e.message }));
        return;
      }
      const order = Array.isArray(payload.order) ? payload.order : null;
      if (!order) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: 'Falta payload.order (array de issue numbers)' }));
        return;
      }
      let issueOrder;
      try { issueOrder = require('./lib/issue-order'); }
      catch (e) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: 'issue-order lib no disponible: ' + e.message }));
        return;
      }
      const state = issueOrder.load();
      issueOrder.setOrder(state, order);
      log(`order: reorder via drag-drop (${order.length} issues, head=${order.slice(0,3).join(',')})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, msg: `Orden actualizado (${order.length} issues)`, count: order.length }));
    });
    return;
  }

  // API JSON
  if (req.url === '/api/state' || req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getPipelineState(), null, 2));
    return;
  }

  // /metrics — Métricas históricas para decisiones de hardware/servicio
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(generateMetricsHTML());
    return;
  }

  // /api/metrics — Raw metrics data
  if (req.url === '/api/metrics') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getMetricsData()));
    return;
  }

  // ===========================================================================
  // V3 — Endpoints de métricas extendidas (issue #2477)
  // ===========================================================================
  if (req.url.startsWith('/metrics/') || req.url === '/consumo' || req.url === '/metrics-v3' || req.url === '/metrics-v3/') {
    if (!v3Aggregator) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'V3 aggregator no disponible. Verificar .pipeline/metrics/aggregator.js' }));
      return;
    }

    // /consumo o /metrics-v3 → página HTML con tabs (#2488: alias /metrics-v3 más descriptivo)
    if (req.url === '/consumo' || req.url === '/metrics-v3' || req.url === '/metrics-v3/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderConsumoHtml());
      return;
    }

    // Endpoints JSON: extraer ventana de querystring
    const u = new URL(req.url, 'http://localhost');
    const windowParam = u.searchParams.get('window') || 'all';

    const respond = (data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data, null, 2));
    };
    const fail = (err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    };

    v3Aggregator.buildSnapshot({ window: windowParam }).then(snap => {
      const baseMeta = { window: windowParam, generated_at: snap.generated_at };

      if (u.pathname === '/metrics/agents') return respond(Object.assign({}, baseMeta, { agents: snap.agents || [] }));
      if (u.pathname === '/metrics/phases') return respond(Object.assign({}, baseMeta, { phases: snap.phases || [] }));
      if (u.pathname === '/metrics/tts')    return respond(Object.assign({}, baseMeta, { tts: snap.tts || {} }));
      if (u.pathname === '/metrics/snapshot') return respond(snap);
      if (u.pathname === '/metrics/totals')  return respond(Object.assign({}, baseMeta, { totals: snap.totals || {} }));
      // #2488 — nuevos endpoints
      if (u.pathname === '/metrics/projections') return respond(Object.assign({}, baseMeta, { projections: snap.projections || {} }));
      if (u.pathname === '/metrics/llm-vs-deterministic') return respond(Object.assign({}, baseMeta, { llm_vs_deterministic: snap.llm_vs_deterministic || [] }));
      if (u.pathname === '/metrics/daily') return respond(Object.assign({}, baseMeta, { daily: snap.daily || [] }));

      const issueMatch = u.pathname.match(/^\/metrics\/issues\/(\d+)\/?$/);
      if (issueMatch) {
        const n = Number(issueMatch[1]);
        const issue = (snap.issues || []).find(i => Number(i.issue) === n);
        if (!issue) return respond(Object.assign({}, baseMeta, { issue: n, not_found: true, timeline: [] }));
        return respond(Object.assign({}, baseMeta, issue));
      }
      if (u.pathname === '/metrics/issues' || u.pathname === '/metrics/issues/') {
        return respond(Object.assign({}, baseMeta, { issues: snap.issues || [] }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'endpoint no reconocido', valid: ['/metrics/agents', '/metrics/phases', '/metrics/issues', '/metrics/issues/:n', '/metrics/tts', '/metrics/totals', '/metrics/snapshot', '/metrics/projections', '/metrics/llm-vs-deterministic', '/metrics/daily', '/consumo', '/metrics-v3'] }));
    }).catch(fail);
    return;
  }

  // HTML dashboard
  const state = getPipelineState();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(generateHTML(state));
});

server.listen(PORT, () => {
  log(`Dashboard V2 en http://localhost:${PORT}`);
  log(`API: /api/state | Logs: /logs/{file} | SSE: /events`);
  try { require('./lib/ready-marker').signalReady('dashboard', { port: PORT }); } catch {}
});

// dashboard.pid se mantiene como hint informativo (útil para mtime →
// uptime y para diagnóstico humano). NO es fuente de verdad: el dashboard
// descubre sus peers vía pid-discovery.
try { fs.writeFileSync(path.join(PIPELINE, 'dashboard.pid'), String(process.pid)); } catch {}
process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });

// Crash handlers — loguear antes de morir para diagnóstico
process.on('uncaughtException', (err) => {
  const msg = `[${new Date().toISOString()}] [dashboard] CRASH uncaughtException: ${err.stack || err.message}\n`;
  try { fs.appendFileSync(path.join(LOG_DIR, 'dashboard.log'), msg); } catch {}
  console.error(msg);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const msg = `[${new Date().toISOString()}] [dashboard] CRASH unhandledRejection: ${reason?.stack || reason}\n`;
  try { fs.appendFileSync(path.join(LOG_DIR, 'dashboard.log'), msg); } catch {}
  console.error(msg);
  process.exit(1);
});
