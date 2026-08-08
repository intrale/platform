'use strict';

// =============================================================================
// stale-services.js — Marcador de servicios que quedaron con CÓDIGO VIEJO
// después de un `git reset --hard` (#5646).
// -----------------------------------------------------------------------------
// PROBLEMA que resuelve:
//   `watchdog.ps1` hace `fetch origin main` + `reset --hard FETCH_HEAD` sobre el
//   repo principal en dos caminos (liveness pre-respawn y pre-loop de servicios
//   caídos) y relanza SÓLO los servicios caídos. Los servicios vivos siguen con
//   el código anterior en el require-cache de Node. Cuando un merge agrega una
//   sección nueva a `config.yaml` **y** su declaración en `config-schema.js`, el
//   dashboard vivo valida CONFIG NUEVA contra SCHEMA VIEJO → fail-closed →
//   "⛔ Configuración inválida" y la ola pierde todos los estados.
//
// DISEÑO (una sola línea de decisión):
//   - Los emisores de reset (watchdog, restart.js, endpoint del dashboard) SÓLO
//     MARCAN qué componentes quedaron con código viejo. No ejecutan restarts.
//   - El watchdog es el ÚNICO EJECUTOR del restart selectivo: ya corre cada 2
//     min, ya tiene el contrato de spawn de PowerShell, y es externo al
//     dashboard (que no puede matarse a sí mismo) — REQ-SEC-5646-5, sin
//     inventar un relanzador genérico que acepte paths o command lines.
//   - La marca PERSISTE en disco y se limpia SÓLO tras spawn confirmado: si el
//     relanzamiento falla, el componente sigue pendiente el ciclo siguiente
//     (cierra el fail-open de REQ-SEC-5646-7).
//
// Contrato de seguridad:
//   - REQ-SEC-5646-1: git se invoca con `execFileSync('git', [args])` (array,
//     sin shell). El `prevSha` se obtiene vía `runtime-boot.readBootMarker()`
//     (valida SHA_RE) o se valida acá con la MISMA regex antes de llegar a los
//     argv. Un SHA que no valida NUNCA se pasa a git: se devuelve
//     `unknown:true` + TODOS los componentes (fail-closed conservador), jamás
//     `components: []`.
//   - REQ-SEC-5646-2: el mapeo diff→componente devuelve NOMBRES de componente,
//     nunca paths ejecutables. El script a spawnear se resuelve siempre desde
//     el registro estático de acá / `$ScriptMap` del watchdog.
//   - REQ-SEC-5646-3: el CLI falla cerrado — JSON válido en stdout con exit 0,
//     o stdout VACÍO con exit ≠ 0. Nunca stack traces mezclados con JSON.
//   - REQ-SEC-5646-8: los paths salen del contenido del commit → se sanitizan
//     (strip CR/LF + secuencias ANSI + truncado) antes de tocar un log.
//   - REQ-SEC-5646-6: este módulo NO toca la validación de config. El bug es la
//     frescura del código, no el fail-closed.
//
// Vocabulario (UX G-2): "código viejo" en texto para el operador, `stale` como
// identificador técnico en JSON/código.
// =============================================================================

const fs = require('fs');
const path = require('path');
const runtimeBoot = require('./runtime-boot');

const STATE_FILENAME = 'stale-services.json';
const STATE_VERSION = 1;

// Longitud fija de truncado de paths en logs (REQ-SEC-5646-8).
const LOG_PATH_MAX = 120;

// ---------------------------------------------------------------------------
// Registro canónico de componentes (CA-4).
// Es la UNIÓN de `restart.js:COMPONENTS` (8, con `dashboard`, sin
// `outbox-drain`) y `dashboard.js:COMPONENTS` (8, con `outbox-drain`, sin
// `dashboard` porque no puede matarse a sí mismo). Ninguna de las dos listas
// contiene a la otra → el registro canónico es de 9.
// El orden ES el orden de relanzamiento del watchdog: primero el motor, después
// los adaptadores, y el dashboard al final (es la ventana del operador).
// ---------------------------------------------------------------------------
const COMPONENT_REGISTRY = [
    { name: 'pulpo', script: 'pulpo.js' },
    { name: 'listener', script: 'listener-telegram.js' },
    { name: 'svc-telegram', script: 'servicio-telegram.js' },
    { name: 'svc-github', script: 'servicio-github.js' },
    { name: 'svc-drive', script: 'servicio-drive.js' },
    { name: 'svc-emulador', script: 'servicio-emulador.js' },
    { name: 'svc-reconciler', script: 'servicio-reconciler.js' },
    { name: 'outbox-drain', script: 'outbox-drain.js' },
    { name: 'dashboard', script: 'dashboard.js' },
];

