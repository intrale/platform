// =============================================================================
// rollback-guard.js — Guard del auto-rollback del pipeline (issue #5723)
//
// Problema que resuelve (incidente 2026-08-09):
//   El auto-rollback asume que `pipeline-stable` es SIEMPRE un estado mejor
//   que HEAD. Cuando el fix de un bug del propio lifecycle ya está mergeado
//   en main pero el tag no avanzó, esa premisa se invierte: el rollback pasa
//   a ser el mecanismo que IMPIDE la recuperación. El 2026-08-09 se
//   revirtieron 22 archivos / 2407 líneas (fixes #5704 y #5687), volvió a
//   fallar por la misma causa y volvió a rollbackear. Dos ciclos completos
//   antes de la intervención manual, que siempre es el mismo comando:
//   `git tag -f pipeline-stable <sha-bueno>`.
//
// Decisión de producto (PO, #5723):
//   El guard NO es incondicional. En operación normal `pipeline-stable` es
//   siempre ancestro de HEAD, así que "ancestro + toca lifecycle → frenar"
//   aplicado literal desactivaría el rollback para todo cambio en los 4
//   archivos del lifecycle, incluido el caso legítimo de revertir un commit
//   malo recién mergeado. Redacción operativa acordada:
//     - 1er rollback hacia un target dado → revierte, pero logueando el
//       diffstat ANTES y alertando con el detalle de qué se pierde.
//     - 2do rollback consecutivo hacia el MISMO target sin smoke limpio en
//       el medio → frena, no revierte, y escala a needs-human.
//   N = 2 (CONSECUTIVE_THRESHOLD): el incidente del 2026-08-09 tuvo 2 ciclos
//   y el de svc-reconciler (2026-04-30) tuvo 3; cortar en el 2do evita ambos.
//
// Estado persistido: .pipeline/rollback-state.json (gitignored).
//   - Escritura atómica (.tmp + rename) igual que circuit-breaker-infra.js.
//   - Lectura defensiva: JSON corrupto → estado default, nunca throw.
//   - Vive FUERA del árbol versionado a propósito: el rollback hace
//     `git checkout <target> -- .pipeline/` y se llevaría puesto cualquier
//     estado versionado. Al estar gitignored el checkout no lo toca, pero
//     OJO: un `git clean -xdf` sí lo borra (se pierde el contador y el
//     próximo rollback vuelve a contar desde 1).
//   - Ventana de frescura (STALE_MS): si el último rollback es viejo,
//     asumimos que es otro incidente y el contador arranca de cero. Sin esto
//     un halt quedaría pegado para siempre, porque el restart relanzado por
//     el rollback corre con el código VIEJO (revertido) que no sabe resetear.
//
// Este módulo es lógica pura + IO de estado. Los comandos git de rollback.js
// los ejecuta rollback.js y le pasa los resultados, así todo lo que decide es
// testeable con `node --test`. La única excepción es
// `readDirtyPipelineCode()`, que sí corre un `git diff` acotado: vive acá —y no
// inline en restart.js— porque requerir restart.js dispara un restart real, y
// esa imposibilidad de testear fue exactamente por donde se coló el bloqueante 1
// de la review de #5723. El runner git es inyectable y `cwd` es parámetro, así
// que los tests lo ejercitan contra repos temporales de verdad.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'rollback-state.json');

/**
 * Archivos que gobiernan el ciclo de vida del pipeline. Si el rollback los
 * toca, está modificando el mecanismo mismo de arranque/recuperación: es el
 * escenario donde un rollback puede volverse auto-destructivo.
 * Paths relativos a la raíz del repo (formato de `git diff --name-only`).
 */
const LIFECYCLE_FILES = [
    '.pipeline/restart.js',
    '.pipeline/pulpo.js',
    '.pipeline/watchdog.ps1',
    '.pipeline/smoke-test.js',
];

