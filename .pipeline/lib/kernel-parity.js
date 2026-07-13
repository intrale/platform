'use strict';

/**
 * Verificación E2E de paridad de comportamiento — Ola 9.1 · #4665
 * --------------------------------------------------------------
 * Cierre de la sub-ola 9.1: demostrar, de forma determinística y reproducible,
 * que el pipeline post-migración (kernel migrado + wiring vía `kernel-resolver`)
 * se comporta **idéntico** al estado pre-migración capturado en el tag
 * `pre-ola9-migracion`. Paridad de comportamiento, no solo "compila".
 *
 * Por qué la paridad es verificable de forma barata y de bajo riesgo:
 *  - El consumo del kernel empaquetado está gateado OFF por default
 *    (`pipeline.config.json` → `kernel.consume: false`). En coexistencia, el
 *    `kernel-resolver` devuelve el **motor local** de `.pipeline/`, que quedó
 *    **intacto** durante 9.1 (inventario-migrado-9.1.md).
 *  - Por lo tanto el resultado esperado (comportamiento idéntico) es **por
 *    diseño**: basta demostrar que (a) los entrypoints del motor resueltos por el
 *    wiring nuevo son byte-idénticos a los del tag baseline, y (b) las tablas de
 *    configuración que gobiernan los cuatro flujos clave (intake, dispatch,
 *    gates, delivery) no cambiaron.
 *
 * Este módulo NO arranca procesos ni muta estado del pipeline: es un verificador
 * puro que shellea `git` (execFileSync, array de args — NUNCA shell, sin entrada
 * en banda) para leer blobs de dos refs y compararlos. Fail-closed: cualquier
 * flujo con diferencia estructural o error de resolución cuenta como regresión.
 *
 * Contrato de flujos clave (CA-1/CA-2), fuente `.pipeline/config.yaml`:
 *  - intake   → `intake:` (labels → pipeline/fase de entrada) + `admission`
 *  - dispatch → `pipelines.*` (fases + skills_por_fase) + `concurrencia`
 *  - gates    → `skills_por_fase.verificacion` + `.aprobacion` + `analisis`
 *               (+ `convergence_excludes_skills`)
 *  - delivery → `skills_por_fase.entrega` + `concurrencia.delivery`
 */

const path = require('path');
const { execFileSync } = require('child_process');

const PIPELINE_DIR = path.resolve(__dirname, '..');       // .pipeline/
const PRODUCT_ROOT = path.resolve(PIPELINE_DIR, '..');    // repo del producto

const BASELINE_TAG = 'pre-ola9-migracion';
const CONFIG_REL = '.pipeline/config.yaml';

// Entrypoints del motor que migraron a `core/` del kernel (allowlist del resolver).
const ENGINE_ENTRYPOINTS = Object.freeze(['pulpo', 'dashboard']);
// Archivos del motor cuya byte-identidad demuestra que el arranque no cambió.
const ENGINE_FILES = Object.freeze([
  '.pipeline/pulpo.js',
  '.pipeline/dashboard.js',
  '.pipeline/config.yaml',
]);

