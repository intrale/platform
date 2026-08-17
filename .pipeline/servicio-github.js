#!/usr/bin/env node
// =============================================================================
// Servicio GitHub — Cola con retry, create-issue y condensador generico
// Procesa cola de servicios/github/pendiente/
//
// #3025 — Inyección de dependencia funcional para `gh` (ghClient).
// El worker delega cada operación a un cliente inyectable (`defaultGhClient`
// por default), lo que permite a los tests usar un mock JS puro en vez de un
// stub `gh.cmd` que invoca a Node y escribe a un log compartido. Bajo carga
// concurrente (947 tests en paralelo), el stub original era flaky por
// contención NTFS / EBUSY / resolución de PATH desde cmd.exe. La inyección
// elimina por completo esa superficie sin cambiar el comportamiento de
// producción (el `defaultGhClient` envuelve los `execSync` 1:1).
// =============================================================================

// #3303 — Usamos `cp.execFileSync` en lugar de `execSync` con interpolación
// de string al shell, lo que elimina dependencia de cmd.exe / sh. Mantenemos
// `spawn` destructured porque lo usa `fireOnComplete` con detached:true (no
// pasa por shell). `cp` se referencia por módulo para permitir monkey-patch
// desde los tests (#3303 CA-5).
const cp = require('child_process');
const { spawn } = cp;
const fs = require('fs');
const path = require('path');
// #2334: sanitización write-time.
require('./lib/sanitize-console').install();
// Saneado global de JAVA_HOME — este servicio spawnea agentes Claude que
// pueden invocar gradle; hereda y propaga el valor a sus hijos.
require('./lib/java-home-normalizer').normalizeJavaHome({
  log: (msg) => console.error(msg),
});
const { sanitize } = require('./sanitizer');
const { sanitizeGithubPayload } = require('./lib/sanitize-payload');
const gateLabelReconciler = require('./lib/gate-label-reconciler');
// #5690 — guardrail fail-closed contra la mezcla `needs-human`/`tipo:recomendacion`
// y contra la auto-aprobación de recomendaciones desde la cola anónima.
const labelGuardrail = require('./lib/label-guardrail');
// #4693 CA-0 — fuente de verdad única del repo destino. Reemplaza el literal
// DEFAULT_REPO por el `primary` del bloque `repos` de pipeline.config.json.
const repoTarget = require('./lib/repo-target');
// #5863 CA-R3 — canal de vuelta hacia el Pulpo. Este proceso es el único que
// aplica labels de verdad; el Pulpo cachea labels 10 min y, sin este registro,
// no tiene forma de enterarse de una mutación aplicada acá.
const labelMutationLog = require('./lib/label-mutation-log');

const ROOT = process.env.PIPELINE_MAIN_ROOT || path.resolve(__dirname, '..');
// #2994 — `GH_BIN_OVERRIDE` permite a los tests E2E de la cola apuntar a un
// stub de `gh` en disco sin tocar el sistema. En producción se ignora.
// #3025 — Sigue siendo el resolver del binario para `defaultGhClient`. Los
// tests unit-puros usan `ghClient` mockeado y NO tocan este path.
const GH_BIN = process.env.GH_BIN_OVERRIDE || 'C:\\Workspaces\\gh-cli\\bin\\gh.exe';
const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);
const QUEUE_DIR = path.join(PIPELINE, 'servicios', 'github');
const PENDIENTE = path.join(QUEUE_DIR, 'pendiente');
const TRABAJANDO = path.join(QUEUE_DIR, 'trabajando');
const LISTO = path.join(QUEUE_DIR, 'listo');
const FALLIDO = path.join(QUEUE_DIR, 'fallido');
const MAX_RETRIES = 3;
const LOG_DIR = path.join(PIPELINE, 'logs');
const STALE_ORDERS_LOG = path.join(LOG_DIR, 'stale-orders.log');