// -----------------------------------------------------------------------------
// Clasificación código vs estado runtime (#5723 — bloqueante 1 de la review)
//
// `moveStableTag()` no debe taggear como estable un árbol cuyo CÓDIGO en disco
// no es el de HEAD (el estado típico post-rollback). Pero la detección ingenua
// `git diff --name-only HEAD -- .pipeline/` es inservible: `.pipeline/` tiene
// archivos de estado runtime TRACKEADOS que el propio pipeline reescribe
// mientras corre, así que el árbol está sucio SIEMPRE y el tag no avanzaría
// nunca — justo la condición que causó el incidente del 2026-08-09, vuelta
// permanente por diseño.
//
// Criterio (asimétrico a propósito, fail-closed hacia "es código"):
//   1. Si la extensión es de código ejecutable → CÓDIGO. Gana sobre todo lo
//      demás: un .js nuevo dentro de un dir de estado sigue siendo código.
//      Esto es lo que impide que la lista abra la puerta a saltear cambios de
//      código reales.
//   2. Si está en la lista explícita de estado runtime → ESTADO.
//   3. Si cuelga de un dir que sólo contiene estado/artefactos → ESTADO.
//   4. Cualquier otra cosa → DESCONOCIDO, y cuenta como sucio. Un archivo de
//      config nuevo (agent-models.json, priority-windows.json…) frena el tag
//      hasta que alguien lo clasifique a mano, que es el lado seguro del error.
// -----------------------------------------------------------------------------

/**
 * Extensiones que SIEMPRE son código/config ejecutable del pipeline.
 * Tienen prioridad sobre RUNTIME_STATE_FILES y RUNTIME_STATE_DIRS.
 */
const PIPELINE_CODE_EXTENSIONS = new Set([
    '.js', '.cjs', '.mjs', '.ps1', '.sh', '.bat', '.yaml', '.yml',
]);

/**
 * Archivos de estado runtime TRACKEADOS que el pipeline reescribe en caliente.
 * Verificado sobre el repo vivo el 2026-08-10: `git diff --name-only HEAD --
 * .pipeline/` los devuelve segundos después de cada boot.
 * (Muchos otros ya están gitignored y por eso nunca aparecen en el diff.)
 */
const RUNTIME_STATE_FILES = new Set([
    '.pipeline/credential-reminder-state.json',
    '.pipeline/issue-manual-order.json',
    '.pipeline/metrics-history.jsonl',
    '.pipeline/partial-pause-deps-cache.json',
    '.pipeline/process-transitions.jsonl',
    '.pipeline/runtime-boot.json',
    '.pipeline/skill-profiles.json',
    '.pipeline/telegram-health.json',
]);

/**
 * Directorios que sólo contienen estado runtime: colas de trabajo, snapshots,
 * evidencia y artefactos generados. No hay código adentro (verificado con
 * `git ls-files ... | grep -E '\.(js|ps1|sh)$'` → vacío), y si algún día lo
 * hubiera, la regla 1 (extensión) lo sigue clasificando como código.
 */
const RUNTIME_STATE_DIRS = [
    '.pipeline/state/',
    '.pipeline/logs/',
    '.pipeline/audit/',
    '.pipeline/handoff/',
    '.pipeline/sessions/',
    '.pipeline/deliverables/',
    '.pipeline/servicios/',
    '.pipeline/desarrollo/',
    '.pipeline/definicion/',
];

/** Normalizar un path al formato de `git diff --name-only` (slashes unix). */
function normalizeRepoPath(file) {
    return String(file == null ? '' : file).trim().replace(/\\/g, '/');
}

/**
 * Clasificar un archivo cambiado bajo `.pipeline/`.
 * @returns {'code'|'runtime-state'|'unknown'}
 */
function classifyPipelineChange(file) {
    const f = normalizeRepoPath(file);
    if (!f) return 'unknown';

    // 1. La extensión manda: código es código esté donde esté.
    const dot = f.lastIndexOf('.');
    const slash = f.lastIndexOf('/');
    const ext = dot > slash ? f.slice(dot).toLowerCase() : '';
    if (PIPELINE_CODE_EXTENSIONS.has(ext)) return 'code';

    // 2. Lista explícita de estado runtime.
    if (RUNTIME_STATE_FILES.has(f)) return 'runtime-state';

    // 3. Dirs que sólo contienen estado runtime.
    if (RUNTIME_STATE_DIRS.some((d) => f.startsWith(d))) return 'runtime-state';

    // 4. Fail-closed: lo que no sabemos clasificar cuenta como sucio.
    return 'unknown';
}

