'use strict';

// =============================================================================
// operativo-drift.js — Detección de cambios del MODELO OPERATIVO entregados a
// `main` pero aún no aplicados al runtime vivo (#4460, corazón del issue).
// -----------------------------------------------------------------------------
// Compara `bootSha..origin/main` (bootSha = HEAD con el que arrancó el runtime,
// leído del trust anchor `runtime-boot.json`). Los commits en ese rango que
// tocan paths del modelo operativo (`.pipeline/**`, `.claude/hooks/**`) →
// "pendientes de aplicar" (requieren restart para tomar efecto). Los que sólo
// tocan producto (`app/**`, `backend/**`, ...) NO disparan restart del pipeline.
//
// Contrato de seguridad:
//   - REQ-SEC-4460-2 (command injection): `bootSha` es dato NO confiable (viene
//     del FS). Se valida contra /^[0-9a-f]{7,40}$/ ANTES de usarlo, y `git` se
//     ejecuta con `execFileSync('git', [args...])` (array de args, NUNCA shell
//     string). Un `runtime-boot.json` con `{"sha":"HEAD; rm -rf ."}` no llega
//     jamás a un shell — además la validación lo rechaza antes.
//   - REQ-SEC-4460-5 (integridad): bootSha inválido/vacío → `{items:[], unknown:true}`
//     ("estado desconocido"), nunca `{items:[]}` a secas (que se leería como "todo
//     al día") ni un throw.
//   - CA-4 (clasificación): allowlist explícita deny-by-default. Path desconocido
//     → producto → no ofrece restart. Evita falsos positivos que "entrenen" al
//     operador a ignorar el botón.
//
// Rendimiento: `git log` por request satura el endpoint → cache TTL (patrón
// `dashboard-slices.js` skillSpark24h). El cache se llavea por bootSha para que
// un avance del marker (post-restart) invalide naturalmente.
// =============================================================================

const path = require('path');
const { execFileSync } = require('node:child_process');

// SHA hex short (7) → full (40). Frontera de validación del dato no confiable.
const SHA_RE = /^[0-9a-f]{7,40}$/;

// Allowlist deny-by-default del modelo operativo (REQ-SEC-4460 / guru CA-4).
// Un path que empieza con alguno de estos prefijos requiere restart del
// pipeline. Todo lo demás (incluido lo desconocido) es "producto".
const OPERATIVO_PREFIXES = [
    '.pipeline/',
    '.claude/hooks/',
];

// Mapa prefijo → etiqueta humana de componente (para el tooltip / motivo). Se
// evalúa en orden; el primer match gana. Sólo etiquetas cortas, sin paths.
const COMPONENTE_LABELS = [
    { prefix: '.pipeline/dashboard.js', label: 'dashboard' },
    { prefix: '.pipeline/lib/dashboard', label: 'dashboard' },
    { prefix: '.pipeline/views/dashboard', label: 'dashboard' },
    { prefix: '.pipeline/pulpo.js', label: 'pulpo' },
    { prefix: '.pipeline/restart.js', label: 'restart' },
    { prefix: '.pipeline/servicios/', label: 'servicios' },
    { prefix: '.claude/hooks/', label: 'hooks' },
    { prefix: '.pipeline/', label: 'pipeline' },
];

const CACHE_TTL_MS = 45 * 1000; // 30–60s (patrón dashboard-slices)
let _cache = { key: null, at: 0, data: null };

/**
 * Clasifica un path como 'operativo' (requiere restart) o 'producto'.
 * Deny-by-default: cualquier path fuera de la allowlist es 'producto'.
 * @param {string} file — path relativo al repo (forward slashes).
 * @returns {'operativo'|'producto'}
 */
function classifyPath(file) {
    if (typeof file !== 'string' || !file) return 'producto';
    // Normalizar backslashes de Windows a forward slashes para el match.
    const f = file.replace(/\\/g, '/');
    return OPERATIVO_PREFIXES.some((p) => f.startsWith(p)) ? 'operativo' : 'producto';
}

