// =============================================================================
// Tests port-guard — #5722
//
// El guard de puerto del restart hacía fail-open cuando no podía leer la
// CommandLine del ocupante: lo perdonaba, el dashboard no podía hacer listen y
// el pipeline quedó 20 horas sin despachar agentes.
//
// DIFERENCIA CLAVE CON EL TEST ANTERIOR (#4308): aquel reimplementaba el
// `onHolder` dentro del propio test, así que verificaba una copia y nunca
// ejecutó la línea que falló en producción. Estos tests importan y ejercitan
// EL GUARD REAL (`lib/port-guard.js`), inyectándole las dependencias del SO.
//
//   CA-1 → holder node.exe con CommandLine ilegible: se clasifica del pipeline
//          y SE MATA (antes se perdonaba).
//   CA-2 → puerto que nunca se libera: free=false + alerta con PID, qué se
//          intentó y comando de destrabe; distinta severidad si es ajeno.
//   CA-3 → taskkill falla o "tiene éxito" dejando el proceso vivo: escala a
//          `wmic call terminate`; el veredicto sale de pidAlive, no del exit code.
//   CA-5 → selección de PIDs de killAll: el opaco corroborado se mata, el opaco
//          sin corroborar no.
//   CA-6 → holder genuinamente ajeno: NO se mata (el fix no puede degenerar en
//          "matar cualquier cosa que toque el 3200").
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../port-guard');
const pid = require('../../pid-discovery');

// --- Helpers ---------------------------------------------------------------

// Tabla de procesos "vivos" simulada. `commandLine: ''` modela el caso del
// incidente: node.exe cuya CommandLine es ilegible por permisos.
function fakeProcessTable(rows) {
  return (p) => rows.find((r) => r.pid === p) || null;
}

// Simula el SO: `taskkill` no puede con ciertos PIDs (Acceso denegado), pero
// `wmic call terminate` sí. Registra los comandos ejecutados.
function fakeOs({ vivos = [], inmunesATaskkill = [], taskkillSilencioso = false } = {}) {
  const alive = new Set(vivos);
  const comandos = [];
  return {
    comandos,
    alive,
    exec(cmd) {
      comandos.push(cmd);
      const m = cmd.match(/(?:\/PID |ProcessId=)(\d+)/);
      const target = m ? parseInt(m[1], 10) : null;
      if (cmd.startsWith('taskkill')) {
        if (inmunesATaskkill.includes(target)) {
          // taskkillSilencioso modela el caso peor: el comando "sale bien" pero
          // el proceso sigue vivo. Si no, tira el "Acceso denegado" real.
          if (taskkillSilencioso) return '';
          const err = new Error('ERROR: no se puede terminar el proceso');
          err.stderr = 'ERROR: Acceso denegado.';
          throw err;
        }
        alive.delete(target);
        return '';
      }
      if (cmd.startsWith('wmic')) {
        alive.delete(target); // verificado efectivo en el incidente
        return 'ReturnValue = 0;';
      }
      return '';
    },
    pidAlive: (p) => alive.has(p),
  };
}

// Sustituye pid.findPidByPort por una secuencia. waitForPortFree lo resuelve
// vía module.exports, así que esta sustitución impacta sus llamadas internas.
function withFindPidByPortSequence(sequence, fn) {
  const original = pid.findPidByPort;
  let i = 0;
  pid.findPidByPort = () => {
    const v = i < sequence.length ? sequence[i] : sequence[sequence.length - 1];
    i++;
    return v;
  };
  try {
    return fn();
  } finally {
    pid.findPidByPort = original;
  }
}

// Ejecuta el guard REAL contra un SO simulado.
function runGuard({ port = 3200, tabla = [], os, secuenciaPuerto, attempts = 3 }) {
  const logs = [];
  let res;
  withFindPidByPortSequence(secuenciaPuerto, () => {
    res = guard.freeDashboardPort(port, {
      waitForPortFree: pid.waitForPortFree,
      processForPid: fakeProcessTable(tabla),
      pidAlive: os.pidAlive,
      exec: os.exec,
      log: (m) => logs.push(m),
      sleep: () => {},           // sin sleeps reales
      selfPid: 999999,
      platform: 'win32',
      attempts,
      delayMs: 0,
    });
  });
  return { res, logs };
}

// --- CA-1: el fail-open del incidente ---------------------------------------

