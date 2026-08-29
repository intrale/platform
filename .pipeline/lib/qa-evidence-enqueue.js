// =============================================================================
// qa-evidence-enqueue.js — #6145
// =============================================================================
//
// Encolado canónico del descriptor de evidencia QA estructural para el servicio
// Drive, y rescate de los descriptores que quedaron varados en un worktree.
//
// ## Por qué existe
//
// `.pipeline/roles/qa.md` instruía escribir el descriptor con un path RELATIVO
// (`.pipeline/servicios/drive/pendiente/qa-<issue>-structural.json`). El agente
// de `verificacion` corre con CWD = worktree del issue (`PIPELINE_WORKTREE`),
// así que ese path relativo resuelve DENTRO del worktree — un árbol que
// `servicio-drive.js` nunca mira: el servicio lee `PIPELINE_STATE_DIR` (o su
// propio `__dirname`), siempre el repo principal.
//
// El descriptor queda entonces:
//   - fuera de la cola que consume el servicio (nunca se procesa), y
//   - fuera de git (`.gitignore` ignora `.pipeline/servicios/*/pendiente/*`),
// o sea: se pierde en silencio cuando se poda el worktree. Aguas abajo, la fase
// de aprobación ve el descriptor de una pasada VIEJA en `listo/` y concluye —
// correctamente — que la evidencia aprobada nunca se encoló.
//
// Segundo defecto: el nombre `qa-<issue>-structural.json` es FIJO, un único
// slot por issue. Cada re-pasada pisa a la anterior y no queda trazabilidad por
// pasada; de ahí que hayan aparecido nombres improvisados tipo
// `qa-<issue>-structural-current.json` en `listo/`.
//
// ## Invariantes
//
//  1. El destino se ancla SIEMPRE en el repo canónico (env del pulpo), NUNCA en
//     `process.cwd()` ni en `__dirname` si hay env disponible.
//  2. El nombre del descriptor es único por pasada: nunca pisa una pasada
//     previa, y `extractIssue()` del servicio lo sigue resolviendo por el patrón
//     `qa-(\d+)`.
//  3. Todo es best-effort hacia afuera: una falla de encolado o de rescate
//     jamás lanza al llamador ni deja el servicio fuera de línea.
//  4. Módulo puro/inyectable: `fsImpl`, `env` y `now` entran por parámetro.
//
// =============================================================================
'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');

// Campos canónicos que `servicio-drive.js::isStructuralEvidenceJob` exige para
// eximir el job del uploader de videos. Si alguno falta, el descriptor cae al
// camino de video y termina en `fallido/`.
const REQUIRED_MODE = 'structural';
const REQUIRED_SOURCE = 'qa-structural';

// Convención de nombre de worktree del pipeline: `<repo>.agent-<issue>-<skill>`.
const WORKTREE_SUFFIX_RE = /^\.agent-\d+-/;

function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim() !== '';
}

// -----------------------------------------------------------------------------
// Resolución del árbol de estado canónico
// -----------------------------------------------------------------------------

// Precedencia deliberada, de más explícito a menos:
//   1. PIPELINE_DIR_OVERRIDE  — override directo del dir `.pipeline`
//   2. PIPELINE_STATE_DIR     — el mismo que lee `servicio-drive.js`
//   3. PIPELINE_REPO_ROOT     — lo setea el pulpo al lanzar cada agente
//                               (`pulpo.js` → pipelineExtras) y apunta SIEMPRE
//                               al repo principal, no al worktree
//   4. módulo-relativo        — último recurso (proceso que corre en el repo)
//
// `process.cwd()` NO participa: es exactamente la fuente que produjo el bug.
function resolveStateRoot(env, deps) {
    const e = env && typeof env === 'object' ? env : {};
    if (isNonEmptyString(e.PIPELINE_DIR_OVERRIDE)) {
        return path.resolve(e.PIPELINE_DIR_OVERRIDE);
    }
    if (isNonEmptyString(e.PIPELINE_STATE_DIR)) {
        return path.resolve(e.PIPELINE_STATE_DIR);
    }
    if (isNonEmptyString(e.PIPELINE_REPO_ROOT)) {
        return path.resolve(e.PIPELINE_REPO_ROOT, '.pipeline');
    }
    const fallbackDir = (deps && isNonEmptyString(deps.moduleDir))
        ? deps.moduleDir
        : __dirname;
    return path.resolve(fallbackDir, '..');
}

function resolveRepoRoot(env, deps) {
    return path.resolve(resolveStateRoot(env, deps), '..');
}