/**
 * Filtrar una lista de archivos cambiados dejando sólo los que deben frenar el
 * avance de `pipeline-stable` (código + desconocidos). El estado runtime se
 * descarta porque cambia solo, sin que nadie haya tocado el código.
 */
function filterRelevantChanges(changedFiles) {
    if (!Array.isArray(changedFiles)) return [];
    return changedFiles
        .map(normalizeRepoPath)
        .filter(Boolean)
        .filter((f) => classifyPipelineChange(f) !== 'runtime-state');
}

/**
 * Runner git por defecto. Único punto del módulo que toca el proceso; existe
 * para que `readDirtyPipelineCode()` sea invocable sin plomería desde
 * restart.js y, a la vez, ejercitable de verdad desde los tests apuntando
 * `cwd` a un repo git temporal.
 */
function defaultGitRunner(cmd, cwd) {
    // require perezoso: mantiene el módulo cargable en contextos sin child_process.
    const { execSync } = require('child_process');
    return execSync(cmd, { cwd, encoding: 'utf8', timeout: 10000, windowsHide: true });
}

/**
 * Leer qué archivos de `.pipeline/` difieren de HEAD en el árbol de trabajo y
 * separarlos en CÓDIGO (frena el avance de `pipeline-stable`) vs ESTADO RUNTIME
 * (no frena nada: el pipeline lo reescribe solo en cada boot).
 *
 * Vive acá y no inline en restart.js por el bloqueante 1 de la review de #5723:
 * la versión inline no tenía forma de testearse — requerir restart.js dispara
 * un restart real — y el bug se coló justamente ahí. Con esto los tests
 * ejercitan el MISMO código que corre en producción, contra git de verdad.
 *
 * @param {{cwd?: string, run?: (cmd: string, cwd: string) => string}} opts
 * @returns {{all: string[], relevant: string[], readFailed: boolean}}
 *   - `all`: todo lo que difiere de HEAD bajo `.pipeline/`.
 *   - `relevant`: sólo lo que debe frenar el tag (código + no clasificados).
 *   - `readFailed`: true si git no respondió. El llamador debe tratarlo como
 *     "no sé" y NO como "está limpio" ni como "está sucio".
 */
function readDirtyPipelineCode(opts = {}) {
    const cwd = opts.cwd || process.cwd();
    const run = typeof opts.run === 'function' ? opts.run : defaultGitRunner;
    let out;
    try {
        out = run('git diff --name-only HEAD -- .pipeline/', cwd);
    } catch {
        return { all: [], relevant: [], readFailed: true };
    }
    const all = String(out == null ? '' : out)
        .trim()
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    return { all, relevant: filterRelevantChanges(all), readFailed: false };
}

/** Rollbacks consecutivos hacia el mismo target que se toleran antes de cortar. */
const CONSECUTIVE_THRESHOLD = 2;

/** Ventana de frescura del contador: más viejo que esto → otro incidente. */
const STALE_MS = 6 * 60 * 60 * 1000;

function defaultState() {
    return {
        consecutive: 0,
        last_target: null,
        last_at: null,
        halted: false,
        halted_at: null,
        last_reason: null,
    };
}

/**
 * Lectura defensiva. Nunca lanza: si el archivo no existe, está corrupto o
 * tiene un shape inesperado devolvemos el default. Un rollback no puede
 * fallar por un JSON truncado.
 */
function readState(file = STATE_FILE) {
    try {
        if (!fs.existsSync(file)) return defaultState();
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultState();
        return { ...defaultState(), ...parsed };
    } catch {
        return defaultState();
    }
}

/** Escritura atómica (.tmp + rename). Devuelve el estado escrito. */
function writeState(state, file = STATE_FILE) {
    const next = { ...defaultState(), ...state };
    const tmp = file + '.tmp';
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
        fs.renameSync(tmp, file);
    } catch {
        // Si no podemos persistir seguimos igual: el guard degrada a
        // "primer intento" en vez de bloquear el rollback por un fallo de IO.
        try { fs.unlinkSync(tmp); } catch {}
    }
    return next;
}

/**
 * Resetear el contador. Se llama cuando un smoke test pasa limpio: eso
 * significa que el pipeline está sano y la cadena de rollbacks se cortó.
 */