test('CA-1 · un holder node.exe con CommandLine ILEGIBLE se trata como del pipeline y SE MATA', () => {
  // Reproduce el incidente: PID 17168, node.exe, CommandLine vacía por permisos.
  const os = fakeOs({ vivos: [17168] });
  const { res, logs } = runGuard({
    tabla: [{ pid: 17168, name: 'node.exe', commandLine: '', creationDate: '' }],
    os,
    // holder la primera vuelta; una vez muerto, el puerto queda libre.
    secuenciaPuerto: [17168, null],
  });

  assert.equal(res.free, true, 'el puerto termina libre: el guard convergió');
  assert.equal(res.holder.kind, guard.HOLDER_OPAQUE_NODE,
    'se clasifica como node opaco, NO como ajeno');
  assert.ok(os.comandos.some((c) => c.includes('17168')),
    'se intentó terminar el PID que retenía el puerto');
  assert.ok(!os.alive.has(17168), 'el ocupante quedó efectivamente muerto');
  assert.ok(logs.some((l) => /CommandLine ilegible/.test(l)),
    'el log explicita por qué se lo trató como del pipeline (auditoría)');
});

test('CA-1 · classifyHolder distingue "no es node" de "es node con CommandLine ilegible"', () => {
  const processForPid = fakeProcessTable([
    { pid: 100, name: 'node.exe', commandLine: '' },                       // opaco
    { pid: 200, name: 'node.exe', commandLine: 'node C:\\...\\.pipeline\\dashboard.js' },
    { pid: 300, name: 'node.exe', commandLine: 'node C:\\otra-app\\server.js' },
  ]);
  const deps = { processForPid, selfPid: 999999 };

  assert.equal(classify(100), guard.HOLDER_OPAQUE_NODE, 'node.exe opaco ≠ ajeno');
  assert.equal(classify(200), guard.HOLDER_PIPELINE);
  assert.equal(classify(300), guard.HOLDER_FOREIGN, 'node.exe legible y ajeno');
  assert.equal(classify(400), guard.HOLDER_FOREIGN, 'ausente del scan ⇒ no es node');
  assert.equal(classify(999999), guard.HOLDER_SELF, 'nunca se mata a sí mismo');

  function classify(p) { return guard.classifyHolder(p, deps).kind; }
});

// --- CA-6: no degenerar en "matar cualquier cosa" ---------------------------

test('CA-6 · un holder genuinamente ajeno (no es node) NO se mata, y el guard no converge', () => {
  const os = fakeOs({ vivos: [4242] });
  const { res, logs } = runGuard({
    tabla: [],                      // 4242 no está en el scan de node ⇒ ajeno
    os,
    secuenciaPuerto: [4242],        // nunca se libera
  });

  assert.equal(res.free, false);
  assert.equal(res.holder.kind, guard.HOLDER_FOREIGN);
  assert.deepEqual(os.comandos, [], 'no se ejecutó NINGÚN comando de kill contra un ajeno');
  assert.ok(os.alive.has(4242), 'el proceso ajeno sigue vivo');
  assert.ok(logs.some((l) => /no se mata por diseño/.test(l)));
});

test('CA-6 · un node.exe ajeno con CommandLine legible tampoco se mata', () => {
  const os = fakeOs({ vivos: [9999] });
  const { res } = runGuard({
    tabla: [{ pid: 9999, name: 'node.exe', commandLine: 'node C:\\Program Files\\Foo\\server.js' }],
    os,
    secuenciaPuerto: [9999],
  });

  assert.equal(res.holder.kind, guard.HOLDER_FOREIGN);
  assert.deepEqual(os.comandos, [], 'CommandLine legible y ajena ⇒ no se toca');
  assert.ok(os.alive.has(9999));
});

// --- CA-3: fallback wmic verificado por pidAlive ----------------------------

test('CA-3 · si taskkill da "Acceso denegado", se escala a `wmic call terminate`', () => {
  const os = fakeOs({ vivos: [17168], inmunesATaskkill: [17168] });

  const res = guard.terminateProcess(17168, {
    exec: os.exec, pidAlive: os.pidAlive, sleep: () => {}, platform: 'win32',
  });

  assert.equal(res.killed, true, 'el fallback lo terminó');
  assert.equal(res.intentos.length, 2, 'primero taskkill, después wmic');
  assert.equal(res.intentos[0].label, 'taskkill /F /T');
  assert.match(res.intentos[0].error, /Acceso denegado/,
    'el error NO se traga: es la señal que justifica el fallback');
  assert.equal(res.intentos[0].alive, true, 'tras taskkill seguía vivo');
  assert.equal(res.intentos[1].label, 'wmic call terminate');
  assert.equal(res.intentos[1].alive, false);
  assert.ok(os.comandos[1].includes('wmic process where "ProcessId=17168" call terminate'));
});