function resolveDriveQueueDir(env, deps) {
    return path.join(resolveStateRoot(env, deps), 'servicios', 'drive', 'pendiente');
}

// -----------------------------------------------------------------------------
// Nombre único por pasada
// -----------------------------------------------------------------------------

// `qa-<issue>-<kind>-<ts>-<NN>.json`.
// Mantiene el prefijo `qa-<issue>-` para que `extractIssue()` del servicio siga
// derivando el issue del filename aunque el payload venga incompleto.
// `kind` es `structural` para la evidencia estructural y `video` para el resto
// (android/api), que es la nomenclatura histórica de la cola.
function kindForMode(mode) {
    return String(mode || REQUIRED_MODE).trim().toLowerCase() === REQUIRED_MODE
        ? 'structural'
        : 'video';
}

function buildDescriptorName(issue, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const ts = Number.isFinite(o.now) ? Math.trunc(o.now) : 0;
    const seq = Number.isFinite(o.seq) ? Math.trunc(o.seq) : 0;
    const kind = isNonEmptyString(o.kind) ? o.kind.trim() : kindForMode(o.mode);
    return `qa-${String(issue)}-${kind}-${ts}-${String(seq).padStart(2, '0')}.json`;
}

// Reserva un nombre libre en la cola. Nunca pisa un descriptor existente: si el
// nombre está tomado (misma marca de tiempo), incrementa el secuencial.
function reserveDescriptorPath(queueDir, issue, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const fsImpl = o.fsImpl || nodeFs;
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    const kind = isNonEmptyString(o.kind) ? o.kind.trim() : kindForMode(o.mode);
    for (let seq = 0; seq < 100; seq++) {
        const name = buildDescriptorName(issue, { now, seq, kind });
        const full = path.join(queueDir, name);
        let taken = false;
        try { taken = fsImpl.existsSync(full); } catch { taken = false; }
        if (!taken) return { name, path: full };
    }
    // 100 colisiones en el mismo milisegundo es imposible en la práctica; si
    // pasara, degradamos a un nombre con sufijo aleatorio antes que fallar.
    const name = buildDescriptorName(issue, { now, seq: 0, kind })
        .replace(/\.json$/, `-${Math.floor(Math.random() * 1e6)}.json`);
    return { name, path: path.join(queueDir, name) };
}

// -----------------------------------------------------------------------------
// Descriptor canónico
// -----------------------------------------------------------------------------

// Construye el payload y VALIDA los campos que el servicio exige. Devuelve
// `{ ok, descriptor, errors }` — no lanza: el llamador decide qué hacer.
function buildDescriptor(fields) {
    const f = fields && typeof fields === 'object' ? fields : {};
    const errors = [];

    const issue = String(f.issue == null ? '' : f.issue).trim();
    if (!/^\d+$/.test(issue)) errors.push('issue debe ser numérico');

    // `structural` por default: es el modo que exime el uploader de video.
    // Cualquier otro modo (`android`, `api`) SÍ lleva artefacto a subir, por eso
    // NO puede emitir `source: qa-structural` — eso saltearía el upload real.
    const mode = isNonEmptyString(f.mode) ? f.mode.trim().toLowerCase() : REQUIRED_MODE;
    const esStructural = mode === REQUIRED_MODE;

    const file = isNonEmptyString(f.file)
        ? f.file.trim()
        : (esStructural
            ? `qa/evidence/${issue}/qa-${issue}-structural.md`
            : `qa/evidence/${issue}/qa-${issue}.mp4`);

    // El descriptor describe UNA pasada concreta: sin veredicto explícito, la
    // fase de aprobación no puede distinguir la pasada aprobada de la rechazada
    // (que es justamente lo que se rompió acá).
    const verdict = isNonEmptyString(f.verdict) ? f.verdict.trim().toLowerCase() : '';
    if (!verdict) errors.push('verdict es obligatorio (aprobado|rechazado)');

    const descriptor = {
        action: 'upload',
        file,
        issue: Number(issue) || issue,
        mode,
        source: esStructural ? REQUIRED_SOURCE : `qa-${mode}`,
        verdict,
    };

    if (isNonEmptyString(f.folder)) descriptor.folder = f.folder.trim();
    else if (/^\d+$/.test(issue)) descriptor.folder = `QA/evidence/${issue}`;
    if (isNonEmptyString(f.title)) descriptor.title = f.title.trim();
    if (isNonEmptyString(f.description)) descriptor.description = f.description.trim();
    if (isNonEmptyString(f.motivo)) descriptor.motivo = f.motivo.trim();
    if (f.passed != null) descriptor.passed = Number(f.passed);
    if (f.total != null) descriptor.total = Number(f.total);
    // Ancla la evidencia al commit que se evaluó: sin esto, un descriptor
    // "aprobado" no dice SOBRE QUÉ código lo está.
    if (isNonEmptyString(f.head)) descriptor.head = f.head.trim();
    if (isNonEmptyString(f.narrator)) descriptor.narrator = f.narrator.trim();
    if (isNonEmptyString(f.rejectionPdf)) descriptor.rejectionPdf = f.rejectionPdf.trim();
    if (Array.isArray(f.criteriosFallidos) && f.criteriosFallidos.length > 0) {
        descriptor.criteriosFallidos = f.criteriosFallidos.map(String);
    }

    return { ok: errors.length === 0, descriptor, errors };
}