function clearState(file = STATE_FILE) {
    try {
        if (!fs.existsSync(file)) return false; // no había racha que cortar
        fs.unlinkSync(file);
        return true;
    } catch {
        return false;
    }
}

/** ¿El diff a revertir toca alguno de los archivos del lifecycle? */
function touchesLifecycle(changedFiles) {
    if (!Array.isArray(changedFiles)) return false;
    const lifecycle = new Set(LIFECYCLE_FILES);
    return changedFiles.some((f) => lifecycle.has(String(f).trim().replace(/\\/g, '/')));
}

/**
 * Decidir si el rollback procede o se frena.
 *
 * @param {object} opts
 * @param {string} opts.targetSha        SHA resuelto del target
 * @param {string} opts.headSha          SHA de HEAD
 * @param {boolean} opts.isAncestor      target es ancestro de HEAD
 * @param {boolean} opts.lifecycleTouched el diff target..HEAD toca lifecycle
 * @param {object} [opts.state]          estado previo (readState())
 * @param {number} [opts.now]            timestamp (ms) para tests
 * @param {number} [opts.threshold]      default CONSECUTIVE_THRESHOLD
 * @param {number} [opts.staleMs]        default STALE_MS
 * @returns {{action:'proceed'|'halt', attempt:number, severity:'warn'|'critical',
 *            sameTarget:boolean, stale:boolean, reason:string, nextState:object}}
 */
function decide(opts) {
    const {
        targetSha = null,
        headSha = null,
        isAncestor = false,
        lifecycleTouched = false,
        state = null,
        now = Date.now(),
        threshold = CONSECUTIVE_THRESHOLD,
        staleMs = STALE_MS,
    } = opts || {};

    const prev = { ...defaultState(), ...(state || {}) };
    const lastAtMs = prev.last_at ? Date.parse(prev.last_at) : NaN;
    const stale = !Number.isFinite(lastAtMs) || now - lastAtMs > staleMs;

    const prevConsecutive = stale ? 0 : Number(prev.consecutive) || 0;
    const sameTarget = !stale && !!prev.last_target && !!targetSha && prev.last_target === targetSha;

    // Intento hacia ESTE target (el criterio del PO) y racha total de
    // rollbacks sin smoke limpio (el criterio literal del CA-4). Frenamos
    // con el que se cumpla primero.
    const attemptSameTarget = sameTarget ? prevConsecutive + 1 : 1;
    const attemptAny = prevConsecutive + 1;

    // El rollback contra un target que NO es ancestro de HEAD es el caso
    // "avanzar/divergir": no puede estar borrando commits que HEAD ya tiene,
    // así que no es el escenario auto-destructivo del issue.
    const selfDestructive = isAncestor && lifecycleTouched;
    const severity = selfDestructive ? 'critical' : 'warn';

    const halted = !stale && prev.halted === true;
    let action = 'proceed';
    let reason = '';

    if (halted) {
        action = 'halt';
        reason = 'El rollback ya había quedado frenado y todavía no pasó ningún smoke test limpio.';
    } else if (attemptSameTarget >= threshold) {
        action = 'halt';
        reason = `Es el ${attemptSameTarget}º rollback seguido hacia el mismo punto sin que el smoke test pase en el medio: revertir otra vez borraría los mismos cambios y volveríamos a caer igual.`;
    } else if (attemptAny > threshold) {
        action = 'halt';
        reason = `Van ${attemptAny} rollbacks seguidos sin ningún smoke test limpio en el medio: el pipeline no se está recuperando solo.`;
    } else if (selfDestructive) {
        reason = 'El punto al que se vuelve es anterior a lo que hay hoy y el rollback toca los archivos que gobiernan el arranque del pipeline: si alguno de esos commits era el fix del problema actual, este rollback lo borra.';
    } else {
        reason = 'Rollback normal: se revierte y se avisa qué se pierde.';
    }

    const attempt = Math.max(attemptSameTarget, sameTarget ? attemptAny : 1);

    return {
        action,
        attempt,
        attemptSameTarget,
        attemptAny,
        severity,
        sameTarget,
        stale,
        selfDestructive,
        reason,
        nextState: {
            consecutive: attemptAny,
            last_target: targetSha,
            last_head: headSha,
            last_at: new Date(now).toISOString(),
            halted: action === 'halt',
            halted_at: action === 'halt' ? new Date(now).toISOString() : null,
            last_reason: reason,
        },
    };
}

