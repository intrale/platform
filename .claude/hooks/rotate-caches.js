#!/usr/bin/env node
// rotate-caches.js — Rotacion de caches de maquina que nadie mas toca.
//
// Uso: node rotate-caches.js [--dry-run] [--force] [--min-free-gb=N]
//
// Contexto: el disco se llena cada 2-3 semanas. Los worktrees los atiende
// cleanup-worktrees.js; los artefactos de build los regenera Gradle. Lo que no
// tenia dueno son los caches de maquina, que solo crecen:
//
//   ~/.gradle/.tmp                    temporales que Gradle nunca borra (28k
//                                     entradas / 2 GB en la medicion 2026-08-20)
//   ~/.cache/puppeteer/chrome*        una copia de Chrome (~430 MB) por version
//                                     descargada; se acumulan todas
//   npm-cache                         crecio a 8 GB sin techo
//   worktrees inactivos: build/       artefactos regenerables replicados por
//   .gradle/ .kotlin/                 worktree
//
// Por defecto solo actua si el disco libre esta por debajo del umbral, para que
// correrlo seguido no cueste nada. --force ignora el umbral.
//
// NO toca: ~/.android/avd (emulador QA con snapshot qa-ready), ~/.cache/whisper
// ni ~/.cache/huggingface (modelos de audio operativos), qa/evidence, logs del
// pipeline, ni ningun worktree con heartbeat fresco.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const HOOKS_DIR = __dirname;
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(HOOKS_DIR, "..", "..");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const HOME = os.homedir();

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const MIN_FREE_GB = (() => {
    const arg = process.argv.find(a => a.startsWith("--min-free-gb="));
    const n = arg ? Number(arg.split("=")[1]) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 30;
})();

// Un heartbeat mas nuevo que esto significa que hay un agente trabajando ahi.
const HEARTBEAT_FRESH_MS = 15 * 60 * 1000;
// Artefactos de build regenerables. `build` es ambiguo: en `.pipeline/` es una
// FASE del pipeline (pendiente/trabajando/listo), no un directorio de Gradle.
// Por eso el walk corta en `.pipeline` y en `.git`.
const BUILD_ARTIFACTS = new Set(["build", ".gradle", ".kotlin", "kotlin-js-store"]);
const WALK_SKIP = new Set([".pipeline", ".git", "node_modules", "qa"]);

function log(msg) {
    const line = "[" + new Date().toISOString() + "] rotate-caches: " + msg;
    try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) {}
    console.log(msg);
}

function freeBytes() {
    try {
        const out = execSync("fsutil volume diskfree C:", {
            encoding: "utf8", timeout: 15000, windowsHide: true,
        });
        const m = /:\s+([\d.,]+)/.exec(out.split("\n")[0]);
        if (m) return Number(m[1].replace(/[.,]/g, ""));
    } catch (e) {}
    return NaN;
}

function dirSize(dir) {
    let total = 0;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return 0; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        try {
            if (e.isSymbolicLink()) continue;   // no seguir junctions NTFS
            total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
        } catch (e2) {}
    }
    return total;
}

function gb(bytes) { return (bytes / 1e9).toFixed(2) + " GB"; }

let freed = 0;

function reclaim(target, label) {
    if (!fs.existsSync(target)) return 0;
    const size = dirSize(target);
    if (size === 0) return 0;
    if (DRY_RUN) {
        log("  [dry-run] " + label + ": " + gb(size));
        freed += size;
        return size;
    }
    try {
        fs.rmSync(target, { recursive: true, force: true });
        freed += size;
        log("  " + label + ": " + gb(size));
        return size;
    } catch (e) {
        log("  FALLO " + label + ": " + e.message);
        return 0;
    }
}

// --- 1. Temporales de Gradle -------------------------------------------------
function rotateGradleTmp() {
    log("Gradle .tmp");
    reclaim(path.join(HOME, ".gradle", ".tmp"), "~/.gradle/.tmp");
}

// --- 2. Puppeteer: conservar solo la version mas nueva ------------------------
// Comparar como strings ordena "146.0.7680.76" antes que "146.0.7680.153";
// hay que comparar segmento a segmento como numeros.
function compareVersions(a, b) {
    const pa = a.replace(/^win64-/, "").split(".").map(Number);
    const pb = b.replace(/^win64-/, "").split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
    }
    return 0;
}