const ALL_COMPONENTS = COMPONENT_REGISTRY.map(c => c.name);

// Paths (relativos al root del repo, separador `/` como los emite git) que
// afectan a TODOS los componentes.
const PIPELINE_PREFIX = '.pipeline/';
const SHARED_LIB_PREFIX = '.pipeline/lib/';
const SHARED_CONFIG = '.pipeline/config.yaml';

// ---------------------------------------------------------------------------
// Sanitizado de paths para log (REQ-SEC-5646-8 / CA-7).
// Los paths salen de `git diff`, o sea del CONTENIDO DEL COMMIT: un path con un
// salto de línea embebido permite falsificar líneas en el log que el operador
// usa justamente para diagnosticar este tipo de incidente.
// ---------------------------------------------------------------------------
function sanitizePathForLog(p) {
    if (typeof p !== 'string') return '';
    let s = p;
    // Secuencias ANSI CSI (colores, movimiento de cursor): ESC [ ... letra final.
    s = s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
    // Resto de secuencias de escape de dos chars: ESC + un char.
    s = s.replace(/\u001b[@-Z\\-_]/g, '');
    // Cualquier control char (CR, LF, TAB, NUL, backspace, DEL) -> espacio: es lo
    // que permitiria falsificar una linea entera del log del operador.
    s = s.replace(/[\u0000-\u001f\u007f]/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > LOG_PATH_MAX) s = s.slice(0, LOG_PATH_MAX - 1) + '\u2026';
    return s;
}

// ---------------------------------------------------------------------------
// Mapeo diff → componentes. ESTÁTICO y CONSERVADOR (CA-2, guru §5): nada de
// grafo de imports — ningún proceso puede inspeccionar el `require.cache` de
// otro, así que cualquier inferencia fina sería adivinanza.
//
//   `.pipeline/lib/**`          → todos
//   `.pipeline/config.yaml`     → todos
//   `.pipeline/<script propio>` → sólo ese componente
//   cualquier otra cosa         → nadie
// ---------------------------------------------------------------------------
function componentsForPath(p) {
    if (typeof p !== 'string' || !p) return [];
    // git emite siempre `/`; normalizamos por si el caller pasó separador Windows.
    const rel = p.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!rel.startsWith(PIPELINE_PREFIX)) return [];
    if (rel.startsWith(SHARED_LIB_PREFIX)) return ALL_COMPONENTS.slice();
    if (rel === SHARED_CONFIG) return ALL_COMPONENTS.slice();
    const tail = rel.slice(PIPELINE_PREFIX.length);
    const hit = COMPONENT_REGISTRY.find(c => c.script === tail);
    return hit ? [hit.name] : [];
}

/**
 * Cruza una lista de paths del diff contra el registro y devuelve los
 * componentes afectados + el path que motivó cada uno.
 *
 * UX G-1: se guarda UN path por componente (el primero que lo motivó), no el
 * diff entero: con casi todo merge tocando `.pipeline/lib/**` la lista completa
 * es ruido que entierra la señal.
 *
 * @param {string[]} paths
 * @returns {{ components: string[], reasons: Array<{component:string, path:string}> }}
 */
function mapPathsToComponents(paths) {
    const firstReason = new Map();
    for (const raw of (Array.isArray(paths) ? paths : [])) {
        for (const name of componentsForPath(raw)) {
            if (!firstReason.has(name)) firstReason.set(name, sanitizePathForLog(raw));
        }
    }
    // Orden canónico del registro (= orden de relanzamiento), no orden del diff.
    const components = ALL_COMPONENTS.filter(n => firstReason.has(n));
    return {
        components,
        reasons: components.map(n => ({ component: n, path: firstReason.get(n) })),
    };
}