// #4693 CA-0 — resuelto vía repo-target (primary del manifiesto). El helper
// es fail-closed: si el manifiesto falta/está roto, cae a 'intrale/platform'.
// Se evalúa una vez al cargar el módulo (comportamiento idéntico al literal).
const DEFAULT_REPO = (() => {
  try { return repoTarget.getPrimaryRepo(); } catch { return 'intrale/platform'; }
})();

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [svc-github] ${msg}`);
}

function listWorkFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => !f.startsWith('.') && f.endsWith('.json'))
      .map(f => ({ name: f, path: path.join(dir, f) }));
  } catch { return []; }
}

// =============================================================================
// #3303 — `esc()` quedó deprecated y se removió. Era el helper de escapeo
// para interpolación shell de `execSync(`...${esc(body)}...`)`. Convertía
// `\n` real a la secuencia literal `\\n` para no romper el quoting de cmd.exe.
// Efecto colateral: el body posteado a GitHub llegaba con `\n` LITERALES en
// lugar de saltos de línea reales, y el detector de dependencias del Pulpo
// (`parseDependencyComment`) no matcheaba el heading porque el comentario
// quedaba en una sola línea — incidente #3253 (2026-05-17).
//
// Reemplazo: `cp.execFileSync(GH_BIN, argv, { input, ... })`. Argv array NO
// pasa por shell en Windows (CreateProcess directo) ni en Unix (execve), así
// que no requiere escapeo. Body multilínea se pasa por stdin con
// `--body-file -`, que es la API soportada por `gh` (validada en gh 2.86.0).
//
// Por qué NO se mantiene `esc()` como utilidad opcional:
//   - No queda ningún caller en este archivo que pase argumentos por shell.
//   - Si en el futuro un caller necesita shell escape, el patrón canónico
//     es agregar el caso específico con `cp.execFileSync` + argv y NO
//     reintroducir el shell. Mantener un helper "por si acaso" reabre el
//     vector que cerramos.
//   - Cualquier reintroducción de `execSync` o de `esc()` para body/title
//     en este archivo debe ser bloqueada en review — el bug es estructural,
//     no un escape mal escrito.
// =============================================================================

// =============================================================================
// #3025 — defaultGhClient: cliente real que envuelve `cp.execFileSync` al
// binario `gh`. La forma de cada método es la API estable que consume
// `processQueue`, `refreshLabelCache` y `ensureLabels`. Tests inyectan un
// mock JS puro con la misma forma; no hay diferencia funcional para producción.
//
// Salvaguardas preservadas:
//   - `GH_BIN_OVERRIDE` sigue resolviendo el binario (futuros smoke tests E2E
//     reales pueden apuntar a stubs sin tocar este código).
//   - `createLabel` mantiene la idempotencia: detecta "already exists" en el
//     stderr/message y devuelve `{ alreadyExists: true }` sin arrojar. Es
//     crítico para creación concurrente de labels.
//   - `sanitizeGithubPayload(data)` se sigue invocando ANTES del client en el
//     call site del worker (no se mueve dentro del client) — defensa explícita
//     para que cualquier caller del client tenga que sanitizar primero.
//
// #3303 — Refactor a `cp.execFileSync` con argv array:
//   - `commentIssue` y `createIssue` envían el body por stdin con
//     `--body-file -` (preserva newlines reales, soporta cualquier UTF-8).
//   - Resto de métodos (`editIssue`, `listLabels`, `createLabel`) pasan args
//     en argv array — sin shell, sin escape, sin expansión de `%var%`.
// =============================================================================
const defaultGhClient = {
  editIssue(issueNumber, { addLabel, removeLabel } = {}) {
    if (addLabel) {
      cp.execFileSync(GH_BIN, ['issue', 'edit', String(issueNumber), '--add-label', String(addLabel)], {
        cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true,
      });
    }
    if (removeLabel) {
      cp.execFileSync(GH_BIN, ['issue', 'edit', String(issueNumber), '--remove-label', String(removeLabel)], {
        cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true,
      });
    }
  },

  editPullRequest(prNumber, { addLabel, removeLabel } = {}) {
    if (addLabel) {
      cp.execFileSync(GH_BIN, ['pr', 'edit', String(prNumber), '--add-label', String(addLabel)], {
        cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true,
      });
    }
    if (removeLabel) {
      cp.execFileSync(GH_BIN, ['pr', 'edit', String(prNumber), '--remove-label', String(removeLabel)], {
        cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true,
      });
    }
  },

  commentIssue(issueNumber, body) {
    cp.execFileSync(GH_BIN, ['issue', 'comment', String(issueNumber), '--body-file', '-'], {
      cwd: ROOT, encoding: 'utf8', input: body == null ? '' : String(body),
      timeout: 15000, windowsHide: true,
    });
  },

  createIssue({ title, body, labels, repo } = {}) {
    const targetRepo = repo || DEFAULT_REPO;
    const args = ['issue', 'create', '--title', String(title || ''), '--body-file', '-', '--repo', targetRepo];
    if (labels) args.push('--label', String(labels));
    const output = cp.execFileSync(GH_BIN, args, {
      cwd: ROOT, encoding: 'utf8', input: body == null ? '' : String(body),
      timeout: 20000, windowsHide: true,
    }).trim();
    const urlMatch = output.match(/\/(\d+)\s*$/);
    return {
      number: urlMatch ? parseInt(urlMatch[1], 10) : null,
      url: output,
    };
  },

  listLabels({ repo, limit } = {}) {
    const targetRepo = repo || DEFAULT_REPO;
    const targetLimit = limit || 200;
    const raw = cp.execFileSync(
      GH_BIN,
      ['label', 'list', '--json', 'name', '--limit', String(targetLimit), '--repo', targetRepo],
      { cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true },
    );
    return JSON.parse(raw || '[]');
  },

  createLabel(name, color, { repo } = {}) {
    const targetRepo = repo || DEFAULT_REPO;
    try {
      cp.execFileSync(
        GH_BIN,
        ['label', 'create', String(name), '--color', String(color), '--repo', targetRepo],
        { cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true },
      );
      return { created: true, alreadyExists: false };
    } catch (e) {
      // Idempotencia: si el label ya existe (carrera concurrente de varios
      // workers), tratarlo como éxito. Mismo patrón que tenía el código
      // anterior — preservar es CRÍTICO.
      const msg = (e && (e.stderr ? String(e.stderr) : e.message)) || '';
      if (msg.includes('already exists')) {
        return { created: false, alreadyExists: true };
      }
      throw e;
    }
  },

  getIssueLabels(issueNumber) {
    const raw = cp.execFileSync(
      GH_BIN,
      ['issue', 'view', String(issueNumber), '--json', 'labels', '--repo', DEFAULT_REPO],
      { cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true },
    );
    const parsed = JSON.parse(raw || '{}');
    return Array.isArray(parsed.labels)
      ? parsed.labels.map((l) => (l && l.name) ? l.name : String(l)).filter(Boolean)
      : [];
  },

  getPrLabels(prNumber) {
    const raw = cp.execFileSync(
      GH_BIN,
      ['pr', 'view', String(prNumber), '--json', 'labels', '--repo', DEFAULT_REPO],
      { cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true },
    );
    const parsed = JSON.parse(raw || '{}');
    return Array.isArray(parsed.labels)
      ? parsed.labels.map((l) => (l && l.name) ? l.name : String(l)).filter(Boolean)
      : [];
  },
};

// --- Recovery: mover orphans de trabajando/ a pendiente/ al arrancar ---
function recoverOrphans() {
  const orphans = listWorkFiles(TRABAJANDO);
  for (const file of orphans) {
    try {
      fs.renameSync(file.path, path.join(PENDIENTE, file.name));
      log(`Recuperado orphan: ${file.name}`);
    } catch {}
  }
}

// --- Condensador: disparar onComplete cuando un grupo se completa ---
function checkCondenser(data) {
  if (!data.group || !data.groupSize) return;

  const group = data.group;
  const expected = data.groupSize;

  // Contar items del grupo en listo/ y fallido/
  let completed = 0;
  for (const dir of [LISTO, FALLIDO]) {
    for (const f of listWorkFiles(dir)) {
      try {
        const item = JSON.parse(fs.readFileSync(f.path, 'utf8'));
        if (item.group === group) completed++;
      } catch {}
    }
  }

  log(`Condenser: grupo "${group}" — ${completed}/${expected}`);
  if (completed < expected) return;

  // Proteccion anti-duplicado: flag atomico
  const firedMarker = path.join(QUEUE_DIR, `condenser-fired-${group}.json`);
  try {
    fs.writeFileSync(firedMarker, JSON.stringify({ group, ts: Date.now() }), { flag: 'wx' });
  } catch {
    // Otro thread ya disparo el onComplete
    log(`Condenser: grupo "${group}" ya fue disparado`);
    return;
  }

  // Recolectar todos los resultados del grupo
  const results = [];
  for (const dir of [LISTO, FALLIDO]) {
    const dirName = path.basename(dir);
    for (const f of listWorkFiles(dir)) {
      try {
        const item = JSON.parse(fs.readFileSync(f.path, 'utf8'));
        if (item.group === group) {
          results.push({ ...item, _status: dirName === 'fallido' ? 'failed' : 'completed', _file: f.name });
        }
      } catch {}
    }
  }

  // Buscar onComplete en cualquier item del grupo
  const onComplete = data.onComplete;
  if (!onComplete || !onComplete.command) {
    log(`Condenser: grupo "${group}" completado sin onComplete`);
    return;
  }

  // Escribir results JSON
  const resultsPath = path.join(QUEUE_DIR, `condenser-results-${group}.json`);
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

  fireOnComplete(onComplete.command, resultsPath, group);
}

// --- Ejecutar onComplete como proceso hijo ---
function fireOnComplete(command, resultsPath, group) {
  log(`Condenser: grupo "${group}" completado — firing: ${command} --results ${resultsPath}`);

  try {
    // Parsear el command respetando comillas (extraer args correctamente)
    const args = parseCommandArgs(command);
    args.push('--results', resultsPath);
    const child = spawn(process.execPath, args, {
      cwd: ROOT, stdio: 'ignore', detached: true, windowsHide: true
    });
    child.unref();
  } catch (e) {
    log(`Condenser: error firing onComplete: ${e.message}`);
    // Marker para retry al reiniciar
    const retryPath = path.join(QUEUE_DIR, `condenser-retry-${group}.json`);
    fs.writeFileSync(retryPath, JSON.stringify({ group, command, resultsPath, error: e.message, ts: Date.now() }));
  }
}

// --- Parsear args de un comando respetando comillas ---
function parseCommandArgs(command) {
  // Quitar "node " del inicio si lo tiene
  const cmd = command.replace(/^node\s+/, '');
  const args = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  for (const ch of cmd) {
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; }
      else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ' ') {
      if (current) { args.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

// --- Retry de onComplete fallidos al arrancar ---
function retryFailedOnCompletes() {
  const retryFiles = listWorkFiles(QUEUE_DIR).filter(f => f.name.startsWith('condenser-retry-'));
  for (const file of retryFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(file.path, 'utf8'));
      log(`Reintentando onComplete: ${data.command}`);
      const args = parseCommandArgs(data.command);
      if (data.resultsPath) args.push('--results', data.resultsPath);
      const child = spawn(process.execPath, args, {
        cwd: ROOT, stdio: 'ignore', detached: true, windowsHide: true
      });
      child.unref();
      fs.unlinkSync(file.path);
      log(`onComplete reintentado OK, marker eliminado`);
    } catch (e) {
      log(`Error reintentando onComplete ${file.name}: ${e.message}`);
    }
  }
}

// --- Cache de labels existentes (se refresca cada 10 min) ---
let labelCache = new Set();
let labelCacheTs = 0;
const LABEL_CACHE_TTL = 10 * 60 * 1000;

function refreshLabelCache(ghClient = defaultGhClient) {
  if (Date.now() - labelCacheTs < LABEL_CACHE_TTL && labelCache.size > 0) return;
  try {
    const labels = ghClient.listLabels({ repo: DEFAULT_REPO, limit: 200 });
    labelCache = new Set((labels || []).map(l => l.name));
    labelCacheTs = Date.now();
    log(`Label cache refrescado: ${labelCache.size} labels`);
  } catch (e) {
    log(`Error refrescando label cache: ${e.message}`);
  }
}

const LABEL_COLORS = {
  'qa:dependency': 'D93F0B',
  'blocked:dependencies': 'B60205',
  'needs-definition': 'ededed',
  'needs-human': 'B60205',   // #2405 CA-4 — circuit breaker infra escalado a humano
  // #5689 (UX-7) — label de TRIAJE, no de bloqueo. Deliberadamente NO usa el
  // gris por defecto (`ededed`) ni el rojo de alarma del panel de bloqueados
  // (`B60205`): es backlog esperando revisión humana, no un agente frenado.
  // Color = `--purple` de `.pipeline/assets/design-tokens.css:73` (lavanda
  // claro). NO se usa `--purple-dim` (#8957E5) porque es visualmente muy
  // cercano al `5319E7` que ya llevan `area:pipeline` y `app:delivery`, labels
  // que co-ocurren justo en los issues que se van a triar (GURU-6).
  'needs:triage-backlog': 'BC8CFF',
};

function ensureLabels(labelsStr, ghClient = defaultGhClient) {
  if (!labelsStr) return;
  refreshLabelCache(ghClient);
  const names = labelsStr.split(',').map(s => s.trim()).filter(Boolean);
  for (const name of names) {
    if (labelCache.has(name)) continue;
    const color = LABEL_COLORS[name] || 'ededed';
    try {
      const result = ghClient.createLabel(name, color, { repo: DEFAULT_REPO });
      labelCache.add(name);
      // result.alreadyExists === true es éxito silencioso (carrera con
      // otro worker). result.created === true loggea creación nueva.
      if (result && result.created) {
        log(`Label "${name}" creado automáticamente`);
      }
    } catch (e) {
      log(`Error creando label "${name}": ${e.message}`);
    }
  }
}

// Helper para tests: invalida la cache de labels (estado módulo).
function _resetLabelCacheForTests() {
  labelCache = new Set();
  labelCacheTs = 0;
}

function currentLabelsForTarget(number, target, ghClient) {
  const normalizedTarget = target || 'issue';
  if (normalizedTarget !== 'issue' && normalizedTarget !== 'pr') {
    throw new Error(`target inválido para reconciliar labels QA: ${normalizedTarget}`);
  }
  const method = normalizedTarget === 'pr' ? 'getPrLabels' : 'getIssueLabels';
  if (!ghClient || typeof ghClient[method] !== 'function') {
    throw new Error(`ghClient.${method} requerido para reconciliar labels QA`);
  }
  const labels = ghClient[method](number);
  return Array.isArray(labels) ? labels.map(String) : [];
}

// #5690 — Guardrail fail-closed de labels sensibles.
//
// Devuelve `true` si la orden fue RECHAZADA (el caller debe cortar sin mutar),
// `false` si puede seguir su curso normal.
//
// SEC-4 / R4: este camino NUNCA remueve `needs-human` ni ordena removerlo. Su
// único efecto sobre `data` es marcarla como `discarded` — el mismo patrón que
// la guardia de staleness — para que el JSON viaje a `listo/` con la traza.
//
// SEC-C: la consulta de labels actuales se pasa como thunk y NO se envuelve en
// un catch que devuelva `[]`. Si `gh issue view` falla (rate limit, red, token,
// timeout), `evaluateLabelOrder` recibe el throw y falla CERRADO. Con `[]` el
// guardrail no vería conflicto y sería bypasseable a voluntad induciendo rate
// limit. Por eso tampoco se reusa `currentLabelsForIssue`, que normaliza a `[]`.
function applyLabelGuardrail(data, ghClient, origen) {
  if (!data) return false;
  const verdict = labelGuardrail.evaluateLabelOrder({
    action: data.action,
    label: data.label,
    order: data,
    getCurrentLabels: () => {
      if (!ghClient || typeof ghClient.getIssueLabels !== 'function') {
        throw new Error('ghClient.getIssueLabels requerido para evaluar el guardrail de labels');
      }
      return ghClient.getIssueLabels(data.issue);
    },
  });
  if (verdict.allowed) {
    // El escape hatch de procedencia no es criptográfico; lo que lo hace
    // auditable es que cada uso queda escrito y atribuido.
    if (verdict.authorizedBy) {
      labelGuardrail.auditAuthorizedBypass({
        issue: data.issue,
        label_solicitado: data.label,
        labels_actuales: verdict.currentLabels,
        origen: data.origen || origen || null,
        accion: data.action,
        motivo: verdict.motivo,
        authorized_by: verdict.authorizedBy,
      });
      log(`Guardrail de labels: mutación sensible "${data.label}" en #${data.issue} permitida por procedencia declarada "${verdict.authorizedBy}".`);
    }
    return false;
  }

  data.discarded = `label-guardrail:${verdict.motivo}`;
  data.discarded_at = new Date().toISOString();
  data.guardrail_motivo = verdict.motivo;
  data.guardrail_labels_actuales = verdict.currentLabels || null;

  const contexto = {
    issue: data.issue,
    label_solicitado: data.label,
    labels_actuales: verdict.currentLabels,
    origen: data.origen || origen || null,
    accion: data.action,
    motivo: verdict.motivo,
  };
  // Un fallo de auditoría NO puede convertirse en una mutación: el rechazo ya
  // está decidido antes de llegar acá y `auditConflict` nunca tira.
  const audit = labelGuardrail.auditConflict(contexto);
  if (!audit.written && !audit.deduped) {
    log(`Guardrail de labels: no se pudo escribir la auditoría (${audit.error}). El rechazo se aplica igual.`);
  }
  // UX-4a — línea legible en el log normal del servicio. UX-4b — sin Telegram.
  log(labelGuardrail.describeRejection(contexto));
  return true;
}

