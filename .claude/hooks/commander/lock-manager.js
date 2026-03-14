// commander/lock-manager.js — Gestión de lockfile, offset persistente y procesos
// Responsabilidad: singleton del commander, offset de Telegram, kill de zombies
"use strict";

const fs = require("fs");
const path = require("path");

// ─── Constantes ──────────────────────────────────────────────────────────────
const LOCK_STALE_MS = 24 * 60 * 60 * 1000; // 24h
const OFFSET_STALE_GAP_MS = 60 * 1000;     // 60 segundos

// ─── Estado ──────────────────────────────────────────────────────────────────
let _lockFile = null;
let _offsetFile = null;
let _conflictCooldownFile = null;
let _log = console.log;

function init(lockFile, offsetFile, conflictCooldownFile, logFn) {
    _lockFile = lockFile;
    _offsetFile = offsetFile;
    _conflictCooldownFile = conflictCooldownFile;
    if (logFn) _log = logFn;
}

// ─── Process checks ─────────────────────────────────────────────────────────

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

function isLockStale(data) {
    if (!data.pid || typeof data.pid !== "number") return true;
    if (!isProcessAlive(data.pid)) return true;
    if (data.started) {
        const age = Date.now() - new Date(data.started).getTime();
        if (age > LOCK_STALE_MS) return true;
    }
    return false;
}

// ─── Kill other commanders ──────────────────────────────────────────────────

function killOtherCommanders() {
    try {
        const { execSync } = require("child_process");
        const wmicOutput = execSync(
            'wmic process where "name=\'node.exe\' and commandline like \'%telegram-commander.js%\'" get ProcessId /FORMAT:LIST 2>NUL',
            { encoding: "utf8", timeout: 5000, windowsHide: true }
        );
        const pids = [];
        wmicOutput.split("\n").forEach(line => {
            const m = line.trim().match(/^ProcessId=(\d+)$/);
            if (m) pids.push(parseInt(m[1]));
        });
        const myPid = process.pid;
        const others = pids.filter(p => p !== myPid);
        for (const pid of others) {
            try {
                execSync("taskkill /PID " + pid + " /F 2>NUL", { timeout: 3000, windowsHide: true });
                _log("Matado commander previo (PID " + pid + ") para evitar conflicto 409");
            } catch (e) {}
        }
        if (others.length > 0) {
            _log("Eliminados " + others.length + " commander(s) previo(s): " + others.join(", "));
        }
    } catch (e) {
        _log("killOtherCommanders error (no crítico): " + e.message);
    }
}

// ─── Lockfile ────────────────────────────────────────────────────────────────

function acquireLock() {
    if (fs.existsSync(_lockFile)) {
        let data;
        try {
            data = JSON.parse(fs.readFileSync(_lockFile, "utf8"));
        } catch (e) {
            _log("Lockfile corrupto. Reemplazando.");
            try { fs.unlinkSync(_lockFile); } catch (e2) {}
            data = null;
        }

        if (data) {
            if (isLockStale(data)) {
                _log("Lockfile stale (PID " + data.pid + "). Reemplazando.");
                try { fs.unlinkSync(_lockFile); } catch (e) {}
            } else {
                console.error("Commander ya corriendo (PID " + data.pid + "). Abortando.");
                process.exit(1);
            }
        }
    }

    killOtherCommanders();

    fs.writeFileSync(_lockFile, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), "utf8");
    _log("Lock adquirido (PID " + process.pid + ")");
}

function releaseLock() {
    try { fs.unlinkSync(_lockFile); } catch (e) {}
}

// ─── Offset persistente ─────────────────────────────────────────────────────

function loadOffset() {
    try {
        const data = JSON.parse(fs.readFileSync(_offsetFile, "utf8"));
        return { offset: data.offset || 0, timestamp: data.timestamp || null };
    } catch (e) { return { offset: 0, timestamp: null }; }
}

function saveOffset(offset) {
    try {
        fs.writeFileSync(_offsetFile, JSON.stringify({ offset, timestamp: new Date().toISOString() }), "utf8");
    } catch (e) {}
}

function detectOffsetGap(savedTimestamp) {
    if (!savedTimestamp) return false;
    try {
        const gap = Date.now() - new Date(savedTimestamp).getTime();
        if (gap > OFFSET_STALE_GAP_MS) {
            _log("Offset gap detectado: " + Math.round(gap / 1000) + "s desde último save — updates intermedios pueden ser stale");
            return true;
        }
    } catch (e) {}
    return false;
}

// ─── Conflict cooldown ───────────────────────────────────────────────────────

function writeConflictCooldown() {
    try {
        fs.writeFileSync(_conflictCooldownFile, JSON.stringify({ ts: Date.now(), pid: process.pid }), "utf8");
    } catch (e) {}
}

function clearConflictCooldown() {
    try { fs.unlinkSync(_conflictCooldownFile); } catch (e) {}
}

// ─── Trust pre-registration ─────────────────────────────────────────────────

function preTrustDirectory(absPath) {
    const mangled = absPath.replace(/[:\\/]/g, "-");
    const homeDir = process.env.USERPROFILE || process.env.HOME;
    const trustDir = path.join(homeDir, ".claude", "projects", mangled);
    if (!fs.existsSync(trustDir)) {
        fs.mkdirSync(trustDir, { recursive: true });
        _log("Trust pre-registrado: " + mangled);
    }
}

module.exports = {
    init,
    isProcessAlive,
    isLockStale,
    killOtherCommanders,
    acquireLock,
    releaseLock,
    loadOffset,
    saveOffset,
    detectOffsetGap,
    writeConflictCooldown,
    clearConflictCooldown,
    preTrustDirectory,
};