function _resolvePipelineDir(opts) {
    const o = opts || {};
    if (typeof o.pipelineDir === 'string' && o.pipelineDir) return o.pipelineDir;
    return path.resolve(__dirname, '..');
}

function _resolveRepoRoot(opts) {
    const o = opts || {};
    if (typeof o.repoRoot === 'string' && o.repoRoot) return o.repoRoot;
    return path.resolve(_resolvePipelineDir(o), '..');
}

function _statePath(opts) {
    return path.join(_resolvePipelineDir(opts), STATE_FILENAME);
}

// ---------------------------------------------------------------------------
// Cómputo de afectados (CA-2 + CA-8).
// ---------------------------------------------------------------------------
/**
 * Calcula qué componentes quedaron con código viejo tras un reset.
 *
 * @param {object} [opts] — {
 *     prevSha,      // HEAD ANTES del reset. Si falta/no valida → readBootMarker.
 *     headSha,      // HEAD DESPUÉS del reset. Si falta → `git rev-parse HEAD`.
 *     repoRoot, pipelineDir,
 *     exec,         // inyectable para test: (args:string[]) => string (stdout)
 *   }
 * @returns {{ ok:boolean, unknown:boolean, components:string[],
 *             reasons:Array<{component:string,path:string}>, prevSha:string|null,
 *             headSha:string|null, msg:string }}
 *   NUNCA lanza. Ante cualquier duda devuelve `unknown:true` con TODOS los
 *   componentes (fail-closed conservador): un restart de más es ruido, un
 *   servicio stale invisible es el bug de este issue.
 */
function computeAffectedComponents(opts) {
    const o = opts || {};
    const repoRoot = _resolveRepoRoot(o);
    const exec = typeof o.exec === 'function'
        ? o.exec
        : (args) => {
            const { execFileSync } = require('node:child_process');
            // Array de argumentos, SIN shell (REQ-SEC-5646-1). Molde de
            // lib/operativo-sync.js — nunca el execSync-con-string de restart.js.
            return execFileSync('git', args, {
                cwd: repoRoot, encoding: 'utf8', timeout: 30000, windowsHide: true,
                maxBuffer: 8 * 1024 * 1024,
            });
        };

    const unknownResult = (msg, prevSha, headSha) => ({
        ok: true,
        unknown: true,
        components: ALL_COMPONENTS.slice(),
        reasons: ALL_COMPONENTS.map(n => ({ component: n, path: '(estado desconocido)' })),
        prevSha: prevSha || null,
        headSha: headSha || null,
        msg,
    });

    // 1. prevSha. Prohibido parsear runtime-boot.json a mano: readBootMarker ya
    //    valida SHA_RE y nunca lanza. Un prevSha explícito se valida con la
    //    MISMA regex antes de acercarse a los argv de git: un valor tipo
    //    `--upload-pack=...` o `-x` cambiaría la semántica del comando aunque
    //    no haya shell de por medio (argument injection).
    let prevSha = null;
    if (typeof o.prevSha === 'string' && runtimeBoot.SHA_RE.test(o.prevSha)) {
        prevSha = o.prevSha;
    } else if (o.prevSha != null) {
        return unknownResult('prevSha inválido (no hex 7-40): estado desconocido', null, null);
    } else {
        const marker = runtimeBoot.readBootMarker({ pipelineDir: _resolvePipelineDir(o) });
        if (marker && runtimeBoot.SHA_RE.test(marker.sha)) prevSha = marker.sha;
    }
    if (!prevSha) {
        return unknownResult('sin referencia previa (marker ausente o corrupto): estado desconocido', null, null);
    }

    // 2. headSha. Mismo tratamiento.
    let headSha = null;
    if (typeof o.headSha === 'string' && runtimeBoot.SHA_RE.test(o.headSha)) {
        headSha = o.headSha;
    } else if (o.headSha != null) {
        return unknownResult('headSha inválido (no hex 7-40): estado desconocido', prevSha, null);
    } else {
        try {
            headSha = String(exec(['rev-parse', 'HEAD'])).trim();
        } catch (e) {
            return unknownResult(`no se pudo resolver HEAD: ${_msg(e)}`, prevSha, null);
        }
        if (!runtimeBoot.SHA_RE.test(headSha)) {
            return unknownResult('HEAD resuelto no es hex: estado desconocido', prevSha, null);
        }
    }

    // 3. Sin movimiento → nadie quedó con código viejo. Es el único camino que
    //    puede devolver la lista vacía con certeza.
    if (prevSha === headSha) {
        return {
            ok: true, unknown: false, components: [], reasons: [],
            prevSha, headSha, msg: 'el reset no movió el HEAD: sin componentes afectados',
        };
    }

    // 4. Diff. `-z` para que los paths raros (espacios, unicode, CR/LF) vengan
    //    NUL-separados y sin quoting propio de git (REQ-SEC-5646-8).
    let out;
    try {
        out = exec(['diff', '--name-only', '-z', prevSha, headSha]);
    } catch (e) {
        return unknownResult(`git diff falló: ${_msg(e)}`, prevSha, headSha);
    }
    const paths = String(out == null ? '' : out).split('\0').filter(Boolean);
    const mapped = mapPathsToComponents(paths);
    return {
        ok: true,
        unknown: false,
        components: mapped.components,
        reasons: mapped.reasons,
        prevSha,
        headSha,
        msg: mapped.components.length
            ? `${mapped.components.length} componente(s) con código viejo tras el reset`
            : 'sin componentes afectados por el reset',
    };
}

