#!/usr/bin/env node
'use strict';

// =============================================================================
// opstate-cutover-probe.js — Sondas del cutover del ESTADO OPERATIVO (#7189)
//
// Herramienta de OPERADOR para preparar el cutover del registro de olas
// (`waves.json`) y la allowlist (`.partial-pause.json`) al store durable
// (`intrale-kernel-coordination`), con el flag `operational_state.durable`
// APAGADO. Todo lo que hace es de sólo lectura o idempotente; lo irreversible
// (encender flags, `apply` contra AWS, R8 medido, aborto en ventana real) vive
// en la hija H0 (#7194) y lo ejecuta el operador siguiendo
// `docs/pipeline/runbook-cutover-estado-operativo.md` §10.
//
// SUBCOMANDOS (uno por invocación):
//
//   --preconditions     CA-1 · sólo lectura. Reporta CA-B1 (strict auth +
//                       `gate_grace` en 30 días), CA-B2 (CAS declarado por el
//                       driver real), CA-B3 (identidad efectiva del runtime),
//                       CA-B5 (namespaceado + layout migrado), el valor efectivo
//                       de `kernel.durable` (D-9) y `describeMode()`.
//   --cas-probe         CA-2 · escribe UNA clave de sonda (`coord#opstate-cas-probe`)
//                       por `compareAndSet` contra AWS real con la identidad del
//                       runtime: dos escrituras con la misma `expectedVersion`,
//                       la segunda tiene que volver `conflict: true`.
//   --positive          CA-3 · sólo lectura. `coord#waves` y `coord#partial-pause`
//                       por dos caminos disjuntos (backend vs `get-item
//                       --consistent-read`): verde sólo con contenido NO vacío,
//                       `version ≥ 1` y SHA-256 canónico idéntico.
//   --migration-dry-run CA-4 · dry-run del migrador contra las fuentes reales con
//                       backup timestampeado verificado contra su `manifest.json`.
//                       NUNCA `apply` (eso va en H0 y en los tests contra fake).
//   --export-to-fs      CA-5 · reintegra olas + allowlist del store al `stateDir()`.
//                       Se NIEGA sin `.pipeline/.paused` (el freno del cutover, D-3).
//   --abort-drill       CA-6 · ensayo del aborto con el sink REAL
//                       (`kernel-degradation-alert.createDegradationSink`) y un
//                       `halt` inyectado que escribe `.paused` en un SANDBOX
//                       temporal — nunca en el `.pipeline/` real.
//
// LO QUE ESTE ARCHIVO NO HACE, A PROPÓSITO
//   - No toca `.pipeline/config.yaml` ni ningún flag (CA-9).
//   - No hace `put-item` / `delete-item` a mano: la única escritura al store es
//     la clave de sonda, por `compareAndSet` (SEC-9 / D-5).
//   - No degrada a filesystem: si el store no responde, el resultado es ROJO.
//   - No se importa desde el pulpo: es standalone, no puede dejarlo fuera de
//     servicio.
//
// ESTILO (igual que `lib/kernel-cutover-probe.js`, la voz que el operador ya
// conoce de #5208/#5209): `[OK]` / `[FALLA]` por paso, cada falla con una CAUSA
// máquina-legible estable y una línea "→ H0 paso N" que dice qué la pone en
// verde; línea final `VEREDICTO:`; `--json` para la evidencia (siempre pasado
// por `redactAll`). Errores como DATO, nunca `throw` fuera del módulo, nunca
// `process.exit` (ni siquiera en el CLI: se usa `process.exitCode`).
// =============================================================================

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib');

// Todos los módulos del pipeline se requieren LAZY: `main()` puede fijar
// `PIPELINE_DIR_OVERRIDE` antes de tocarlos y los tests inyectan casi todo.
const lib = (name) => require(path.join(LIB, name)); // eslint-disable-line global-require

// ─── Constantes del contrato ────────────────────────────────────────────────

/** Clave de sonda del CAS (CA-2). SK resultante: `coord#opstate-cas-probe`. */
const PROBE_KEY = 'opstate-cas-probe';

/**
 * Drivers que prueban algo contra AWS real. El backend usa el SÍNCRONO
 * (`createAwsCliDynamoDriverSync` ⇒ `'aws-cli-sync'`); `'aws-cli'` es el async
 * del mismo runner (precisión del PO en `validacion`, 2026-09-14).
 */
const ALLOWED_DRIVER_KINDS = Object.freeze(['aws-cli', 'aws-cli-sync']);

/** Trampa §2.5: el driver en memoria da verde sin escribir un byte. NUNCA, ni con override. */
const FORBIDDEN_DRIVER_KINDS = Object.freeze(['in-memory']);

const GATE_GRACE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const OPSTATE_KEYS = Object.freeze(['waves', 'partial-pause']);

/**
 * Causas máquina-legibles. Cada `[FALLA]` de la sonda usa una de acá y tiene
 * su test en `lib/__tests__/opstate-cutover-probe-7189.test.js` (CA-7).
 * `siguiente` es la línea "→ qué hacer" que remite al paso de H0 / del runbook.
 */
