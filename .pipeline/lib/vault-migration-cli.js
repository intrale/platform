// =============================================================================
// vault-migration-cli.js — la lógica del punto de entrada del operador para la
// migración del vault (#5453 · rev-1).
//
// Por qué la lógica vive acá y no en el ejecutable
// -----------------------------------------------
// Mismo patrón que `lib/vault-cut-breakglass.js` (#5460) y
// `vault-shadow-status.js` (#5451): el archivo de `.pipeline/` sólo lee argv y
// stdin y devuelve un exit code; todo lo demás es este módulo, que se puede
// testear sin spawnear un proceso.
//
// Qué resuelve
// ------------
// La rev-0 de #5453 entregó el coordinador sin ningún invocador productivo: no
// existía comando alguno que llamara a `preflight/rotate/provision/respawn/
// observe`. El runbook decía "el operador ejecuta fuera de banda y el
// coordinador ACREDITA", pero acreditar era imposible. Esto es el "acreditá".
//
// Contrato con el operador
// ------------------------
// Cada comando es UNA etapa de la máquina de estados, en el orden del runbook.
// El coordinador valida el orden por su cuenta: pedir `provision` sin haber
// acreditado la rotación devuelve `etapa_fuera_de_orden`, no una excepción.
//
// Las dos etapas que acreditan material irreversible (`rotate`, `provision`)
// exigen una frase de confirmación por STDIN, nunca por argv: argv lo lee
// cualquier proceso del host y queda en el historial del shell.
//
// Contención
// ----------
// Lo que se imprime es la evidencia YA sanitizada por `vault-migration.js`
// (modelo cerrado de campos: nombres lógicos, conteos, timestamps y enums).
// Nunca valores, paths, PIDs ni namespaces.
// =============================================================================

'use strict';

const wiring = require('./vault-migration-wiring');
const vaultMigration = require('./vault-migration');

/** Frases de confirmación. Cortas, en mayúsculas, imposibles de tipear sin querer. */
const CONFIRM = Object.freeze({
  rotate: 'ROTACION ACREDITADA',
  provision: 'PROVISION ACREDITADA',
});

/**
 * Códigos de salida ESTABLES: el runbook los documenta y un script de operación
 * puede ramificar sobre ellos. No reordenar.
 */
const EXIT = Object.freeze({
  OK: 0,
  GATE_CERRADO: 10,
  NO_CONFIRMADO: 11,
  USO_INVALIDO: 12,
  ETAPA_FALLIDA: 13,
  INDETERMINADO: 14,
});

const COMANDOS = Object.freeze([
  'status', 'preflight', 'rotate', 'provision', 'respawn', 'observe', 'advance',
]);

const HELP = [
  'Coordinador de migracion del vault por host (#5453).',
  '',
  'Uso:',
  '  node .pipeline/vault-migration-run.js <comando> [--host <host>] [opciones]',
  '',
  'Comandos (en el orden del runbook):',
  '  status                 estado de todos los hosts (o de uno con --host)',
  '  preflight  --host H    valida ancla vault-only, allowlist e inventario (CA-22/CA-25)',
  '  rotate     --host H --version <etiqueta>   acredita la rotacion hecha fuera de banda',
  '  provision  --host H    acredita el material subido al vault (CA-23)',
  '  respawn    --host H    acredita que los consumidores de larga vida volvieron',
  '  observe    --host H    evalua la matriz de cobertura de la ventana (CA-26)',
  '  advance    --host H    ejecuta la UNICA transicion que corresponda a la etapa actual',
  '',
  'Confirmacion (solo rotate y provision, siempre por STDIN, nunca por argv):',
  '  echo "' + CONFIRM.rotate + '" | node .pipeline/vault-migration-run.js rotate --host H --version 2026-08-31-r1',
  '  echo "' + CONFIRM.provision + '" | node .pipeline/vault-migration-run.js provision --host H',
  '',
  'Este comando NO rota, NO sube material y NO corta el fallback: ACREDITA lo que',
  'el operador ya hizo fuera de banda. El corte lo ejecuta unicamente',
  '.pipeline/vault-cut-breakglass.js (#5452/#5460).',
  '',
  'Codigos de salida:',
  '  0  ok            11 frase no confirmada     13 la etapa no avanzo',
  '  10 gate cerrado  12 uso invalido            14 indeterminado',
  '',
  'Runbook: docs/runbooks/credential-rotation.md',
].join('\n');

