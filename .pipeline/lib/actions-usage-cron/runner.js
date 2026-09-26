// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// actions-usage-cron / runner — lanza `scripts/measure-actions-billing.js` en
// modo estricto como proceso hijo (#7689, parte 3/4 de #7661)
// =============================================================================
//
// Reglas de seguridad (RS-7689-1..4):
//   - Binario `process.execPath`, args SIEMPRE como array y sin la opción de
//     shell; `windowsHide: true`. El script es una constante.
//   - Ninguna ruta del YAML llega al hijo: el padre crea un `mkdtemp` propio
//     (`<tmp>/measure-actions-XXXX`) con `raw/`, `out/` y `pricing.json`
//     (re-serializado desde el objeto ya validado).
//   - Timeout duro `timeout_min`: mata el ÁRBOL del hijo (en Windows,
//     `taskkill /T /F` y, si el proceso sigue vivo, `wmic ... call terminate`,
//     ambos por `execFileSync` sin shell y con PID entero validado).
//   - stderr: tope de 4 KB, pasa por `redactSecretValue` y va SÓLO al logger.
//   - El `mkdtemp` se borra en TODOS los caminos, previa verificación de que la
//     ruta resuelta está bajo `<tmp>/measure-actions-`.
//   - La promesa se resuelve UNA sola vez (guard `settled`): `exit` y `error`
//     pueden llegar los dos.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { redactSecretValue } = require('../redact');

const TMP_PREFIX = 'measure-actions-';
const SUMMARY_FILE = 'actions-usage-summary.json';
const SUMMARY_MAX_BYTES = 5 * 1024 * 1024;
const STDERR_MAX_BYTES = 4096;
/** Clasificación de salida del script (EXIT_CODES de #7687). Otro código ⇒ `api`. */
const EXIT_MAP = Object.freeze({ 0: 'ok', 2: 'config', 3: 'rate_limit', 4: 'api' });
const KINDS = Object.freeze(['ok', 'config', 'rate_limit', 'api', 'timeout', 'summary_invalido', 'tmp_no_disponible']);

function scriptPath(repoRoot) {
    return path.join(repoRoot, 'scripts', 'measure-actions-billing.js');
}

function classifyExit(code) {
    return Object.hasOwn(EXIT_MAP, String(code)) ? EXIT_MAP[code] : 'api';
}

/** Args del hijo (CA-10). `section` ya viene validada por `cron.resolveSection`. */
function buildArgs(section, runDir, repoRoot) {
    return [
        scriptPath(repoRoot),
        '--strict',
        '--summary-only',
        '--since', section.since,
        '--days', String(section.cadence_days),
        '--skip-storage',
        '--skip-releases',
        '--pricing', path.join(runDir, 'pricing.json'),
        '--raw', path.join(runDir, 'raw'),
        '--out', path.join(runDir, 'out'),
        '--repos', section.repos.join(','),
    ];
}

function spawnOptions(repoRoot) {
    return { cwd: repoRoot, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] };
}

/** ¿`runDir` es un hijo directo de `<tmp>/measure-actions-…`? */
function isOwnTmp(runDir, tmpRoot = os.tmpdir()) {
    if (typeof runDir !== 'string' || !runDir) return false;
    const resolved = path.resolve(runDir);
    const prefix = path.join(path.resolve(tmpRoot), TMP_PREFIX);
    if (!resolved.startsWith(prefix) || resolved.length <= prefix.length) return false;
    return !/[\\/]/.test(resolved.slice(prefix.length));
}

/** Borrado defensivo del `mkdtemp` (CA-13). Nunca lanza. */
function safeRmTmp(runDir, fsImpl = fs, logger = () => {}, tmpRoot = os.tmpdir()) {
    if (!isOwnTmp(runDir, tmpRoot)) {
        logger('limpieza omitida: el directorio temporal no tiene la forma esperada');
        return false;
    }
    try {
        fsImpl.rmSync(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        return true;
    } catch (e) {
        logger(`no se pudo borrar el directorio temporal (${(e && e.code) || 'error'})`);
        return false;
    }
}

/** Lee y parsea el summary con tope de tamaño. Lanza si falta o es inválido. */
function readSummary(outDir, fsImpl = fs) {
    const file = path.join(outDir, SUMMARY_FILE);
    const st = fsImpl.statSync(file);
    if (!st.isFile() || st.size > SUMMARY_MAX_BYTES) throw new Error('summary fuera de tope');
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('summary no es un objeto');
    return parsed;
}

function writePricing(runDir, pricingObj, fsImpl = fs) {
    if (!pricingObj || typeof pricingObj !== 'object' || Array.isArray(pricingObj)) {
        throw new Error('pricing inválido');
    }
    // Re-serializar: el hijo recibe un archivo del padre, nunca una ruta del YAML.
    const data = JSON.stringify(JSON.parse(JSON.stringify(pricingObj)));
    fsImpl.writeFileSync(path.join(runDir, 'pricing.json'), data, { mode: 0o600 });
}

function sleepSync(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* sin espera */ }
}

function defaultPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return !!(e && e.code === 'EPERM');
    }
}

/**
 * Mata el árbol del hijo. Patrón de `port-guard.terminateProcess` (intentar,
 * verificar con `pidAlive`, escalar), pero con `execFileSync` sin shell.
 *
 * @returns {{killed:boolean, intentos:Array<{label:string, alive:boolean, error:string|null}>}}
 */