const CAUSAS = Object.freeze({
    // CA-1 · CA-B1
    strict_auth_apagado: 'H0 paso 0 · exportá PARTIAL_PAUSE_STRICT_AUTH=1 en el entorno del SERVICIO (launcher / restart.js) y reiniciá; verificalo desde el proceso del Pulpo, no desde una shell suelta (D-10, runbook §4 CA-B1).',
    gate_grace_reciente: 'H0 paso 0 · hubo removals de allowlist SIN autoría en los últimos 30 días: revisá el audit trail (runbook §4 CA-B1) y corregí el caller antes de abrir la ventana.',
    audit_ilegible: 'runbook §4 CA-B4 · el audit trail local no se pudo leer/parsear: sin trail verificable no se abre la ventana.',
    // CA-1 · CA-B2
    cas_options_vacias: 'runbook §4 CA-B2 · `buildCasWriteOptions(7, true)` devolvió `{}`: el CAS desapareció del helper compartido. No sigas.',
    driver_no_resuelto: 'runbook "Si algo sale mal" · el backend no pudo construir el driver real (config o credenciales del runtime): corregí eso antes de la sonda del CAS.',
    atomic_update_falso: 'runbook §4 CA-B2 · el driver resuelto NO declara `atomicUpdate: true`: la escritura remota saldría sin ConditionExpression. No sigas.',
    driver_no_aws_cli: 'runbook §2.5 · el driver no es `aws-cli` / `aws-cli-sync`: un driver en memoria o fake da verde sin tocar DynamoDB. Corré la sonda con el cableado real.',
    // CA-1 · CA-B3 (pass-through de `verifyRuntimeIdentity`)
    identidad_inesperada: 'runbook §4 CA-B3 · corré la sonda con el perfil del runtime (`kernel.runtimeProfile`), nunca con un admin.',
    runtime_principal_ausente: 'runbook §4 CA-B3 · declará `kernel.runtimePrincipal` en .pipeline/config.yaml.',
    identidad_ilegible: 'runbook §4 CA-B3 · `sts get-caller-identity` devolvió algo que no parsea: revisá la AWS CLI.',
    aws_cli_failed: 'runbook "Credenciales AWS del runtime no resueltas" · la AWS CLI falló: revisá perfil, región y red.',
    aws_cli_spawn_failed: 'runbook "Credenciales AWS del runtime no resueltas" · no se pudo lanzar `aws`: ¿está instalada y en el PATH del usuario del pipeline?',
    // CA-1 · CA-B5
    namespaceado_apagado: 'H0 paso 1 · encendé `operational_state.namespaced.enabled: true` y corré `migrate-operational-state-namespace.js` (D-4 / CA-B5).',
    layout_no_migrado: 'H0 paso 1 · el layout sigue plano: corré `node .pipeline/scripts/migrate-operational-state-namespace.js` con el pipeline pausado y verificá `--status` ⇒ `migrated: true`.',
    status_ilegible: 'runbook §4 CA-B5 · `migrate-operational-state-namespace.js --status` no devolvió JSON: revisá su salida a mano.',
    state_dir_divergente: 'runbook §2.4 · `project-context.stateDir()` y el `stateDir` de `--status` NO coinciden: migrar así escribe estado obsoleto. No sigas.',
    // CA-3 / CA-5
    modo_no_remoto: 'la sonda necesita leer el store: corré con `PIPELINE_OPSTATE_DURABLE=1` en el entorno de ESTE proceso (el CLI lo fija solo). El flag del config NO se toca.',
    lectura_degradada: 'runbook §6 · el backend reportó degradación al leer el store: la sonda es ROJA por diseño (nunca fallback a filesystem).',
    estado_vacio: 'H0 paso 3 · el store no tiene contenido para esta clave (0 olas / allowlist vacía no cierran la sonda): migrá primero (runbook §2) y volvé a correr.',
    version_invalida: 'runbook §8.1 · `body.version` tiene que ser un entero ≥ 1 por los dos caminos.',
    item_ausente_camino_b: 'runbook §8.1 · la lectura consistente cruda no encontró el ítem que el backend dice leer: dos fuentes de verdad. No sigas.',
    clave_distinta: 'runbook §8.1 · PK/SK del ítem crudo no coinciden con la partición/clave esperadas (anti-IDOR).',
    hash_distinto_por_camino: 'runbook §8.1 · el SHA-256 canónico difiere entre backend y `get-item --consistent-read`: NO declares paridad.',
    // CA-2
    cas_primera_escritura_fallida: 'runbook §8.3 · la primera escritura de la clave de sonda no entró (permisos `PutItem` del runtime sobre la tabla de coordinación, o KMS).',
    cas_sin_conflicto: 'runbook §8.3 · la segunda escritura con la MISMA expectedVersion NO volvió `conflict: true`: el CAS no protege. No sigas.',
    readback_distinto: 'runbook §8.3 · la lectura consistente cruda de la clave de sonda no coincide con lo que `compareAndSet` dijo escribir.',
    // CA-4
    fuentes_ausentes: 'runbook §2.2 · falta `waves.json` y/o `.partial-pause.json` en el `sourceDir`: ¿estás apuntando al directorio de estado del host del pipeline? (`--pipeline-dir` / `--source-dir`).',
    dry_run_fallido: 'runbook §2.2 · el dry-run del migrador devolvió error: leé el código y el mensaje de abajo.',
    backup_no_verificado: 'runbook §2.2 · el backup NO coincide con su propio `manifest.json`: no hay punto de retorno confiable. No sigas.',
    // CA-5
    freno_ausente: 'runbook §1.5 · poné el freno ANTES de exportar: por Telegram `/pausar`, o a mano `node -e "require(\'fs\').writeFileSync(\'.pipeline/.paused\', JSON.stringify({source:\'manual\', ts:new Date().toISOString(), reason:\'export store→FS #7189\'}))"`.',
    export_hash_distinto: 'runbook §1.5 · lo escrito en filesystem NO coincide con lo leído del store: hay avance perdido. No reinicies hasta resolverlo.',
    export_escritura_fallida: 'runbook §1.5 · no se pudo escribir en `stateDir()`: revisá permisos/disco. Nada quedó a medias: se escribe sólo si las dos claves se leyeron.',
    // CA-6
    ventana_cerrada: 'H0 paso 5 · sólo el booleano `true` exacto en `kernel.cutover_window` abre la ventana (SEC-4). El drill se corre con `--window true`; en H0 el operador lo pone en el config durante la ventana.',
    sink_no_aborto: 'runbook §5 · el sink NO marcó `aborted` con la ventana abierta: el cableado del aborto está roto. No abras la ventana real.',
    paused_no_escrito: 'runbook §5 · el halt no dejó `.paused` en disco: el aborto sin freno no cierra CA-C5.',
    throw_propagado: 'runbook §5 · el camino del aborto PROPAGÓ una excepción: prohibido (el pipeline no puede morir).',
    process_exit_llamado: 'runbook §5 · el camino del aborto llamó a `process.exit`: prohibido.',
    fallback_a_filesystem: 'runbook §5 · el backend devolvió contenido con el store caído: alguien reintrodujo el fallback a filesystem (CA-A7). No sigas.',
    // genérica
    error_inesperado: 'leé el detalle; si no es accionable, abrí un issue con el JSON de la sonda (ya viene redactado).',
});

// ─── Utilidades puras ───────────────────────────────────────────────────────

function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return path.resolve(process.env.PIPELINE_DIR_OVERRIDE);
    return path.resolve(__dirname, '..');
}

/**
 * Misma composición que `redactAll` de `lib/kernel-cutover-probe.js` (que no la
 * exporta): secretos (`redactSecrets` del migrador) + account-ids de 12 dígitos
 * (`redactAccountIds`). TODA salida de este archivo pasa por acá (SEC-7).
 */
function redactAll(text) {
    const { redactAccountIds } = lib('kernel-cutover-probe');
    const { redactSecrets } = lib('kernel-store-migrate');
    return redactAccountIds(redactSecrets(String(text == null ? '' : text)));
}

