// circuit-breaker.js — Solucion S3 del reporte operativo 2026-03-24
// Patron Open/Half-Open/Closed para agent-recovery
// Previene loops infinitos de reintento con backoff exponencial
"use strict";

const fs = require("fs");
const path = require("path");

const HOOKS_DIR = __dirname;
const STATE_FILE = path.join(HOOKS_DIR, "circuit-breaker-state.json");

// --- Parametros ---
const MAX_FAILURES_BEFORE_OPEN = 3;   // Fallos consecutivos por agente antes de abrir
const BACKOFF_BASE_MS = 60 * 1000;    // 1 minuto base
const BACKOFF_MAX_MS = 600 * 1000;    // 10 minutos techo
const MAX_OPEN_CYCLES = 5;            // Ciclos open antes de parada permanente
const SYSTEMIC_FAILURE_THRESHOLD = 0.5; // 50% de agentes fallando = fallo sistemico

// --- Atomic write (usa S1 si disponible, fallback a fs directo) ---
let atomicWrite;
try { atomicWrite = require("./atomic-write"); } catch (_) { atomicWrite = null; }

function readState() {
  if (atomicWrite) return atomicWrite.readJsonSafe(STATE_FILE, { agents: {}, global: {} });
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (_) { return { agents: {}, global: {} }; }
}

function writeState(state) {
  if (atomicWrite) { atomicWrite.writeJsonAtomic(STATE_FILE, state); return; }
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8"); } catch (_) {}
}

/**
 * Obtiene o crea el estado del circuit breaker para un agente.
 */
function getAgentState(state, agentId) {
  if (!state.agents) state.agents = {};
  if (!state.agents[agentId]) {
    state.agents[agentId] = {
      status: "CLOSED",       // CLOSED | OPEN | HALF_OPEN | STOPPED
      consecutiveFailures: 0,
      openCycles: 0,
      lastFailureTs: null,
      nextRetryTs: null,
      backoffMs: BACKOFF_BASE_MS
    };
  }
  return state.agents[agentId];
}

/**
 * Verifica si un agente puede ser relanzado.
 * @param {string} agentId - Identificador del agente (ej: issue number)
 * @returns {{ allowed: boolean, reason: string, nextRetryIn: number|null }}
 */
function canRelaunch(agentId) {
  const state = readState();
  const agent = getAgentState(state, String(agentId));
  const now = Date.now();

  switch (agent.status) {
    case "CLOSED":
      return { allowed: true, reason: "circuit closed (normal)", nextRetryIn: null };

    case "HALF_OPEN":
      return { allowed: true, reason: "circuit half-open (probe attempt)", nextRetryIn: null };

    case "OPEN":
      if (agent.nextRetryTs && now >= agent.nextRetryTs) {
        // Backoff expirado -> transicionar a HALF_OPEN
        agent.status = "HALF_OPEN";
        writeState(state);
        return { allowed: true, reason: "backoff expired, trying half-open probe", nextRetryIn: null };
      }
      const waitMs = agent.nextRetryTs ? agent.nextRetryTs - now : agent.backoffMs;
      return {
        allowed: false,
        reason: "circuit OPEN (backoff " + Math.round(waitMs / 1000) + "s remaining, cycle " + agent.openCycles + "/" + MAX_OPEN_CYCLES + ")",
        nextRetryIn: waitMs
      };

    case "STOPPED":
      return {
        allowed: false,
        reason: "circuit STOPPED permanently after " + MAX_OPEN_CYCLES + " cycles — manual intervention required",
        nextRetryIn: null
      };

    default:
      return { allowed: true, reason: "unknown state, allowing", nextRetryIn: null };
  }
}

/**
 * Registra un fallo de relaunch para un agente.
 * @param {string} agentId
 */
function recordFailure(agentId) {
  const state = readState();
  const agent = getAgentState(state, String(agentId));
  const now = Date.now();

  agent.consecutiveFailures++;
  agent.lastFailureTs = new Date(now).toISOString();

  if (agent.status === "HALF_OPEN") {
    // Fallo en half-open -> volver a OPEN con backoff incrementado
    agent.status = "OPEN";
    agent.openCycles++;
    agent.backoffMs = Math.min(agent.backoffMs * 2, BACKOFF_MAX_MS);
    agent.nextRetryTs = now + agent.backoffMs;

    if (agent.openCycles >= MAX_OPEN_CYCLES) {
      agent.status = "STOPPED";
      agent.nextRetryTs = null;
    }
  } else if (agent.consecutiveFailures >= MAX_FAILURES_BEFORE_OPEN) {
    // Demasiados fallos -> abrir circuit
    agent.status = "OPEN";
    agent.openCycles++;
    agent.nextRetryTs = now + agent.backoffMs;

    if (agent.openCycles >= MAX_OPEN_CYCLES) {
      agent.status = "STOPPED";
      agent.nextRetryTs = null;
    }
  }

  writeState(state);
  return agent;
}

/**
 * Registra un exito de relaunch para un agente.
 * @param {string} agentId
 */
function recordSuccess(agentId) {
  const state = readState();
  const agent = getAgentState(state, String(agentId));

  agent.status = "CLOSED";
  agent.consecutiveFailures = 0;
  agent.openCycles = 0;
  agent.backoffMs = BACKOFF_BASE_MS;
  agent.nextRetryTs = null;

  writeState(state);
  return agent;
}

/**
 * Evalua si hay un fallo sistemico (>50% de agentes en estado abierto/parado).
 * @returns {{ systemic: boolean, failedCount: number, totalCount: number, pct: number }}
 */
function evaluateSystemicFailure() {
  const state = readState();
  const agents = Object.values(state.agents || {});
  if (agents.length === 0) return { systemic: false, failedCount: 0, totalCount: 0, pct: 0 };

  const failed = agents.filter(a => a.status === "OPEN" || a.status === "STOPPED" || a.status === "HALF_OPEN");
  const pct = failed.length / agents.length;

  return {
    systemic: pct >= SYSTEMIC_FAILURE_THRESHOLD,
    failedCount: failed.length,
    totalCount: agents.length,
    pct: Math.round(pct * 100)
  };
}

/**
 * Resetea el estado completo del circuit breaker (para inicio de nuevo sprint).
 */
function reset() {
  writeState({ agents: {}, global: { resetAt: new Date().toISOString() } });
}

/**
 * Obtiene el estado actual para diagnostico.
 */
function getStatus() {
  return readState();
}

module.exports = {
  canRelaunch,
  recordFailure,
  recordSuccess,
  evaluateSystemicFailure,
  reset,
  getStatus,
  // Constantes expuestas para testing
  MAX_FAILURES_BEFORE_OPEN,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  MAX_OPEN_CYCLES,
  SYSTEMIC_FAILURE_THRESHOLD
};