// Etiqueta de componente humana para un path operativo (sin exponer el path).
function componenteFor(file) {
    const f = String(file || '').replace(/\\/g, '/');
    for (const { prefix, label } of COMPONENTE_LABELS) {
        if (f.startsWith(prefix)) return label;
    }
    return 'pipeline';
}

// Parsea el/los `Closes #N` (o Fixes/Resolves #N) del subject/body del commit.
// GitHub también inyecta `(#N)` en el subject del merge-squash. Devuelve el
// primer issue# encontrado, o null.
function parseIssueRef(subject) {
    if (typeof subject !== 'string') return null;
    // Prioridad 1: keyword de cierre (closes/fixes/resolves #N).
    const kw = subject.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i);
    if (kw) return Number(kw[1]);
    // Prioridad 2: `(#N)` que GitHub agrega al squash-merge.
    const paren = subject.match(/\(#(\d+)\)/);
    if (paren) return Number(paren[1]);
    // Prioridad 3: cualquier #N suelto.
    const loose = subject.match(/#(\d+)/);
    if (loose) return Number(loose[1]);
    return null;
}

/**
 * Refresca `refs/remotes/origin/main` best-effort (#4460 fix rebote rev-1).
 * Sin esto, `git log bootSha..origin/main` compararía contra un `origin/main`
 * potencialmente stale (el runtime vivo no fetchea solo) → falso negativo de
 * CA-1 para entregas recién mergeadas. NUNCA lanza: si no hay red/remoto, se
 * usa el `origin/main` que ya haya en local. `execFile('git', [args])`, sin
 * shell (REQ-SEC-4460-2). Timeout corto para no colgar el request.
 * @param {string} repoRoot
 */
function _fetchOriginMain(repoRoot) {
    try {
        execFileSync('git', ['fetch', 'origin', 'main', '--quiet'], {
            cwd: repoRoot, encoding: 'utf8', timeout: 15000, windowsHide: true,
        });
    } catch {
        // best-effort: sin remoto/red se sigue con el origin/main local.
    }
}

/**
 * Corre `git log <bootSha>..origin/main --name-only` y parsea commits→archivos.
 * Formato: `%H\x1f%s` por commit, seguido de los archivos (--name-only), líneas
 * en blanco separan commits. Usa \x1f (unit separator) como delim intra-línea.
 *
 * @param {string} bootSha — YA validado hex por el caller.
 * @param {string} repoRoot
 * @returns {Array<{sha:string, subject:string, files:string[]}>}
 */
function _gitLogRange(bootSha, repoRoot) {
    let out;
    try {
        out = execFileSync(
            'git',
            ['log', `${bootSha}..origin/main`, '--name-only', '--format=%H%x1f%s', '--no-color'],
            { cwd: repoRoot, encoding: 'utf8', timeout: 15000, windowsHide: true }
        );
    } catch {
        // bootSha desconocido para git (ej. commit local no en origin), rango
        // inválido, o git no disponible → sin datos. El caller decide unknown.
        return null;
    }
    const commits = [];
    let current = null;
    for (const line of out.split('\n')) {
        if (line.indexOf('\x1f') !== -1) {
            // Cabecera de commit: <sha>\x1f<subject>
            const idx = line.indexOf('\x1f');
            if (current) commits.push(current);
            current = { sha: line.slice(0, idx), subject: line.slice(idx + 1), files: [] };
        } else if (line.trim() !== '' && current) {
            current.files.push(line.trim());
        }
    }
    if (current) commits.push(current);
    return commits;
}

/**
 * Detecta los issues del modelo operativo entregados a `main` pero no aplicados
 * al runtime vivo.
 *
 * @param {object} params — { bootSha, pipelineDir, repoRoot, now }.
 *   - bootSha: SHA del runtime vivo (de runtime-boot.readBootMarker). Puede ser
 *     null/inválido → devuelve `{items:[], unknown:true}`.
 *   - repoRoot: raíz del repo git (default: parent de pipelineDir o de este lib).
 * @returns {{ items: Array<{issue:number|null, componente:string, motivo:string}>,
 *             unknown: boolean }}
 */
function detectPendingRestart(params) {
    const p = params || {};
    const bootSha = p.bootSha;
    const now = typeof p.now === 'number' ? p.now : Date.now();

    // REQ-SEC-4460-5: bootSha ausente/inválido → estado DESCONOCIDO. Nunca
    // asumir "sin pendientes" (el operador podría correr código viejo creyendo
    // estar al día).
    if (typeof bootSha !== 'string' || !SHA_RE.test(bootSha)) {
        return { items: [], unknown: true };
    }

    // Cache por bootSha (un avance del marker invalida naturalmente).
    if (_cache.data && _cache.key === bootSha && (now - _cache.at) < CACHE_TTL_MS) {
        return _cache.data;
    }

    const repoRoot = _resolveRepoRoot(p);
    // SECUNDARIO (#4460 fix rebote rev-1): el runtime vivo NO hace fetch
    // periódico, así que `origin/main` en el repo local puede estar stale y una
    // entrega recién mergeada sería invisible al detector → falso negativo de
    // CA-1. Refrescamos `origin/main` best-effort ANTES del rango. Está gateado
    // por el cache TTL (sólo corre en cache-miss, ≤1 fetch / TTL), así que no
    // satura. Inyectable/desactivable por test con `p.skipFetch`.
    if (!p.skipFetch) _fetchOriginMain(repoRoot);
    const commits = _gitLogRange(bootSha, repoRoot);
    if (commits === null) {
        // git falló (rango inválido, sha no alcanzable) → desconocido, no mentir.
        const res = { items: [], unknown: true };
        _cache = { key: bootSha, at: now, data: res };
        return res;
    }

    // Agrupar por issue (o por sha si no hay issue): un issue puede tocar varios
    // archivos operativos; se reporta una sola vez con su componente principal.
    const byKey = new Map();
    for (const c of commits) {
        const operativoFiles = (c.files || []).filter((f) => classifyPath(f) === 'operativo');
        if (operativoFiles.length === 0) continue; // sólo producto → no dispara

        const issue = parseIssueRef(c.subject);
        const componente = componenteFor(operativoFiles[0]);
        const key = issue != null ? `issue:${issue}` : `sha:${c.sha}`;
        if (byKey.has(key)) {
            // Ya registrado; agregamos componentes distintos al motivo si aporta.
            const prev = byKey.get(key);
            if (!prev._componentes.has(componente)) prev._componentes.add(componente);
            continue;
        }
        byKey.set(key, {
            issue,
            _componentes: new Set([componente]),
        });
    }

    const items = [];
    for (const v of byKey.values()) {
        const comps = Array.from(v._componentes);
        const componente = comps[0];
        const extra = comps.length > 1 ? ` (+${comps.length - 1})` : '';
        const motivo = `tocó ${comps.join(', ')}`;
        items.push({
            issue: v.issue,
            componente: componente + extra,
            motivo,
        });
    }

    const res = { items, unknown: false };
    _cache = { key: bootSha, at: now, data: res };
    return res;
}

function _resolveRepoRoot(p) {
    if (p && typeof p.repoRoot === 'string' && p.repoRoot) return p.repoRoot;
    if (p && typeof p.pipelineDir === 'string' && p.pipelineDir) {
        return path.resolve(p.pipelineDir, '..');
    }
    return path.resolve(__dirname, '..', '..');
}

// Invalidación manual del cache (tests / tras restart).
function _clearCache() {
    _cache = { key: null, at: 0, data: null };
}

module.exports = {
    detectPendingRestart,
    classifyPath,
    componenteFor,
    parseIssueRef,
    OPERATIVO_PREFIXES,
    SHA_RE,
    CACHE_TTL_MS,
    _gitLogRange,
    _fetchOriginMain,
    _clearCache,
};