// -----------------------------------------------------------------------------
// Encolado
// -----------------------------------------------------------------------------

// Escribe el descriptor en la cola canónica del servicio Drive.
// Devuelve `{ ok, path, name, queueDir, errors }`. Nunca lanza.
function enqueueStructuralEvidence(fields, deps) {
    const d = deps && typeof deps === 'object' ? deps : {};
    const fsImpl = d.fsImpl || nodeFs;
    const env = d.env || process.env;
    const now = Number.isFinite(d.now) ? d.now : Date.now();

    const built = buildDescriptor(fields);
    if (!built.ok) {
        return { ok: false, path: null, name: null, queueDir: null, errors: built.errors };
    }

    const queueDir = isNonEmptyString(d.queueDir)
        ? path.resolve(d.queueDir)
        : resolveDriveQueueDir(env, d);

    try {
        fsImpl.mkdirSync(queueDir, { recursive: true });
        const target = reserveDescriptorPath(queueDir, built.descriptor.issue, {
            fsImpl, now, mode: built.descriptor.mode,
        });
        fsImpl.writeFileSync(target.path, JSON.stringify(built.descriptor, null, 2) + '\n', 'utf8');
        return {
            ok: true,
            path: target.path,
            name: target.name,
            queueDir,
            descriptor: built.descriptor,
            errors: [],
        };
    } catch (e) {
        return {
            ok: false,
            path: null,
            name: null,
            queueDir,
            errors: [`no se pudo escribir el descriptor: ${e.message}`],
        };
    }
}

// -----------------------------------------------------------------------------
// Rescate de descriptores varados en worktrees
// -----------------------------------------------------------------------------

// Lista los worktrees hermanos del repo canónico: directorios `<repo>.agent-*`
// bajo el mismo padre. No usa git — sólo el filesystem, para no depender de un
// subproceso dentro del loop del servicio.
function listAgentWorktrees(repoRoot, deps) {
    const d = deps && typeof deps === 'object' ? deps : {};
    const fsImpl = d.fsImpl || nodeFs;
    const parent = path.dirname(repoRoot);
    const base = path.basename(repoRoot);
    let entries = [];
    try {
        entries = fsImpl.readdirSync(parent, { withFileTypes: true });
    } catch { return []; }
    const out = [];
    for (const entry of entries) {
        let name;
        let isDir;
        if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
            name = entry.name;
            isDir = typeof entry.isDirectory === 'function' ? entry.isDirectory() : true;
        } else {
            name = String(entry);
            isDir = true;
        }
        if (!isDir) continue;
        if (!name.startsWith(base + '.')) continue;
        if (!WORKTREE_SUFFIX_RE.test(name.slice(base.length))) continue;
        out.push(path.join(parent, name));
    }
    return out;
}

// Encuentra descriptores `.json` varados en la cola `pendiente/` de cada
// worktree. Son descriptores que ningún servicio va a consumir jamás.
function findStrandedDescriptors(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const fsImpl = o.fsImpl || nodeFs;
    const repoRoot = isNonEmptyString(o.repoRoot)
        ? path.resolve(o.repoRoot)
        : resolveRepoRoot(o.env || process.env, o);

    const found = [];
    for (const worktree of listAgentWorktrees(repoRoot, { fsImpl })) {
        const queue = path.join(worktree, '.pipeline', 'servicios', 'drive', 'pendiente');
        let names = [];
        try {
            names = fsImpl.readdirSync(queue);
        } catch { continue; }
        for (const name of names) {
            if (typeof name !== 'string') continue;
            if (name.startsWith('.') || !name.endsWith('.json')) continue;
            const full = path.join(queue, name);
            let data = null;
            try {
                data = JSON.parse(fsImpl.readFileSync(full, 'utf8'));
            } catch {
                // Descriptor ilegible: se reporta igual para que quede visible,
                // pero no se re-encola (el servicio no sabría qué hacer con él).
                found.push({ path: full, worktree, name, data: null, parseable: false });
                continue;
            }
            found.push({ path: full, worktree, name, data, parseable: true });
        }
    }
    return found;
}

