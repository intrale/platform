'use strict';

// =============================================================================
// operativo-sync.js — Avance seguro del working tree del modelo operativo a
// `origin/main` SIN plano global de restart (#4460, fix del rebote rev-1).
// -----------------------------------------------------------------------------
// PROBLEMA que resuelve (causa raíz del rechazo de `aprobacion`):
//   El botón "Reiniciar modelo operativo" iba por `restartComponent('pulpo')`
//   (taskkill + spawn del pulpo desde el working tree ON-DISK). Esa ruta NO
//   sincroniza el tree con `origin/main`: el pulpo relanzado corre EXACTAMENTE
//   el mismo código local de antes → el marker no avanza → `bootSha..origin/main`
//   sigue no vacío → el banner persiste para siempre y la entrega jamás se
//   aplica (viola Objetivo, CA-4, CA-7).
//
//   El único que avanzaba el tree era `syncWithMain()` en `restart.js`, pero esa
//   ruta hace `killAll()` (incluye `claude.exe` y agentes vivos) — prohibida por
//   REQ-SEC-4460-4. Tensión: "no killAll" vs "aplicar cambios (exige sincronizar
//   el tree)".
//
// SOLUCIÓN: aislar la PARTE GIT de `syncWithMain` (fetch + reset --hard +
//   writeBootMarker) SIN el plano global. Este módulo NO importa `restart.js`,
//   NO mata procesos ni agentes: sólo avanza el tree y reescribe el trust anchor.
//   El caller (endpoint restart-operativo) lo invoca ANTES de respawnear el pulpo
//   → el pulpo relanzado lee el código nuevo → el marker refleja el HEAD nuevo →
//   `restartPendienteSlice` devuelve `items:[]` → el botón deja de renderizarse.
//
// Contrato de seguridad:
//   - REQ-SEC-4460-2 (command injection): `git` se ejecuta con `execFileSync(
//     'git', [args...])` (array de args, NUNCA shell string). Ningún dato del
//     usuario/FS se interpola en un comando.
//   - REQ-SEC-4460-4 (no killAll): este módulo NO mata procesos. El restart del
//     pulpo lo hace el caller de forma AISLADA (restartComponent), post-sync.
//   - REQ-SEC-4460-5 (integridad): NUNCA lanza. Ante cualquier fallo devuelve
//     `{ok:false, synced:false, msg}` y NO reescribe el marker (el marker viejo
//     se lee como "estado anterior", nunca como "al día" falsamente).
// =============================================================================

const path = require('path');
const { execFileSync } = require('node:child_process');
const runtimeBoot = require('./runtime-boot');

// SHA hex short (7) → full (40). Frontera de validación del HEAD resuelto.
const SHA_RE = /^[0-9a-f]{7,40}$/;

function _resolveRepoRoot(opts) {
    if (opts && typeof opts.repoRoot === 'string' && opts.repoRoot) return opts.repoRoot;
    if (opts && typeof opts.pipelineDir === 'string' && opts.pipelineDir) {
        return path.resolve(opts.pipelineDir, '..');
    }
    return path.resolve(__dirname, '..', '..');
}

function _resolvePipelineDir(opts) {
    if (opts && typeof opts.pipelineDir === 'string' && opts.pipelineDir) return opts.pipelineDir;
    return path.resolve(__dirname, '..');
}

/**
 * Avanza el working tree del repo operativo a `origin/main` (fast-forward
 * destructivo, igual que `syncWithMain`) y reescribe el boot marker con el HEAD
 * resultante. NO mata procesos: el restart del pulpo lo hace el caller aparte.
 *
 * Es el paso que faltaba para que el botón de restart APLIQUE las entregas:
 * primero se avanza el código on-disk, recién después el caller respawnea el
 * pulpo (que ahora lee el código nuevo).
 *
 * @param {object} [opts] — {
 *     repoRoot,        // raíz del repo git (default: parent de .pipeline)
 *     pipelineDir,     // dir del .pipeline (para el marker)
 *     exec,            // inyectable para test: (args:string[]) => string (stdout)
 *     writeMarker,     // inyectable para test: (sha, {pipelineDir}) => {ok}
 *   }
 * @returns {{ ok:boolean, synced:boolean, sha?:string, wroteMarker?:boolean, msg?:string }}
 *   - ok=true & synced=true: tree avanzado y marker reescrito con el HEAD nuevo.
 *   - ok=false: algo falló (git no disponible, sin conectividad, HEAD inválido);
 *     el marker NO se tocó. NUNCA lanza.
 */
function syncOperativoTree(opts) {
    const o = opts || {};
    const repoRoot = _resolveRepoRoot(o);
    const pipelineDir = _resolvePipelineDir(o);
    const exec = typeof o.exec === 'function'
        ? o.exec
        : (args) => execFileSync('git', args, {
            cwd: repoRoot, encoding: 'utf8', timeout: 30000, windowsHide: true,
        });
    const writeMarker = typeof o.writeMarker === 'function'
        ? o.writeMarker
        : (sha, wo) => runtimeBoot.writeBootMarker(sha, wo);

    // 1. Traer origin/main (dato remoto) y avanzar el tree. `reset --hard
    //    FETCH_HEAD` es el mismo fast-forward que usa `syncWithMain` en
    //    restart.js (comportamiento probado). Si falla (sin red, sin remoto),
    //    NO tocamos el marker: mejor un banner que persiste que un marker que
    //    miente diciendo "al día" sin haber aplicado nada.
    try {
        exec(['fetch', 'origin', 'main']);
        exec(['reset', '--hard', 'FETCH_HEAD']);
    } catch (e) {
        return { ok: false, synced: false, msg: `sync git falló: ${_msg(e)}` };
    }

    // 2. Resolver el HEAD resultante = SHA canónico de "qué corre vivo".
    let head;
    try {
        head = String(exec(['rev-parse', 'HEAD'])).trim();
    } catch (e) {
        return { ok: false, synced: true, msg: `no se pudo resolver HEAD post-sync: ${_msg(e)}` };
    }
    if (!SHA_RE.test(head)) {
        return { ok: false, synced: true, msg: 'HEAD post-sync inválido (no hex)' };
    }

    // 3. Reescribir el trust anchor con el HEAD nuevo → la señal de drift
    //    desaparece en el próximo poll (CA-4). Escritura atómica en runtime-boot.
    let w;
    try {
        w = writeMarker(head, { pipelineDir });
    } catch (e) {
        return { ok: false, synced: true, sha: head, wroteMarker: false, msg: `marker falló: ${_msg(e)}` };
    }
    return {
        ok: !!(w && w.ok),
        synced: true,
        sha: head,
        wroteMarker: !!(w && w.ok),
        msg: (w && w.ok) ? `tree avanzado a ${head.slice(0, 8)}` : 'tree avanzado pero marker no se pudo escribir',
    };
}

function _msg(e) {
    return ((e && e.message) || String(e) || 'error desconocido').slice(0, 120);
}

module.exports = {
    syncOperativoTree,
    SHA_RE,
};
