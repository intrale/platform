// port-guard.js — Decisión de ownership y terminación de procesos del pipeline (#5722)
//
// POR QUÉ EXISTE ESTE MÓDULO
//
// El guard vivía inline en `restart.js`, un script de 737 líneas con side
// effects en el require y sin `module.exports`: no se podía importar. El test
// que supuestamente lo cubría reimplementaba el `onHolder` dentro del propio
// test, así que el test verde nunca ejecutó la línea que falló en producción.
// Por eso el fail-open pasó desapercibido durante el incidente del 2026-08-09,
// en el que el pipeline quedó 20 horas sin despachar agentes.
//
// EL FAIL-OPEN QUE SE CIERRA ACÁ
//
// El guard anterior decidía "¿es del pipeline?" leyendo la CommandLine. Cuando
// esa lectura fallaba (permisos) asumía que NO era del pipeline y lo perdonaba.
// Es exactamente al revés de lo que conviene: el proceso que ocupa el puerto
// del dashboard es, por definición, el que impide arrancar. Perdonarlo garantiza
// que el restart no pueda converger nunca.
//
// Todas las dependencias del sistema (scan de procesos, kill, sleep, log) se
// inyectan: el módulo es puro respecto del SO y los tests ejercitan ESTE código,
// no una copia.

'use strict';

// --- CLASIFICACIÓN DEL OCUPANTE ---

// El propio restart.js. Nunca se mata a sí mismo.
const HOLDER_SELF = 'self';
// node.exe con CommandLine legible que matchea el pipeline. Se mata.
const HOLDER_PIPELINE = 'pipeline';
// node.exe presente en el scan pero con CommandLine ILEGIBLE. Se trata como del
// pipeline cuando retiene el puerto configurado del dashboard (CA-1): imagen
// `node.exe` + retener justo ese puerto son las dos señales alternativas.
const HOLDER_OPAQUE_NODE = 'opaque-node';
// No aparece en el scan de procesos node ⇒ imagen distinta de node.exe, o
// node.exe con CommandLine legible y ajena. NO se mata (CA-6).
const HOLDER_FOREIGN = 'foreign';

// Exit code propio para "puerto bloqueado, no reintentar en loop" (CA-2). Un
// `exit(1)` genérico se confunde con cualquier otro fallo y habilita el
// crash-loop que este issue quiere evitar.
const EXIT_PORT_BLOCKED = 3;

// Marcadores de CommandLine que identifican un proceso del pipeline.
const PIPELINE_CMD_MARKERS = ['dashboard.js', '.pipeline'];

function _isPipelineCmd(cmd) {
  return PIPELINE_CMD_MARKERS.some((m) => cmd.includes(m));
}

// classifyHolder(pid, { processForPid, selfPid }) → { pid, kind, name, commandLine }
//
// `processForPid` debe respetar el contrato de pid-discovery: `null` significa
// EXCLUSIVAMENTE "no es un proceso node". Un registro con `commandLine` vacía
// significa "es node pero su CommandLine es ilegible" — que NO es evidencia de
// que sea ajeno.
function classifyHolder(pid, { processForPid, selfPid } = {}) {
  if (pid === selfPid) {
    return { pid, kind: HOLDER_SELF, name: null, commandLine: null };
  }

  const proc = typeof processForPid === 'function' ? processForPid(pid) : null;

  // Ausente del scan de node ⇒ ajeno de verdad. Única rama que perdona.
  if (!proc) {
    return { pid, kind: HOLDER_FOREIGN, name: null, commandLine: null };
  }

  const name = proc.name || null;
  const cmd = (proc.commandLine || '').trim();

  if (cmd && _isPipelineCmd(cmd)) {
    return { pid, kind: HOLDER_PIPELINE, name, commandLine: cmd };
  }
  if (cmd) {
    // node.exe con CommandLine legible que no es del pipeline: ajeno legítimo.
    return { pid, kind: HOLDER_FOREIGN, name, commandLine: cmd };
  }
  // CommandLine ilegible. Antes esto caía en "no es del pipeline" y sobrevivía.
  return { pid, kind: HOLDER_OPAQUE_NODE, name, commandLine: null };
}

// ¿Este holder se puede matar? Sólo procesos del pipeline (legibles u opacos).
function isKillable(kind) {
  return kind === HOLDER_PIPELINE || kind === HOLDER_OPAQUE_NODE;
}

// --- TERMINACIÓN CON FALLBACK VERIFICADO ---

// Comando manual que se le ofrece al operador cuando todo falló. Es el mismo
// que se verificó efectivo durante el incidente.
function manualKillCommand(pid, platform) {
  return platform === 'win32'
    ? `wmic process where "ProcessId=${pid}" call terminate`
    : `kill -9 ${pid}`;
}

