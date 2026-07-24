// =============================================================================
// multimedia-attachment.js — Helpers para validar adjuntos multimedia
// Issue #3540
//
// Responsabilidad: detección de MIME por magic bytes y probe de duración de
// video vía ffprobe. Módulo PURO (sin side effects) salvo:
//   - lectura de los primeros bytes del archivo (`fs.openSync` + `readSync`)
//   - `child_process.spawnSync` sobre ffprobe con timeout HARD
//
// Defensas (issue #3540, CA-SEC-EXT-2 / CA-SEC-EXT-3):
//   - MIME por magic bytes ANTES de extensión: defiende spoofing (`payload.exe`
//     renombrado a `report.pdf`).
//   - `ffprobe` SIEMPRE vía `spawnSync` con array de args (no `exec`/`execSync`
//     con string concatenado). Timeout HARD 15s default. Stderr cap 4KB.
//   - El path absoluto pasado a ffprobe DEBE ser el `realpath` resuelto por
//     `validateAttachmentPath` (resuelto, sin `..`).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// -----------------------------------------------------------------------------
// Tabla de magic bytes por MIME (CA-SEC-EXT-2)
//
// Cada entrada declara:
//   - offset:     en bytes desde el comienzo del archivo.
//   - signatures: array de Buffer candidatos. Match si cualquiera coincide.
//                 `null` significa "skip" (formatos sin magic byte fijo
//                 como markdown — solo validamos extensión).
// -----------------------------------------------------------------------------
const MAGIC_BYTES = Object.freeze({
    'application/pdf':  { offset: 0, signatures: [Buffer.from('%PDF-', 'utf8')] },
    'image/png':        { offset: 0, signatures: [Buffer.from([0x89, 0x50, 0x4E, 0x47])] },
    'image/jpeg':       { offset: 0, signatures: [Buffer.from([0xFF, 0xD8, 0xFF])] },
    // MP4: 'ftyp' atom en offset 4 (los primeros 4 bytes son el atom size, BE).
    'video/mp4':        { offset: 4, signatures: [Buffer.from('ftyp', 'utf8')] },
    // WebM: EBML header.
    'video/webm':       { offset: 0, signatures: [Buffer.from([0x1A, 0x45, 0xDF, 0xA3])] },
    // GIF: GIF87a / GIF89a.
    'image/gif':        { offset: 0, signatures: [Buffer.from('GIF87a', 'utf8'), Buffer.from('GIF89a', 'utf8')] },
    // Markdown: sin magic byte fijo (texto plano). Validamos extensión + size,
    // sin verificación binaria. CA-SEC-EXT-2 acepta esta laxitud por ser texto
    // (no es vector de malware en transit por Telegram bot — el cliente lo
    // muestra como documento descargable, no ejecuta nada).
    'text/markdown':    { offset: 0, signatures: null },
});

// -----------------------------------------------------------------------------
// Mapeo extensión → MIME. Solo las extensiones soportadas en V1 (#3540).
// HTML deliberadamente excluido (V2, #3547 sanitizer pendiente).
// -----------------------------------------------------------------------------
const EXT_TO_MIME = Object.freeze({
    '.pdf':  'application/pdf',
    '.md':   'text/markdown',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.mp4':  'video/mp4',
    '.webm': 'video/webm',
    '.gif':  'image/gif',
});

// -----------------------------------------------------------------------------
// Mapeo MIME → tipo lógico (document/image/video/animation). Útil para
// agrupar y para elegir el método Telegram (sendDocument/sendPhoto/etc).
// -----------------------------------------------------------------------------
const MIME_TO_KIND = Object.freeze({
    'application/pdf':  'document',
    'text/markdown':    'document',
    'image/png':        'image',
    'image/jpeg':       'image',
    'video/mp4':        'video',
    'video/webm':       'video',
    'image/gif':        'animation',
});

// Timeout por defecto del probe de duración (CA-SEC-EXT-3 — HARD).
const DEFAULT_FFPROBE_TIMEOUT_MS = 15000;

// Cap de stderr cuando ffprobe falla sobre archivos corruptos (CA-SEC-EXT-3).
const DEFAULT_FFPROBE_STDERR_CAP = 4096;

/**
 * Devuelve el MIME conocido para la extensión del path, o `null` si la
 * extensión no está en `EXT_TO_MIME` (V1).
 *
 * @param {string} p - path absoluto o relativo.
 * @returns {string|null} mime string.
 */
function mimeForPath(p) {
    if (typeof p !== 'string' || p.length === 0) return null;
    const ext = path.extname(p).toLowerCase();
    return EXT_TO_MIME[ext] || null;
}

/**
 * CA-SEC-EXT-2 — Verifica los magic bytes del archivo contra el MIME declarado.
 *
 * Devuelve `{ ok, reason?, skipped? }`:
 *   - `ok:true, skipped:false`     — magic bytes coinciden.
 *   - `ok:true, skipped:true`      — el MIME no tiene magic byte fijo (ej. md).
 *   - `ok:false, reason:'mime_unknown'`     — MIME no soportado en V1.
 *   - `ok:false, reason:'mime_mismatch'`    — bytes leídos NO matchean.
 *   - `ok:false, reason:'read_failed'`      — error de fs (file gone, etc).
 *   - `ok:false, reason:'stat_failed'`      — error de stat para markdown.
 *
 * NUNCA tira excepción.
 *
 * @param {string} absPath - path absoluto realresuelto por validateAttachmentPath.
 * @param {string} mime    - MIME declarado por mimeForPath o caller.
 * @returns {{ ok: boolean, skipped?: boolean, reason?: string }}
 */