// #5690 SEC-H — el mismo guardrail sobre el NACIMIENTO del issue.
//
// `case 'create-issue'` pasaba `data.labels` a `ensureLabels` + `createIssue`
// sin ninguna guardia: un issue podía nacer con `needs-human` y
// `tipo:recomendacion` juntos, que es exactamente la mezcla que el CA declara
// imposible por construcción. No alcanza con cubrir la mutación posterior.
//
// Devuelve `true` si la creación fue RECHAZADA (el caller corta sin crear).
// SEC-4/R4 intacto: sólo marca `discarded`, nunca remueve nada.
function applyCreateIssueGuardrail(data, origen) {
  if (!data) return false;
  const verdict = labelGuardrail.evaluateCreateIssueLabels({ labels: data.labels, order: data });
  if (verdict.allowed) {
    if (verdict.authorizedBy) {
      labelGuardrail.auditAuthorizedBypass({
        issue: null,
        label_solicitado: data.labels,
        labels_actuales: null,
        origen: data.origen || origen || null,
        accion: 'create-issue',
        motivo: verdict.motivo,
        authorized_by: verdict.authorizedBy,
      });
      log(`Guardrail de labels: creación con labels sensibles "${data.labels}" permitida por procedencia declarada "${verdict.authorizedBy}".`);
    }
    return false;
  }

  data.discarded = `label-guardrail:${verdict.motivo}`;
  data.discarded_at = new Date().toISOString();
  data.guardrail_motivo = verdict.motivo;

  const contexto = {
    issue: null,
    label_solicitado: data.labels,
    labels_actuales: null,
    origen: data.origen || origen || null,
    accion: 'create-issue',
    motivo: verdict.motivo,
  };
  const audit = labelGuardrail.auditConflict(contexto);
  if (!audit.written && !audit.deduped) {
    log(`Guardrail de labels: no se pudo escribir la auditoría (${audit.error}). El rechazo se aplica igual.`);
  }
  log(labelGuardrail.describeRejection(contexto));
  return true;
}