function _strategiesFor(pid, platform) {
  if (platform === 'win32') {
    return [
      { label: 'taskkill /F /T', cmd: `taskkill /PID ${pid} /F /T` },
      // CA-3: verificado en el incidente — `wmic ... call terminate` termina
      // procesos donde `taskkill`/`Stop-Process` devuelven "Acceso denegado".
      { label: 'wmic call terminate', cmd: `wmic process where "ProcessId=${pid}" call terminate` },
    ];
  }
  return [
    { label: 'kill -TERM', cmd: `kill -TERM ${pid}` },
    { label: 'kill -KILL', cmd: `kill -KILL ${pid}` },
  ];
}

// terminateProcess(pid, deps) → { killed, intentos: [{ label, alive, error }] }
//
// CA-3. Dos reglas que el código anterior violaba:
//
//   1. NO se traga el error. Antes era `stdio:'ignore'` + `catch {}`: el
//      "Acceso denegado" desaparecía y no había evento del cual colgar el
//      fallback.
//   2. NO se confía en el exit code. `taskkill` puede reportar éxito y dejar el
//      proceso vivo. La comprobación fidedigna es `pidAlive(pid)` DESPUÉS del
//      intento — por eso se escala aunque el comando "haya salido bien".
function terminateProcess(pid, deps = {}) {
  const {
    exec,
    pidAlive,
    sleep = () => {},
    platform = process.platform,
    settleMs = 200,
  } = deps;

  const intentos = [];
  if (!pid) return { killed: false, intentos };

  for (const s of _strategiesFor(pid, platform)) {
    let error = null;
    try {
      exec(s.cmd);
    } catch (e) {
      // Se REGISTRA en vez de tragarse: es la señal que dispara el fallback.
      error = (e && (e.stderr ? String(e.stderr) : e.message)) || String(e);
      error = error.trim().split('\n')[0].slice(0, 200);
    }
    // Dar un instante al SO para reflejar la terminación antes de verificar.
    sleep(settleMs);
    const alive = pidAlive(pid);
    intentos.push({ label: s.label, alive, error });
    if (!alive) return { killed: true, intentos };
  }

  return { killed: false, intentos };
}

// --- GUARD DEL PUERTO DEL DASHBOARD ---

// freeDashboardPort(port, deps) → { free, port, holder }
//
// `holder` es la última clasificación observada (con `intentos` de terminación
// si se intentó matarlo). Cuando `free` es false, es lo que el caller necesita
// para construir la alerta de CA-2.
function freeDashboardPort(port, deps = {}) {
  const {
    waitForPortFree,
    processForPid,
    pidAlive,
    exec,
    log = () => {},
    sleep = () => {},
    selfPid = process.pid,
    platform = process.platform,
    attempts = 6,
    delayMs = 500,
  } = deps;

  let holder = null;

  const onHolder = (pid) => {
    const h = classifyHolder(pid, { processForPid, selfPid });
    holder = h;

    // Auditoría ANTES de matar: PID + imagen + CommandLine + veredicto.
    log(`  [puerto ${port}] holder PID ${pid} img=${h.name || '<desconocida>'} `
      + `cmd=${h.commandLine || '<ilegible>'} → ${h.kind}`);

    if (h.kind === HOLDER_SELF) return;

    if (h.kind === HOLDER_FOREIGN) {
      // CA-6: un ocupante genuinamente ajeno sigue sin matarse. La salida
      // correcta es el abort ruidoso del caller, que escala a humano.
      log(`  [puerto ${port}] PID ${pid} es un proceso ajeno — no se mata por diseño`);
      return;
    }

    if (h.kind === HOLDER_OPAQUE_NODE) {
      log(`  [puerto ${port}] PID ${pid} es node con CommandLine ilegible y retiene `
        + 'el puerto del dashboard — se trata como del pipeline (#5722)');
    }

    const res = terminateProcess(pid, { exec, pidAlive, sleep, platform });
    h.intentos = res.intentos;
    if (res.killed) {
      const via = res.intentos[res.intentos.length - 1].label;
      log(`  [puerto ${port}] PID ${pid} terminado vía ${via}`);
    } else {
      const detalle = res.intentos.map((i) => `${i.label}${i.error ? ` (${i.error})` : ''}`).join(' → ');
      log(`  [puerto ${port}] PID ${pid} NO se pudo terminar: ${detalle}`);
    }
  };

  const free = waitForPortFree(port, { attempts, delayMs, onHolder });
  return { free, port, holder };
}

// --- COPY DEL ABORT (CA-2) ---
//
// El mensaje lo lee un humano con el pipeline caído, posiblemente de
// madrugada. Tiene que responder tres preguntas sin abrir un log: qué pasó (en
// consecuencia, no en implementación), qué se intentó, y qué hacer.

function _intentosResumen(holder, platform) {
  const intentos = (holder && holder.intentos) || [];
  if (!intentos.length) return 'no se intentó terminarlo (proceso ajeno)';
  return intentos.map((i) => i.label).join(', ');
}

