#!/usr/bin/env node
// delivery.js — Orquestador determinístico del refactor #2870.
//
// Reemplaza la lógica del SKILL.md de /delivery con un script que:
//   1. Lee estado git con git-context
//   2. Clasifica el cambio con change-classifier
//   3. Lee payload del issue (si existe) o cae a fallback
//   4. Construye commit-message con commit-builder
//   5. Construye pr-body con pr-builder
//   6. Ejecuta: git commit + push + gh pr create
//
// Cero LLM. Determinismo total.
//
// QUÉ ES ESTE ARCHIVO Y QUÉ NO (#6496 rev-2)
// -----------------------------------------------------------------------------
// NO es el camino que corre la fase `entrega` del pipeline. Esa fase ejecuta el
// skill determinístico `.pipeline/skills-deterministicos/delivery.js`
// (`DETERMINISTIC_SKILLS` en `lib/agent-launcher/providers/deterministic.js`).
//
// Este archivo TAMPOCO es código muerto: es el CLI de `/delivery`, o sea
//   · el fallback LLM (`.claude/skills/delivery/SKILL.md` lo invoca), que se
//     activa por diseño si el script determinístico desaparece (rollout
//     reversible de #2476/#2482/#2484), y
//   · el uso manual del operador desde el repo principal.
// Los dos tocan el remoto, así que los dos necesitan los mismos gates.
//
// Regla que sale de esto: toda decisión que gobierne una entrega vive en
// `lib/` y la consumen AMBOS. Duplicarla es lo que produjo el defecto de rev-1
// —el GATE 3 implementado sólo acá, con 100 tests en verde mientras producción
// integraba veredictos caducos—. Ver `lib/delivery/freshness-gate.js`.
//
// Uso:
//   node .pipeline/delivery.js --issue <N> --description "<desc>" [--type <tipo>] [--draft]
//   node .pipeline/delivery.js --description "<desc>" [--type <tipo>]   (sin issue)

'use strict';

// #5172 — `fs` quedó sin uso: la única lectura de disco de este archivo era el
// `readFileSync` de config.yaml, que ahora hace el punto único.
// #5864 — vuelve a usarse: encolar la propagación del label de gate QA al PR.
const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');
// #6226 - escritura fail-closed de dropfiles.
const dropfileWriter = require('./lib/dropfile-writer');

const gitCtx = require('./lib/delivery/git-context');
const classifier = require('./lib/delivery/change-classifier');
const commitBuilder = require('./lib/delivery/commit-builder');
const prBuilder = require('./lib/delivery/pr-builder');
const operatorSignature = require('./lib/operator-signature');
const gateLabelReconciler = require('./lib/gate-label-reconciler');
// #5864 SEC-2 — procedencia del PR destino (defensa contra PRs de fork).
const prProvenance = require('./lib/pr-provenance');
// #6496 — consumidor del sello de evidencia de QA (#6495): caducidad + reparación.
const qaEvidenceSeal = require('./lib/qa-evidence-seal');
// #6496 rev-2 — GATE 3 compartido. La POLÍTICA de caducidad vive en un único
// módulo que consumen los DOS caminos de entrega (este CLI y el skill
// determinístico `skills-deterministicos/delivery.js`, que es el que corre la
// fase `entrega`). No se duplica la decisión en dos archivos.
const freshnessGate = require('./lib/delivery/freshness-gate');

// #6496 — Raíz del ESTADO del pipeline.
//
// `entrega` corre en el WORKTREE del issue (`lib/phase-workspace.js` →
// `EXISTING_WORKTREE_PHASES`), así que `__dirname` es el `.pipeline/` del
// worktree: un árbol que tiene la estructura de directorios versionada pero
// NINGÚN estado vivo y NINGÚN servicio drenándolo. Los dropfiles de
// `desarrollo/verificacion/procesado/`, el contador de caducidad y la cola de
// `servicios/github` viven en el `.pipeline/` del REPO PRINCIPAL, que el Pulpo
// le pasa a todo agente en `PIPELINE_REPO_ROOT` (`pulpo.js`).
//
// #6496 rev-2 — la resolución vive en `lib/delivery/freshness-gate.js` para que
// este CLI y el skill determinístico (el camino REAL de la fase `entrega`) usen
// EXACTAMENTE la misma raíz de estado. Acá sólo se fija el fallback a
// `__dirname`, que es el correcto para el uso manual desde el repo principal.
function resolveStatePipelineDir() {
  return freshnessGate.resolveStatePipelineDir({ fallbackDir: __dirname });
}