function defaultKillTree(pid, deps = {}) {
    const {
        child = null,
        platform = process.platform,
        execFile = cp.execFileSync,
        pidAlive = defaultPidAlive,
        sleep = sleepSync,
        settleMs = 200,
    } = deps;
    const intentos = [];
    if (!Number.isInteger(pid) || pid <= 0) return { killed: false, intentos };
    if (platform !== 'win32') {
        try {
            if (child && typeof child.kill === 'function') child.kill('SIGKILL');
            else process.kill(pid, 'SIGKILL');
        } catch { /* ya muerto */ }
        return { killed: true, intentos };
    }
    const strategies = [
        { label: 'taskkill /F /T', file: 'taskkill', args: ['/PID', String(pid), '/F', '/T'] },
        { label: 'wmic call terminate', file: 'wmic', args: ['process', 'where', `ProcessId=${pid}`, 'call', 'terminate'] },
    ];
    for (const s of strategies) {
        let error = null;
        try {
            execFile(s.file, s.args, { windowsHide: true, stdio: 'ignore', timeout: 15000 });
        } catch (e) {
            error = String((e && e.message) || e).split('\n')[0].slice(0, 200);
        }
        sleep(settleMs);
        const alive = pidAlive(pid);
        intentos.push({ label: s.label, alive, error });
        if (!alive) return { killed: true, intentos };
    }
    return { killed: false, intentos };
}

/** Deja el stderr apto para una línea de log: sin rutas del tmp, redactado y en una línea. */
function sanitizeStderr(buf, runDir) {
    let s = buf.toString('utf8');
    if (runDir) s = s.split(runDir).join('<tmp>');
    s = s.replace(/\r?\n/g, ' | ').trim();
    return redactSecretValue(s);
}

/**
 * Corre la medición en un proceso hijo.
 *
 * @param {object} p
 * @param {object} p.section       sección validada por `cron.resolveSection`
 * @param {string} p.repoRoot
 * @param {object} p.pricingObj    pricing ya leído y validado por el padre
 * @returns {Promise<{kind:string, summary:object|null}>}
 */
function spawnMeasure({
    section, repoRoot, pricingObj,
    spawnImpl = cp.spawn, killTree = defaultKillTree,
    setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
    fsImpl = fs, logger = () => {}, tmpRoot = os.tmpdir(),
} = {}) {
    let runDir;
    try {
        runDir = fsImpl.mkdtempSync(path.join(tmpRoot, TMP_PREFIX));
    } catch (e) {
        logger(`no se pudo crear el directorio temporal (${(e && e.code) || 'error'})`);
        return Promise.resolve({ kind: 'tmp_no_disponible', summary: null });
    }
    return new Promise((resolve) => {
        let settled = false;
        let stderr = Buffer.alloc(0);
        let timer = null;
        let child = null;
        const finish = (kind) => {
            if (settled) return;
            settled = true;
            if (timer !== null) {
                try { clearTimeoutImpl(timer); } catch { /* noop */ }
            }
            let summary = null;
            try {
                if (kind === 'ok') summary = readSummary(path.join(runDir, 'out'), fsImpl);
            } catch {
                kind = 'summary_invalido';
            } finally {
                safeRmTmp(runDir, fsImpl, logger, tmpRoot);
            }
            if (stderr.length) logger(`stderr del medidor: ${sanitizeStderr(stderr, runDir)}`);
            resolve({ kind, summary });
        };
        try {
            fsImpl.mkdirSync(path.join(runDir, 'raw'));
            fsImpl.mkdirSync(path.join(runDir, 'out'));
            writePricing(runDir, pricingObj, fsImpl);
            child = spawnImpl(process.execPath, buildArgs(section, runDir, repoRoot), spawnOptions(repoRoot));
        } catch (e) {
            logger(`no se pudo lanzar el medidor (${(e && e.code) || 'error'})`);
            finish('api');
            return;
        }
        if (!child || typeof child.on !== 'function') {
            finish('api');
            return;
        }
        if (child.stderr && typeof child.stderr.on === 'function') {
            child.stderr.on('data', (b) => {
                if (stderr.length >= STDERR_MAX_BYTES) return;
                const chunk = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
                stderr = Buffer.concat([stderr, chunk]).subarray(0, STDERR_MAX_BYTES);
            });
        }
        child.on('error', () => finish('api'));
        child.on('exit', (code) => finish(classifyExit(code)));
        timer = setTimeoutImpl(() => {
            if (settled) return;
            try {
                const res = killTree(child.pid, { child });
                if (res && res.killed === false) logger('el medidor no se pudo cortar por completo al vencer el tiempo');
            } catch { /* se resuelve igual */ }
            finish('timeout');
        }, section.timeout_min * 60000);
        if (timer && typeof timer.unref === 'function') timer.unref();
    });
}

module.exports = {
    TMP_PREFIX,
    SUMMARY_FILE,
    SUMMARY_MAX_BYTES,
    STDERR_MAX_BYTES,
    EXIT_MAP,
    KINDS,
    scriptPath,
    classifyExit,
    buildArgs,
    spawnOptions,
    isOwnTmp,
    safeRmTmp,
    readSummary,
    writePricing,
    defaultKillTree,
    sanitizeStderr,
    spawnMeasure,
};