// --- Parsing de salidas de git -------------------------------------------

/**
 * Parsea `git diff --shortstat`:
 *   " 22 files changed, 124 insertions(+), 2407 deletions(-)"
 * Devuelve null si no matchea nada (diff vacío).
 */
function parseShortstat(text) {
    if (!text || typeof text !== 'string') return null;
    const files = /(\d+) files? changed/.exec(text);
    const ins = /(\d+) insertions?\(\+\)/.exec(text);
    const del = /(\d+) deletions?\(-\)/.exec(text);
    if (!files && !ins && !del) return null;
    return {
        files: files ? Number(files[1]) : 0,
        insertions: ins ? Number(ins[1]) : 0,
        deletions: del ? Number(del[1]) : 0,
    };
}

/** Texto humano del shortstat, en unidades que el operador entiende (G-2). */
function formatShortstat(stat) {
    if (!stat) return 'sin cambios de archivos';
    const partes = [`${stat.files} archivo${stat.files === 1 ? '' : 's'}`];
    if (stat.insertions) partes.push(`+${stat.insertions}`);
    if (stat.deletions) partes.push(`-${stat.deletions}`);
    return partes.join(', ') + (stat.insertions || stat.deletions ? ' líneas' : '');
}

/**
 * Parsea `git log --oneline --no-decorate <target>..HEAD`.
 * Devuelve [{ sha, subject }].
 */
function parseCommitList(text) {
    if (!text || typeof text !== 'string') return [];
    return text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
            const m = /^([0-9a-f]{7,40})\s+(.*)$/i.exec(l);
            return m ? { sha: m[1], subject: m[2] } : { sha: '', subject: l };
        });
}

/**
 * Issues referenciados en los commits que se están por revertir. Sirven para
 * aplicar `needs-human`: son exactamente los issues cuyos cambios quedaron
 * atrapados en el bucle de rollback.
 *
 * Orden de preferencia, porque no todo `#N` es un issue:
 *   1. `Closes/Fixes/Resolves #N` del body — es el issue de verdad.
 *   2. `agent/<N>-<slug>` — la convención de ramas del pipeline.
 *   3. Cualquier `#N` suelto — último recurso: en los merges squash el `#N`
 *      del subject es el número del PR, no el del issue. Sirve igual para que
 *      el humano llegue al cambio, pero es menos preciso.
 *
 * Acepta texto crudo del git log o la lista parseada de commits.
 */