// ---- #4575 · GATE 2 defense-in-depth (revalidación firma↔HEAD) --------------
//
// La retención estructural vive en pulpo.js (no promueve `aprobacion → entrega`
// sin firma, así delivery ni corre para un issue sin firmar). Esto es la segunda
// barrera anti-TOCTOU (CA-3): justo antes de crear/mergear el PR, revalidamos que
// exista una firma verde ligada AL HEAD ACTUAL. Kill switch OFF por default.
//
// Función pura y testeable: recibe headSha + config + signers y devuelve
// `{ ok, reason }`. NO ejecuta git/gh (eso lo resuelve `main`).
function checkOperatorSignatureGate({ issueNumber, headSha, config, authorizedSigners, pipelineDir }) {
  const sig = (config && config.operator_signature) || {};
  if (sig.enabled !== true) return { ok: true, reason: 'gate disabled (kill switch)' };
  if (!issueNumber) return { ok: true, reason: 'sin issue asociado — gate no aplica' };

  const res = operatorSignature.evaluate({
    issue: { number: issueNumber },
    headOid: headSha,
    config: sig,
    options: { authorizedSigners, pipelineDir },
  });
  if (res.decision === 'block') {
    return { ok: false, reason: `GATE 2 (firma de aceptación): ${res.reason}` };
  }
  return { ok: true, reason: res.reason };
}

// #5172 — Carga FAIL-CLOSED de config.yaml (lee `operator_signature` y `cua`).
//
// ANTES era "best-effort": `catch { return {} }`. Con `{}`,
// `operator_signature.enabled !== true` ⇒ GATE 2 se saltaba entero. O sea: una
// config ilegible APAGABA el gate de firma humana justo antes de pushear y crear
// el PR, y el operador leía "🔏 gate disabled (kill switch)" como si fuera una
// decisión suya. Ese es el fail-open que la historia mata.
//
// AHORA propaga el error tipado (ya redactado). delivery.js es un CLI de un solo
// tiro: el `catch` de `require.main` imprime el motivo y sale con código 1 —
// sin defaults silenciosos y sin haber tocado el remoto. La ausencia de las
// secciones `operator_signature:`/`cua:` NO es error (D-4): eso lo siguen
// resolviendo los defaults de `checkOperatorSignatureGate` y
// `resolveAuthorizedSigners`.
//
// El parámetro `pipelineDir` (punto de inyección por firma) se conserva tal cual.
function loadConfigFailClosed(pipelineDir) {
  // Lazy: requerir el resolver en el tope obligaría a `js-yaml`+`ajv` a existir
  // sólo para importar el módulo desde un test.
  const configResolver = require('./lib/config-resolver');
  try {
    return configResolver.resolve({ pipelineDir });
  } catch (e) {
    // Ruidoso y accionable ANTES de propagar: el `catch` de arriba sólo imprime
    // `err.message`, que para un YAML roto no dice ni qué archivo ni qué línea.
    try {
      const configSchema = require('./lib/config-schema');
      const estado = configSchema.describeConfigFailure(e, { archivo: e && e.archivo, contexto: 'cli' });
      console.error(configSchema.formatConfigFailureLog(estado, {
        titulo: 'CONFIG INVÁLIDA — delivery abortado (no se evalúa GATE 2 con defaults)',
      }));
    } catch { /* si ni el formateador carga, propaga igual */ }
    throw e;
  }
}

// Firmantes autorizados (CA-4): allowlist única `cua.operator_chat_ids` +
// credential dedicada del operador (env). NO se crea lista paralela.
function resolveAuthorizedSigners(config, env = process.env) {
  const ids = new Set();
  const cua = (config && config.cua) || {};
  if (Array.isArray(cua.operator_chat_ids)) {
    for (const raw of cua.operator_chat_ids) {
      const s = String(raw == null ? '' : raw).trim();
      if (s) ids.add(s);
    }
  }
  const envOperator = String(env.TELEGRAM_LEO_OPERATOR_CHAT_ID || '').trim();
  if (envOperator) ids.add(envOperator);
  return Array.from(ids);
}