test('CA-3 · el veredicto sale de pidAlive, no del exit code: taskkill "exitoso" pero proceso vivo igual escala', () => {
  // El caso más traicionero: el comando no falla, pero no mata nada. Un guard
  // que confiara en el exit code daría por terminado un proceso vivo.
  const os = fakeOs({ vivos: [15636], inmunesATaskkill: [15636], taskkillSilencioso: true });

  const res = guard.terminateProcess(15636, {
    exec: os.exec, pidAlive: os.pidAlive, sleep: () => {}, platform: 'win32',
  });

  assert.equal(res.intentos[0].error, null, 'taskkill no reportó error alguno');
  assert.equal(res.intentos[0].alive, true, 'pero el proceso seguía vivo');
  assert.equal(res.killed, true);
  assert.equal(res.intentos[1].label, 'wmic call terminate', 'se escaló igual');
});

test('CA-3 · si ninguna estrategia termina el proceso, killed=false con el detalle de lo intentado', () => {
  const os = fakeOs({ vivos: [7777] });
  os.exec = (cmd) => { os.comandos.push(cmd); throw new Error('Acceso denegado'); };

  const res = guard.terminateProcess(7777, {
    exec: os.exec, pidAlive: os.pidAlive, sleep: () => {}, platform: 'win32',
  });

  assert.equal(res.killed, false);
  assert.deepEqual(res.intentos.map((i) => i.label), ['taskkill /F /T', 'wmic call terminate']);
  assert.ok(res.intentos.every((i) => i.alive === true));
});

// --- CA-2: abort ruidoso ----------------------------------------------------

test('CA-2 · si el puerto sigue tomado tras el backoff, el guard NO reporta éxito', () => {
  const os = fakeOs({ vivos: [17168] });
  os.exec = (cmd) => { os.comandos.push(cmd); throw new Error('Acceso denegado'); };

  const { res } = runGuard({
    tabla: [{ pid: 17168, name: 'node.exe', commandLine: '' }],
    os,
    secuenciaPuerto: [17168],   // nunca se libera
    attempts: 3,
  });

  assert.equal(res.free, false, 'no se avanza a un arranque condenado');
  assert.equal(res.holder.pid, 17168, 'el holder viaja al caller para la alerta');
  assert.ok(res.holder.intentos.length >= 2, 'se registró lo que se intentó');
});

test('CA-2 · la alerta del holder del pipeline es 🚨, dice qué se intentó y trae el comando de destrabe con el PID', () => {
  const holder = {
    pid: 17168,
    kind: guard.HOLDER_OPAQUE_NODE,
    name: 'node.exe',
    commandLine: null,
    intentos: [
      { label: 'taskkill /F /T', alive: true, error: 'Acceso denegado' },
      { label: 'wmic call terminate', alive: true, error: null },
    ],
  };
  const alerta = guard.buildAbortAlert({ port: 3200, holder, platform: 'win32', attempts: 6, delayMs: 500 });

  assert.equal(alerta.foreign, false);
  assert.match(alerta.telegram, /🚨/, 'severidad de incidente: es un bug nuestro');
  assert.match(alerta.telegram, /puerto 3200/);
  assert.match(alerta.telegram, /17168/, 'el operador no tiene que buscar el PID en un log');
  assert.match(alerta.telegram, /CommandLine ilegible/);
  assert.match(alerta.telegram, /taskkill \/F \/T, wmic call terminate/, 'qué se intentó');
  assert.match(alerta.telegram, /wmic process where "ProcessId=17168" call terminate/,
    'comando de destrabe con el PID ya interpolado');
  assert.ok(!/se avanza igual/.test(alerta.telegram + alerta.logText),
    'desaparece el copy que mentía tranquilizando');
});

test('CA-2/CA-6 · la alerta del holder ajeno usa ⚠️ y NO ofrece matarlo', () => {
  const holder = { pid: 4242, kind: guard.HOLDER_FOREIGN, name: null, commandLine: null };
  const alerta = guard.buildAbortAlert({ port: 3200, holder, platform: 'win32' });

  assert.equal(alerta.foreign, true);
  assert.match(alerta.telegram, /⚠️/, 'no es incidente propio: severidad distinta');
  assert.ok(!/🚨/.test(alerta.telegram), 'los dos desenlaces no comparten severidad');
  assert.match(alerta.telegram, /ajeno/);
  assert.ok(!/call terminate/.test(alerta.telegram),
    'no se le sugiere al operador matar un proceso que no es nuestro');
});

test('CA-2 · el exit code del abort es propio y distinto del genérico', () => {
  assert.equal(guard.EXIT_PORT_BLOCKED, 3);
  assert.notEqual(guard.EXIT_PORT_BLOCKED, 1);
});

// --- CA-5: fail-open gemelo de killAll() ------------------------------------

