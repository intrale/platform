'use strict';

// =============================================================================
// repo-probe.js — Prueba de alcance real de un repo/tablero (CA-2 · #4801).
//
// QUÉ RESUELVE
// ------------
// El bootstrap de onboarding (`project-bootstrap.verifyAccess`) valida la FORMA de
// las URLs del descriptor contra una allowlist anti-SSRF, pero deja la prueba de
// alcance REAL como `deps.probeAccess` inyectable. Hasta #4801 ese hook nunca se
// cableaba: `reachable` quedaba en `null` y todo host allowlisted se trataba como
// accesible. Este módulo implementa ese `probeAccess` con least-privilege.
//
// SEGURIDAD (A10 · SSRF — vector principal del issue)
// ---------------------------------------------------
//   - Delega SIEMPRE la forma/host en `project-bootstrap.assertUrlAllowed` ANTES de
//     tocar la red: sólo `https:`, sólo hosts allowlisted (github.com/api.github.com),
//     sin credenciales embebidas, sin IP privada/loopback/link-local/CGNAT/metadata.
//   - NO hace `fetch`/`http.get` crudo de la URL del operador. La prueba de alcance
//     se hace con `gh repo view <owner>/<repo>` (menor superficie SSRF: `gh` habla
//     con `api.github.com`, no sigue redirects hacia hosts arbitrarios).
//   - Defensa DNS-rebinding: re-chequea el host contra `isPrivateOrLoopbackHost`
//     además de la allowlist (defensa de forma redundante; no re-resuelve a IP).
//   - Fail-closed en el guard de forma (URL hostil ⇒ `false`, sin conexión). En la
//     prueba de alcance es tolerante a fallas de infra del propio `gh` (ver abajo):
//     un `gh` ausente/timeout NO bloquea un alta cuyo host ya pasó la allowlist;
//     sólo un "repo inexistente" definitivo devuelve `false`.
// =============================================================================

const { execFileSync } = require('node:child_process');

const bootstrap = require('./project-bootstrap');

// Patrones de stderr de `gh` que indican un repo DEFINITIVAMENTE inaccesible
// (no error de infra). Sólo estos devuelven `false` en la prueba de alcance.
const NOT_FOUND_RE = /could not resolve to a repository|not found|404|HTTP 404|no se encontr/i;

/**
 * Extrae `owner/repo` de una URL de repositorio GitHub. Devuelve null si la URL
 * no tiene la forma `https://github.com/<owner>/<repo>` (ej. una URL de Project
 * `/orgs/x/projects/1` no es un repo).
 * @param {string} rawUrl
 * @returns {string|null}
 */
function parseRepoSlug(rawUrl) {
    let u;
    try { u = new URL(String(rawUrl)); } catch { return null; }
    // Segmentos no vacíos del path.
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    let repo = parts[1];
    // Un tablero (`orgs/<org>/projects/<n>`) no es un repo.
    if (owner === 'orgs' || owner === 'users') return null;
    repo = repo.replace(/\.git$/i, '');
    // owner/repo con caracteres seguros de GitHub (evita inyección al arg de gh).
    if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
    return `${owner}/${repo}`;
}

/**
 * Ejecuta `gh repo view <slug>` de forma acotada. Devuelve:
 *   - { reachable: true }                 exit 0 (repo accesible)
 *   - { reachable: false }                stderr con patrón de "no encontrado"
 *   - { reachable: true, indeterminate }  cualquier otro fallo (gh ausente/timeout/
 *                                          red) — no bloquea el alta (host ya allowlisted)
 */
function defaultGhExec(slug) {
    try {
        execFileSync('gh', ['repo', 'view', slug, '--json', 'name'], {
            timeout: 8000,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
            encoding: 'utf8',
        });
        return { reachable: true };
    } catch (e) {
        const stderr = String((e && e.stderr) || (e && e.message) || '');
        if (NOT_FOUND_RE.test(stderr)) return { reachable: false };
        // gh ausente (ENOENT), timeout o error de red ⇒ indeterminado: no se
        // bloquea un host ya validado por la allowlist (evita falsos rechazos).
        return { reachable: true, indeterminate: true };
    }
}

/**
 * Prueba que un target (`{ kind, id, url }`) sea accesible con least-privilege.
 * Contrato compatible con `verifyAccess`/`deps.probeAccess`.
 *
 * @param {{kind?:string,id?:string,url:string}|string} target
 * @param {object} [deps]  { assertUrlAllowed, isPrivateOrLoopbackHost, ghExec }
 * @returns {boolean} true sólo si el host pasó la allowlist Y el alcance no dio
 *                    un "no encontrado" definitivo.
 */
function probeAccess(target, deps = {}) {
    const url = (target && typeof target === 'object') ? target.url : target;
    const kind = (target && typeof target === 'object' && target.kind) ? target.kind : 'repo';

    const assertUrlAllowed = typeof deps.assertUrlAllowed === 'function'
        ? deps.assertUrlAllowed : bootstrap.assertUrlAllowed;
    const isPrivate = typeof deps.isPrivateOrLoopbackHost === 'function'
        ? deps.isPrivateOrLoopbackHost : bootstrap.isPrivateOrLoopbackHost;

    // Guard de forma anti-SSRF (fail-closed). NUNCA se toca la red si no pasa.
    const guard = assertUrlAllowed(url);
    if (!guard.allowed) return false;
    // Defensa DNS-rebinding redundante: el host jamás debe resolver a interno.
    if (guard.host && isPrivate(guard.host)) return false;

    // El tablero (Project) no es un repo: la allowlist ya es prueba suficiente de
    // forma; no hay `gh repo view` que correr. Se acepta el host allowlisted.
    if (kind !== 'repo') return true;

    const slug = parseRepoSlug(url);
    if (!slug) return false; // URL de repo malformada ⇒ no alcanzable.

    const ghExec = typeof deps.ghExec === 'function' ? deps.ghExec : defaultGhExec;
    let res;
    try { res = ghExec(slug); } catch { return true; } // fallo de infra ⇒ no bloquea
    return !!(res && res.reachable);
}

module.exports = {
    probeAccess,
    parseRepoSlug,
    defaultGhExec,
    NOT_FOUND_RE,
};
