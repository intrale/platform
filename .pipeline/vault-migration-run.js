#!/usr/bin/env node
// =============================================================================
// vault-migration-run.js — CLI del operador para la migración del vault por
// host (#5453 · rev-1).
//
// Toda la lógica vive en `lib/vault-migration-cli.js` (testeable) y el cableado
// real en `lib/vault-migration-wiring.js`, que es el MISMO que usa el Pulpo.
// Acá sólo hay lectura de argv/stdin y códigos de salida — igual que
// `vault-cut-breakglass.js`.
//
//   Uso rápido:
//     node .pipeline/vault-migration-run.js status
//     node .pipeline/vault-migration-run.js preflight --host <host>
//     echo "ROTACION ACREDITADA"  | node .pipeline/vault-migration-run.js rotate    --host <host> --version 2026-08-31-r1
//     echo "PROVISION ACREDITADA" | node .pipeline/vault-migration-run.js provision --host <host>
//     node .pipeline/vault-migration-run.js respawn --host <host>
//     node .pipeline/vault-migration-run.js observe --host <host>
//
// Este comando NO rota credenciales, NO sube material al vault y NO corta el
// fallback: ACREDITA lo que el operador ya hizo fuera de banda, siguiendo
// `docs/runbooks/credential-rotation.md`. El corte lo ejecuta únicamente
// `.pipeline/vault-cut-breakglass.js`.
//
// Ver: docs/runbooks/credential-rotation.md
// =============================================================================

'use strict';

const cli = require('./lib/vault-migration-cli');

/** Lee stdin completo. Si no hay stdin (TTY), devuelve '' — nunca cuelga. */
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      // Cota defensiva: la frase son ~20 bytes. Un stdin gigante es un error de
      // uso (o un pipe equivocado), no una confirmación.
      if (data.length > 4096) { data = data.slice(0, 4096); process.stdin.pause(); resolve(data); }
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  // Sólo se consume stdin cuando el comando lo necesita: `status` desde una
  // terminal no puede quedarse esperando un EOF que nadie va a mandar.
  //
  // Se resuelve con el MISMO parser que decide el comando (#5453 rev-2). El
  // `argv.includes('rotate')` de la rev-1 miraba el argv entero, así que
  // `--host rotate` pedía stdin para un `status`, y un comando escrito después
  // de un flag suelto podía no pedirlo. El comando es una posición, no una
  // subcadena del argv.
  const comando = cli.parseArgs(argv).comando;
  const necesitaConfirmacion = comando === 'rotate' || comando === 'provision';
  const confirmation = necesitaConfirmacion ? await readStdin() : '';

  const { exitCode, lines } = cli.runCli({
    argv,
    confirmation,
    deps: { pipelineDir: __dirname, logger: (msg) => process.stdout.write(msg + '\n') },
  });
  process.stdout.write(lines.join('\n') + '\n');
  return exitCode;
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch(() => {
      // Nunca se imprime el error: puede traer paths o contexto del host.
      process.stdout.write('VAULT · migracion: fallo inesperado; el estado no avanzo.\n');
      process.exitCode = cli.EXIT.INDETERMINADO;
    });
}

module.exports = { readStdin };