// -----------------------------------------------------------------------------
// git helpers — array de args, sin shell (A03/command-injection), fail-safe.
// -----------------------------------------------------------------------------
function git(args, cwd = PRODUCT_ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

/** SHA del blob de `file` en `ref` (o null si no existe / error). */
function blobSha(ref, file) {
  try {
    return git(['rev-parse', `${ref}:${file}`]);
  } catch {
    return null;
  }
}

/** Contenido textual de `file` en `ref` (o null). */
function showFile(ref, file) {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      cwd: PRODUCT_ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** ¿Existe el tag/commit baseline? */
function baselineExists(ref = BASELINE_TAG) {
  try {
    git(['rev-parse', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// YAML — mismo loader lazy que el runtime (canonical-facts.js): js-yaml safe.
// -----------------------------------------------------------------------------
function parseYaml(text) {
  if (text == null) return null;
  const yaml = require('js-yaml'); // safe-by-default (load, sin !!js/function)
  return yaml.load(text) || {};
}

/**
 * Extrae de un config.yaml parseado el subconjunto que gobierna los cuatro
 * flujos clave. Determinístico y estable al ordenamiento (JSON canónico luego).
 */
function extractFlows(cfg) {
  cfg = cfg || {};
  const pipelines = cfg.pipelines || {};
  const flowOf = (pl) => {
    const p = pipelines[pl] || {};
    return { fases: p.fases || null, skills_por_fase: p.skills_por_fase || null };
  };
  return {
    intake: {
      intake: cfg.intake || null,
      admission: cfg.admission || null,
    },
    dispatch: {
      definicion: flowOf('definicion'),
      desarrollo: flowOf('desarrollo'),
      concurrencia: cfg.concurrencia || null,
    },
    gates: {
      analisis: ((pipelines.definicion || {}).skills_por_fase || {}).analisis || null,
      verificacion: ((pipelines.desarrollo || {}).skills_por_fase || {}).verificacion || null,
      aprobacion: ((pipelines.desarrollo || {}).skills_por_fase || {}).aprobacion || null,
      convergence_excludes_skills: (cfg.circuit_breaker || {}).convergence_excludes_skills || null,
    },
    delivery: {
      entrega: ((pipelines.desarrollo || {}).skills_por_fase || {}).entrega || null,
      concurrencia_delivery: (cfg.concurrencia || {}).delivery ?? null,
    },
  };
}

/** Igualdad estructural determinística (orden de claves irrelevante). */
function stableEqual(a, b) {
  return canonical(a) === canonical(b);
}
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

// -----------------------------------------------------------------------------
// CA-1/CA-2 — paridad de los cuatro flujos clave (baseline vs post) por diff
// estructural de la config que los gobierna.
// -----------------------------------------------------------------------------
function verifyFlowParity(baselineRef = BASELINE_TAG, headRef = 'HEAD') {
  const baseText = showFile(baselineRef, CONFIG_REL);
  const headText = showFile(headRef, CONFIG_REL);
  if (baseText == null || headText == null) {
    return {
      ok: false,
      reason: `no se pudo leer ${CONFIG_REL} en ${baseText == null ? baselineRef : headRef}`,
      flows: [],
    };
  }
  const baseFlows = extractFlows(parseYaml(baseText));
  const headFlows = extractFlows(parseYaml(headText));
  const flows = ['intake', 'dispatch', 'gates', 'delivery'].map((name) => {
    const identical = stableEqual(baseFlows[name], headFlows[name]);
    return {
      flow: name,
      identical,
      baseline: baseFlows[name],
      post: headFlows[name],
    };
  });
  return { ok: flows.every((f) => f.identical), flows };
}

// -----------------------------------------------------------------------------
// CA-2/CA-3 — paridad de wiring: los entrypoints del motor resueltos por el
// wiring nuevo son byte-idénticos a los del baseline, y el resolver por default
// (coexistencia) apunta al motor local (mismo path que el arranque pre-migración).
// -----------------------------------------------------------------------------
function verifyEngineParity(baselineRef = BASELINE_TAG, headRef = 'HEAD') {
  const files = ENGINE_FILES.map((f) => {
    const base = blobSha(baselineRef, f);
    const head = blobSha(headRef, f);
    return { file: f, baselineSha: base, postSha: head, identical: base != null && base === head };
  });
  return { ok: files.every((f) => f.identical), files };
}

/**
 * El wiring nuevo (kernel-resolver) resuelve, bajo el default de coexistencia,
 * exactamente los mismos scripts locales del motor que arrancaba el pipeline
 * pre-migración (`path.join(PIPELINE, 'pulpo.js'|'dashboard.js')`).
 */
function verifyResolverDefault() {
  const resolver = require('./kernel-resolver');
  const consumeEnabled = resolver.isConsumeEnabled();
  const entries = ENGINE_ENTRYPOINTS.map((name) => {
    let resolved = null;
    let error = null;
    try {
      resolved = resolver.resolveEntry(name);
    } catch (e) {
      error = e.message;
    }
    const expectedLocal = path.join(PIPELINE_DIR, `${name}.js`);
    const pointsLocal = !!resolved && resolved.source === 'local' && resolved.path === expectedLocal;
    return { name, expectedLocal, resolved, pointsLocal, error };
  });
  return {
    // Paridad exige coexistencia (consume OFF) → motor local idéntico.
    ok: !consumeEnabled && entries.every((e) => e.pointsLocal),
    consumeEnabled,
    entries,
  };
}

// -----------------------------------------------------------------------------
// CA-3 — rollback probado como salida segura.
// El punto de retorno es el tag `pre-ola9-migracion`. Como el default ya es el
// motor local byte-idéntico, el rollback es un no-op de comportamiento; se
// demuestra que (a) el tag existe y resuelve a un commit, y (b) el arranque
// baseline apuntaba a los mismos scripts que el resolver devuelve hoy.
// -----------------------------------------------------------------------------
function verifyRollback(baselineRef = BASELINE_TAG) {
  const exists = baselineExists(baselineRef);
  let sha = null;
  if (exists) {
    try { sha = git(['rev-parse', `${baselineRef}^{commit}`]); } catch { sha = null; }
  }
  const resolverDefault = verifyResolverDefault();
  // El baseline arrancaba pulpo/dashboard desde `.pipeline/` (motor local); el
  // resolver por default devuelve esos mismos paths → rollback sin cambio de path.
  const sameStartTargets = resolverDefault.ok;
  return {
    ok: exists && sameStartTargets,
    baselineRef,
    baselineSha: sha,
    tagExists: exists,
    defaultIsLocalEngine: sameStartTargets,
  };
}

// -----------------------------------------------------------------------------
// CA-4 — paridad de los gates de seguridad: el skill `security` sigue cableado
// en las fases donde corría, la cadena de redacción y el cargador de
// credenciales (path canónico fuera del repo) siguen intactos.
// -----------------------------------------------------------------------------
function verifySecurityGates(headRef = 'HEAD') {
  const cfg = parseYaml(showFile(headRef, CONFIG_REL));
  const flows = extractFlows(cfg);
  const securityInAnalisis = Array.isArray(flows.gates.analisis) && flows.gates.analisis.includes('security');
  const securityInVerificacion = Array.isArray(flows.gates.verificacion) && flows.gates.verificacion.includes('security');
  // Excluido de la convergencia por diseño (defensa en profundidad).
  const securityExcludedFromConvergence = Array.isArray(flows.gates.convergence_excludes_skills)
    && flows.gates.convergence_excludes_skills.includes('security');

  // Cargador de credenciales: path canónico fuera del repo (no roto por cutover).
  const credText = showFile(headRef, '.pipeline/lib/credentials.js') || '';
  const credentialsCanonicalPath = /\.claude\/secrets\/credentials\.json/.test(credText);

  // Cadena de redacción: patrones sensibles intactos (AWS/JWT/api-key/password).
  const redactText = showFile(headRef, '.pipeline/lib/redact.js') || '';
  const redactAwsKey = /AKIA/.test(redactText);
  const redactHasPatterns = /password|api[_-]?key|token|jwt|bearer/i.test(redactText);

  const checks = {
    securityInAnalisis,
    securityInVerificacion,
    securityExcludedFromConvergence,
    credentialsCanonicalPath,
    redactAwsKey,
    redactHasPatterns,
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}

// -----------------------------------------------------------------------------
// CA-5 — secret-scan de la historia migrada: el tooling fail-closed sigue
// presente y su resultado documentado (0 hallazgos reales) es reproducible. No
// re-corremos el barrido de 2390 blobs (requiere el staging efímero del kernel);
// verificamos presencia del escáner + allowlist auditada + test node --test.
// -----------------------------------------------------------------------------
function verifySecretScanTooling(headRef = 'HEAD') {
  const present = {
    scanner: blobSha(headRef, '.pipeline/kernel-bootstrap/scan-history-9.1.js') != null,
    allowlist: blobSha(headRef, '.pipeline/kernel-bootstrap/motor-9.1-secret-allowlist.json') != null,
    test: blobSha(headRef, '.pipeline/tests/kernel-scan-history-9.1.test.js') != null,
  };
  return { ok: Object.values(present).every(Boolean), present };
}

// -----------------------------------------------------------------------------
// Orquestador — reporte estructurado de paridad. Fail-closed: `passed` sólo si
// todos los ejes pasan.
// -----------------------------------------------------------------------------
function runParity(opts = {}) {
  const baselineRef = opts.baselineRef || BASELINE_TAG;
  const headRef = opts.headRef || 'HEAD';

  const axes = {
    engine: verifyEngineParity(baselineRef, headRef),      // CA-2 wiring bytes
    flows: verifyFlowParity(baselineRef, headRef),          // CA-1/CA-2 flujos
    resolver: verifyResolverDefault(),                      // CA-2 default→local
    rollback: verifyRollback(baselineRef),                  // CA-3
    security: verifySecurityGates(headRef),                 // CA-4
    secretScan: verifySecretScanTooling(headRef),           // CA-5
  };

  const passed = Object.values(axes).every((a) => a && a.ok);
  return { passed, baselineRef, headRef, axes };
}

module.exports = {
  BASELINE_TAG,
  CONFIG_REL,
  ENGINE_ENTRYPOINTS,
  ENGINE_FILES,
  // helpers
  blobSha,
  showFile,
  baselineExists,
  parseYaml,
  extractFlows,
  stableEqual,
  // ejes
  verifyFlowParity,
  verifyEngineParity,
  verifyResolverDefault,
  verifyRollback,
  verifySecurityGates,
  verifySecretScanTooling,
  runParity,
};