/**
 * #5863 CA-R3 — Registra en el marker append-only una mutación de label ya
 * APLICADA en GitHub, para que el Pulpo invalide su caché sin esperar el TTL.
 *
 * Se invoca sólo después de que el editor de `gh` retornó sin lanzar: una orden
 * descartada por stale, bloqueada por un gate o fallida NO se registra. El
 * marker describe el estado real de GitHub, no las intenciones de la cola.
 *
 * Best-effort absoluto: si el registro falla, la mutación ya ocurrió y el
 * pipeline debe seguir. El costo de perder una línea es volver al
 * comportamiento previo (la caché del Pulpo vence sola a los 10 minutos).
 */
function recordLabelMutation(issue, label, action, target) {
  try {
    labelMutationLog.recordApplied({
      pipelineDir: PIPELINE, issue, label, action, target,
    });
  } catch { /* best-effort — nunca puede romper el procesamiento de la cola */ }
}

function applyGateLabelAction(data, ghClient) {
  if (!data || !gateLabelReconciler.isGateLabel(data.label)) return false;

  if (data.gate_reconciler === true) {
    const edit = data.target === 'pr' ? ghClient.editPullRequest : ghClient.editIssue;
    if (typeof edit !== 'function') throw new Error(`ghClient sin editor para target=${data.target || 'issue'}`);
    if (data.action === 'label') {
      ensureLabels(data.label, ghClient);
      edit.call(ghClient, data.issue, { addLabel: data.label });
      log(`Gate label reconciliado "${data.label}" -> #${data.issue}`);
      recordLabelMutation(data.issue, data.label, 'label', data.target);
      return true;
    }
    if (data.action === 'remove-label') {
      edit.call(ghClient, data.issue, { removeLabel: data.label });
      log(`Gate label reconciliado "${data.label}" removido de #${data.issue}`);
      recordLabelMutation(data.issue, data.label, 'remove-label', data.target);
      return true;
    }
  }

  if (data.action === 'remove-label') {
    data.discarded = 'legacy-gate-label-remove-blocked';
    data.discarded_at = new Date().toISOString();
    log(`Orden legacy bloqueada: #${data.issue} remove-label=${data.label} (labels QA son dominio del reconciliador)`);
    return true;
  }

  if (data.action !== 'label') return false;

  const target = data.target || 'issue';
  const currentLabels = currentLabelsForTarget(data.issue, target, ghClient);
  const verdict = gateLabelReconciler.verdictForGateLabel(data.label);
  const reconciliation = gateLabelReconciler.reconcileGateLabels({ currentLabels, verdict });
  const actions = gateLabelReconciler.buildLabelActions({ issue: data.issue, reconciliation, target });
  data.gate_reconciled = true;
  data.gate_reconciled_at = new Date().toISOString();
  data.gate_reconciled_from = currentLabels;
  data.gate_reconciled_actions = actions;

  for (const action of actions) {
    const edit = action.target === 'pr' ? ghClient.editPullRequest : ghClient.editIssue;
    if (typeof edit !== 'function') throw new Error(`ghClient sin editor para target=${action.target}`);
    if (action.action === 'remove-label') {
      edit.call(ghClient, action.issue, { removeLabel: action.label });
      log(`Gate label normalizado "${action.label}" removido de #${action.issue}`);
      recordLabelMutation(action.issue, action.label, 'remove-label', action.target);
    } else if (action.action === 'label') {
      ensureLabels(action.label, ghClient);
      edit.call(ghClient, action.issue, { addLabel: action.label });
      log(`Gate label normalizado "${action.label}" -> #${action.issue}`);
      recordLabelMutation(action.issue, action.label, 'label', action.target);
    }
  }
  if (actions.length === 0) {
    log(`Gate label normalizado no-op: #${data.issue} target=${data.label}`);
  }
  return true;
}