function typeLabel(v) {
    if (v === undefined) return 'ausente';
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

/** `true (boolean)`, `"true" (string)`, `1 (number)`, `ausente` — UX: valor CON tipo (SEC-4). */
function literalWithType(v) {
    if (v === undefined) return 'ausente';
    return `${JSON.stringify(v)} (${typeLabel(v)})`;
}

function samePath(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
    return norm(a) === norm(b);
}

/**
 * Conteo OPERATIVO de una clave (no el `countRecords` del migrador, que cuenta
 * claves top-level y daría 7 para un registro sin ninguna ola). Es el número
 * que el operador compara a ojo entre ensayos: `olas: n · allowlist: m`.
 */
function countOperational(key, value) {
    if (!value || typeof value !== 'object') return { label: key === 'waves' ? 'olas' : 'allowlist', count: 0 };
    if (key === 'waves') {
        const n = (value.active_wave ? 1 : 0)
            + (Array.isArray(value.planned_waves) ? value.planned_waves.length : 0)
            + (Array.isArray(value.archived_waves) ? value.archived_waves.length : 0);
        return { label: 'olas', count: n };
    }
    return { label: 'allowlist', count: Array.isArray(value.allowed_issues) ? value.allowed_issues.length : 0 };
}

/** Formato ÚNICO de conteos (dry-run, R8 del export, tabla de §10). */
function formatCounts({ olas, allowlist, avancePerdido }) {
    const parts = [`olas: ${olas == null ? '?' : olas}`, `allowlist: ${allowlist == null ? '?' : allowlist}`];
    if (avancePerdido !== undefined) parts.push(`avance perdido: ${avancePerdido}`);
    return parts.join(' · ');
}

function isIntVersion(v) {
    return Number.isInteger(v) && v >= 1;
}

function sha(value) {
    return lib('kernel-store-migrate').sha256Canonical(value);
}

// ─── Modelo de checks y render ──────────────────────────────────────────────

function check(id, etapa, ok, detalle, extra = {}) {
    const c = { id, etapa, ok: ok === true, detalle: String(detalle == null ? '' : detalle) };
    if (!c.ok) {
        c.causa = extra.causa || 'error_inesperado';
        c.siguiente = CAUSAS[c.causa] || CAUSAS.error_inesperado;
    }
    if (extra.informativo) c.informativo = true;
    if (extra.datos !== undefined) c.datos = extra.datos;
    return c;
}

function finish(result) {
    const decisivos = result.checks.filter((c) => !c.informativo);
    result.ok = decisivos.length > 0 && decisivos.every((c) => c.ok);
    result.causas = decisivos.filter((c) => !c.ok).map((c) => c.causa);
    result.veredicto = result.ok ? 'VERDE' : 'ROJO';
    result.exitCode = result.ok ? 0 : 1;
    return result;
}

function newResult(subcomando, naturaleza, extra = {}) {
    return {
        subcomando,
        naturaleza,
        generadoEn: new Date().toISOString(),
        pipelineDir: pipelineDir(),
        ...extra,
        checks: [],
    };
}

function renderReport(result) {
    const lines = [];
    lines.push(`===== SONDA DEL ESTADO OPERATIVO · ${result.subcomando} =====`);
    lines.push(`naturaleza: ${result.naturaleza}`);
    if (result.contexto) {
        for (const [k, v] of Object.entries(result.contexto)) lines.push(`${k}: ${v}`);
    }
    lines.push('');
    for (const c of result.checks) {
        const marca = c.ok ? '[OK]   ' : '[FALLA]';
        const tag = c.informativo ? ' (informativo)' : '';
        lines.push(`${marca} ${c.id} · ${c.etapa}${tag} — ${c.detalle}`);
        if (!c.ok) {
            lines.push(`        causa: ${c.causa}`);
            lines.push(`        → ${c.siguiente}`);
        }
    }
    if (result.conteos) {
        lines.push('');
        lines.push(`conteos: ${result.conteos}`);
    }
    if (result.reporteMigrador) {
        lines.push('');
        lines.push('--- REPORTE DEL MIGRADOR (dry-run) ---');
        lines.push(result.reporteMigrador);
    }
    lines.push('');
    lines.push('--- VEREDICTO ---');
    if (result.ok) {
        lines.push(`VEREDICTO: VERDE — ${result.checks.filter((c) => !c.informativo).length} verificación(es) en verde.`);
    } else {
        const rojos = result.checks.filter((c) => !c.ok && !c.informativo);
        lines.push(`VEREDICTO: ROJO — ${rojos.length} en rojo (${rojos.map((c) => c.id).join(', ')}) · causas: ${[...new Set(result.causas)].join(', ') || 'sin checks decisivos'}.`);
        lines.push('           Qué hacer ahora: NO enciendas ningún flag. Resolvé cada causa con su línea "→" y volvé a correr la sonda.');
    }
    return redactAll(lines.join('\n'));
}

function renderJson(result) {
    return redactAll(JSON.stringify(result, null, 2)) + '\n';
}

// ─── Dependencias inyectables ───────────────────────────────────────────────

function loadConfig(deps) {
    if (deps.config) return deps.config;
    return lib('config-resolver').resolve({ pipelineDir: pipelineDir() });
}

function backendOf(deps) {
    return deps.backend || lib('operational-state-backend');
}

function projectContextOf(deps) {
    return deps.projectContext || lib('project-context');
}

/** Metadatos del driver que el backend resolvió. NUNCA el driver. Errores como dato. */
function describeBackendDriver(backend) {
    try {
        const d = backend._describeDriver();
        return { ok: true, ...d };
    } catch (e) {
        return { ok: false, error: redactAll(e && e.message ? e.message : String(e)) };
    }
}

/**
 * Regla de admisión del `kind` del driver. `in-memory` está prohibido SIEMPRE
 * (trampa §2.5); fuera de tests sólo pasan `aws-cli` / `aws-cli-sync`. Los
 * tests amplían la lista con `fake-sync` vía `deps.allowedDriverKinds` — el CLI
 * nunca lo hace.
 */
function driverKindAllowed(kind, deps) {
    if (typeof kind !== 'string' || FORBIDDEN_DRIVER_KINDS.includes(kind)) return false;
    const allowed = Array.isArray(deps.allowedDriverKinds) ? deps.allowedDriverKinds : ALLOWED_DRIVER_KINDS;
    return allowed.includes(kind);
}

/**
 * Driver DynamoDB SÍNCRONO con el MISMO cableado que `resolveDriver()` del
 * backend: credenciales del principal runtime → runner sync → driver sync
 * (`kind: 'aws-cli-sync'`). Si la sonda armara el driver de otra forma,
 * probaría un cableado que producción no usa.
 */
function buildSyncRuntimeDriver(kernelCfg, profile, deps = {}) {
    const creds = lib('kernel-runtime-credentials');
    const kernel = profile ? { ...kernelCfg, runtimeProfile: profile } : kernelCfg;
    const resolved = creds.resolveRuntimeAwsEnv({ kernel, deps: deps.credsDeps, env: deps.env });
    if (!resolved.ok) return { ok: false, code: resolved.code, error: resolved.error };
    const { createAwsCliRunnerSync, createAwsCliDynamoDriverSync } = lib('provisioner-infra');
    const { runSync } = createAwsCliRunnerSync(resolved.env);
    return { ok: true, driver: createAwsCliDynamoDriverSync({ runSync }), source: creds.describe(resolved) };
}

function verifyIdentity(cfg, deps) {
    const kernel = (cfg && cfg.kernel) || {};
    const fn = deps.verifyRuntimeIdentity || lib('kernel-cutover-probe').verifyRuntimeIdentity;
    return fn({
        expectedPrincipal: kernel.runtimePrincipal,
        profile: deps.profile || kernel.runtimeProfile,
        env: deps.env,
        spawnSync: deps.spawnSync,
    });
}

function consistentRead(cfg, deps, { pk, sk, tableName }) {
    const kernel = (cfg && cfg.kernel) || {};
    const fn = deps.getItemConsistent || lib('kernel-cutover-probe').getItemConsistent;
    return fn({
        tableName: tableName || kernel.coordinationTableName,
        region: kernel.region,
        pk,
        sk,
        profile: deps.profile || kernel.runtimeProfile,
        env: deps.env,
        spawnSync: deps.spawnSync,
    });
}

/**
 * `migrate-operational-state-namespace.js --status` en un proceso hijo (hereda
 * `PIPELINE_DIR_OVERRIDE`). Errores como dato.
 */
function namespaceStatus(deps) {
    if (typeof deps.namespaceStatus === 'function') {
        try { return { ok: true, status: deps.namespaceStatus() }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }
    const script = path.join(__dirname, 'migrate-operational-state-namespace.js');
    const res = spawnSync(process.execPath, [script, '--status'], { encoding: 'utf8', env: process.env, windowsHide: true, timeout: 30000 });
    if (res.error) return { ok: false, error: `no se pudo lanzar --status: ${res.error.message}` };
    const out = String(res.stdout || '');
    const i = out.indexOf('{');
    if (i < 0) return { ok: false, error: `--status no devolvió JSON (exit ${res.status}): ${redactAll((res.stderr || out).slice(0, 300))}` };
    try {
        return { ok: true, status: JSON.parse(out.slice(i)) };
    } catch (e) {
        return { ok: false, error: `--status devolvió JSON ilegible: ${e.message}` };
    }
}

/**
 * Cuenta entradas `gate_grace: true` del audit trail local en la ventana
 * (default 30 días). Lee el JSONL directo: una línea que no parsea se cuenta
 * como tal y NO se ignora en silencio.
 */
function countGateGrace({ file, now = Date.now(), windowMs = GATE_GRACE_WINDOW_MS }) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e && e.code === 'ENOENT') return { ok: true, exists: false, total: 0, count: 0, malformed: 0, last: null };
        return { ok: false, exists: true, error: e.message };
    }
    const cutoff = now - windowMs;
    let total = 0; let count = 0; let malformed = 0; let last = null;
    for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        total += 1;
        let e;
        try { e = JSON.parse(line); } catch { malformed += 1; continue; }
        if (e && e.gate_grace === true) {
            const t = Date.parse(e.timestamp || '');
            if (Number.isFinite(t) && t >= cutoff) count += 1;
            if (!last || (Number.isFinite(t) && t > Date.parse(last))) last = e.timestamp || last;
        }
    }
    return { ok: malformed === 0, exists: true, total, count, malformed, last, error: malformed ? `${malformed} línea(s) del audit no parsean` : undefined };
}

// ─── CA-1 · --preconditions ─────────────────────────────────────────────────