/** Parseo de argv sin dependencias. */
function parseArgs(argv) {
  const out = { comando: null, host: '', version: '', help: false, desconocidos: [] };
  const lista = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < lista.length; i += 1) {
    const a = String(lista[i]);
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--host' && lista[i + 1]) { out.host = String(lista[i + 1]); i += 1; continue; }
    if (a.startsWith('--host=')) { out.host = a.slice('--host='.length); continue; }
    if (a === '--version' && lista[i + 1]) { out.version = String(lista[i + 1]); i += 1; continue; }
    if (a.startsWith('--version=')) { out.version = a.slice('--version='.length); continue; }
    if (a.startsWith('-')) { out.desconocidos.push(a); continue; }
    if (out.comando === null) { out.comando = a; continue; }
    out.desconocidos.push(a);
  }
  return out;
}

/** Normaliza la confirmación de stdin: sin espacios de borde, sin CR de Windows. */
function confirmacionCoincide(entrada, esperada) {
  if (typeof entrada !== 'string') return false;
  return entrada.replace(/\r/g, '').trim() === esperada;
}

/** Mensaje del gate cerrado. Explica QUÉ falta, no sólo que está cerrado. */
function explicarGate(gate) {
  if (gate === wiring.GATE.VAULT_CERRADO) {
    return 'VAULT · gate cerrado: `vault.enabled` no es `true` en .pipeline/config.yaml. '
      + 'La migracion no arranca y no se crea estado. Ver el runbook, paso 0.';
  }
  if (gate === wiring.GATE.MIGRACION_CERRADA) {
    return 'VAULT · gate cerrado: `vault.migration.enabled` no es `true` en .pipeline/config.yaml. '
      + 'Abrir ese flag es lo que declara la ventana de migracion abierta. Ver el runbook, paso 0.';
  }
  return 'VAULT · gate cerrado: el config no se pudo leer. Fail-closed a proposito: '
    + 'sin config no se puede validar el ancla vault-only.';
}

/** Render de una línea de estado por host. Sólo conteos y timestamps. */
function lineaEstado(st) {
  if (!st) return '  (sin estado: todavia no se corrio preflight)';
  const partes = ['  etapa: ' + st.stage];
  if (st.rotacion && st.rotacion.at) {
    partes.push('rotacion: ' + st.rotacion.at + (st.rotacion.version ? ' (' + st.rotacion.version + ')' : ''));
  }
  if (st.provision && st.provision.at) partes.push('provision: ' + st.provision.at);
  if (st.respawn && st.respawn.at) {
    partes.push('respawn: ' + st.respawn.at + ' (' + st.respawn.consumidores + ' consumidores)');
  }
  if (st.cobertura) {
    partes.push('cobertura: ' + st.cobertura.cubiertos + '/' + st.cobertura.descriptores);
  }
  if (st.pendiente) partes.push('PENDIENTE: ' + st.pendiente.op + ' (clave conservada)');
  return partes.join(' · ');
}

/**
 * Ejecuta un comando de la CLI.
 *
 * @param {object}   params
 * @param {string[]} params.argv          argv sin `node` ni el script.
 * @param {string}   [params.confirmation] contenido de stdin.
 * @param {object}   [params.deps]        se reenvía a `createProductionVaultMigration`.
 * @returns {{exitCode:number, lines:string[]}}
 */