// ---------------------------------------------------------------------------
// Persistencia del registro de pendientes (CA-5).
// Escritura ATÓMICA temp+rename, mismo contrato que runtime-boot.js: el archivo
// es la única memoria de "a quién falta reiniciar" entre ciclos del watchdog.
// ---------------------------------------------------------------------------
function _readState(opts) {
    let raw;
    try {
        raw = fs.readFileSync(_statePath(opts), 'utf8');
    } catch {
        return { version: STATE_VERSION, pending: {} };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // Corrupto → se trata como vacío. No crasheamos al watchdog por esto;
        // el próximo reset vuelve a marcar lo que corresponda.
        return { version: STATE_VERSION, pending: {} };
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.pending || typeof parsed.pending !== 'object') {
        return { version: STATE_VERSION, pending: {} };
    }
    // Filtro defensivo: sólo nombres del registro canónico sobreviven a la
    // lectura (REQ-SEC-5646-2 — el archivo del FS es dato no confiable).
    const pending = {};
    for (const name of ALL_COMPONENTS) {
        const e = parsed.pending[name];
        if (e && typeof e === 'object') {
            pending[name] = {
                sha: typeof e.sha === 'string' && runtimeBoot.SHA_RE.test(e.sha) ? e.sha : null,
                path: sanitizePathForLog(typeof e.path === 'string' ? e.path : ''),
                markedAt: typeof e.markedAt === 'string' ? e.markedAt : null,
            };
        }
    }
    return { version: STATE_VERSION, pending };
}

function _writeState(state, opts) {
    const target = _statePath(opts);
    const payload = JSON.stringify({ version: STATE_VERSION, pending: state.pending }, null, 2) + '\n';
    const tmp = target + '.' + process.pid + '.tmp';
    try {
        fs.writeFileSync(tmp, payload, { encoding: 'utf8' });
        fs.renameSync(tmp, target); // atómico en el mismo filesystem
        return { ok: true };
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* noop */ }
        return { ok: false, msg: _msg(e) };
    }
}

/**
 * Marca componentes como "con código viejo". Idempotente y ADITIVO: no pisa una
 * marca anterior que todavía no se pudo relanzar (si un componente quedó
 * pendiente de un reset previo, sigue pendiente).
 *
 * @param {string[]} names — nombres del registro canónico (los demás se ignoran).
 * @param {object} [meta] — { sha, reasons: [{component, path}] }.
 * @param {object} [opts] — { pipelineDir }.
 * @returns {{ ok:boolean, marked:string[], msg?:string }}  NUNCA lanza.
 */