async function runPreconditions(opts = {}) {
    const deps = opts.deps || {};
    const result = newResult('--preconditions', 'sonda de sólo lectura — segura de re-ejecutar (no escribe en el store ni en el filesystem)');
    let cfg;
    try {
        cfg = loadConfig(deps);
    } catch (e) {
        result.checks.push(check('config', 'lectura de .pipeline/config.yaml', false, `no se pudo resolver la config: ${e.message}`, { causa: 'driver_no_resuelto' }));
        return finish(result);
    }
    const kernel = cfg.kernel || {};
    const backend = backendOf(deps);
    const pc = projectContextOf(deps);
    const env = deps.env || process.env;

    // CA-B1 · strict auth + gate_grace en 30 días (D-10)
    const strict = env.PARTIAL_PAUSE_STRICT_AUTH === '1';
    const auditPath = deps.auditFile || lib('partial-pause-audit')._paths().AUDIT_FILE;
    const grace = countGateGrace({ file: auditPath, now: deps.now ? deps.now() : Date.now() });
    {
        let ok = strict && grace.ok && grace.count === 0;
        let causa = null;
        if (!strict) causa = 'strict_auth_apagado';
        else if (!grace.ok) causa = 'audit_ilegible';
        else if (grace.count > 0) causa = 'gate_grace_reciente';
        result.checks.push(check('CA-B1', 'PARTIAL_PAUSE_STRICT_AUTH=1 + sin `gate_grace` en 30 días', ok,
            `strict: ${strict} (leído del entorno de ESTE proceso: ${env.PARTIAL_PAUSE_STRICT_AUTH === undefined ? 'ausente' : JSON.stringify(env.PARTIAL_PAUSE_STRICT_AUTH)}) · `
            + `gate_grace en 30 días: ${grace.ok ? grace.count : 'ilegible'} (audit: ${grace.exists ? `${grace.total} entradas` : 'sin archivo'}`
            + `${grace.last ? `, último gate_grace ${grace.last}` : ''})`,
            { causa, datos: { strict, gateGrace30d: grace.count, auditEntries: grace.total, lastGateGrace: grace.last, auditExists: grace.exists } }));
    }

    // CA-B2 · CAS declarado por el helper compartido + por el driver REAL resuelto
    {
        const casOpts = lib('kernel-coordination-store').buildCasWriteOptions(7, true);
        const casNoVacio = casOpts && Object.keys(casOpts).length > 0 && typeof casOpts.conditionExpression === 'string';
        const drv = describeBackendDriver(backend);
        let causa = null;
        if (!casNoVacio) causa = 'cas_options_vacias';
        else if (!drv.ok) causa = 'driver_no_resuelto';
        else if (drv.atomicUpdate !== true) causa = 'atomic_update_falso';
        else if (!driverKindAllowed(drv.kind, deps)) causa = 'driver_no_aws_cli';
        result.checks.push(check('CA-B2', '`atomicUpdate === true` en el driver real + `buildCasWriteOptions` no vacío', causa === null,
            `buildCasWriteOptions(7,true): ${casNoVacio ? `"${casOpts.conditionExpression}"` : 'VACÍO'} · driver: ${drv.ok ? `kind=${drv.kind} atomicUpdate=${drv.atomicUpdate} tabla=${drv.tableName} partición=${drv.projectId}` : `NO RESUELTO (${drv.error})`}`,
            { causa, datos: { casOptions: casNoVacio, driver: drv.ok ? { kind: drv.kind, atomicUpdate: drv.atomicUpdate, tableName: drv.tableName, projectId: drv.projectId } : { error: drv.error } } }));
    }

    // CA-B3 · identidad efectiva del runtime
    {
        const ident = verifyIdentity(cfg, deps);
        result.checks.push(check('CA-B3', 'identidad efectiva = `kernel.runtimePrincipal`', ident.ok,
            ident.ok ? `principal efectivo: ${ident.principal} (coincide con config)` : ident.error,
            { causa: ident.ok ? null : (CAUSAS[ident.code] ? ident.code : 'aws_cli_failed'), datos: { expected: kernel.runtimePrincipal, profile: deps.profile || kernel.runtimeProfile, principal: ident.ok ? ident.principal : null, code: ident.code || null } }));
    }

    // CA-B5 · namespaceado ON + layout migrado + stateDir coincidente (trampa §2.4)
    {
        const nsEnabled = pc.namespaceEnabled() === true;
        const st = namespaceStatus(deps);
        let stateDirNow = null;
        try { stateDirNow = pc.stateDir(); } catch (e) { stateDirNow = `<irresoluble: ${e.message}>`; }
        let causa = null;
        if (!st.ok) causa = 'status_ilegible';
        else if (!nsEnabled) causa = 'namespaceado_apagado';
        else if (st.status.migrated !== true) causa = 'layout_no_migrado';
        else if (!samePath(st.status.stateDir, stateDirNow)) causa = 'state_dir_divergente';
        result.checks.push(check('CA-B5', 'namespaceado encendido + `--status` ⇒ migrated:true + stateDir coincidente', causa === null,
            `namespaceEnabled(): ${nsEnabled} · --status: ${st.ok ? `migrated=${st.status.migrated} stateDir=${st.status.stateDir}` : `ILEGIBLE (${st.error})`} · project-context.stateDir(): ${stateDirNow}`,
            { causa, datos: { namespaceEnabled: nsEnabled, migrated: st.ok ? st.status.migrated : null, statusStateDir: st.ok ? st.status.stateDir : null, stateDir: stateDirNow, flatLayoutItems: st.ok ? st.status.flatLayoutItems : null } }));
    }

    // D-9 · kernel.durable se REPORTA, no se exige
    result.checks.push(check('D-9', 'valor efectivo de `kernel.durable` (se reporta, no se exige)', true,
        `kernel.durable = ${literalWithType(kernel.durable)} — "cutover del kernel ensayado" (#5207/#5208/#5209); re-encenderlo es trabajo aparte, fuera de #7189 y de H0`,
        { informativo: true, datos: { kernelDurable: kernel.durable === undefined ? null : kernel.durable, tipo: typeLabel(kernel.durable) } }));

    // describeMode · modo EFECTIVO del runtime, mode + source siempre juntos
    {
        let mode;
        try { mode = backend.describeMode(); } catch (e) { mode = { error: e.message }; }
        result.checks.push(check('modo', '`describeMode()` del backend', true,
            mode.error ? `no se pudo describir: ${mode.error}` : `mode: ${mode.mode} · source: ${mode.source} · degraded: ${mode.degraded} · observed: ${mode.observed}`,
            { informativo: true, datos: mode }));
    }

    return finish(result);
}

// ─── CA-2 · --cas-probe ─────────────────────────────────────────────────────