function runCli(params) {
  const p = params || {};
  const args = parseArgs(p.argv);
  const lines = [];
  const emit = (s) => { lines.push(s); };

  if (args.help || !args.comando) {
    emit(HELP);
    return { exitCode: args.comando ? EXIT.OK : (args.help ? EXIT.OK : EXIT.USO_INVALIDO), lines };
  }
  if (!COMANDOS.includes(args.comando)) {
    emit('VAULT · comando desconocido: "' + args.comando + '". Validos: ' + COMANDOS.join(', ') + '.');
    return { exitCode: EXIT.USO_INVALIDO, lines };
  }
  if (args.desconocidos.length) {
    emit('VAULT · argumentos no reconocidos: ' + args.desconocidos.join(' ') + '.');
    return { exitCode: EXIT.USO_INVALIDO, lines };
  }
  if (args.comando !== 'status' && !args.host) {
    emit('VAULT · falta --host. Cada etapa se acredita host por host, nunca en lote: '
      + 'un lote convierte un error de un host en un avance de todos.');
    return { exitCode: EXIT.USO_INVALIDO, lines };
  }
  if (args.host && !vaultMigration.HOST_RE.test(args.host)) {
    emit('VAULT · el host "' + args.host + '" no es un nombre logico valido.');
    return { exitCode: EXIT.USO_INVALIDO, lines };
  }

  // La confirmación se valida ANTES de construir nada: sin frase no se toca el
  // filesystem, ni siquiera para crear el directorio de estado.
  const acreditacion = {};
  if (args.comando === 'rotate' || args.comando === 'provision') {
    if (!confirmacionCoincide(p.confirmation, CONFIRM[args.comando])) {
      emit('VAULT · la etapa "' + args.comando + '" no se acredito: falta la frase de confirmacion.');
      emit('  echo "' + CONFIRM[args.comando] + '" | node .pipeline/vault-migration-run.js '
        + args.comando + ' --host ' + args.host
        + (args.comando === 'rotate' ? ' --version <etiqueta>' : ''));
      return { exitCode: EXIT.NO_CONFIRMADO, lines };
    }
    if (args.comando === 'rotate') {
      if (!wiring.VERSION_RE.test(String(args.version || '').trim())) {
        emit('VAULT · falta --version o la etiqueta no es valida. '
          + 'Es una etiqueta NO sensible de la rotacion (ej: 2026-08-31-r1), '
          + 'no el secreto ni nada derivado de el.');
        return { exitCode: EXIT.USO_INVALIDO, lines };
      }
      acreditacion.rotate = { confirmado: true, version: String(args.version).trim() };
    } else {
      acreditacion.provision = { confirmado: true };
    }
  }

  const armado = wiring.createProductionVaultMigration(
    Object.assign({}, p.deps, { acreditacion }),
  );
  if (!armado.gateAbierto) {
    emit(explicarGate(armado.gate));
    return { exitCode: EXIT.GATE_CERRADO, lines };
  }
  const co = armado.coordinador;

  if (args.comando === 'status') {
    const hosts = args.host ? [args.host] : (armado.hosts.length ? armado.hosts : co.listHosts());
    emit('VAULT · migracion por host (' + hosts.length + ' host(s) en la ventana)');
    if (!hosts.length) {
      emit('  (sin hosts: `vault.shadow_window.hosts_activos` esta vacio)');
    }
    for (const h of hosts) {
      emit(h + ':');
      emit(lineaEstado(co.readState(h)));
    }
    const corte = co.corteState();
    emit('corte: ' + (corte && corte.status ? corte.status + ' (' + corte.at + ')' : 'no delegado'));
    emit('auditoria: ' + armado.auditPath);
    return { exitCode: EXIT.OK, lines };
  }

  let res;
  try {
    if (args.comando === 'preflight') res = co.preflight({ host: args.host });
    else if (args.comando === 'rotate') res = co.rotate({ host: args.host });
    else if (args.comando === 'provision') res = co.provision({ host: args.host });
    else if (args.comando === 'respawn') res = co.respawn({ host: args.host });
    else if (args.comando === 'observe') res = co.observeCoverage({ host: args.host });
    else res = co.advance({ host: args.host });
  } catch (e) {
    // Nunca se imprime el error crudo: puede traer paths del host.
    emit('VAULT · la etapa "' + args.comando + '" fallo de forma inesperada ('
      + ((e && e.code) || 'error') + '). El estado del host no avanzo.');
    return { exitCode: EXIT.INDETERMINADO, lines };
  }

  if (res && res.ok) {
    emit('VAULT · ' + args.host + ' · ' + args.comando + ': OK · etapa ahora "' + res.stage + '"');
    emit('  evidencia: ' + JSON.stringify(res.evidencia));
    return { exitCode: EXIT.OK, lines };
  }
  emit('VAULT · ' + args.host + ' · ' + args.comando + ': NO AVANZO · causa "'
    + ((res && res.causa) || 'indeterminada') + '"');
  if (res && res.evidencia) emit('  evidencia: ' + JSON.stringify(res.evidencia));
  emit('  El fallback se conserva. Ver la tabla de causas en docs/runbooks/credential-rotation.md.');
  return { exitCode: EXIT.ETAPA_FALLIDA, lines };
}

module.exports = {
  runCli,
  parseArgs,
  confirmacionCoincide,
  CONFIRM,
  EXIT,
  COMANDOS,
  HELP,
};