function markAffected(names, meta, opts) {
    const m = meta || {};
    const list = Array.isArray(names) ? names.filter(n => ALL_COMPONENTS.includes(n)) : [];
    if (!list.length) return { ok: true, marked: [] };
    const reasonByComp = new Map(
        (Array.isArray(m.reasons) ? m.reasons : [])
            .filter(r => r && typeof r.component === 'string')
            .map(r => [r.component, sanitizePathForLog(r.path)])
    );
    const sha = typeof m.sha === 'string' && runtimeBoot.SHA_RE.test(m.sha) ? m.sha : null;
    let state;
    try {
        state = _readState(opts);
    } catch (e) {
        return { ok: false, marked: [], msg: _msg(e) };
    }
    const markedAt = new Date().toISOString();
    const marked = [];
    for (const name of list) {
        if (state.pending[name]) continue; // ya pendiente: no pisar el motivo original
        state.pending[name] = {
            sha,
            path: reasonByComp.get(name) || '(sin path)',
            markedAt,
        };
        marked.push(name);
    }
    if (!marked.length) return { ok: true, marked: [] };
    const w = _writeState(state, opts);
    return { ok: !!w.ok, marked: w.ok ? marked : [], msg: w.msg };
}

/**
 * Lee los componentes pendientes de relanzar.
 * @returns {{ ok:boolean, components:string[], reasons:Array<{component,path,sha,markedAt}> }}
 */
function readPending(opts) {
    let state;
    try {
        state = _readState(opts);
    } catch {
        return { ok: true, components: [], reasons: [] };
    }
    const components = ALL_COMPONENTS.filter(n => state.pending[n]);
    return {
        ok: true,
        components,
        reasons: components.map(n => ({
            component: n,
            path: state.pending[n].path || '(sin path)',
            sha: state.pending[n].sha || null,
            markedAt: state.pending[n].markedAt || null,
        })),
    };
}

/**
 * Limpia UN componente del registro de pendientes. Se invoca SÓLO tras spawn
 * confirmado (CA-5): si el relanzamiento falla, el componente sigue pendiente el
 * ciclo siguiente en vez de desaparecer en silencio.
 */
function clearComponent(name, opts) {
    if (typeof name !== 'string' || !ALL_COMPONENTS.includes(name)) {
        return { ok: false, cleared: false, msg: 'componente fuera del registro canónico' };
    }
    let state;
    try {
        state = _readState(opts);
    } catch (e) {
        return { ok: false, cleared: false, msg: _msg(e) };
    }
    if (!state.pending[name]) return { ok: true, cleared: false, msg: 'no estaba pendiente' };
    delete state.pending[name];
    const w = _writeState(state, opts);
    return { ok: !!w.ok, cleared: !!w.ok, msg: w.msg };
}

/**
 * Limpia varios componentes. Pensado para `restart.js`, que tras `launchAll()`
 * ya relanzó un subconjunto conocido: se limpia SÓLO ese subconjunto real, nunca
 * el registro entero (P-1 de guru / CA-3 corregido por PO — `outbox-drain` no
 * está en `COMPONENTS` de restart.js y limpiarlo lo dejaría stale para siempre).
 */
function clearComponents(names, opts) {
    const list = Array.isArray(names) ? names.filter(n => ALL_COMPONENTS.includes(n)) : [];
    const cleared = [];
    for (const n of list) {
        const r = clearComponent(n, opts);
        if (r.cleared) cleared.push(n);
    }
    return { ok: true, cleared };
}

/**
 * Línea de log para el operador (UX G-1): qué pasó / por qué / con qué reset.
 * Causa antes del efecto, UN path (el que motivó), nombre del componente tal
 * como aparece en el panel de servicios del dashboard.
 */
function formatRestartLogLine(component, reasonPath, prevSha, headSha) {
    const p = sanitizePathForLog(reasonPath || '') || '(sin path)';
    const from = typeof prevSha === 'string' ? prevSha.slice(0, 9) : '?';
    const to = typeof headSha === 'string' ? headSha.slice(0, 9) : '?';
    return `restart selectivo: ${component} reiniciado — cambio en ${p} (reset ${from} -> ${to})`;
}