async function runCasProbe(opts = {}) {
    const deps = opts.deps || {};
    const result = newResult('--cas-probe', `escribe UNA clave de sonda (coord#${PROBE_KEY}) por compareAndSet — idempotente: cada corrida incrementa su versión; nunca toca coord#waves ni coord#partial-pause`);
    let cfg;
    try { cfg = loadConfig(deps); } catch (e) {
        result.checks.push(check('config', 'lectura de .pipeline/config.yaml', false, e.message, { causa: 'driver_no_resuelto' }));
        return finish(result);
    }
    const kernel = cfg.kernel || {};
    const pc = projectContextOf(deps);
    const projectId = deps.projectId || pc.currentProjectIdOrNull();
    result.contexto = { tabla: kernel.coordinationTableName, region: kernel.region, particion: projectId, claveDeSonda: `coord#${PROBE_KEY}` };

    // 1 · identidad (SEC-2): sin coincidencia NO se escribe nada.
    const ident = verifyIdentity(cfg, deps);
    result.checks.push(check('identidad', 'principal efectivo = `kernel.runtimePrincipal` (SEC-2)', ident.ok,
        ident.ok ? `principal efectivo: ${ident.principal}` : ident.error,
        { causa: ident.ok ? null : (CAUSAS[ident.code] ? ident.code : 'aws_cli_failed') }));
    if (!ident.ok) return finish(result);

    // 2 · driver real explícito (trampa §2.5)
    let driver = deps.driver;
    let driverSource = 'inyectado';
    if (!driver) {
        const built = buildSyncRuntimeDriver(kernel, deps.profile, deps);
        if (!built.ok) {
            result.checks.push(check('driver', 'driver DynamoDB del runtime', false, built.error, { causa: 'driver_no_resuelto' }));
            return finish(result);
        }
        driver = built.driver;
        driverSource = built.source;
    }
    const kindOk = driverKindAllowed(driver && driver.kind, deps);
    result.checks.push(check('driver', 'driver.kind ∈ {aws-cli, aws-cli-sync}', kindOk,
        `kind=${driver && driver.kind} · credenciales: ${driverSource}`, { causa: kindOk ? null : 'driver_no_aws_cli' }));
    if (!kindOk) return finish(result);

    // 3 · helper compartido del CAS no vacío
    const coord = lib('kernel-coordination-store');
    const casOpts = coord.buildCasWriteOptions(1, true);
    const casNoVacio = !!(casOpts && casOpts.conditionExpression);
    result.checks.push(check('cas-options', '`buildCasWriteOptions(1, true)` no vacío', casNoVacio,
        casNoVacio ? `"${casOpts.conditionExpression}"` : 'VACÍO', { causa: casNoVacio ? null : 'cas_options_vacias' }));
    if (!casNoVacio) return finish(result);

    // 4 · dos escrituras con la MISMA expectedVersion, por compareAndSet (SEC-9)
    let store;
    try {
        const factory = deps.createStore || coord.createCoordinationStore;
        store = factory({
            driver,
            contextProjectId: projectId,
            instanceId: projectId,
            config: { kernel },
            knownKeys: [...lib('kernel-store-migrate').MIGRATION_KNOWN_KEYS, PROBE_KEY],
        });
    } catch (e) {
        result.checks.push(check('store', 'createCoordinationStore con driver real', false, e.message, { causa: 'driver_no_resuelto' }));
        return finish(result);
    }
    const runAt = new Date().toISOString();
    const payload = (attempt) => ({ probe: 'opstate-cutover-probe', issue: 7189, runAt, attempt });
    let base; let w1; let w2;
    try {
        const cur = await store.getState(PROBE_KEY);
        base = cur ? cur.version : 0;
        w1 = await store.compareAndSet(PROBE_KEY, payload(1), base);
        w2 = await store.compareAndSet(PROBE_KEY, payload(2), base);
    } catch (e) {
        result.checks.push(check('cas', 'compareAndSet contra la tabla real', false, `excepción: ${e && e.message}`, { causa: 'cas_primera_escritura_fallida' }));
        return finish(result);
    }
    const ok1 = !!(w1 && w1.ok === true && w1.version === base + 1);
    result.checks.push(check('cas-1', `1ª escritura con expectedVersion=${base}`, ok1,
        ok1 ? `ok · versión ${base} → ${w1.version}` : `falló: ${JSON.stringify(w1)}`, { causa: ok1 ? null : 'cas_primera_escritura_fallida', datos: { expectedVersion: base, result: w1 } }));
    const ok2 = !!(w2 && w2.ok === false && w2.conflict === true);
    result.checks.push(check('cas-2', `2ª escritura con la MISMA expectedVersion=${base} ⇒ conflict:true`, ok2,
        ok2 ? `rechazada como corresponde · conflict:true · versión vigente ${w2.version}` : `NO fue rechazada: ${JSON.stringify(w2)}`, { causa: ok2 ? null : 'cas_sin_conflicto', datos: { expectedVersion: base, result: w2 } }));
    if (!ok1) return finish(result);

    // 5 · readback por el camino B (lectura consistente cruda, por afuera del driver)
    const rb = consistentRead(cfg, deps, { pk: projectId, sk: coord.skFor(PROBE_KEY) });
    if (!rb.ok) {
        result.checks.push(check('readback', 'get-item --consistent-read de la clave de sonda', false, rb.error, { causa: 'aws_cli_failed' }));
        return finish(result);
    }
    const item = rb.item;
    const rbOk = !!(item && item.PK === projectId && item.SK === coord.skFor(PROBE_KEY)
        && item.body && item.body.version === base + 1 && sha(item.body.value) === sha(payload(1)));
    result.checks.push(check('readback', 'lectura consistente cruda coincide con la 1ª escritura (versión + sha256)', rbOk,
        item ? `PK=${item.PK} SK=${item.SK} body.version=${item.body && item.body.version} sha256(body.value)=${item.body ? sha(item.body.value) : 'n/a'}` : 'ítem AUSENTE',
        { causa: rbOk ? null : (item ? 'readback_distinto' : 'item_ausente_camino_b'), datos: { version: item && item.body ? item.body.version : null, sha256: item && item.body ? sha(item.body.value) : null, esperado: { version: base + 1, sha256: sha(payload(1)) } } }));
    return finish(result);
}

// ─── CA-3 · --positive ──────────────────────────────────────────────────────

async function runPositive(opts = {}) {
    const deps = opts.deps || {};
    const result = newResult('--positive', 'sonda de sólo lectura — segura de re-ejecutar (backend con PIPELINE_OPSTATE_DURABLE=1 en este proceso vs `get-item --consistent-read`)');
    let cfg;
    try { cfg = loadConfig(deps); } catch (e) {
        result.checks.push(check('config', 'lectura de .pipeline/config.yaml', false, e.message, { causa: 'driver_no_resuelto' }));
        return finish(result);
    }
    const kernel = cfg.kernel || {};
    const backend = backendOf(deps);

    if (backend.isRemote() !== true) {
        result.checks.push(check('modo', 'el backend lee el store (override por env)', false, `describeMode: ${JSON.stringify(backend.describeMode())}`, { causa: 'modo_no_remoto' }));
        return finish(result);
    }
    const drv = describeBackendDriver(backend);
    const kindOk = drv.ok && driverKindAllowed(drv.kind, deps);
    result.checks.push(check('driver', 'driver del backend ∈ {aws-cli, aws-cli-sync}', kindOk,
        drv.ok ? `kind=${drv.kind} tabla=${drv.tableName} partición=${drv.projectId}` : `NO RESUELTO (${drv.error})`,
        { causa: kindOk ? null : (drv.ok ? 'driver_no_aws_cli' : 'driver_no_resuelto') }));
    if (!kindOk) return finish(result);
    const projectId = drv.projectId;
    result.contexto = { tabla: drv.tableName, region: kernel.region, particion: projectId };

    const coord = lib('kernel-coordination-store');
    const conteos = {};
    for (const key of OPSTATE_KEYS) {
        const sk = coord.skFor(key);
        // Camino A · el backend (mismo cableado que el runtime)
        const a = backend.readKeyWithVersion(key);
        const aCount = countOperational(key, a.value);
        conteos[aCount.label] = aCount.count;
        let causaA = null;
        if (a.degraded) causaA = 'lectura_degradada';
        else if (!a.value || aCount.count === 0) causaA = 'estado_vacio';
        else if (!isIntVersion(a.version)) causaA = 'version_invalida';
        const shaA = a.value ? sha(a.value) : null;
        result.checks.push(check(`A:${key}`, `camino A · backend.readKeyWithVersion('${key}')`, causaA === null,
            `remote=${a.remote} degraded=${a.degraded} version=${literalWithType(a.version)} ${aCount.label}=${aCount.count} sha256=${shaA || 'n/a'}${a.error ? ` error=${a.error.message}` : ''}`,
            { causa: causaA, datos: { version: a.version, count: aCount.count, sha256: shaA, degraded: a.degraded } }));

        // Camino B · lectura consistente cruda, por afuera del driver
        const b = consistentRead(cfg, deps, { pk: projectId, sk, tableName: drv.tableName });
        if (!b.ok) {
            result.checks.push(check(`B:${key}`, `camino B · get-item --consistent-read ${sk}`, false, b.error, { causa: CAUSAS[b.code] ? b.code : 'aws_cli_failed' }));
            continue;
        }
        const item = b.item;
        const bValue = item && item.body ? item.body.value : null;
        const bCount = countOperational(key, bValue);
        let causaB = null;
        if (!item) causaB = a.value ? 'item_ausente_camino_b' : 'estado_vacio';
        else if (item.PK !== projectId || item.SK !== sk) causaB = 'clave_distinta';
        else if (!bValue || bCount.count === 0) causaB = 'estado_vacio';
        else if (!isIntVersion(item.body.version)) causaB = 'version_invalida';
        const shaB = bValue ? sha(bValue) : null;
        result.checks.push(check(`B:${key}`, `camino B · get-item --consistent-read ${sk}`, causaB === null,
            item ? `PK=${item.PK} SK=${item.SK} body.version=${literalWithType(item.body && item.body.version)} ${bCount.label}=${bCount.count} sha256=${shaB || 'n/a'}` : 'ítem AUSENTE (sin `Item` en la respuesta)',
            { causa: causaB, datos: { version: item && item.body ? item.body.version : null, count: bCount.count, sha256: shaB } }));

        // Comparación · sólo si los dos caminos tienen contenido
        if (causaA === null && causaB === null) {
            const igual = shaA === shaB && a.version === item.body.version;
            result.checks.push(check(`A=B:${key}`, `paridad ${key} · sha256 y versión idénticos por los dos caminos`, igual,
                igual ? `sha256 ${shaA} · version ${a.version}` : `A: sha256=${shaA} v=${a.version} | B: sha256=${shaB} v=${item.body.version}`,
                { causa: igual ? null : 'hash_distinto_por_camino' }));
        }
    }
    result.conteos = formatCounts(conteos);
    return finish(result);
}

