'use strict';

/**
 * Kernel resolver — cutover de wiring (Ola 9.1 · #4664)
 * ----------------------------------------------------
 * Punto ÚNICO donde el producto (adaptador Intrale) resuelve los entrypoints del
 * motor de orquestación migrado al repo del kernel (`@intrale/operating-kernel`,
 * #4662/#4663). En vez de que `restart.js` apunte directo a `.pipeline/pulpo.js`
 * y `.pipeline/dashboard.js` (ubicación vieja del motor), pasa por acá: el wiring
 * "apunta al kernel migrado" (CA-1) a través de una resolución declarativa.
 *
 * Reglas de diseño (contrato kernel↔adaptador #4010 §6.1 · kernel-repo-design §2):
 *  - Se resuelve el kernel por NOMBRE de paquete desde `node_modules`
 *    (`require.resolve`), NUNCA por `require()` de un path arbitrario ni derivado
 *    de entrada externa (issue body / labels / chat). Los subpaths consumibles son
 *    una allowlist estática (`ENTRYPOINTS`), no datos en banda.
 *  - Consumo pineado por referencia inmutable + validación de `contractVersion`
 *    antes de cargar (§6.2). Integridad del origen (security A08).
 *
 * Coexistencia (por qué el default NO cambia el comportamiento — CA-2/CA-3):
 *  - El `.pipeline/` del producto QUEDA intacto durante 9.1 (ver
 *    `docs/desacople-kernel/inventario-migrado-9.1.md`). El motor local es
 *    byte-idéntico al del kernel (verificado por el operador 2026-07-12).
 *  - El CONSUMO del paquete está gateado OFF por default: la externalización del
 *    estado del motor (`.pipeline/` state, `config.yaml`) es la sub-ola 9.4 y el
 *    freeze del motor local es la 9.5. Hasta entonces, arrancar el kernel
 *    empaquetado resolvería mal sus paths de estado. Por eso, salvo opt-in
 *    explícito, el resolver devuelve el motor LOCAL: el pipeline arranca idéntico.
 *  - Cuando el consumo se habilita (post 9.4/9.5, con OK humano), este mismo
 *    resolver pasa a devolver el entrypoint del paquete sin tocar `restart.js`.
 *
 * Activación (opt-in, gateado):
 *  - `pipeline.config.json` → `kernel.consume: true`, o
 *  - variable de entorno `PIPELINE_CONSUME_KERNEL=1`.
 *  Habilitado + paquete ausente/incompatible ⇒ error accionable (fail-closed):
 *  no se degrada en silencio a un motor local que el operador cree retirado.
 */

const fs = require('fs');
const path = require('path');

const PIPELINE_DIR = path.resolve(__dirname, '..');           // .pipeline/
const PRODUCT_ROOT = path.resolve(PIPELINE_DIR, '..');        // repo del producto
const MANIFEST_PATH = path.join(PRODUCT_ROOT, 'pipeline.config.json');

const KERNEL_PACKAGE = '@intrale/operating-kernel';
// Major de contrato soportado por este adaptador. contractVersion 0.x ⇒ major 0.
const SUPPORTED_CONTRACT_MAJOR = 0;

/**
 * Allowlist estática de entrypoints del motor que migraron a `core/` del kernel.
 * (Frontera autoritativa: docs/desacople-kernel/inventario-migrado-9.1.md §"Mapa
 * de re-ubicación": .pipeline/pulpo.js → core/pulpo.js, .pipeline/dashboard.js →
 * core/dashboard.js). NO se aceptan nombres fuera de esta tabla.
 */
const ENTRYPOINTS = Object.freeze({
  pulpo:     { pkgSubpath: `${KERNEL_PACKAGE}/core/pulpo`,     localScript: 'pulpo.js' },
  dashboard: { pkgSubpath: `${KERNEL_PACKAGE}/core/dashboard`, localScript: 'dashboard.js' },
});

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/** ¿El operador habilitó explícitamente el consumo del kernel empaquetado? */
function isConsumeEnabled(manifest = readManifest()) {
  if (process.env.PIPELINE_CONSUME_KERNEL === '1') return true;
  return !!(manifest && manifest.kernel && manifest.kernel.consume === true);
}

