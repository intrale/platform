'use strict';

// pid-discovery.js — descubrimiento dinámico del PID de un agente en vuelo.
//
// Reemplaza la lectura de `.claude/hooks/agent-registry.json` cuando necesitamos
// matar un agente desde el dashboard. El registry sufría race conditions
// (stale PIDs reutilizados por el OS, falta de sincronización entre spawn y
// session:start) y era una fuente de verdad duplicada.
//
// Estrategia de descubrimiento:
//
//   1) Scan de procesos vivos (PowerShell Get-CimInstance Win32_Process)
//      filtrando por CommandLine — funciona para agentes determinísticos
//      (node.exe con skills-deterministicos/<skill>.js y el issue en argv).
//
//   2) Heartbeat file (.claude/hooks/agent-<issue>.heartbeat) como fuente
//      secundaria — aporta el PID de agentes LLM (claude.exe) porque el
//      CommandLine de claude no contiene el número de issue (viene por env
//      o por el prompt `-p`). Se valida que el PID esté vivo Y que su
//      proceso sea claude.exe / node.exe antes de confiar en él.
//
// Todos los PIDs retornados están verificados (proceso vivo + cmdline
// consistente con un agente). Eso previene matar procesos ajenos por
// PID reuse.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const HEARTBEAT_DIR = path.join(PROJECT_ROOT, '.claude', 'hooks');
const HEARTBEAT_MAX_AGE_MS = 5 * 60 * 1000; // 5 min — heartbeat anterior se considera stale

/**
 * Lista procesos node.exe / claude.exe con su CommandLine.
 * Retorna [{ pid: number, name: string, cmdline: string }, ...].
 *
 * En entornos sin PowerShell (tests), el caller puede inyectar `runner` para
 * stubear la salida.
 */
function listProcesses({ runner } = {}) {
  const defaultRunner = () => {
    // PowerShell Get-CimInstance devuelve CSV con ProcessId + CommandLine.
    // Filtramos por nombre para reducir el volumen de datos parseados.
    const script = [
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='claude.exe'\"",
      '| Select-Object ProcessId,Name,CommandLine',
      '| ConvertTo-Csv -NoTypeInformation',
    ].join(' ');
    return execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
  };
  const exec = runner || defaultRunner;
  let csv;
  try {
    csv = exec();
  } catch {
    return [];
  }
  return parseProcessCsv(csv);
}

/**
 * Parsea la salida CSV de `Get-CimInstance | ConvertTo-Csv`.
 *
 * Cada fila: "PID","Name","CommandLine" (con comillas dobles escapadas
 * duplicándose: `""` → `"`). Se ignora la cabecera.
 */
function parseProcessCsv(csv) {
  if (!csv || typeof csv !== 'string') return [];
  const lines = csv.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length <= 1) return [];
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i]);
    if (fields.length < 2) continue;
    const pid = parseInt(fields[0], 10);
    if (!Number.isFinite(pid)) continue;
    const name = (fields[1] || '').toLowerCase();
    const cmdline = fields[2] || '';
    rows.push({ pid, name, cmdline });
  }
  return rows;
}

/**
 * Split de una línea CSV con comillas dobles escapadas (`""` dentro del campo).
 */
function splitCsvLine(line) {
  const out = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (line[i] === '"') {
      // Campo con comillas
      let buf = '';
      i++;
      while (i < n) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            buf += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          buf += line[i];
          i++;
        }
      }
      out.push(buf);
      if (line[i] === ',') i++;
    } else {
      // Campo sin comillas — leer hasta la próxima coma
      let buf = '';
      while (i < n && line[i] !== ',') {
        buf += line[i];
        i++;
      }
      out.push(buf);
      if (line[i] === ',') i++;
    }
  }
  return out;
}

/**
 * Valida si una línea de comando corresponde a un agente determinístico
 * para (issue, skill). Match por presencia del archivo del skill Y del issue
 * como token independiente.
 */
function matchesDeterministicAgent(cmdline, issue, skill) {
  if (!cmdline) return false;
  const lower = cmdline.toLowerCase();
  // El script se invoca como `node <path>\skills-deterministicos\<skill>.js`
  const skillMarker = `skills-deterministicos`;
  const skillFile = `${String(skill).toLowerCase()}.js`;
  if (!lower.includes(skillMarker)) return false;
  if (!lower.includes(skillFile)) return false;
  // El issue viene como primer argumento posicional: `... <skill>.js 2486 --trabajando=...`.
  // Usamos una regex con word boundary para evitar falsos positivos (eg. 24860).
  const issueRe = new RegExp(`\\b${String(issue)}\\b`);
  return issueRe.test(cmdline);
}

/**
 * Lee el heartbeat de un issue. Retorna el objeto parseado o null si no existe
 * o está malformado.
 */
function readHeartbeat(issue, { heartbeatDir = HEARTBEAT_DIR } = {}) {
  const file = path.join(heartbeatDir, `agent-${issue}.heartbeat`);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(raw);
    const stat = fs.statSync(file);
    return { ...json, file, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Descubre los PIDs verificados de un agente en vuelo para (issue [, skill]).
 *
 * Retorna un array de candidatos: [{ pid, source, name, cmdline }].
 *
 *   - source: 'process-scan' (match por cmdline) o 'heartbeat' (PID leído del
 *     heartbeat y confirmado vivo con cmdline node.exe / claude.exe).
 *
 * Parámetros opcionales para inyección en tests:
 *   - listRunner: función que devuelve el CSV de Get-CimInstance.
 *   - heartbeatDir: carpeta alternativa para el heartbeat.
 *   - now: epoch ms (para test de frescura del heartbeat).
 */
function discoverAgentPids({ issue, skill, listRunner, heartbeatDir, now } = {}) {
  if (!issue) return [];
  const nowMs = typeof now === 'number' ? now : Date.now();
  const processes = listProcesses({ runner: listRunner });
  const byPid = new Map();

  // 1) Scan por cmdline — determinísticos (si se pasó skill).
  if (skill) {
    for (const proc of processes) {
      if (proc.name !== 'node.exe') continue;
      if (matchesDeterministicAgent(proc.cmdline, issue, skill)) {
        byPid.set(proc.pid, {
          pid: proc.pid,
          source: 'process-scan',
          name: proc.name,
          cmdline: proc.cmdline,
        });
      }
    }
  }

  // 2) Heartbeat — aporta PID de agentes LLM (claude.exe) que no son scanneables
  // por cmdline. Validación:
  //   a) Archivo fresco (< 5 min). Un heartbeat viejo indica agente muerto.
  //   b) El PID declarado aparece en el scan vivo.
  //   c) El proceso es claude.exe o node.exe (evita matar otro proceso con PID reusado).
  const hb = readHeartbeat(issue, { heartbeatDir });
  if (hb && hb.pid && (nowMs - hb.mtimeMs) <= HEARTBEAT_MAX_AGE_MS) {
    const alive = processes.find(p => p.pid === hb.pid);
    if (alive && (alive.name === 'claude.exe' || alive.name === 'node.exe')) {
      if (!byPid.has(alive.pid)) {
        byPid.set(alive.pid, {
          pid: alive.pid,
          source: 'heartbeat',
          name: alive.name,
          cmdline: alive.cmdline,
        });
      }
    }
  }

  return Array.from(byPid.values());
}

module.exports = {
  discoverAgentPids,
  listProcesses,
  parseProcessCsv,
  splitCsvLine,
  matchesDeterministicAgent,
  readHeartbeat,
  HEARTBEAT_MAX_AGE_MS,
};