// ─── CA-4 · --migration-dry-run ─────────────────────────────────────────────

/** Verifica un backup del migrador contra su PROPIO `manifest.json` (checksum + conteo por archivo). */
function verifyBackupAgainstManifest(backupDir) {
    const migrate = lib('kernel-store-migrate');
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
    } catch (e) {
        return { ok: false, error: `manifest.json ilegible: ${e.message}`, files: [] };
    }
    const files = [];
    for (const [file, meta] of Object.entries(manifest.files || {})) {
        if (!meta || meta.present !== true) { files.push({ file, present: false, ok: true }); continue; }
        try {
            const value = JSON.parse(fs.readFileSync(path.join(backupDir, file), 'utf8'));
            const checksum = migrate.sha256Canonical(value);
            const records = migrate.countRecords(value);
            files.push({ file, present: true, ok: checksum === meta.checksum && records === meta.records, checksum, records, manifest: { checksum: meta.checksum, records: meta.records } });
        } catch (e) {
            files.push({ file, present: true, ok: false, error: e.message });
        }
    }
    return { ok: files.length > 0 && files.every((f) => f.ok), files, createdAt: manifest.createdAt ? new Date(manifest.createdAt).toISOString() : null };
}

async function runMigrationDryRun(opts = {}) {
    const deps = opts.deps || {};
    const result = newResult('--migration-dry-run', 'dry-run: lee las fuentes reales y escribe SÓLO un backup timestampeado (no toca el store; `apply` va en H0 y en los tests contra fake)');
    const migrate = lib('kernel-store-migrate');
    const pc = projectContextOf(deps);
    let sourceDir;
    try { sourceDir = opts.sourceDir || pc.stateDir(); } catch (e) {
        result.checks.push(check('sourceDir', 'resolución de `stateDir()`', false, e.message, { causa: 'state_dir_divergente' }));
        return finish(result);
    }
    const backupRoot = opts.backupRoot || path.join(pipelineDir(), 'backup');
    const sources = migrate.SOURCES.filter((s) => OPSTATE_KEYS.includes(s.key));
    result.contexto = { sourceDir, backupRoot, fuentes: sources.map((s) => s.file).join(', ') };

    // Trampa §2.4 · con el namespaceado encendido, el sourceDir tiene que ser el que `--status` reporta.
    let nsEnabled = false;
    try { nsEnabled = pc.namespaceEnabled() === true; } catch { nsEnabled = false; }
    if (nsEnabled && !opts.sourceDir) {
        const st = namespaceStatus(deps);
        const coincide = st.ok && samePath(st.status.stateDir, sourceDir);
        result.checks.push(check('§2.4', 'namespaceado ON ⇒ sourceDir = stateDir de `--status`', coincide,
            st.ok ? `--status.stateDir=${st.status.stateDir} · sourceDir=${sourceDir}` : st.error, { causa: coincide ? null : (st.ok ? 'state_dir_divergente' : 'status_ilegible') }));
        if (!coincide) return finish(result);
    } else {
        result.checks.push(check('§2.4', 'layout de las fuentes', true, `namespaceEnabled=${nsEnabled} · sourceDir=${sourceDir}${opts.sourceDir ? ' (explícito)' : ' (plano)'}`, { informativo: true }));
    }

    // Presencia + conteos operativos de las fuentes
    const items = migrate.readSources(sourceDir, sources);
    const ausentes = items.filter((it) => !it.present);
    const conteos = {};
    for (const it of items) { const c = countOperational(it.key, it.value); conteos[c.label] = it.present ? c.count : null; }
    result.conteos = formatCounts(conteos);
    result.checks.push(check('fuentes', 'waves.json y .partial-pause.json presentes y parseables', ausentes.length === 0 && !items.some((it) => it.error),
        items.map((it) => `${it.file}: ${it.present ? `presente (${countOperational(it.key, it.value).label} ${countOperational(it.key, it.value).count}, ${migrate.countRecords(it.value)} claves top-level)` : `AUSENTE${it.error ? ` (${it.error})` : ''}`}`).join(' · '),
        { causa: ausentes.length || items.some((it) => it.error) ? 'fuentes_ausentes' : null }));
    if (ausentes.length || items.some((it) => it.error)) return finish(result);

    // Dry-run del migrador (sin `store` ⇒ no escribe en ningún sustrato remoto)
    let res;
    try {
        res = await migrate.migrateState({ apply: false, sourceDir, backupRoot, sources, now: deps.now ? deps.now() : undefined });
    } catch (e) {
        res = { ok: false, code: 'exception', error: e && e.message };
    }
    result.checks.push(check('dry-run', 'migrateState({ apply:false })', res.ok === true && res.dryRun === true,
        res.ok ? `ok · backup en ${res.backupDir} · claves con checksum: ${Object.keys(res.before || {}).join(', ')}` : `${res.code}: ${res.error}`, { causa: res.ok ? null : 'dry_run_fallido' }));
    if (!res.ok) return finish(result);
    result.reporteMigrador = res.report;
    result.backupDir = res.backupDir;
    result.checksums = res.before;

    // Backup verificado contra su propio manifest
    const v = verifyBackupAgainstManifest(res.backupDir);
    result.checks.push(check('backup', 'backup coincide con su propio manifest.json (sha256 + conteo por archivo)', v.ok,
        v.ok ? v.files.map((f) => `${f.file}: ${f.present ? `sha256 ${f.checksum} · ${f.records} claves` : 'no presente'}`).join(' · ') : (v.error || v.files.filter((f) => !f.ok).map((f) => `${f.file}: ${f.error || 'checksum/conteo distinto'}`).join(' · ')),
        { causa: v.ok ? null : 'backup_no_verificado', datos: v }));
    return finish(result);
}

// ─── CA-5 · --export-to-fs ──────────────────────────────────────────────────