// ---- CLI parsing -----------------------------------------------------------

function parseArgs(argv) {
  const args = {
    issue: null,
    description: null,
    type: null,
    draft: false,
    dryRun: false,
    json: false,
    repo: 'intrale/platform',
    base: 'main',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--issue') args.issue = argv[++i];
    else if (a === '--description') args.description = argv[++i];
    else if (a === '--type') args.type = argv[++i];
    else if (a === '--draft') args.draft = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--base') args.base = argv[++i];
  }
  return args;
}

// ---- gh CLI helpers --------------------------------------------------------

function gh(ghArgs, opts = {}) {
  const result = spawnSync('gh', ghArgs, {
    stdio: 'pipe',
    encoding: 'utf8',
    windowsHide: true,
    ...opts,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

// ---- #5864 · Propagación del label de gate QA issue → PR -------------------
//
// El ciclo de QA aplica `qa:passed`/`qa:failed`/`qa:pending` sobre el ISSUE, y
// el gate previo al merge los busca en el PR. Acá se cierra ese tramo: es el
// único punto del pipeline donde el PR ya existe (lo acabamos de crear/resolver)
// y todavía no se mergeó.
//
// Función PURA (sin fs/gh) para que la decisión sea testeable. Reglas:
//   - SEC-1: el vínculo issue↔PR lo establece la RAMA (`agent/<issue>-…`), nunca
//     el cuerpo del PR. Si la rama no corresponde al issue, no se propaga.
//   - SEC-2/fail-closed: ante ausencia o conflicto de labels de gate en el
//     issue no se escribe nada y queda el motivo. Nunca se infiere aprobación.
//   - SEC-3: unidireccional. El issue es la autoridad; el PR es sólo destino.
//   - Se emite UNA sola orden (sin `gate_reconciler`) para que el worker de
//     `servicio-github` relea los labels frescos DEL PR y haga remove-then-add
//     sincrónico (exclusión mutua garantizada, sin race de orden en la cola).
function buildPrGatePropagation({ issue, prNumber, branch, issueLabels, prHead, repo, pipelineDir, hasOpenRequeue } = {}) {
  const issueNum = parseInt(issue, 10);
  if (!Number.isInteger(issueNum) || issueNum <= 0) return { ok: false, reason: 'sin_issue' };
  // #6496 CA-12 / SEC-C — mientras haya un re-encolado de verificación ABIERTO,
  // el gate del issue NO viaja al PR. El label del issue es la autoridad que lee
  // esta propagación; si un veredicto caducó, `requeueVerification` ya lo degradó
  // a `qa:pending` y hay una orden en vuelo para volver a verificar. Propagar
  // igual —aunque sea `qa:pending`— convierte una ventana de re-verificación en
  // una afirmación sobre el PR que nadie hizo. Fail-closed: `hasOpenRequeue`
  // contesta `true` ante cualquier error que no sea "la cola no existe".
  const requeueAbierto = typeof hasOpenRequeue === 'function'
    ? hasOpenRequeue
    : qaEvidenceSeal.hasOpenRequeue;
  if (requeueAbierto({ pipelineDir: pipelineDir || resolveStatePipelineDir(), issue: issueNum })) {
    return { ok: false, reason: 're_encolado_de_verificacion_abierto' };
  }
  const pr = parseInt(prNumber, 10);
  if (!Number.isInteger(pr) || pr <= 0) return { ok: false, reason: 'pr_no_resuelto' };
  if (typeof branch !== 'string' || !branch.startsWith(`agent/${issueNum}-`)) {
    return { ok: false, reason: 'rama_no_corresponde_al_issue', branch: branch || null };
  }
  // SEC-2 — el chequeo de arriba valida la rama LOCAL; éste valida el PR
  // DESTINO. El repo es público y la rama `agent/<issue>-<skill>` es
  // predecible, así que un fork puede abrir un PR con esa misma rama y cobrar
  // el `qa:passed` del issue. Fail-closed ante falta de datos.
  const prov = prProvenance.checkPrProvenance(prHead, { branch, repo });
  if (!prov.ok) return { ok: false, reason: prov.reason, detail: prov.detail || null };
  if (prHead.number !== undefined && parseInt(prHead.number, 10) !== pr) {
    return { ok: false, reason: 'procedencia_desconocida', detail: `pr consultado #${prHead.number} ≠ destino #${pr}` };
  }
  const gates = [...new Set(
    (Array.isArray(issueLabels) ? issueLabels : [])
      .map((l) => (l && typeof l === 'object' && l.name) ? String(l.name) : String(l))
      .filter((l) => gateLabelReconciler.isGateLabel(l)),
  )];
  if (gates.length === 0) return { ok: false, reason: 'issue_sin_label_de_gate' };
  if (gates.length > 1) return { ok: false, reason: 'labels_de_gate_en_conflicto', labels: gates };
  return { ok: true, action: { action: 'label', issue: pr, target: 'pr', label: gates[0] } };
}

// Encola la propagación. NUNCA es fatal: un problema acá no puede tumbar la
// entrega (el PR ya existe y el label ausente mantiene cerrado el gate).
function propagateGateLabelToPr({ issue, prNumber, branch, repo, pipelineDir }) {
  try {
    if (!issue) {
      console.log('→ gate QA: sin issue asociado, no se propaga');
      return null;
    }
    const view = gh(['issue', 'view', String(issue), '--repo', repo, '--json', 'labels']);
    if (!view.ok) {
      console.log(`→ gate QA: no se propaga (fetch_failed: ${view.stderr || `exit ${view.status}`})`);
      return null;
    }
    let issueLabels = [];
    try { issueLabels = JSON.parse(view.stdout || '{}').labels || []; }
    catch (e) {
      console.log(`→ gate QA: no se propaga (respuesta ilegible: ${e.message})`);
      return null;
    }
    // SEC-2 — datos de procedencia del PR destino, leídos justo antes de
    // decidir. Si `gh` falla, `prHead` queda null y la decisión es fail-closed.
    let prHead = null;
    if (prNumber) {
      const prView = gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', prProvenance.PR_PROVENANCE_FIELDS.join(',')]);
      if (prView.ok) {
        try { prHead = JSON.parse(prView.stdout || 'null'); } catch { prHead = null; }
      }
    }
    const res = buildPrGatePropagation({
      issue, prNumber, branch, issueLabels, prHead, repo,
      // #6496 — el estado (y la cola de re-encolados) vive en el repo principal,
      // no en el worktree donde corre `entrega`.
      pipelineDir: resolveStatePipelineDir(),
    });
    if (!res.ok) {
      console.log(`→ gate QA: no se propaga al PR (${res.reason}${res.detail ? `: ${res.detail}` : ''})`);
      return null;
    }
    // #6496 — la cola tiene que ser la del REPO PRINCIPAL. `entrega` corre en el
    // worktree del issue, así que el `__dirname` de este archivo apunta al
    // `.pipeline/` del worktree: un árbol con la estructura de directorios
    // versionada pero sin ningún `servicio-github` drenándolo. La orden quedaba
    // escrita en una cola muerta y el label nunca llegaba al PR.
    const queueDir = path.join(pipelineDir || resolveStatePipelineDir(), 'servicios', 'github', 'pendiente');
    fs.mkdirSync(queueDir, { recursive: true });
    // #6226 - escritura fail-closed. Se conserva el nombre; solo ante colision
    // real se desambigua con `-<n>`.
    const { filePath: file } = dropfileWriter.writeUniqueFileSync({
        dir: queueDir,
        filename: `${issue}-delivery-pr-${res.action.issue}-${Date.now()}.json`,
        data: JSON.stringify(res.action),
        onCollision: (name, attempt) => console.log(
            `-> gate QA: colision de nombre de orden github (${name}, intento ${attempt + 1}) - se reintenta, no se sobreescribe`
        ),
    });
    console.log(`→ gate QA: encolado ${res.action.label} para el PR #${res.action.issue} (desde el issue #${issue})`);
    return file;
  } catch (e) {
    console.log(`→ gate QA: no se propaga (error: ${e.message})`);
    return null;
  }
}

// Lee body + comments del issue. Devuelve { body, comments: [{body}] }.
function fetchIssue(issueNumber, repo) {
  if (!issueNumber) return { body: null, comments: [] };
  const r = gh([
    'issue', 'view', String(issueNumber),
    '--repo', repo,
    '--json', 'body,comments',
  ]);
  if (!r.ok) return { body: null, comments: [] };
  try {
    const data = JSON.parse(r.stdout);
    return {
      body: data.body || null,
      comments: (data.comments || []).map((c) => ({ body: c.body || '' })),
    };
  } catch {
    return { body: null, comments: [] };
  }
}

// ---- Main ------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();

  // 1. Snapshot de git
  const snap = gitCtx.snapshot(cwd, `origin/${args.base}`);
  if (!snap.branch) {
    console.error('❌ No se pudo determinar branch actual');
    process.exit(1);
  }
  if (snap.ahead === 0) {
    console.error(`❌ Branch ${snap.branch} no tiene commits adelante de origin/${args.base}`);
    process.exit(1);
  }

  // 2. Clasificar cambio
  const inferredType = classifier.classify({
    files: snap.files,
    commits: snap.commits,
    status: snap.status,
    override: args.type,
  });

  // 3. Leer issue (si hay) para payload
  const issue = fetchIssue(args.issue, args.repo);

  // 4. Construir commit-message
  const commit = commitBuilder.build({
    issueBody: issue.body,
    issueComments: issue.comments,
    type: inferredType,
    description: args.description,
    issueNumber: args.issue,
  });

  // 5. Construir pr-body
  const pr = prBuilder.build({
    issueBody: issue.body,
    issueComments: issue.comments,
    description: args.description,
    diffStat: snap.stat,
    issueNumber: args.issue,
  });

  // Modo --json: emite todo lo computado y termina (no ejecuta git/gh).
  // Útil para que /delivery (SKILL.md) consuma sin perder los gates externos.
  if (args.json) {
    const out = {
      branch: snap.branch,
      base: args.base,
      ahead: snap.ahead,
      stat: snap.stat,
      type: inferredType,
      issue: args.issue,
      commitMessage: commit.message,
      commitSource: commit.source,
      prTitle: commit.message.split('\n')[0],
      prBody: pr.body,
      prSource: pr.source,
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // Reporte de lo que se va a hacer
  console.log('━━━ /delivery (determinístico) ━━━');
  console.log(`Branch:      ${snap.branch}`);
  console.log(`Base:        origin/${args.base}`);
  console.log(`Ahead:       ${snap.ahead} commits, ${snap.stat.files} archivos`);
  console.log(`Tipo:        ${inferredType || 'N/A'}`);
  console.log(`Issue:       ${args.issue || 'N/A'}`);
  console.log(`Commit src:  ${commit.source}`);
  console.log(`PR src:      ${pr.source}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (args.dryRun) {
    console.log('\n--- COMMIT MESSAGE ---');
    console.log(commit.message);
    console.log('\n--- PR BODY ---');
    console.log(pr.body);
    console.log('\n(--dry-run: no se ejecutó push ni se creó PR)');
    return;
  }

  // 5.5 #4575 — GATE 2 defense-in-depth: revalidar firma verde ligada al HEAD
  // actual antes de tocar remoto (anti-TOCTOU CA-3). Kill switch OFF ⇒ no-op.
  const pipelineDir = path.join(__dirname);
  const cfg = loadConfigFailClosed(pipelineDir);
  if (((cfg.operator_signature || {}).enabled === true) && args.issue) {
    const headRev = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const headSha = headRev.status === 0 ? (headRev.stdout || '').trim() : '';
    const gate = checkOperatorSignatureGate({
      issueNumber: parseInt(args.issue, 10),
      headSha,
      config: cfg,
      authorizedSigners: resolveAuthorizedSigners(cfg),
      pipelineDir,
    });
    if (!gate.ok) {
      console.error(`❌ Merge/entrega bloqueado — ${gate.reason}`);
      process.exit(1);
    }
    console.log(`🔏 GATE 2 OK: ${gate.reason}`);
  }

  // 5.6 #6496 — GATE 3: CADUCIDAD DEL VEREDICTO DE QA.
  //
  // Va acá y no en otro lado: DESPUÉS del GATE 2 y ANTES del push. Un chequeo
  // posterior al push no sirve de nada —el remoto ya se movió— y uno anterior al
  // GATE 2 gastaría trabajo en issues que la firma va a frenar igual.
  //
  // Qué resuelve: hoy un desfasaje entre el HEAD que QA verificó y el HEAD que se
  // va a integrar no lo detecta nadie de forma determinista (lo detectó un agente
  // PO leyendo un YAML a mano en #6258), y cuando se detecta el issue muere con
  // `needs-human` + `blocked:routing-manual`. Acá se convierte en una reparación
  // automática acotada: re-encolar verificación, máximo dos veces, y recién
  // entonces escalar.
  //
  // La POLÍTICA (qué es caduco, qué se encola, cuándo escala) vive en
  // `lib/delivery/freshness-gate.js`, compartida con el skill determinístico.
  // Acá sólo se traduce el resultado al contrato de salida de ESTE CLI.
  const statePipelineDir = resolveStatePipelineDir();
  let shaVerificado = null;

  // rebote security rev-3 (F1) — EL GATE NO PUEDE SER OPCIONAL.
  //
  // Antes todo este bloque colgaba de `if (args.issue)`, o sea que el gate se
  // desactivaba OMITIENDO UN FLAG: sin `--issue`, con `--issue ""`, o con
  // `--issue` como último argumento (`argv[++i]` ⇒ `undefined`), `shaVerificado`
  // quedaba `null` y el flujo seguía derecho al `git push` y al `gh pr create`.
  // Este archivo es el que corren el fallback LLM de `/delivery` y el operador a
  // mano: un agente que ve el JSON `veredicto_caduco` y reintenta "sin el flag
  // que lo frenó" empujaba al remoto un HEAD que nadie verificó. El gate entero
  // que agrega #6496 se apagaba por omisión — lo contrario de fail-closed. El
  // gemelo determinístico ya fallaba cerrado ante lo mismo (`if (!issue) exit 2`).
  //
  // Resolución, distinguiendo flag AUSENTE de flag VACÍO:
  //   · `args.issue === null` ⇒ el flag no se pasó (valor inicial de `parseArgs`).
  //     Se deriva de la rama `agent/<issue>-…`, que es la misma autoridad
  //     issue↔rama que usa `buildPrGatePropagation` (SEC-1).
  //   · rama `agent/*` sin issue derivable ⇒ exit 1. Es una rama del pipeline:
  //     que no se pueda nombrar el issue no la exime, la vuelve no verificable.
  //   · flag presente pero vacío/roto ⇒ NO se saltea: cae en `issueInvalido` y
  //     sale 1. "Vacío" nunca significa "seguí sin gate".
  //   · rama que no es del pipeline (`feature/*`, `bugfix/*`, main…) ⇒ no hay
  //     veredicto de QA indexado por issue contra el cual chequear frescura, así
  //     que el gate no aplica. Se deja constancia explícita en stdout.
  const AGENT_BRANCH_ISSUE = /^agent\/(\d+)-/;
  let issueGate = args.issue;
  if (args.issue === null) {
    const m = AGENT_BRANCH_ISSUE.exec(snap.branch || '');
    if (m) {
      issueGate = m[1];
      console.log(`ℹ️  GATE 3: --issue ausente, issue #${issueGate} derivado de la rama ${snap.branch}`);
    } else if (/^agent\//.test(snap.branch || '')) {
      console.error(`❌ Rama del pipeline ${snap.branch} sin número de issue derivable: no se puede verificar la frescura del veredicto de QA`);
      process.exit(1);
    } else {
      issueGate = null;
      console.log(`ℹ️  GATE 3 no aplica: ${snap.branch} no es una rama del pipeline (agent/<issue>-…), no hay veredicto de QA indexado por issue`);
    }
  }

  if (issueGate !== null) {
    const gate3 = freshnessGate.evaluateFreshnessGate({
      pipelineDir: statePipelineDir, issue: issueGate, cwd,
    });
    if (gate3.issueInvalido) {
      // Fail-closed: con un `--issue` que no es un número de issue no se puede ni
      // resolver el veredicto ni nombrar el contador. No se toca el remoto.
      console.error('❌ --issue inválido: no se puede verificar la frescura del veredicto de QA');
      process.exit(1);
    }
    if (gate3.caduco) {
      for (const linea of gate3.stderr) console.error(linea);
      // rev-4 (D3) — sin reparación encolada no se puede afirmar "esto se repara
      // solo". `evaluateFreshnessGate` traga la excepción de
      // `requeueVerification` en `reparacionError` y devuelve `caduco:true` con
      // `reparacionOk:false`; emitir igual el contrato `veredicto_caduco` hacía
      // que el agente LLM (y el Pulpo detrás) leyeran "ya está encolada la
      // reparación" cuando la cola había quedado vacía. El gate frena lo mismo
      // —no se pushea ni se mergea nada—, pero sale 1: esto es un fallo que
      // necesita el camino de rechazo normal, no una auto-reparación.
      if (!gate3.reparacionOk) {
        console.error(`❌ veredicto caduco y la reparación NO quedó encolada`
          + `${gate3.reparacionError ? `: ${gate3.reparacionError}` : ''}`);
        console.error('❌ La re-verificación NO está encolada: requiere atención.');
        process.exit(1);
      }
      // CA-14 — contrato machine-readable como ÚLTIMA línea de stdout. Quien
      // ejecuta este script es un agente LLM: `exit 0` a secas es
      // indistinguible de "entrega exitosa" y produce el falso positivo de R3
      // en `delivery-status.js` (#5220/#5244, markers `aprobado` cuyo motivo
      // confiesa "merge bloqueado"). Sale con 0 —no 1— para que el Pulpo pueda
      // drenar la orden y re-encolar; un `exit 1` dejaría el issue muerto igual
      // que hoy.
      console.log(JSON.stringify(gate3.contrato));
      process.exit(0);
    }
    // CA-15 — se pushea el SHA VERIFICADO, no una referencia simbólica.
    shaVerificado = gate3.shaVerificado;
    console.log(`🔎 GATE 3 OK: ${gate3.exento
      ? 'exención de migración pre-sellado'
      : 'el veredicto de QA está sellado contra el HEAD actual'}${
      shaVerificado ? ` (${shaVerificado.slice(0, 8)}…)` : ''}`);
  }

  // 6. Push (asume commits ya hechos por el agente)
  //
  // #6496 CA-15 / SEC-F — con un SHA verificado se pushea ESE SHA explícito, no
  // el nombre de la rama. Antes se verificaba un SHA y se pusheaba un nombre que
  // pudo haber avanzado entre el chequeo y el push (TOCTOU): si un commit entra
  // en esa ventana, `git push -u origin <branch>` lo sube igual y el gate queda
  // hablando de un commit que no es el que se integró. El GATE 2 recomputa el
  // HEAD por esta misma razón (#4575). Si el HEAD se movió, `git push <sha>:<ref>`
  // sube exactamente lo verificado y nada más.
  console.log('\n→ git push...');
  const pushArgs = shaVerificado
    ? ['-C', cwd, 'push', 'origin', `${shaVerificado}:refs/heads/${snap.branch}`]
    : ['-C', cwd, 'push', '-u', 'origin', snap.branch];
  const push = spawnSync('git', pushArgs, { stdio: 'inherit' });
  if (push.status !== 0) {
    console.error('❌ git push falló');
    process.exit(1);
  }
  if (shaVerificado) {
    // `push <sha>:refs/heads/<branch>` no setea upstream (no acepta `-u`).
    // Best-effort: sin upstream el PR se crea igual (`--head` es explícito), así
    // que un fallo acá no puede frenar una entrega ya pusheada.
    spawnSync('git', ['-C', cwd, 'branch', `--set-upstream-to=origin/${snap.branch}`, snap.branch], { stdio: 'ignore' });
  }
  // CA-8 (rebote security rev-3, F6) — ACÁ NO SE RESETEA EL CONTADOR.
  //
  // El reset estaba en este punto, atado al push. Pero CA-8 dice "cuando un
  // veredicto fresco SE INTEGRA", y lo que integra es el merge — y este CLI
  // NUNCA mergea: pushea y, como mucho, crea el PR. O sea que el reset acá era
  // incondicional en el 100% de las corridas, y con eso el tope de 2
  // re-encolados automáticos de CA-9 se podía reiniciar indefinidamente
  // corriendo `/delivery` — la escalada a `needs-human` no llegaba nunca.
  //
  // El único punto de reset vive donde se confirma el merge
  // (`skills-deterministicos/delivery.js`, tras `mergeSha = outcome.sha`). Que el
  // contador sobreviva a una entrega por CLI es la dirección conservadora: a lo
  // sumo el próximo caduco escala una vuelta antes, que es fail-closed.

  // 7. Crear PR (si no existe)
  const existing = gh([
    'pr', 'list',
    '--repo', args.repo,
    '--head', snap.branch,
    '--state', 'open',
    '--json', prProvenance.PR_PROVENANCE_FIELDS.join(','),
  ]);

  let prUrl = null;
  let prNumber = null;
  if (existing.ok && existing.stdout && existing.stdout !== '[]') {
    try {
      const list = JSON.parse(existing.stdout);
      // SEC-2 — `--head` no filtra por owner: descartar PRs de fork antes de
      // adoptar uno como "el PR de esta entrega".
      for (const p of (Array.isArray(list) ? list : [])) {
        const prov = prProvenance.checkPrProvenance(p, { branch: snap.branch, repo: args.repo });
        if (prov.ok) { prUrl = p.url; prNumber = p.number; break; }
        console.log(`→ PR #${(p && p.number) || '?'} descartado por procedencia (${prov.reason}${prov.detail ? `: ${prov.detail}` : ''})`);
      }
    } catch {}
  }

  if (!prUrl) {
    console.log('→ gh pr create...');
    const subject = commit.message.split('\n')[0];
    const createArgs = [
      'pr', 'create',
      '--repo', args.repo,
      '--title', subject,
      '--body', pr.body,
      '--base', args.base,
      '--head', snap.branch,
      '--assignee', 'leitolarreta',
    ];
    if (args.draft) createArgs.push('--draft');
    const create = gh(createArgs);
    if (!create.ok) {
      console.error('❌ gh pr create falló:', create.stderr);
      process.exit(1);
    }
    prUrl = create.stdout.split('\n').find((l) => l.startsWith('https://')) || create.stdout;
    const m = prUrl.match(/\/pull\/(\d+)/);
    prNumber = m ? m[1] : null;
  } else {
    console.log(`→ PR ya existe: ${prUrl}`);
  }

  // 8. #5864 — el label de gate QA viaja del issue al PR, sin intervención
  //    humana. Único punto del flujo donde el PR ya existe y no se mergeó.
  propagateGateLabelToPr({
    issue: args.issue,
    prNumber,
    branch: snap.branch,
    repo: args.repo,
    pipelineDir: resolveStatePipelineDir(),
  });

  console.log(`\n✅ Delivery completo`);
  console.log(`   PR:     ${prUrl}`);
  console.log(`   Number: ${prNumber || 'N/A'}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('❌ Error en delivery.js:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  fetchIssue,
  main,
  // #5864 — propagación del label de gate QA issue → PR (exportados para tests)
  buildPrGatePropagation,
  propagateGateLabelToPr,
  // #4575 — GATE 2 defense-in-depth (exportados para tests)
  checkOperatorSignatureGate,
  resolveAuthorizedSigners,
  // #5172 — renombrado desde `loadConfigBestEffort`: ya no es best-effort, es
  // fail-closed. El nombre viejo describía justo la degradación que se eliminó.
  loadConfigFailClosed,
  // #6496 — raíz del estado del pipeline (repo principal, no worktree).
  resolveStatePipelineDir,
};