function verifyMagicBytes(absPath, mime) {
    const spec = MAGIC_BYTES[mime];
    if (!spec) return { ok: false, reason: 'mime_unknown' };

    // Formatos texto sin magic byte fijo: validamos que el stat funcione
    // (archivo accesible y no-directorio) y declaramos skip explícito.
    if (spec.signatures === null) {
        try {
            const stat = fs.statSync(absPath);
            if (!stat.isFile()) return { ok: false, reason: 'not_a_file' };
            return { ok: true, skipped: true };
        } catch {
            return { ok: false, reason: 'stat_failed' };
        }
    }

    let fd = null;
    try {
        // Calcular cuántos bytes hay que leer: offset + el signature más largo.
        const maxSigLen = spec.signatures.reduce((m, s) => Math.max(m, s.length), 0);
        const needed = spec.offset + maxSigLen;
        if (needed <= 0) return { ok: false, reason: 'mime_unknown' };

        fd = fs.openSync(absPath, 'r');
        const buf = Buffer.alloc(needed);
        const read = fs.readSync(fd, buf, 0, needed, 0);
        if (read < needed) return { ok: false, reason: 'mime_mismatch' };

        for (const sig of spec.signatures) {
            const slice = buf.slice(spec.offset, spec.offset + sig.length);
            if (slice.equals(sig)) return { ok: true, skipped: false };
        }
        return { ok: false, reason: 'mime_mismatch' };
    } catch {
        return { ok: false, reason: 'read_failed' };
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    }
}

/**
 * Busca el binario de ffprobe — análogo a `findFfmpegExe` en multimedia.js.
 * Prioriza:
 *   1. env `FFPROBE_BIN` si existe en disco.
 *   2. WinGet `Gyan.FFmpeg` package en %LOCALAPPDATA%.
 *   3. Fallback al PATH (`'ffprobe'`).
 *
 * @returns {string} path absoluto o 'ffprobe' (busca en PATH).
 */
function findFfprobeExe() {
    if (process.env.FFPROBE_BIN && fs.existsSync(process.env.FFPROBE_BIN)) {
        return process.env.FFPROBE_BIN;
    }
    if (process.platform === 'win32') {
        const wingetBase = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
        try {
            if (fs.existsSync(wingetBase)) {
                const entries = fs.readdirSync(wingetBase);
                const ff = entries.find((e) => e.toLowerCase().startsWith('gyan.ffmpeg'));
                if (ff) {
                    const pkgDir = path.join(wingetBase, ff);
                    const sub = fs.readdirSync(pkgDir).find((e) => e.toLowerCase().startsWith('ffmpeg-'));
                    if (sub) {
                        const bin = path.join(pkgDir, sub, 'bin', 'ffprobe.exe');
                        if (fs.existsSync(bin)) return bin;
                    }
                }
            }
        } catch {
            // Fallback al PATH.
        }
    }
    return 'ffprobe';
}

/**
 * CA-SEC-EXT-3 — Lee la duración (en segundos enteros, redondeada) de un
 * archivo de video con ffprobe. Patrón seguro:
 *   - `spawnSync` con array de args (no `exec` con string concatenado).
 *   - Timeout HARD configurable (default 15s).
 *   - Stderr capturado con cap 4KB para no agotar memoria con videos malformados.
 *   - El path absoluto DEBE ser el realpath resuelto por la capa de validación.
 *
 * @param {string} absPath
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=15000]
 * @param {number} [opts.stderrCap=4096]
 * @param {string} [opts.ffprobeBin]   - override (tests inyectan stub).
 * @returns {{ ok: boolean, duration_s?: number, reason?: string }}
 */
function probeVideoDurationSeconds(absPath, opts) {
    const timeoutMs = (opts && Number.isFinite(opts.timeoutMs))
        ? opts.timeoutMs
        : DEFAULT_FFPROBE_TIMEOUT_MS;
    const stderrCap = (opts && Number.isFinite(opts.stderrCap))
        ? opts.stderrCap
        : DEFAULT_FFPROBE_STDERR_CAP;
    const ffBin = (opts && typeof opts.ffprobeBin === 'string')
        ? opts.ffprobeBin
        : findFfprobeExe();

    if (typeof absPath !== 'string' || absPath.length === 0) {
        return { ok: false, reason: 'invalid_path' };
    }

    // CA-SEC-EXT-3: array de args, NUNCA exec con string.
    const args = [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=nw=1:nk=1',
        absPath,
    ];

    let result;
    try {
        result = spawnSync(ffBin, args, {
            windowsHide: true,
            timeout: timeoutMs,
            killSignal: 'SIGKILL',
            encoding: 'utf8',
            // maxBuffer del stdout/stderr — cap defensivo contra videos malformados.
            maxBuffer: Math.max(stderrCap * 2, 8192),
        });
    } catch {
        return { ok: false, reason: 'spawn_failed' };
    }

    if (!result) return { ok: false, reason: 'spawn_failed' };
    if (result.error) {
        const code = result.error.code || '';
        if (code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' };
        return { ok: false, reason: 'proc_error' };
    }
    if (result.signal === 'SIGKILL') return { ok: false, reason: 'timeout' };
    if (result.status !== 0) {
        return { ok: false, reason: 'ffprobe_exit_' + result.status };
    }

    const stdout = String(result.stdout || '').trim();
    const d = parseFloat(stdout);
    if (!Number.isFinite(d) || d < 0) return { ok: false, reason: 'parse_failed' };

    return { ok: true, duration_s: Math.round(d) };
}

module.exports = {
    mimeForPath,
    verifyMagicBytes,
    probeVideoDurationSeconds,
    findFfprobeExe,
    MAGIC_BYTES,
    EXT_TO_MIME,
    MIME_TO_KIND,
    DEFAULT_FFPROBE_TIMEOUT_MS,
    DEFAULT_FFPROBE_STDERR_CAP,
};