async function runExportToFs(opts = {}) {
    const deps = opts.deps || {};
    const backend = backendOf(deps);
    let stateDirTxt = '?';
    try { stateDirTxt = projectContextOf(deps).stateDir(); } catch { /* se informa abajo */ }
    const result = newResult('--export-to-fs', `escribe waves.json y .partial-pause.json en ${stateDirTxt} — exige .pipeline/.paused (el freno del cutover, D-3)`);
    result.contexto = { stateDir: stateDirTxt };

    // Freno puesto (D-3): sin `.paused` no se exporta nada. Se pregunta por la
    // fachada (`readFullPauseOrigin`, único lector del marker), no armando el
    // path a mano: `.paused` es filesystem SIEMPRE y su dueño es `partial-pause.js`.
    const readOrigin = deps.readFullPauseOrigin || lib('operational-state').readFullPauseOrigin;
    let origen;
    try { origen = readOrigin(); } catch (e) { origen = { undetermined: `error: ${e.message}` }; }
    const frenado = !!origen && origen.undetermined !== 'marker_ausente' && !String(origen.undetermined || '').startsWith('error:');
    result.checks.push(check('freno', '`.pipeline/.paused` presente (readFullPauseOrigin)', frenado,
        frenado
            ? `presente · source=${origen.source || 'desconocido'}${origen.ts ? ` ts=${origen.ts}` : ''}${origen.undetermined ? ` (${origen.undetermined})` : ''}`
            : `AUSENTE (${origen && origen.undetermined}) — el pipeline seguiría escribiendo en el store mientras se exporta`,
        { causa: frenado ? null : 'freno_ausente' }));
    if (!frenado) return finish(result);

    if (backend.isRemote() !== true) {
        result.checks.push(check('modo', 'el backend lee el store (override por env)', false, `describeMode: ${JSON.stringify(backend.describeMode())}`, { causa: 'modo_no_remoto' }));
        return finish(result);
    }
    const drv = describeBackendDriver(backend);
    const kindOk = drv.ok && driverKindAllowed(drv.kind, deps);
    result.checks.push(check('driver', 'driver del backend ∈ {aws-cli, aws-cli-sync}', kindOk,
        drv.ok ? `kind=${drv.kind} tabla=${drv.tableName} partición=${drv.projectId}` : `NO RESUELTO (${drv.error})`,
        { causa: kindOk ? null : (drv.ok ? 'driver_no_aws_cli' : 'driver_no_resuelto') }));
    if (!kindOk) return finish(result);

    // 1 · leer las DOS claves antes de escribir nada (nada queda a medias).
    const leidas = {};
    const conteos = {};
    for (const key of OPSTATE_KEYS) {
        const r = backend.readKeyWithVersion(key);
        const c = countOperational(key, r.value);
        conteos[c.label] = r.value ? c.count : null;
        let causa = null;
        if (r.degraded) causa = 'lectura_degradada';
        else if (!r.value) causa = 'estado_vacio';
        result.checks.push(check(`lectura:${key}`, `store → '${key}'`, causa === null,
            `remote=${r.remote} degraded=${r.degraded} version=${literalWithType(r.version)} ${c.label}=${r.value ? c.count : 'n/a'} sha256=${r.value ? sha(r.value) : 'n/a'}${r.error ? ` error=${r.error.message}` : ''}`,
            { causa }));
        leidas[key] = r;
    }
    if (!OPSTATE_KEYS.every((k) => leidas[k].value && !leidas[k].degraded)) {
        result.conteos = formatCounts(conteos);
        return finish(result);
    }

    // 2 · escribir en el stateDir() vigente con el write atómico del sustrato.
    const writeFile = deps.writeFile || ((file, data) => lib('waves').atomicWriteFile(file, data));
    let avancePerdido = 0;
    for (const key of OPSTATE_KEYS) {
        const value = leidas[key].value;
        const dest = backend.fileFor(key);
        try {
            writeFile(dest, JSON.stringify(value, null, 2));
        } catch (e) {
            result.checks.push(check(`escritura:${key}`, `'${key}' → ${dest}`, false, e.message, { causa: 'export_escritura_fallida' }));
            avancePerdido += 1;
            continue;
        }
        // 3 · verificar lo escrito releyendo el archivo.
        let shaFs = null;
        try { shaFs = sha(JSON.parse(fs.readFileSync(dest, 'utf8'))); } catch (e) { shaFs = `<ilegible: ${e.message}>`; }
        const igual = shaFs === sha(value);
        if (!igual) avancePerdido += 1;
        result.checks.push(check(`escritura:${key}`, `'${key}' → ${dest} · sha256 del archivo = sha256 del store`, igual,
            igual ? `sha256 ${shaFs} · version del store ${leidas[key].version}` : `store=${sha(value)} · filesystem=${shaFs}`, { causa: igual ? null : 'export_hash_distinto' }));
    }
    result.conteos = formatCounts({ ...conteos, avancePerdido });
    result.r8 = `R8 (tramo export) · ${result.conteos} — los minutos los mide el operador en H0 (apagar flag → reiniciar → primera fase completa desde filesystem)`;
    return finish(result);
}

// ─── CA-6 · --abort-drill ───────────────────────────────────────────────────

/**
 * Halt "del pulpo" para el drill: mismo contrato que `haltCutoverDegraded` de
 * `pulpo.js` y que el `halt` de `resolveSink()` del backend (marker `wx`, source
 * `kernel-cutover-degraded-halt`, nunca pisa una pausa preexistente), pero
 * escribiendo en el SANDBOX que recibe — jamás en el `.pipeline/` real.
 */
// Marker de halt DENTRO del sandbox del drill. Es el único literal `.paused` de
// este archivo y está exento por anchor en `operational-state-lint.allowlist.json`:
// no es el estado del pipeline (ese lo lee `readFullPauseOrigin`), es el
// artefacto que el halt bajo prueba tiene que dejar en un directorio temporal.
const sandboxHaltMarker = (sandboxDir) => path.join(sandboxDir, '.paused');

function makeSandboxHalt(sandboxDir) {
    return ({ cause, correlationId }) => {
        try {
            fs.writeFileSync(sandboxHaltMarker(sandboxDir), JSON.stringify({
                source: 'kernel-cutover-degraded-halt',
                ts: new Date().toISOString(), cause, correlationId, drill: '#7189 --abort-drill',
            }), { flag: 'wx', mode: 0o600 });
            return { markerWritten: true, preexisting: false };
        } catch (err) {
            if (err.code === 'EEXIST') return { markerWritten: false, preexisting: true };
            throw err;
        }
    };
}

async function runAbortDrill(opts = {}) {
    const deps = opts.deps || {};
    const backend = backendOf(deps);
    const ownSandbox = !opts.dir;
    const sandbox = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-abort-drill-'));
    const result = newResult('--abort-drill', `ensayo del aborto con el sink REAL y un halt inyectado que escribe .paused en un SANDBOX (${sandbox}) — nunca en el .pipeline/ real; no envía Telegram`);

    // Valor de la ventana: explícito (`--window <literal>`), o el efectivo del config.
    let windowValue;
    let windowSource;
    if (Object.prototype.hasOwnProperty.call(opts, 'window')) {
        windowValue = opts.window;
        windowSource = 'argumento --window';
    } else {
        try { windowValue = (loadConfig(deps).kernel || {}).cutover_window; } catch { windowValue = undefined; }
        windowSource = 'config efectivo (kernel.cutover_window)';
    }
    const ventanaAbierta = windowValue === true;
    result.contexto = { sandbox, cutover_window: literalWithType(windowValue), origen: windowSource };

    // El backend tiene que estar leyendo el store (override por env en ESTE
    // proceso): sin eso el drill leería filesystem y no ejercitaría el sink.
    if (backend.isRemote() !== true) {
        result.checks.push(check('modo', 'el backend lee el store (override por env)', false, `describeMode: ${JSON.stringify(backend.describeMode())}`, { causa: 'modo_no_remoto' }));
        if (ownSandbox && !opts.keep) { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort */ } }
        return finish(result);
    }

    const logs = [];
    const telegram = [];
    const alert = lib('kernel-degradation-alert');
    const sink = alert.createDegradationSink({
        config: { kernel: windowValue === undefined ? {} : { cutover_window: windowValue } },
        operationalState: true,
        halt: makeSandboxHalt(sandbox),
        log: (m) => logs.push(String(m)),
        sendTelegram: (text) => { telegram.push(String(text)); return null; },
        redact: (s) => lib('redact').redactSecretValue(s),
        // El cid real lleva epoch en ms (13 dígitos) y dispararía el chequeo de
        // redacción de la evidencia (`[0-9]{12}`, SEC-7). El drill usa uno propio,
        // inyectado por la vía que el sink ya ofrece para tests.
        generateCorrelationId: () => `kdeg-drill-${require('node:crypto').randomBytes(4).toString('hex')}`,
    });

    // Interceptar `process.exit` durante el drill: si alguien lo llama, es rojo.
    const origExit = process.exit;
    let exitLlamado = false;
    process.exit = (code) => { exitLlamado = true; throw new Error(`process.exit(${code}) interceptado por el drill`); };
    let r = null;
    let excepcion = null;
    const pausedBefore = fs.existsSync(sandboxHaltMarker(sandbox));
    try {
        backend.setDegradationSink(sink);
        backend._setDriverForTests({
            // El mensaje lleva `ETIMEDOUT` para que `classifyDegradation` lo mapee a
            // la causa `red` del enum (la misma que el ensayo de #5113), no a `desconocido`.
            driver: { kind: 'drill-failing', getItem() { throw Object.assign(new Error('ETIMEDOUT: store caído (ensayo CA-C5 #7189)'), { code: 'ETIMEDOUT' }); } },
            spec: { type: 'dynamodb_table', tableName: 'drill', keys: [] },
            projectId: 'drill', instanceId: 'drill', atomicUpdate: true,
        });
        r = backend.readKeyWithVersion(backend.KEYS.PARTIAL_PAUSE);
    } catch (e) {
        excepcion = e;
    } finally {
        process.exit = origExit;
        try { backend.setDegradationSink(null); backend.invalidateConfigCache(); } catch { /* best-effort */ }
    }
    const pausedPath = sandboxHaltMarker(sandbox);
    const pausedExists = fs.existsSync(pausedPath);
    let marker = null;
    if (pausedExists) { try { marker = JSON.parse(fs.readFileSync(pausedPath, 'utf8')); } catch { marker = { ilegible: true }; } }

    // Checks comunes: sin throw, sin exit, sin fallback.
    result.checks.push(check('sin-throw', 'la degradación NO propagó excepción', !excepcion, excepcion ? `excepción: ${excepcion.message}` : 'readKeyWithVersion devolvió un resultado (error como dato)', { causa: 'throw_propagado' }));
    result.checks.push(check('sin-exit', 'nadie llamó a process.exit', !exitLlamado, exitLlamado ? 'process.exit fue invocado' : 'process.exit intacto', { causa: 'process_exit_llamado' }));
    const sinFallback = !!(r && r.value === null && r.degraded === true && r.remote === true);
    result.checks.push(check('sin-fallback', 'value:null + degraded:true (el gate deniega; nunca lee filesystem)', sinFallback,
        r ? `value=${JSON.stringify(r.value)} degraded=${r.degraded} remote=${r.remote}` : 'sin resultado', { causa: 'fallback_a_filesystem' }));

    if (ventanaAbierta) {
        result.checks.push(check('ventana', 'kernel.cutover_window === true (booleano exacto)', true, `cutover_window = ${literalWithType(windowValue)} · ${windowSource}`));
        result.checks.push(check('sink-aborto', 'el sink marcó `aborted` con la ventana abierta', sink.aborted === true, `aborted=${sink.aborted} causas=${JSON.stringify(sink.causes)}`, { causa: 'sink_no_aborto' }));
        const escrito = pausedExists && !pausedBefore && marker && marker.source === 'kernel-cutover-degraded-halt';
        result.checks.push(check('paused', '`.paused` escrito en disco por el halt (source kernel-cutover-degraded-halt)', escrito,
            pausedExists ? `${pausedPath} · ${JSON.stringify(marker)}` : `NO existe ${pausedPath}`, { causa: 'paused_no_escrito', datos: { marker } }));
    } else {
        // SEC-4 · ventana cerrada: se REPORTA con el literal y su tipo, y se
        // verifica que NO se escribió `.paused`. El drill no queda verde: no
        // demostró el aborto.
        result.checks.push(check('ventana', 'kernel.cutover_window === true (booleano exacto)', false,
            `ventana CERRADA: cutover_window = ${literalWithType(windowValue)} — sólo el booleano true abre la ventana · ${windowSource}`, { causa: 'ventana_cerrada' }));
        result.checks.push(check('sec-4', 'con la ventana cerrada NO se escribe `.paused` (SEC-4)', !pausedExists && sink.aborted !== true,
            `.paused ${pausedExists ? 'EXISTE (mal)' : 'ausente (correcto)'} · sink.aborted=${sink.aborted}`, { informativo: true }));
    }
    result.sink = { aborted: sink.aborted, causes: sink.causes, alertsSent: sink.alertsSent, cutoverWindow: sink.cutoverWindow };
    result.logs = logs;
    result.telegramNoEnviado = telegram;

    if (ownSandbox && !opts.keep) {
        try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort */ }
        result.sandboxEliminado = true;
    }
    return finish(result);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const SUBCOMMANDS = Object.freeze({
    '--preconditions': runPreconditions,
    '--cas-probe': runCasProbe,
    '--positive': runPositive,
    '--migration-dry-run': runMigrationDryRun,
    '--export-to-fs': runExportToFs,
    '--abort-drill': runAbortDrill,
});