function _msg(e) {
    return ((e && e.message) || String(e) || 'error desconocido').slice(0, 160);
}

module.exports = {
    COMPONENT_REGISTRY,
    ALL_COMPONENTS,
    STATE_FILENAME,
    LOG_PATH_MAX,
    sanitizePathForLog,
    componentsForPath,
    mapPathsToComponents,
    computeAffectedComponents,
    markAffected,
    readPending,
    clearComponent,
    clearComponents,
    formatRestartLogLine,
    // internos para test
    _statePath,
};

// ---------------------------------------------------------------------------
// CLI — consumido por `watchdog.ps1` (frontera Node → PowerShell).
//
// Contrato FAIL-CLOSED (REQ-SEC-5646-3): o JSON válido en stdout con exit 0, o
// stdout VACÍO con exit ≠ 0. PowerShell no tiene que adivinar si la salida es
// JSON o un stack trace. Todo lo humano va a stderr.
//
//   node lib/stale-services.js --json                → pendientes actuales
//   node lib/stale-services.js --mark [--prev <sha>] → computa y marca
//   node lib/stale-services.js --clear <componente>  → limpia uno (post-spawn)
// ---------------------------------------------------------------------------
const CLI_FLAGS = ['--json', '--mark', '--prev', '--clear'];

if (require.main === module) {
    let payload = null;
    try {
        const argv = process.argv.slice(2);
        // Argv ESTRICTO: cualquier flag desconocida o un `--clear`/`--prev` sin
        // valor abortan. Fail-closed: es preferible que el watchdog vea "sin
        // datos" a que interprete un default silencioso como "no hay nada que
        // reiniciar" (que es exactamente el fail-open de este issue).
        for (let i = 0; i < argv.length; i++) {
            const a = argv[i];
            if (!CLI_FLAGS.includes(a)) {
                if (i > 0 && (argv[i - 1] === '--prev' || argv[i - 1] === '--clear')) continue; // es el valor
                throw new Error(`argumento no reconocido: ${String(a).slice(0, 40)}`);
            }
            if ((a === '--prev' || a === '--clear') && (i + 1 >= argv.length || CLI_FLAGS.includes(argv[i + 1]))) {
                throw new Error(`${a} requiere un valor`);
            }
        }
        const flag = (name) => argv.includes(name);
        const valueOf = (name) => {
            const i = argv.indexOf(name);
            return (i >= 0 && i + 1 < argv.length) ? argv[i + 1] : null;
        };
        // Dir del estado. Se puede aislar para test sin tocar el `.pipeline` real.
        const cliOpts = process.env.STALE_SERVICES_DIR
            ? { pipelineDir: process.env.STALE_SERVICES_DIR }
            : {};

        if (flag('--mark')) {
            const prevArg = valueOf('--prev');
            const res = computeAffectedComponents(
                Object.assign({}, cliOpts, prevArg != null ? { prevSha: prevArg } : {})
            );
            const mark = markAffected(res.components, { sha: res.headSha, reasons: res.reasons }, cliOpts);
            payload = {
                ok: !!mark.ok,
                unknown: !!res.unknown,
                affected: res.components,
                marked: mark.marked,
                reasons: res.reasons,
                prevSha: res.prevSha,
                headSha: res.headSha,
                msg: res.msg,
            };
        } else if (flag('--clear')) {
            const name = valueOf('--clear');
            const res = clearComponent(name, cliOpts);
            payload = { ok: !!res.ok, cleared: !!res.cleared, component: name, msg: res.msg || '' };
        } else {
            const pend = readPending(cliOpts);
            payload = { ok: true, components: pend.components, reasons: pend.reasons };
        }
    } catch (e) {
        // stdout queda VACÍO a propósito.
        process.stderr.write(`stale-services: ${_msg(e)}\n`);
        process.exit(1);
    }
    process.stdout.write(JSON.stringify(payload));
    process.exit(0);
}