// =============================================================================
// #2994 — Guardia idempotente contra órdenes stale (TOCTOU mitigation)
// =============================================================================
//
// El reconciler encola órdenes basadas en un snapshot del FS. Entre el
// snapshot y la ejecución, alguien (humano destrabando, /unblock automático)
// puede haber cambiado el estado. Si re-aplicamos el label sobre un issue
// que ya fue destrabado, lo re-bloqueamos sin justificación (incidente
// 2026-05-05 con #2975).
//
// La guardia se aplica SOLO a órdenes con metadata. Órdenes legacy sin
// `marker_path`/`marker_mtime` ejecutan SIN guardia (degradado seguro,
// comportamiento idéntico al pre-deploy).
//
// Devuelve `null` si la orden está fresca (ejecutar normalmente) o un
// objeto `{reason, current_mtime}` describiendo por qué descartar.
function validateOrderFresh(data) {
    if (!data || data.action !== 'label') return null;
    if (!data.marker_path) return null; // sin metadata = legacy / sin guardia

    if (!fs.existsSync(data.marker_path)) {
        return { reason: 'stale-marker-missing', current_mtime: null };
    }
    if (typeof data.marker_mtime === 'number') {
        let currentMtime;
        try { currentMtime = fs.statSync(data.marker_path).mtimeMs; }
        catch { return { reason: 'stale-marker-missing', current_mtime: null }; }
        // Tolerancia mínima: NTFS reporta mtimeMs en ms, pero filesystems
        // remotos pueden tener ruido sub-ms. 5ms es suficientemente grande
        // para absorber jitter sin enmascarar cambios reales (un destrabe
        // humano modifica el inode y la diferencia es siempre >> 5ms).
        if (currentMtime > data.marker_mtime + 5) {
            return { reason: 'stale-mtime', current_mtime: currentMtime };
        }
    }
    return null;
}