function rotatePuppeteer() {
    log("Puppeteer (conservar solo la ultima version)");
    for (const kind of ["chrome", "chrome-headless-shell"]) {
        const base = path.join(HOME, ".cache", "puppeteer", kind);
        let versions;
        try { versions = fs.readdirSync(base).filter(v => v.startsWith("win64-")); }
        catch (e) { continue; }
        if (versions.length <= 1) continue;
        versions.sort(compareVersions);
        const keep = versions.pop();
        for (const v of versions) reclaim(path.join(base, v), kind + "/" + v);
        log("  " + kind + ": conservada " + keep);
    }
}

// --- 3. Cache de npm ---------------------------------------------------------
function rotateNpmCache() {
    const cacheDir = path.join(HOME, "AppData", "Local", "npm-cache");
    if (!fs.existsSync(cacheDir)) return;
    const size = dirSize(cacheDir);
    log("npm cache: " + gb(size));
    if (size < 2e9) { log("  bajo el umbral, se conserva"); return; }
    if (DRY_RUN) { log("  [dry-run] npm cache clean --force: " + gb(size)); freed += size; return; }
    try {
        execSync("npm cache clean --force", { timeout: 300000, windowsHide: true, stdio: "ignore" });
        freed += size;
        log("  npm cache limpiado: " + gb(size));
    } catch (e) {
        log("  FALLO npm cache clean: " + e.message);
    }
}

// --- 4. Artefactos de build en worktrees inactivos ---------------------------
function hasFreshHeartbeat(wtPath) {
    const dir = path.join(wtPath, ".claude", "hooks");
    try {
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith(".heartbeat")) continue;
            if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs < HEARTBEAT_FRESH_MS) return true;
        }
    } catch (e) {}
    return false;
}

function collectArtifacts(dir, out, depth) {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return; }
    for (const e of entries) {
        if (!e.isDirectory() || e.isSymbolicLink()) continue;
        if (WALK_SKIP.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (BUILD_ARTIFACTS.has(e.name)) { out.push(p); continue; }
        collectArtifacts(p, out, depth + 1);
    }
}

function rotateWorktreeArtifacts() {
    log("Artefactos de build en worktrees inactivos");
    const parent = path.resolve(REPO_ROOT, "..");
    const repoName = path.basename(REPO_ROOT);
    let entries;
    try { entries = fs.readdirSync(parent, { withFileTypes: true }); }
    catch (e) { return; }
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const wt = path.join(parent, e.name);
        if (path.resolve(wt) === path.resolve(REPO_ROOT)) continue;   // nunca el repo principal
        if (!e.name.startsWith(repoName + ".") && !e.name.startsWith(repoName + "-")) continue;
        if (hasFreshHeartbeat(wt)) { log("  omitido (heartbeat activo): " + e.name); continue; }
        const targets = [];
        collectArtifacts(wt, targets, 0);
        let sub = 0;
        for (const t of targets) sub += reclaim(t, path.relative(parent, t));
        if (sub > 0) log("  " + e.name + ": " + gb(sub));
    }
}

// --- 5. Temporales de agentes fuera de %TEMP% --------------------------------
// Los agentes (qa, po, ux, review) crean copias del repo y scratch dirs en
// `C:\Temp` y `C:\tmp` con nombre de issue (`qa5244-ci-...`, `po6432-wt`).
// Ninguna automatizacion los miraba: `rotate-caches` solo veia los caches de
// maquina y `ghostbusters` solo `C:\Workspaces`. En la medicion 2026-09-05
// sumaban 15,5 GB de issues ya cerrados — mas que todos los worktrees juntos.
//
// El criterio es la ANTIGUEDAD del arbol (48h), no el estado del issue: consultar
// GitHub por cada entrada es caro y falla sin red, mientras que un temporal sin
// tocar en dias no lo usa nadie. Se respeta el dir de la sesion de Claude en
// curso (ahi viven los outputs de tareas en background).
// `%TEMP%` entra tambien: 10 GB en la medicion 2026-09-05, y ninguna
// automatizacion lo miraba pese a ser donde caen los temporales por defecto.
const AGENT_TEMP_DIRS = ["C:\\Temp", "C:\\tmp", os.tmpdir()];
// Nombres que no se tocan ni aunque el arbol se vea viejo. `claude` es el
// scratchpad de las sesiones: ahi viven los outputs de tareas en background,
// y una sesion reanudada puede leer archivos que no escribio hace 48h.
const AGENT_TEMP_KEEP = new Set(["claude", "chocolatey", "gradle", ".gradle"]);
const AGENT_TEMP_AGE_MS = 48 * 60 * 60 * 1000;

