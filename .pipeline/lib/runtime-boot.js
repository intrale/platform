'use strict';

// =============================================================================
// runtime-boot.js — Trust anchor del SHA vivo del runtime (#4460).
// -----------------------------------------------------------------------------
// El pipeline no tiene forma de saber qué commit corre el proceso vivo: los
// `.pid` sólo guardan el PID. Este módulo persiste el HEAD con el que arrancó
// el runtime en `.pipeline/runtime-boot.json` para que la detección de drift
// (`operativo-drift.js`) pueda comparar `bootSHA..origin/main`.
//
// Contrato de seguridad (REQ-SEC-4460-2/5):
//   - Escritura ATÓMICA: write-temp + rename, para que un crash a mitad de
//     escritura no deje el marker corrupto (es la referencia canónica de "qué
//     corre vivo"; un marker mentiroso hace que el operador corra código viejo
//     creyendo que está al día).
//   - `readBootMarker` NUNCA lanza: ante marker ausente, JSON corrupto o `sha`
//     no-hexadecimal devuelve `null`. El caller trata `null` como "estado
//     desconocido" (no ofrece restart), jamás como "sin pendientes".
//   - El `sha` se valida contra /^[0-9a-f]{7,40}$/ AL LEER, no sólo al escribir:
//     el archivo del FS es dato NO confiable (potencialmente tampereable) y su
//     contenido termina alimentando un `git log <sha>..` en operativo-drift.
// =============================================================================

const fs = require('fs');
const path = require('path');

// Regex canónica del SHA (short 7 → full 40). Compartida conceptualmente con
// operativo-drift; acá se aplica en la frontera de lectura del marker.
const SHA_RE = /^[0-9a-f]{7,40}$/;
const MARKER_FILENAME = 'runtime-boot.json';

// Resuelve el directorio del pipeline (donde vive runtime-boot.json). Default:
// el propio `.pipeline/` (parent de este lib). Inyectable para tests.
function _resolvePipelineDir(opts) {
    const dir = opts && typeof opts.pipelineDir === 'string' && opts.pipelineDir
        ? opts.pipelineDir
        : path.resolve(__dirname, '..');
    return dir;
}

function _markerPath(opts) {
    return path.join(_resolvePipelineDir(opts), MARKER_FILENAME);
}

/**
 * Escribe el marker de boot de forma atómica (temp + rename).
 *
 * @param {string} sha — HEAD del runtime vivo (short o full, hex).
 * @param {object} [opts] — { pipelineDir }.
 * @returns {{ ok: boolean, sha?: string, startedAt?: string, msg?: string }}
 *   No lanza: ante `sha` inválido o error de escritura devuelve `{ok:false}`.
 */
function writeBootMarker(sha, opts) {
    if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
        return { ok: false, msg: 'sha inválido (debe ser hex 7-40)' };
    }
    const target = _markerPath(opts);
    // startedAt en ISO. `new Date().toISOString()` es el timestamp real de boot.
    const startedAt = new Date().toISOString();
    const payload = JSON.stringify({ sha, startedAt }, null, 2) + '\n';
    // Temp único por PID para no pisar un rename concurrente de otro proceso.
    const tmp = target + '.' + process.pid + '.tmp';
    try {
        fs.writeFileSync(tmp, payload, { encoding: 'utf8' });
        fs.renameSync(tmp, target); // atómico en el mismo filesystem
        return { ok: true, sha, startedAt };
    } catch (e) {
        // Best-effort: limpiar el temp si el rename falló.
        try { fs.unlinkSync(tmp); } catch { /* noop */ }
        return { ok: false, msg: (e && e.message) || 'error de escritura' };
    }
}

/**
 * Lee el marker de boot. NUNCA lanza.
 *
 * @param {object} [opts] — { pipelineDir }.
 * @returns {{ sha: string, startedAt: string|null } | null}
 *   `null` si el marker no existe, el JSON está corrupto, o `sha` no es hex.
 */
function readBootMarker(opts) {
    let raw;
    try {
        raw = fs.readFileSync(_markerPath(opts), 'utf8');
    } catch {
        return null; // ausente → estado desconocido
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null; // corrupto → estado desconocido, no crashear
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const sha = parsed.sha;
    if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
        return null; // sha no-hex / tampereado → estado desconocido
    }
    const startedAt = typeof parsed.startedAt === 'string' ? parsed.startedAt : null;
    return { sha, startedAt };
}

/**
 * Asegura que el marker refleje el HEAD real al bootear el proceso (#4460).
 * Mitiga el "restart manual sin restart.js": si alguien reinicia dashboard/pulpo
 * fuera de restart.js, el marker quedaría stale y la detección de drift mentiría.
 * Al bootear, el proceso corre el código on-disk = HEAD actual; si el marker
 * falta o difiere, lo reescribimos con el HEAD real.
 *
 * NUNCA lanza. `execFileSync` inyectable para test (deps.resolveHead).
 *
 * @param {object} [opts] — { pipelineDir, repoRoot, resolveHead }.
 * @returns {{ ok:boolean, wrote:boolean, sha?:string, msg?:string }}
 */
function ensureBootMarker(opts) {
    const o = opts || {};
    let head;
    try {
        if (typeof o.resolveHead === 'function') {
            head = o.resolveHead();
        } else {
            const { execFileSync } = require('node:child_process');
            const repoRoot = o.repoRoot || path.resolve(_resolvePipelineDir(o), '..');
            head = execFileSync('git', ['rev-parse', 'HEAD'], {
                cwd: repoRoot, encoding: 'utf8', timeout: 10000, windowsHide: true,
            }).trim();
        }
    } catch (e) {
        return { ok: false, wrote: false, msg: (e && e.message) || 'no se pudo resolver HEAD' };
    }
    if (typeof head !== 'string' || !SHA_RE.test(head)) {
        return { ok: false, wrote: false, msg: 'HEAD inválido' };
    }
    const current = readBootMarker(o);
    if (current && current.sha === head) {
        return { ok: true, wrote: false, sha: head }; // ya al día, no reescribir
    }
    const w = writeBootMarker(head, o);
    return { ok: w.ok, wrote: !!w.ok, sha: head, msg: w.msg };
}

module.exports = {
    writeBootMarker,
    readBootMarker,
    ensureBootMarker,
    MARKER_FILENAME,
    SHA_RE,
    // internos para test
    _markerPath,
};