function logStaleOrder(entry) {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            reason: entry.reason || 'unknown',
            issue: entry.issue || null,
            label: entry.label || null,
            snapshot_at: entry.snapshot_at || null,
            current_mtime: entry.current_mtime ?? null,
            detail: entry.detail || null,
        }) + '\n';
        fs.appendFileSync(STALE_ORDERS_LOG, line);
    } catch {
        // best-effort — no tirar el worker por un fallo de logging
    }
}

// --- Procesamiento de cola ---
//
// #3025 — Acepta `{ ghClient = defaultGhClient }` para que los tests puedan
// inyectar un fake JS puro. En producción no se pasa nada y se usa
// `defaultGhClient` (mismo `execSync` que antes).
function processQueue({ ghClient = defaultGhClient } = {}) {
  const files = listWorkFiles(PENDIENTE);
  if (files.length === 0) return;

  for (const file of files) {
    const trabajandoPath = path.join(TRABAJANDO, file.name);
    try { fs.renameSync(file.path, trabajandoPath); } catch { continue; }

    let data;
    try {
      const rawData = JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
      // #2334: sanitizar body/title/label ANTES de invocar al ghClient.
      // El body viaja a la API pública de GitHub, visible por cualquiera.
      // (CA-4 #3025: la sanitización se queda en el call site del worker —
      // NO se mueve dentro del client para que cualquier caller futuro
      // tenga que sanitizar primero.)
      data = sanitizeGithubPayload(rawData);

      switch (data.action) {
        case 'comment':
          ghClient.commentIssue(data.issue, data.body);
          log(`Comentario en #${data.issue}`);
          break;

        case 'label': {
          // #2994 — guardia idempotente: si la orden trae `marker_path`/
          // `marker_mtime`, validar que el FS sigue justificándola antes
          // de invocar `gh`. Si está stale, descartar + log + `discarded:`.
          //
          // CA-5 #3025: la guardia se ejecuta ANTES de tocar el ghClient.
          const stale = validateOrderFresh(data);
          if (stale) {
            data.discarded = stale.reason;
            data.discarded_at = new Date().toISOString();
            data.current_mtime = stale.current_mtime;
            logStaleOrder({
              reason: stale.reason,
              issue: data.issue,
              label: data.label,
              snapshot_at: data.snapshot_at || null,
              current_mtime: stale.current_mtime,
              detail: data.marker_path,
            });
            log(`Orden stale descartada: #${data.issue} label=${data.label} reason=${stale.reason}`);
            // Salir del switch sin invocar `gh`. El bloque común de abajo
            // moverá el JSON a `listo/` con el campo `discarded` ya seteado.
            break;
          }
          // #5690 — guardrail fail-closed contra la mezcla `needs-human` /
          // `tipo:recomendacion` y contra la auto-aprobación de recomendaciones.
          // Va acá, entre la guardia de staleness y `ensureLabels`/`editIssue`,
          // porque este `switch` es el único choke point de MUTACIÓN por el que
          // pasan los 6+ productores que escriben órdenes a la cola.
          if (applyLabelGuardrail(data, ghClient, file.name)) break;
          if (applyGateLabelAction(data, ghClient)) break;
          if (data.target === 'pr') {
            data.discarded = 'non-gate-pr-label-blocked';
            log(`Orden no-gate a PR bloqueada: #${data.issue} label=${data.label}`);
            break;
          }
          ensureLabels(data.label, ghClient);
          ghClient.editIssue(data.issue, { addLabel: data.label });
          log(`Label "${data.label}" → #${data.issue}`);
          recordLabelMutation(data.issue, data.label, 'label', data.target);
          break;
        }

        case 'remove-label':
          // #5690 SEC-B — este `case` no tiene guardia de staleness y
          // `needs-human` no es gate label, así que hasta ahora
          // `{"action":"remove-label","label":"needs-human"}` destrababa
          // cualquier issue bloqueado por un humano sin dejar rastro.
          if (applyLabelGuardrail(data, ghClient, file.name)) break;
          if (applyGateLabelAction(data, ghClient)) break;
          if (data.target === 'pr') {
            data.discarded = 'non-gate-pr-label-blocked';
            log(`Orden no-gate a PR bloqueada: #${data.issue} remove-label=${data.label}`);
            break;
          }
          ghClient.editIssue(data.issue, { removeLabel: data.label });
          log(`Label "${data.label}" removido de #${data.issue}`);
          recordLabelMutation(data.issue, data.label, 'remove-label', data.target);
          break;

        case 'create-issue': {
          // #5690 SEC-H — antes de `ensureLabels`/`createIssue`: un issue que
          // nace mezclado reintroduce la mezcla igual que uno que se mezcla
          // después. Va primero para no crear siquiera los labels.
          if (applyCreateIssueGuardrail(data, file.name)) break;
          ensureLabels(data.labels, ghClient);
          const created = ghClient.createIssue({
            title: data.title,
            body: data.body,
            labels: data.labels,
            repo: data.repo,
          });
          data.result = created;
          log(`Issue creado: #${data.result.number} — ${data.title}`);

          // Defensa anti-deadlock en pausa parcial (fix #2505):
          // Si el issue creado tiene label qa:dependency Y el body referencia
          // un issue que está en el allowlist de partial_pause, agregamos
          // el nuevo número al allowlist. De lo contrario el issue original
          // queda bloqueado esperando a este nuevo que nunca se procesaría.
          try {
            if (data.result?.number && typeof data.labels === 'string' && data.labels.includes('qa:dependency')) {
              const partialPause = require('./lib/partial-pause');
              const mode = partialPause.getPipelineMode();
              if (mode.mode === 'partial_pause') {
                const refs = [...String(data.body || '').matchAll(/#(\d+)/g)].map(m => parseInt(m[1]));
                const touchesAllowlist = refs.some(n => mode.allowedIssues.includes(n));
                if (touchesAllowlist && !mode.allowedIssues.includes(data.result.number)) {
                  const next = [...mode.allowedIssues, data.result.number];
                  partialPause.setPartialPause(next, { source: 'auto-deadlock-prevention' });
                  log(`Partial pause: #${data.result.number} añadido al allowlist (bloquea a issue permitido).`);
                }
              }
            }
          } catch (e) {
            log(`Warning: auto-allowlist falló: ${e.message}`);
          }
          break;
        }

        default:
          log(`Acción desconocida: ${data.action}`);
      }

      // Escribir JSON enriquecido (puede tener result) y mover a listo
      fs.writeFileSync(path.join(LISTO, file.name), JSON.stringify(data, null, 2));
      try { fs.unlinkSync(trabajandoPath); } catch {}
      checkCondenser(data);

    } catch (e) {
      log(`Error procesando ${file.name}: ${e.message}`);
      try {
        const itemData = data || JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
        itemData.retries = (itemData.retries || 0) + 1;
        itemData.lastError = e.message;

        if (itemData.retries >= MAX_RETRIES) {
          fs.writeFileSync(path.join(FALLIDO, file.name), JSON.stringify(itemData, null, 2));
          try { fs.unlinkSync(trabajandoPath); } catch {}
          log(`${file.name} → fallido/ (${itemData.retries} reintentos agotados)`);
          checkCondenser(itemData);
        } else {
          fs.writeFileSync(path.join(PENDIENTE, file.name), JSON.stringify(itemData, null, 2));
          try { fs.unlinkSync(trabajandoPath); } catch {}
          log(`${file.name} → pendiente/ (reintento ${itemData.retries}/${MAX_RETRIES})`);
        }
      } catch {
        // Fallback: mover de vuelta como estaba
        try { fs.renameSync(trabajandoPath, file.path); } catch {}
      }
    }
  }
}

// --- Main ---
function main() {
  // Asegurar directorios
  for (const dir of [PENDIENTE, TRABAJANDO, LISTO, FALLIDO]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  recoverOrphans();
  retryFailedOnCompletes();

  log('Servicio GitHub iniciado');
  try { require('./lib/ready-marker').signalReady('svc-github'); } catch {}
  setInterval(() => {
    try { processQueue(); } catch (e) { log(`Error: ${e.message}`); }
  }, 10000);
}

// #2994 — Side-effects de arranque (escritura del PID, signal/crash handlers)
// SOLO cuando este archivo es el entrypoint. Si lo `require()` un test, no
// queremos tocar el FS real ni registrar handlers contra el process global.
function installSignalHandlers() {
  fs.writeFileSync(path.join(PIPELINE, 'svc-github.pid'), String(process.pid));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  process.on('uncaughtException', (err) => {
    // #2334: sanitizar antes de persistir stack a disco.
    const msg = sanitize(`[${new Date().toISOString()}] [svc-github] CRASH uncaughtException: ${err.stack || err.message}\n`);
    try { fs.appendFileSync(path.join(LOG_DIR, 'svc-github.log'), msg); } catch {}
    console.error(msg);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = sanitize(`[${new Date().toISOString()}] [svc-github] CRASH unhandledRejection: ${reason?.stack || reason}\n`);
    try { fs.appendFileSync(path.join(LOG_DIR, 'svc-github.log'), msg); } catch {}
    console.error(msg);
    process.exit(1);
  });
}

// #2994 — Sólo arrancar el daemon cuando el archivo se ejecuta como entrypoint.
// `require()` desde tests E2E debe poder llamar a `processQueue()` sin disparar
// el setInterval/registrar handlers globales contra el FS real.
if (require.main === module) {
  installSignalHandlers();
  main();
}

module.exports = {
  processQueue,
  validateOrderFresh,
  logStaleOrder,
  STALE_ORDERS_LOG,
  // Constantes que los tests necesitan (resueltas a partir de PIPELINE_STATE_DIR
  // si se setea antes del require).
  PENDIENTE,
  TRABAJANDO,
  LISTO,
  FALLIDO,
  LOG_DIR,
  // #3025 — exposición del cliente default y helpers de testing.
  defaultGhClient,
  refreshLabelCache,
  ensureLabels,
  _resetLabelCacheForTests,
  applyGateLabelAction,
  // #5690 — guardrail de labels sensibles.
  applyLabelGuardrail,
  applyCreateIssueGuardrail,
  currentLabelsForTarget,
};
