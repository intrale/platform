'use strict';

/**
 * Verificación de paridad de la sub-ola 9.2 — #5068
 * -------------------------------------------------
 * Cierre de la 9.2: demostrar que el pipeline de Intrale opera **idéntico**
 * consumiendo el kernel parametrizado. Es el análogo de `kernel-parity.js`
 * (9.1 · #4665), que probó paridad por byte-identidad del motor; acá el eje es
 * otro, porque lo que cambió en la 9.2 es distinto.
 *
 * Qué cambió en la 9.2 y por qué la paridad se verifica así
 * ---------------------------------------------------------
 * #5067 reescribió los 10 skills de orquestación para que resuelvan las
 * convenciones del producto por el contrato del adaptador en vez de tenerlas
 * escritas: 83 literales → 0 (kernel: `contracts/parametrization-map.md`).
 *
 * Un `SKILL.md` es un prompt en Markdown: **no tiene superficie ejecutable que
 * asertar**. El puente por el que un skill obtiene una convención es
 * `bin/adapter-env.js` del kernel (`kernel-adapter-env`), que proyecta cada
 * accessor del loader a una variable de entorno.
 *
 * Entonces "opera idéntico" tiene un significado preciso y verificable: para
 * cada uno de los cinco flujos que el issue enumera, **el valor que hoy resuelve
 * el contrato es exactamente el literal que el skill tenía hardcodeado antes de
 * la sub-ola**. Si los valores coinciden, el skill emite los mismos comandos, y
 * el comportamiento observable del pipeline no cambió.
 *
 * Los literales esperados de abajo NO se leen del manifiesto (eso sería
 * tautológico: comparar el manifiesto consigo mismo). Están escritos acá como
 * constantes, tomados del estado PRE-9.2: el inventario de convenciones
 * embebidas del kernel (`contracts/inventory.md`, relevado en #5065) y `CLAUDE.md`
 * del producto. Este módulo es el único lugar del repo donde esos literales
 * deben aparecer, y precisamente por eso vive en el adaptador y no en el kernel.
 *
 * Sobre `kernel.consume: false`
 * -----------------------------
 * Que el manifiesto declare `consume: false` **no** invalida esta verificación:
 * es el estado de diseño de la 9.2. La coexistencia está gateada a propósito y
 * habilitar el consumo del paquete es la 9.4/9.5 (ver el encabezado de
 * `kernel-resolver.js`: migrar el estado del motor es la 9.4, el freeze la 9.5).
 * La 9.1 cerró su paridad exactamente en el mismo régimen. Lo que la 9.2
 * cambió — y lo que acá se verifica — es la resolución de convenciones por el
 * contrato, que corre con el consumo apagado igual: el puente `adapter-env` lee
 * el manifiesto del producto, no el paquete publicado.
 *
 * No muta estado ni arranca procesos: ejecuta el puente del kernel en un proceso
 * hijo (`execFileSync`, array de args, NUNCA shell) y compara texto.
 * Fail-closed: cualquier flujo no verificable cuenta como fallo, nunca como
 * "verde por omisión".
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PIPELINE_DIR = path.resolve(__dirname, '..');        // .pipeline/
const PRODUCT_ROOT = path.resolve(PIPELINE_DIR, '..');     // repo del producto
const MANIFEST_PATH = path.join(PRODUCT_ROOT, 'pipeline.config.json');

/** Sub-path del puente dentro del checkout del kernel. */
const ADAPTER_ENV_REL = path.join('bin', 'adapter-env.js');

// -----------------------------------------------------------------------------
// Literales PRE-9.2 — el estado contra el que se mide la paridad.
// Fuentes: kernel `contracts/inventory.md` (#5065) y `CLAUDE.md` del producto.
// -----------------------------------------------------------------------------