/** Resuelve el `package.json` del kernel instalado (o null si no está). */
function resolveKernelPackageJson() {
  try {
    const pkgJsonPath = require.resolve(`${KERNEL_PACKAGE}/package.json`, {
      paths: [PRODUCT_ROOT],
    });
    return { path: pkgJsonPath, json: JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) };
  } catch {
    return null;
  }
}

/** ¿Está el paquete del kernel instalado en node_modules? */
function isKernelInstalled() {
  return resolveKernelPackageJson() !== null;
}

/**
 * Valida compatibilidad de contrato antes de cargar (§6.2). Devuelve la versión
 * del paquete si es compatible; lanza error accionable si no.
 */
function assertKernelCompatible(pkg) {
  const version = pkg && pkg.json && pkg.json.version;
  const major = Number.parseInt(String(version).split('.')[0], 10);
  if (!Number.isInteger(major) || major !== SUPPORTED_CONTRACT_MAJOR) {
    throw new Error(
      `✗ Kernel ${KERNEL_PACKAGE}@${version || '¿?'}: contractVersion incompatible.\n` +
      `  Qué pasó:  el adaptador soporta major ${SUPPORTED_CONTRACT_MAJOR}.x y encontró ${version}.\n` +
      `  Por qué:   un cambio MAJOR del contrato invalida adaptadores existentes (kernel-repo-design §3.1).\n` +
      `  Cómo seguir: alineá el pin del kernel con un release ${SUPPORTED_CONTRACT_MAJOR}.x o actualizá el adaptador.`
    );
  }
  return version;
}

/**
 * Resuelve el path del script a ejecutar para un entrypoint del motor.
 *
 * @param {'pulpo'|'dashboard'} name  entrypoint lógico (allowlist).
 * @returns {{ path: string, source: 'kernel'|'local', version: string|null }}
 */
function resolveEntry(name) {
  const entry = ENTRYPOINTS[name];
  if (!entry) {
    // Nombre fuera de la allowlist: se rechaza (no require de path arbitrario).
    throw new Error(
      `✗ Entrypoint de kernel desconocido: ${JSON.stringify(name)}. ` +
      `Permitidos: ${Object.keys(ENTRYPOINTS).join(', ')}.`
    );
  }

  const localPath = path.join(PIPELINE_DIR, entry.localScript);
  const manifest = readManifest();

  if (!isConsumeEnabled(manifest)) {
    // Default de 9.1: motor LOCAL, comportamiento idéntico (CA-2/CA-3).
    return { path: localPath, source: 'local', version: null };
  }

  // Consumo habilitado (opt-in gateado): fail-closed si el paquete no está listo.
  const pkg = resolveKernelPackageJson();
  if (!pkg) {
    throw new Error(
      `✗ Consumo del kernel habilitado (kernel.consume) pero ${KERNEL_PACKAGE} no está instalado.\n` +
      `  Qué pasó:  no se puede resolver el paquete del kernel en node_modules.\n` +
      `  Por qué:   falta 'npm ci' con el kernel pineado (o el paquete no fue publicado todavía).\n` +
      `  Cómo seguir: instalá el kernel pineado o volvé a kernel.consume:false (motor local) — no se degrada en silencio.`
    );
  }
  const version = assertKernelCompatible(pkg);
  const resolvedPath = require.resolve(entry.pkgSubpath, { paths: [PRODUCT_ROOT] });
  return { path: resolvedPath, source: 'kernel', version };
}

module.exports = {
  KERNEL_PACKAGE,
  SUPPORTED_CONTRACT_MAJOR,
  ENTRYPOINTS,
  MANIFEST_PATH,
  readManifest,
  isConsumeEnabled,
  isKernelInstalled,
  resolveKernelPackageJson,
  assertKernelCompatible,
  resolveEntry,
};