function extractIssueRefs(input, max = 5) {
    let texto = '';
    if (typeof input === 'string') texto = input;
    else if (Array.isArray(input)) {
        texto = input.map((c) => (typeof c === 'string' ? c : [c && c.subject, c && c.body].filter(Boolean).join('\n'))).join('\n');
    }
    if (!texto) return [];

    const recoger = (regex) => {
        const found = [];
        for (const m of texto.matchAll(regex)) {
            const n = Number(m[1]);
            if (n > 0 && !found.includes(n)) found.push(n);
        }
        return found;
    };

    const preferidos = [
        ...recoger(/\b(?:closes|close|closed|fixes|fix|fixed|resolves|resolve|resolved)\s+#(\d{1,7})\b/gi),
        ...recoger(/\bagent\/(\d{1,7})-/gi),
    ];
    const unicos = [...new Set(preferidos.length ? preferidos : recoger(/#(\d{1,7})\b/g))];
    return unicos.slice(0, max);
}

// --- Mensajes al operador (guidelines UX G-1..G-4) ------------------------

/**
 * Markdown de Telegram es frágil: un `*` o un backtick suelto en el subject
 * de un commit rompe el render y el mensaje llega crudo o no llega.
 */
function sanitizeForMarkdown(text) {
    return String(text || '').replace(/[*_`[\]]/g, '').replace(/\s+/g, ' ').trim();
}

function short(sha) {
    return String(sha || '').slice(0, 8) || 'desconocido';
}

function formatCommitLines(commits, max = 5) {
    const list = (commits || []).slice(0, max);
    if (!list.length) return '';
    const lines = list.map((c) => `• ${sanitizeForMarkdown(c.subject)}`);
    const resto = (commits || []).length - list.length;
    if (resto > 0) lines.push(`• …y ${resto} commit${resto === 1 ? '' : 's'} más`);
    return lines.join('\n');
}

/**
 * G-1: el tono sigue a la consecuencia, no al exit code. Un rollback que
 * revierte commits nunca es un ✅.
 * G-2: decir qué se perdió en unidades que el operador entiende + traer
 * escrito el comando de destrabe (siempre es el mismo).
 * El texto solo tiene que alcanzar sin los emoji (accesibilidad).
 */
function buildProceedAlert(ctx) {
    const { target = 'pipeline-stable', targetSha, headSha, severity = 'warn', commits = [], shortstat = null } = ctx || {};
    const icon = severity === 'critical' ? '🚨' : '⚠️';
    const n = commits.length;
    const cabecera = n
        ? `${icon} *Rollback ejecutado — se revirtieron ${n} commit${n === 1 ? '' : 's'}.*`
        : `${icon} *Rollback ejecutado.*`;

    const partes = [
        cabecera,
        `Volviste de \`${short(headSha)}\` a \`${short(targetSha)}\` (\`${target}\`).`,
    ];
    const lista = formatCommitLines(commits);
    if (lista) partes.push(`Commits revertidos:\n${lista}`);
    if (shortstat) partes.push(`Cambios revertidos: ${formatShortstat(shortstat)}.`);
    if (severity === 'critical') {
        partes.push('Ojo: esto tocó los archivos que gobiernan el arranque del pipeline. Si alguno de esos commits era el fix del problema actual, el rollback lo acaba de borrar.');
    }
    partes.push(`Si era el fix, el tag quedó atrás — se destraba así:\n\`git tag -f pipeline-stable <sha-bueno> && git push origin --force pipeline-stable\``);
    return partes.join('\n\n');
}

/**
 * G-3 + G-4: cuando el guard frena, el operador necesita en el primer renglón
 * qué se frenó, por qué y qué hacer. Sin jerga de implementación. Y tiene que
 * distinguirse de las alertas rutinarias: el pipeline quedó detenido y no se
 * recupera solo.
 */
function buildHaltAlert(ctx) {
    const {
        target = 'pipeline-stable',
        targetSha,
        headSha,
        reason = '',
        commits = [],
        shortstat = null,
        issues = [],
    } = ctx || {};

    const partes = [
        '🚨 *Pipeline detenido: el rollback automático se frenó solo.*',
        reason,
        `Se iba a volver de \`${short(headSha)}\` a \`${short(targetSha)}\` (\`${target}\`).`,
    ];
    const lista = formatCommitLines(commits);
    if (lista) partes.push(`Lo que se iba a perder:\n${lista}`);
    if (shortstat) partes.push(`Alcance: ${formatShortstat(shortstat)}.`);
    partes.push('El pipeline queda detenido y no se va a recuperar solo. Hace falta que mires vos.');
    partes.push(
        'Qué hacer:\n' +
        '1. Revisar el detalle en `.pipeline/logs/rollback.log`.\n' +
        '2. Si el fix ya está en main: `git tag -f pipeline-stable <sha-bueno> && git push origin --force pipeline-stable`.\n' +
        '3. Reiniciar con `node .pipeline/restart.js`. Un smoke test limpio destraba el corte solo.'
    );
    if (issues.length) {
        partes.push(`Marcados con needs-human: ${issues.map((i) => `#${i}`).join(', ')}.`);
    }
    return partes.join('\n\n');
}

module.exports = {
    STATE_FILE,
    LIFECYCLE_FILES,
    PIPELINE_CODE_EXTENSIONS,
    RUNTIME_STATE_FILES,
    RUNTIME_STATE_DIRS,
    classifyPipelineChange,
    filterRelevantChanges,
    readDirtyPipelineCode,
    CONSECUTIVE_THRESHOLD,
    STALE_MS,
    defaultState,
    readState,
    writeState,
    clearState,
    touchesLifecycle,
    decide,
    parseShortstat,
    formatShortstat,
    parseCommitList,
    extractIssueRefs,
    sanitizeForMarkdown,
    buildProceedAlert,
    buildHaltAlert,
};