// buildAbortAlert({ port, holder, platform, attempts, delayMs })
//   → { telegram, logText, foreign }
function buildAbortAlert({ port, holder, platform = process.platform, attempts = 6, delayMs = 500 } = {}) {
  const pid = holder && holder.pid;
  const kind = (holder && holder.kind) || HOLDER_FOREIGN;
  const foreign = kind === HOLDER_FOREIGN;
  const img = (holder && holder.name) || 'desconocida';
  const backoff = `backoff ${attempts}×${delayMs}ms`;

  // Los dos desenlaces NO comparten texto: "bug nuestro, urgente" y "proceso
  // ajeno, correcto por diseño pero necesita humano" son situaciones distintas
  // y el operador tiene que separarlas de un vistazo.
  let titulo;
  let detalle;
  if (foreign) {
    titulo = `⚠️ *Pipeline restart ABORTADO — puerto ${port} ocupado por un proceso ajeno*`;
    detalle = pid
      ? `Holder PID ${pid} (${img}): no es del pipeline, no se mata por diseño.`
      : 'No se pudo identificar al ocupante del puerto.';
  } else {
    const cmdTxt = kind === HOLDER_OPAQUE_NODE ? 'CommandLine ilegible' : 'proceso del pipeline';
    titulo = `🚨 *Pipeline restart ABORTADO — puerto ${port} ocupado*`;
    detalle = `Holder PID ${pid} (${img}, ${cmdTxt}), del pipeline pero no se pudo terminar.`;
  }

  const cuerpo = [
    titulo,
    detalle,
    `Se agotaron: ${backoff}, ${_intentosResumen(holder, platform)}.`,
    'El arranque se detuvo: seguir habría dejado el dashboard sin escuchar.',
  ];

  if (pid && !foreign) {
    cuerpo.push('', 'Para destrabar a mano:', `\`${manualKillCommand(pid, platform)}\``);
  } else if (pid) {
    cuerpo.push('', `Revisar quién retiene el puerto ${port} y liberarlo antes de reintentar el restart.`);
  }

  const telegram = cuerpo.join('\n');

  const logText = pid
    ? `  [puerto ${port}] ABORT — holder PID ${pid} (${img}, ${kind}) sigue tomando el puerto `
      + `tras ${backoff}. No se relanza: el arranque estaría condenado. `
      + (foreign ? 'Ocupante ajeno: requiere intervención humana.'
                 : `Destrabe manual: ${manualKillCommand(pid, platform)}`)
    : `  [puerto ${port}] ABORT — el puerto sigue tomado tras ${backoff} y no se pudo `
      + 'identificar al ocupante. No se relanza.';

  return { telegram, logText, foreign };
}

// --- SELECCIÓN DE PIDs PARA EL KILL PRINCIPAL (CA-5) ---
//
// Fail-open gemelo, mismo origen: `killAll()` hacía `if (!p.commandLine)
// continue`, así que un node.exe del pipeline con CommandLine ilegible escapaba
// del kill principal en silencio. Quedaba tapado sólo para el holder del puerto
// del dashboard; pulpo y servicios sobrevivían — el mismo modo de falla de #5704.
//
// El cierre es ACOTADO a propósito: matar todo node.exe opaco sería destructivo
// (se llevaría puestos editores, MCP servers y agentes). Un proceso opaco se
// mata sólo si hay corroboración de ownership del propio pipeline:
//   - su PID está declarado en un archivo `.pid` que escribió un componente, o
//   - retiene el puerto del dashboard.
//
// selectPipelinePidsToKill({...}) → { pids: number[], opacos: [{ pid, motivo }] }
function selectPipelinePidsToKill({
  processes = [],
  scriptNames = [],
  declaredPids = new Map(),
  dashOwner = null,
  selfPid = process.pid,
} = {}) {
  const pids = new Set();
  const opacos = [];
  const names = [...scriptNames];

  for (const p of processes) {
    if (!p || !p.pid || p.pid === selfPid) continue;
    const cmd = (p.commandLine || '').trim();

    if (!cmd) {
      // CommandLine ilegible: se decide por corroboración, no perdonando.
      let motivo = null;
      if (declaredPids.has(p.pid)) motivo = `declarado en ${declaredPids.get(p.pid)}`;
      else if (dashOwner && p.pid === dashOwner) motivo = 'retiene el puerto del dashboard';
      if (motivo) {
        pids.add(p.pid);
        opacos.push({ pid: p.pid, motivo });
      }
      continue;
    }

    const matchByPath = cmd.includes('.pipeline');
    const matchByScript = names.some((s) => cmd.includes(s));
    if (matchByPath || matchByScript) pids.add(p.pid);
  }

  // El ocupante del puerto del dashboard entra aunque no haya matcheado arriba
  // (caso borde: respawn del watchdog entre el scan y el kill).
  if (dashOwner && dashOwner !== selfPid) pids.add(dashOwner);

  return { pids: [...pids], opacos };
}

module.exports = {
  HOLDER_SELF,
  HOLDER_PIPELINE,
  HOLDER_OPAQUE_NODE,
  HOLDER_FOREIGN,
  EXIT_PORT_BLOCKED,
  classifyHolder,
  isKillable,
  terminateProcess,
  freeDashboardPort,
  buildAbortAlert,
  manualKillCommand,
  selectPipelinePidsToKill,
};