const FLOWS = Object.freeze([
  {
    id: 'branch',
    title: 'Creación de rama con el patrón declarado',
    checks: [
      { var: 'ADAPTER_BRANCH_PATTERN', expected: 'agent/<issue>-<slug>', source: 'CLAUDE.md §Ramas y PRs — "Agentes IA · agent/<issue>-<slug>"' },
      { var: 'ADAPTER_BRANCH_BASE', expected: 'origin/main', source: 'CLAUDE.md §Ramas y PRs — base de las ramas de agente' },
      { var: 'ADAPTER_BRANCH_PROTECTED', expected: 'main develop', source: 'CLAUDE.md §Protocolo de tareas — "nunca en main ni develop"' },
    ],
  },
  {
    id: 'delivery',
    title: 'delivery crea PR en el repo correcto, con assignee y body de convención',
    checks: [
      { var: 'ADAPTER_REPO_SLUG', expected: 'intrale/platform', source: 'inventory.md §Capa 1 — slug del repositorio (16 ocurrencias)' },
      { var: 'ADAPTER_ASSIGNEE', expected: 'leitolarreta', source: 'CLAUDE.md §Ramas y PRs — "Asignar a: leitolarreta"' },
      { var: 'ADAPTER_PR_CLOSES_KEYWORD', expected: 'Closes', source: 'CLAUDE.md §Ramas y PRs — body con "Closes #<n>"' },
      { var: 'ADAPTER_PR_AUTO_MERGE', expected: 'false', source: 'CLAUDE.md §Ramas y PRs — "NO auto-merge"' },
    ],
  },
  {
    id: 'qa-gate',
    title: 'El gate de QA lee y escribe los labels declarados',
    checks: [
      { var: 'ADAPTER_QA_PASSED', expected: 'qa:passed', source: 'CLAUDE.md §Gate de QA — labels requeridos antes de merge' },
      { var: 'ADAPTER_QA_SKIPPED', expected: 'qa:skipped', source: 'CLAUDE.md §Gate de QA — labels requeridos antes de merge' },
      { var: 'ADAPTER_QA_PENDING', expected: 'qa:pending', source: 'CLAUDE.md §Gate de QA — "NUNCA mergear con qa:pending"' },
    ],
  },
  {
    id: 'monitor-dashboard',
    title: 'Monitor y dashboard levantan y muestran estado',
    checks: [
      { var: 'ADAPTER_DISPLAY_NAME', expected: 'Intrale Platform', source: 'inventory.md §Capa 1 — nombre visible en la línea de rol (7 ocurrencias)' },
    ],
    // Además de la convención, este flujo verifica el arranque (ver verifyEngineBoot).
    engineBoot: true,
  },
  {
    id: 'reset-ops',
    title: 'reset y ops operan sobre el workspace declarado',
    checks: [
      { var: 'ADAPTER_WORKSPACE_ROOT', expected: 'C:/Workspaces/Intrale/platform', normalize: 'path', source: 'inventory.md §Capa 1 — ruta absoluta del checkout (18 ocurrencias)' },
      { var: 'ADAPTER_WORKTREES_ROOT', expected: 'C:/Workspaces/Intrale', normalize: 'path', source: 'inventory.md §Capa 1 — directorio padre de los checkouts aislados' },
      { var: 'ADAPTER_WORKTREE_PREFIX', expected: 'platform', source: 'pipeline.config.json §workspace.worktreePrefix' },
    ],
    workspaceProbe: true,
  },
]);

// -----------------------------------------------------------------------------
// Resolución del checkout del kernel
// -----------------------------------------------------------------------------

/**
 * Ubica el checkout del kernel que provee el puente `adapter-env`.
 * Orden: env explícita → paquete instalado → checkout hermano (`../kernel`,
 * el mismo path que declara `cross_repo_delivery` en `config.yaml`).
 * @returns {{root: string, how: string} | null}
 */
function resolveKernelRoot() {
  const fromEnv = process.env.KERNEL_ROOT;
  if (fromEnv && fs.existsSync(path.join(fromEnv, ADAPTER_ENV_REL))) {
    return { root: path.resolve(fromEnv), how: 'variable de entorno KERNEL_ROOT' };
  }

  try {
    const pkgJson = require.resolve('@intrale/operating-kernel/package.json', { paths: [PRODUCT_ROOT] });
    const root = path.dirname(pkgJson);
    if (fs.existsSync(path.join(root, ADAPTER_ENV_REL))) {
      return { root, how: 'paquete @intrale/operating-kernel instalado' };
    }
  } catch { /* no instalado: es lo esperado con consume:false */ }

  const sibling = path.resolve(PRODUCT_ROOT, '..', 'kernel');
  if (fs.existsSync(path.join(sibling, ADAPTER_ENV_REL))) {
    return { root: sibling, how: 'checkout hermano ../kernel (cross_repo_delivery)' };
  }
  return null;
}

// -----------------------------------------------------------------------------
// Puente
// -----------------------------------------------------------------------------

/**
 * Ejecuta `bin/adapter-env.js --json` del kernel contra el manifiesto del producto.
 * @returns {{ok: true, env: object} | {ok: false, error: string}}
 */