test('CA-5 · un node del pipeline con CommandLine ilegible declarado en un .pid NO escapa del kill', () => {
  const { pids, opacos } = guard.selectPipelinePidsToKill({
    processes: [
      { pid: 111, name: 'node.exe', commandLine: '' },                 // pulpo opaco
      { pid: 222, name: 'node.exe', commandLine: 'node .pipeline/servicio-github.js' },
    ],
    scriptNames: ['pulpo.js', 'servicio-github.js'],
    declaredPids: new Map([[111, 'pulpo.pid']]),
    selfPid: 999999,
  });

  assert.ok(pids.includes(111), 'el opaco corroborado por su .pid se mata (antes se perdonaba)');
  assert.ok(pids.includes(222));
  assert.deepEqual(opacos, [{ pid: 111, motivo: 'declarado en pulpo.pid' }],
    'queda registrado por qué se lo mató');
});

test('CA-5 · un node opaco SIN corroboración no se mata: el fix no puede llevarse puestos procesos ajenos', () => {
  const { pids, opacos } = guard.selectPipelinePidsToKill({
    processes: [
      { pid: 555, name: 'node.exe', commandLine: '' },   // opaco, nadie lo reclama
      { pid: 666, name: 'node.exe', commandLine: 'node C:\\editor\\lsp-server.js' },
    ],
    scriptNames: ['pulpo.js'],
    declaredPids: new Map(),
    selfPid: 999999,
  });

  assert.deepEqual(pids, [], 'sin corroboración de ownership no se toca nada');
  assert.deepEqual(opacos, []);
});

test('CA-5 · un node opaco que retiene el puerto del dashboard se mata aunque no tenga .pid', () => {
  const { pids, opacos } = guard.selectPipelinePidsToKill({
    processes: [{ pid: 17168, name: 'node.exe', commandLine: '' }],
    scriptNames: ['dashboard.js'],
    declaredPids: new Map(),
    dashOwner: 17168,
    selfPid: 999999,
  });

  assert.deepEqual(pids, [17168]);
  assert.deepEqual(opacos, [{ pid: 17168, motivo: 'retiene el puerto del dashboard' }]);
});

test('CA-5 · nunca se selecciona el propio PID del restart', () => {
  const { pids } = guard.selectPipelinePidsToKill({
    processes: [{ pid: 999999, name: 'node.exe', commandLine: 'node .pipeline/restart.js' }],
    scriptNames: ['restart.js'],
    declaredPids: new Map([[999999, 'pulpo.pid']]),
    dashOwner: 999999,
    selfPid: 999999,
  });
  assert.deepEqual(pids, [], 'el restart no se suicida');
});

// --- Contrato de pid-discovery ---------------------------------------------

test('el parser de wmic conserva el node.exe con CommandLine vacía y propaga `name`', () => {
  // Filas como las del incidente: el ocupante del 3200 aparece en el scan pero
  // su CommandLine viene vacía. Si el parser la descartara —o tirara `name`—,
  // el guard no tendría con qué distinguirla de un proceso ajeno.
  const csv = [
    'Node,CommandLine,CreationDate,Name,ProcessId',
    'HOST,,20260810023409.000000-180,node.exe,17168',
    'HOST,node  C:\\\\repo\\\\.pipeline\\\\dashboard.js,20260810023409.000000-180,node.exe,15636',
    'HOST,C:\\\\Windows\\\\explorer.exe,20260810023409.000000-180,explorer.exe,4242',
  ].join('\n');

  const filas = pid._parseWmicCsv(csv);
  const opaco = filas.find((f) => f.pid === 17168);

  assert.ok(opaco, 'la fila con CommandLine vacía NO se descarta');
  assert.equal(opaco.name, 'node.exe', '`name` se propaga al registro');
  assert.equal(opaco.commandLine, '', 'CommandLine vacía, no ausente');
  assert.ok(filas.find((f) => f.pid === 15636), 'la fila legible sigue funcionando');
  assert.equal(filas.find((f) => f.pid === 4242), undefined, 'lo que no es node.exe no entra al scan');

  // Y el guard, alimentado con esas filas reales, toma la decisión correcta.
  const processForPid = (p) => filas.find((f) => f.pid === p) || null;
  assert.equal(guard.classifyHolder(17168, { processForPid, selfPid: 1 }).kind,
    guard.HOLDER_OPAQUE_NODE);
  assert.equal(guard.classifyHolder(4242, { processForPid, selfPid: 1 }).kind,
    guard.HOLDER_FOREIGN, 'explorer.exe no está en el scan ⇒ ajeno');
});

test('processForPid está exportada y devuelve null para un PID inválido', () => {
  assert.equal(typeof pid.processForPid, 'function');
  assert.equal(pid.processForPid(0), null);
});