// Tope de rescates por corrida. Un worktree viejo puede acumular descriptores;
// re-encolarlos todos de golpe podria disparar una rafaga de uploads y de
// notificaciones a Telegram. Se rescata de a tandas y se DEJA CONSTANCIA de lo
// que quedo pendiente — nunca se descarta en silencio.
const MAX_RESCUES_PER_RUN = 25;

// Re-encola en la cola canónica cada descriptor varado y borra el original para
// que el rescate sea idempotente (no re-encola en el siguiente tick).
//
// Best-effort total: cualquier error se acumula en `errors` y NO se propaga.
function rescueStrandedDescriptors(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const fsImpl = o.fsImpl || nodeFs;
    const env = o.env || process.env;
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    const log = typeof o.log === 'function' ? o.log : () => {};

    const repoRoot = isNonEmptyString(o.repoRoot)
        ? path.resolve(o.repoRoot)
        : resolveRepoRoot(env, o);
    const queueDir = isNonEmptyString(o.queueDir)
        ? path.resolve(o.queueDir)
        : path.join(repoRoot, '.pipeline', 'servicios', 'drive', 'pendiente');

    const maxPerRun = Number.isFinite(o.maxPerRun) && o.maxPerRun > 0
        ? Math.trunc(o.maxPerRun)
        : MAX_RESCUES_PER_RUN;

    const result = { rescued: 0, skipped: 0, diferidos: 0, errors: [], names: [] };

    let stranded = [];
    try {
        stranded = findStrandedDescriptors({ repoRoot, fsImpl });
    } catch (e) {
        result.errors.push(`no se pudo listar worktrees: ${e.message}`);
        return result;
    }
    if (stranded.length === 0) return result;

    try { fsImpl.mkdirSync(queueDir, { recursive: true }); } catch { /* best-effort */ }

    for (const item of stranded) {
        if (result.rescued >= maxPerRun) {
            result.diferidos++;
            continue;
        }
        if (!item.parseable || !item.data || typeof item.data !== 'object') {
            result.skipped++;
            continue;
        }
        try {
            // El issue se deriva del payload o del filename, igual que hace el
            // servicio. Sin issue no hay carpeta destino: se saltea.
            let issue = String(item.data.issue == null ? '' : item.data.issue).trim();
            if (!/^\d+$/.test(issue)) {
                const m = /qa-(\d+)/.exec(item.name);
                issue = m ? m[1] : '';
            }
            if (!/^\d+$/.test(issue)) { result.skipped++; continue; }

            const payload = {
                ...item.data,
                _rescuedFrom: item.worktree,
                _rescuedAt: new Date(now).toISOString(),
            };
            const target = reserveDescriptorPath(queueDir, issue, {
                fsImpl, now, mode: item.data.mode,
            });
            fsImpl.writeFileSync(target.path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
            // Recién después de escribir el destino borramos el origen: si el
            // unlink falla, peor caso es un duplicado, nunca una pérdida.
            try { fsImpl.unlinkSync(item.path); } catch { /* best-effort */ }
            result.rescued++;
            result.names.push(target.name);
            log(`descriptor Drive rescatado de worktree: ${item.name} -> ${target.name}`);
        } catch (e) {
            result.errors.push(`${item.name}: ${e.message}`);
            result.skipped++;
        }
    }
    if (result.diferidos > 0) {
        log(`Rescate: ${result.diferidos} descriptor(es) varado(s) quedan para la proxima corrida `
            + `(tope ${maxPerRun} por tanda); NO se descartaron`);
    }
    return result;
}

module.exports = {
    MAX_RESCUES_PER_RUN,
    REQUIRED_MODE,
    REQUIRED_SOURCE,
    resolveStateRoot,
    resolveRepoRoot,
    resolveDriveQueueDir,
    kindForMode,
    buildDescriptorName,
    reserveDescriptorPath,
    buildDescriptor,
    enqueueStructuralEvidence,
    listAgentWorktrees,
    findStrandedDescriptors,
    rescueStrandedDescriptors,
};