function runAdapterEnv(kernelRoot, manifestPath = MANIFEST_PATH) {
  const script = path.join(kernelRoot, ADAPTER_ENV_REL);
  try {
    const out = execFileSync(process.execPath, [script, '--json'], {
      cwd: kernelRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, KERNEL_ADAPTER_CONFIG: manifestPath },
    });
    return { ok: true, env: JSON.parse(out) };
  } catch (e) {
    const detail = (e && (e.stderr || e.message)) || String(e);
    return { ok: false, error: String(detail).trim().slice(0, 800) };
  }
}

// -----------------------------------------------------------------------------
// Comparaciones
// -----------------------------------------------------------------------------

/** Normaliza separadores para comparar rutas sin atarse al SO. */
function normalizePath(v) {
  return String(v).replace(/\\/g, '/').replace(/\/+$/, '');
}

function compare(check, actual) {
  if (actual === undefined) {
    return { ...check, actual: null, ok: false, why: 'el contrato no emitió la variable' };
  }
  const norm = check.normalize === 'path' ? normalizePath : (x) => String(x);
  const ok = norm(actual) === norm(check.expected);
  return { ...check, actual, ok, why: ok ? null : 'el valor resuelto difiere del literal pre-9.2' };
}

// -----------------------------------------------------------------------------
// Sondas no-textuales
// -----------------------------------------------------------------------------

/**
 * Monitor y dashboard "levantan": el resolver del kernel devuelve los
 * entrypoints del motor y esos archivos son sintácticamente cargables por Node.
 * No se arranca el servidor (mutaría estado y tomaría puertos); se verifica que
 * el arranque no está roto y que la superficie de estado que muestran existe.
 */
function verifyEngineBoot() {
  const checks = [];

  let resolver = null;
  try {
    resolver = require('./kernel-resolver');
  } catch (e) {
    checks.push({ name: 'kernel-resolver cargable', ok: false, detail: e.message });
    return checks;
  }

  for (const entry of ['pulpo', 'dashboard']) {
    let resolved = null;
    let err = null;
    try {
      resolved = typeof resolver.resolveEntrypoint === 'function'
        ? resolver.resolveEntrypoint(entry)
        : null;
    } catch (e) { err = e.message; }

    const script = path.join(PIPELINE_DIR, `${entry}.js`);
    const exists = fs.existsSync(script);
    checks.push({
      name: `entrypoint "${entry}" resuelto y presente`,
      ok: exists && !err,
      detail: err
        ? `resolver falló: ${err}`
        : `${exists ? 'presente' : 'AUSENTE'} en .pipeline/${entry}.js` +
          (resolved ? ` · resolver → ${JSON.stringify(resolved).slice(0, 200)}` : ''),
    });

    if (exists) {
      try {
        execFileSync(process.execPath, ['--check', script], {
          encoding: 'utf8', windowsHide: true, timeout: 60_000,
        });
        checks.push({ name: `${entry}.js parsea (node --check)`, ok: true, detail: 'sin errores de sintaxis' });
      } catch (e) {
        checks.push({
          name: `${entry}.js parsea (node --check)`,
          ok: false,
          detail: String((e && (e.stderr || e.message)) || e).trim().slice(0, 400),
        });
      }
    }
  }

  // "Muestran estado": el estado del pipeline es el filesystem.
  const stateDirs = ['desarrollo/dev/pendiente', 'desarrollo/dev/trabajando', 'desarrollo/dev/listo'];
  const missing = stateDirs.filter((d) => !fs.existsSync(path.join(PIPELINE_DIR, d)));
  checks.push({
    name: 'superficie de estado del pipeline presente',
    ok: missing.length === 0,
    detail: missing.length ? `faltan: ${missing.join(', ')}` : `${stateDirs.length} directorios de cola verificados`,
  });

  return checks;
}

/** `reset` y `ops` operan sobre el workspace declarado: el root existe y es un repo git. */
function verifyWorkspaceProbe(env) {
  const checks = [];
  const root = env.ADAPTER_WORKSPACE_ROOT;
  if (!root) {
    return [{ name: 'workspace.root declarado', ok: false, detail: 'el contrato no emitió ADAPTER_WORKSPACE_ROOT' }];
  }
  const exists = fs.existsSync(root);
  checks.push({ name: 'workspace.root existe', ok: exists, detail: exists ? root : `no existe: ${root}` });

  if (exists) {
    let top = null;
    try {
      top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000,
      }).trim();
    } catch (e) { top = null; }
    checks.push({
      name: 'workspace.root es un checkout git',
      ok: !!top,
      detail: top ? `toplevel = ${top}` : 'git rev-parse falló',
    });
  }

  const wtRoot = env.ADAPTER_WORKTREES_ROOT;
  checks.push({
    name: 'worktreesRoot existe',
    ok: !!wtRoot && fs.existsSync(wtRoot),
    detail: wtRoot ? `${wtRoot}${fs.existsSync(wtRoot) ? '' : ' (AUSENTE)'}` : 'no emitido',
  });

  return checks;
}

