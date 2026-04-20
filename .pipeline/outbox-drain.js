#!/usr/bin/env node
// outbox-drain.js — Mini-servicio standalone que drena el outbox de Telegram
// Se auto-mata si detecta que el Pulpo está corriendo (él ya drena)
// Se levanta automáticamente desde context-cli al unirse a un canal telegram
//
// Uso: node .pipeline/outbox-drain.js
"use strict";

const fs = require("fs");
const path = require("path");

const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);
const ROOT = process.env.PIPELINE_MAIN_ROOT || path.resolve(PIPELINE, "..");
const DRAIN_INTERVAL_MS = 3000;
const PULPO_CHECK_INTERVAL_MS = 15000;
const PID_FILE = path.join(PIPELINE, "outbox-drain.pid");

// Singleton: si ya hay otro corriendo, salir silenciosamente
const { spawnSync } = require("child_process");

function findProcess(scriptName) {
  try {
    // shell:true preserva comillas del filtro wmic (mismo motivo que pid-discovery.js).
    const r = spawnSync(
      `wmic process where "name='node.exe'" get ProcessId,CommandLine /format:csv 2>NUL`,
      { encoding: "utf8", timeout: 10000, windowsHide: true, shell: true }
    );
    const lines = (r.stdout || "").split("\n");
    for (const line of lines) {
      if (line.includes(scriptName) && !line.includes("wmic")) {
        const match = line.match(/(\d+)\s*$/);
        if (match && parseInt(match[1]) !== process.pid) return parseInt(match[1]);
      }
    }
  } catch {}
  return null;
}

// Si ya hay otro outbox-drain corriendo, salir
const existing = findProcess("outbox-drain.js");
if (existing) {
  process.exit(0);
}

// Escribir PID
fs.writeFileSync(PID_FILE, String(process.pid));
process.on("exit", () => {
  try {
    const current = fs.readFileSync(PID_FILE, "utf8").trim();
    if (current === String(process.pid)) fs.unlinkSync(PID_FILE);
  } catch {}
});

function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] [outbox-drain] ${msg}`);
}

log("Iniciado (PID " + process.pid + ") — drain cada " + (DRAIN_INTERVAL_MS / 1000) + "s");

// Drain loop
const outbox = require(path.join(ROOT, ".claude", "hooks", "telegram-outbox"));

const drainTimer = setInterval(() => {
  outbox.drainQueue().then(r => {
    if (r.sent > 0) log("Enviados: " + r.sent + (r.failed > 0 ? ", fallidos: " + r.failed : ""));
  }).catch(() => {});
}, DRAIN_INTERVAL_MS);

// Auto-kill si el Pulpo arranca (él tiene su propio drain en mainLoop)
const pulpoCheckTimer = setInterval(() => {
  const pulpoPid = findProcess("pulpo.js");
  if (pulpoPid) {
    log("Pulpo detectado (PID " + pulpoPid + ") — auto-shutdown");
    clearInterval(drainTimer);
    clearInterval(pulpoCheckTimer);
    process.exit(0);
  }
}, PULPO_CHECK_INTERVAL_MS);

// Graceful shutdown
process.on("SIGINT", () => { log("SIGINT"); process.exit(0); });
process.on("SIGTERM", () => { log("SIGTERM"); process.exit(0); });