function usage() {
    return [
        'uso: node .pipeline/scripts/opstate-cutover-probe.js <subcomando> [opciones]',
        '',
        'subcomandos (uno por invocación):',
        '  --preconditions      CA-1 · sólo lectura',
        '  --cas-probe          CA-2 · escribe la clave de sonda coord#opstate-cas-probe por compareAndSet',
        '  --positive           CA-3 · sólo lectura (fija PIPELINE_OPSTATE_DURABLE=1 en este proceso)',
        '  --migration-dry-run  CA-4 · dry-run + backup verificado (no toca el store)',
        '  --export-to-fs       CA-5 · store → stateDir(); exige .pipeline/.paused',
        '  --abort-drill        CA-6 · sink real + halt inyectado en un sandbox temporal',
        '',
        'opciones:',
        '  --json                 salida JSON redactada (evidencia)',
        '  --pipeline-dir <dir>   .pipeline/ del host del pipeline (fija PIPELINE_DIR_OVERRIDE)',
        '  --profile <perfil>     perfil AWS del runtime (default kernel.runtimeProfile)',
        '  --source-dir <dir>     (dry-run) directorio de las fuentes; default stateDir()',
        '  --backup-root <dir>    (dry-run) raíz de backups; default <pipeline-dir>/backup',
        '  --window <literal>     (drill) valor de cutover_window como JSON: true | "true" | 1 | absent',
        '  --dir <dir>            (drill) sandbox explícito; default mkdtemp',
        '  --keep                 (drill) no borrar el sandbox',
    ].join('\n');
}

function parseArgs(argv) {
    const args = { subcommand: null, json: false, keep: false };
    const errors = [];
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => { i += 1; return argv[i]; };
        if (SUBCOMMANDS[a]) {
            if (args.subcommand && args.subcommand !== a) errors.push(`un solo subcomando por invocación (${args.subcommand} y ${a})`);
            args.subcommand = a;
        } else if (a === '--json') args.json = true;
        else if (a === '--keep') args.keep = true;
        else if (a === '--pipeline-dir') args.pipelineDir = next();
        else if (a === '--profile') args.profile = next();
        else if (a === '--source-dir') args.sourceDir = next();
        else if (a === '--backup-root') args.backupRoot = next();
        else if (a === '--dir') args.dir = next();
        else if (a === '--window') {
            const raw = next();
            if (raw === 'absent' || raw === undefined) args.window = undefined;
            else {
                try { args.window = JSON.parse(raw); } catch { args.window = raw; }
            }
            args.windowGiven = true;
        } else if (a === '--help' || a === '-h') args.help = true;
        else errors.push(`argumento desconocido: ${a}`);
    }
    if (!args.subcommand && !args.help) errors.push('falta el subcomando');
    return { args, errors };
}

/**
 * Punto de entrada testeable: NUNCA `process.exit`, devuelve `{ exitCode, text, result }`.
 */
async function run(argv, deps = {}) {
    const { args, errors } = parseArgs(argv);
    if (args.help) return { exitCode: 0, text: usage() + '\n', result: null };
    if (errors.length) return { exitCode: 2, text: `[FALLA] ${errors.join('; ')}\n\n${usage()}\n`, result: null };
    if (args.pipelineDir) process.env.PIPELINE_DIR_OVERRIDE = path.resolve(args.pipelineDir);
    // Las sondas que LEEN el store lo hacen por override de entorno en ESTE
    // proceso: el flag del config no se toca (CA-9).
    if (['--positive', '--export-to-fs', '--abort-drill'].includes(args.subcommand) && process.env.PIPELINE_OPSTATE_DURABLE === undefined) {
        process.env.PIPELINE_OPSTATE_DURABLE = '1';
    }
    const opts = { deps: { ...deps, profile: args.profile || deps.profile }, sourceDir: args.sourceDir, backupRoot: args.backupRoot, dir: args.dir, keep: args.keep };
    if (args.windowGiven) opts.window = args.window;
    let result;
    try {
        result = await SUBCOMMANDS[args.subcommand](opts);
    } catch (e) {
        result = finish({ subcomando: args.subcommand, naturaleza: 'abortada por error inesperado', generadoEn: new Date().toISOString(), checks: [check('inesperado', 'ejecución de la sonda', false, redactAll(e && e.stack ? e.stack : String(e)), { causa: 'error_inesperado' })] });
    }
    return { exitCode: result.exitCode, text: args.json ? renderJson(result) : renderReport(result) + '\n', result };
}

async function main() {
    const out = await run(process.argv.slice(2));
    process.stdout.write(out.text);
    process.exitCode = out.exitCode;
}

if (require.main === module) {
    main().catch((e) => {
        process.stdout.write(`[FALLA] error inesperado: ${redactAll(e && e.message)}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    run,
    parseArgs,
    runPreconditions,
    runCasProbe,
    runPositive,
    runMigrationDryRun,
    runExportToFs,
    runAbortDrill,
    verifyBackupAgainstManifest,
    countGateGrace,
    countOperational,
    formatCounts,
    literalWithType,
    driverKindAllowed,
    renderReport,
    renderJson,
    CAUSAS,
    PROBE_KEY,
    ALLOWED_DRIVER_KINDS,
    FORBIDDEN_DRIVER_KINDS,
    GATE_GRACE_WINDOW_MS,
};