// -----------------------------------------------------------------------------
// Verificación completa
// -----------------------------------------------------------------------------

/**
 * Corre la verificación de paridad 9.2.
 * @returns {{ok:boolean, kernel:object|null, flows:Array, error:string|null}}
 */
function verifyParity({ kernelRoot = null, manifestPath = MANIFEST_PATH } = {}) {
  const resolved = kernelRoot
    ? { root: kernelRoot, how: 'parámetro explícito' }
    : resolveKernelRoot();

  if (!resolved) {
    return {
      ok: false,
      kernel: null,
      flows: [],
      error:
        'No se encontró el puente `bin/adapter-env.js` del kernel.\n' +
        '  Buscado en: $KERNEL_ROOT, el paquete @intrale/operating-kernel instalado, y ../kernel.\n' +
        '  Cómo seguir: apuntá KERNEL_ROOT al checkout del kernel. La paridad NO se da por verde sin poder ejercitar el contrato.',
    };
  }

  const bridge = runAdapterEnv(resolved.root, manifestPath);
  if (!bridge.ok) {
    return {
      ok: false,
      kernel: resolved,
      flows: [],
      error: `El puente del kernel falló contra ${manifestPath}:\n${bridge.error}`,
    };
  }

  const env = bridge.env;
  const flows = FLOWS.map((flow) => {
    const checks = flow.checks.map((c) => compare(c, env[c.var]));
    const probes = [];
    if (flow.engineBoot) probes.push(...verifyEngineBoot());
    if (flow.workspaceProbe) probes.push(...verifyWorkspaceProbe(env));
    const ok = checks.every((c) => c.ok) && probes.every((p) => p.ok);
    return { id: flow.id, title: flow.title, ok, checks, probes };
  });

  return { ok: flows.every((f) => f.ok), kernel: resolved, flows, error: null, env };
}

// -----------------------------------------------------------------------------
// Reporte
// -----------------------------------------------------------------------------

function formatReport(result) {
  const out = [];
  out.push('Paridad de la sub-ola 9.2 — el pipeline de Intrale con el kernel parametrizado (#5068)');
  out.push('='.repeat(86));

  if (result.error) {
    out.push('');
    out.push(`✗ No verificable: ${result.error}`);
    return out.join('\n');
  }

  out.push(`kernel: ${result.kernel.root}`);
  out.push(`        (resuelto por ${result.kernel.how})`);
  out.push('');

  for (const flow of result.flows) {
    out.push(`${flow.ok ? '✓' : '✗'} ${flow.id} — ${flow.title}`);
    for (const c of flow.checks) {
      const mark = c.ok ? '·' : '✗';
      out.push(`    ${mark} ${c.var}`);
      out.push(`        esperado (pre-9.2): ${JSON.stringify(c.expected)}`);
      out.push(`        resuelto por contrato: ${JSON.stringify(c.actual)}`);
      if (!c.ok) out.push(`        → ${c.why}`);
      out.push(`        fuente: ${c.source}`);
    }
    for (const p of flow.probes) {
      out.push(`    ${p.ok ? '·' : '✗'} ${p.name}: ${p.detail}`);
    }
    out.push('');
  }

  const okCount = result.flows.filter((f) => f.ok).length;
  out.push('='.repeat(86));
  out.push(`${result.ok ? '✓' : '✗'} ${okCount}/${result.flows.length} flujos con paridad verificada.`);
  return out.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const idx = args.indexOf('--kernel-root');
  const kernelRoot = idx !== -1 && args[idx + 1] ? path.resolve(args[idx + 1]) : null;

  const result = verifyParity({ kernelRoot });
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
  }
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = {
  FLOWS,
  resolveKernelRoot,
  runAdapterEnv,
  normalizePath,
  compare,
  verifyEngineBoot,
  verifyWorkspaceProbe,
  verifyParity,
  formatReport,
  main,
};