// mtime del propio dir no basta: en Windows no se propaga desde los hijos, asi
// que un arbol tocado hoy puede tener el raiz con fecha vieja. Se mira el mtime
// mas nuevo del arbol, cortando apenas se encuentra algo fresco.
function newestMtime(target, deadline, depth = 0) {
    let newest = 0;
    try { newest = fs.lstatSync(target).mtimeMs; } catch (e) { return 0; }
    if (newest > deadline || depth > 4) return newest;
    let entries;
    try { entries = fs.readdirSync(target, { withFileTypes: true }); }
    catch (e) { return newest; }
    for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const child = path.join(target, e.name);
        const m = e.isDirectory() ? newestMtime(child, deadline, depth + 1) : safeMtime(child);
        if (m > newest) newest = m;
        if (newest > deadline) break;
    }
    return newest;
}

function safeMtime(f) {
    try { return fs.lstatSync(f).mtimeMs; } catch (e) { return 0; }
}

function rotateAgentTempDirs() {
    log("Temporales de agentes (" + AGENT_TEMP_DIRS.join(", ") + ")");
    const deadline = Date.now() - AGENT_TEMP_AGE_MS;
    // El scratchpad de la sesion de Claude en curso vive bajo %TEMP%, pero el
    // agente puede haber sido lanzado con TEMP apuntando a cualquiera de estos
    // dirs: se excluye por prefijo, no por nombre.
    const protectedPaths = [process.env.TEMP, process.env.TMP, process.cwd()]
        .filter(Boolean)
        .map(d => path.resolve(d).toLowerCase());
    const vistos = new Set();
    for (const base of AGENT_TEMP_DIRS) {
        const baseKey = path.resolve(base).toLowerCase();
        if (vistos.has(baseKey)) continue;
        vistos.add(baseKey);
        let entries;
        try { entries = fs.readdirSync(base, { withFileTypes: true }); }
        catch (e) { continue; }
        let sub = 0;
        for (const e of entries) {
            if (e.isSymbolicLink()) continue;
            const target = path.join(base, e.name);
            if (AGENT_TEMP_KEEP.has(e.name.toLowerCase())) continue;
            const lower = path.resolve(target).toLowerCase();
            if (protectedPaths.some(p => p.startsWith(lower))) continue;
            if (newestMtime(target, deadline) > deadline) continue;
            sub += reclaim(target, path.join(base, e.name));
        }
        if (sub > 0) log("  " + base + ": " + gb(sub));
    }
}

function main() {
    const before = freeBytes();
    if (Number.isFinite(before)) log("Libre antes: " + gb(before));

    if (!FORCE && Number.isFinite(before) && before > MIN_FREE_GB * 1e9) {
        log("Por encima del umbral (" + MIN_FREE_GB + " GB libres). Nada que hacer.");
        return;
    }

    rotateGradleTmp();
    rotatePuppeteer();
    rotateNpmCache();
    rotateWorktreeArtifacts();
    rotateAgentTempDirs();

    log("");
    log("Recuperado" + (DRY_RUN ? " (estimado, dry-run)" : "") + ": " + gb(freed));
    const after = freeBytes();
    if (Number.isFinite(after)) log("Libre despues: " + gb(after));
}

if (require.main === module) main();

module.exports = {
    compareVersions, dirSize, hasFreshHeartbeat, newestMtime,
    BUILD_ARTIFACTS, WALK_SKIP, AGENT_TEMP_DIRS, AGENT_TEMP_AGE_MS, AGENT_TEMP_KEEP,
};
