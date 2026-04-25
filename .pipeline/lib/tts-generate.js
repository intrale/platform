#!/usr/bin/env node
// =============================================================================
// tts-generate.js — CLI wrapper para TTS con perfiles por agente
//
// Wrappea multimedia.textToSpeechWithMeta para consumo desde shell o scripts
// que no corren en el proceso del pulpo. Cada perfil tiene su primary/fallback
// y personalidades distintas (Claudito/Tommy, Rulo/Nacho, etc.).
//
// Uso:
//   node .pipeline/lib/tts-generate.js \
//     --profile qa \
//     --input qa/evidence/2505/qa-2505-guion.txt \
//     --output qa/evidence/2505/qa-2505-narration.mp3
//
// O con texto inline:
//   node .pipeline/lib/tts-generate.js --profile guru --text "Texto a narrar" --output out.mp3
//
// Exit codes:
//   0 → audio generado OK
//   1 → error de argumentos
//   2 → no se pudo generar audio (primary y fallback fallaron)
//   3 → error de I/O (no se pudo leer input o escribir output)
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') args.profile = argv[++i];
    else if (a === '--input') args.input = argv[++i];
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--text') args.text = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`tts-generate — genera audio TTS con el perfil de un agente.

Uso:
  node .pipeline/lib/tts-generate.js --profile <name> (--input <file> | --text <string>) --output <file>

Argumentos:
  --profile <name>   Nombre del perfil TTS (default, qa, guru, security, po, ux, etc.)
  --input <file>     Archivo con texto a narrar (UTF-8).
  --text <string>    Texto inline (alternativo a --input).
  --output <file>    Archivo de audio de salida (formato según response_format del perfil).

Ejemplo:
  node .pipeline/lib/tts-generate.js \\
    --profile qa \\
    --input qa/evidence/2505/qa-2505-guion.txt \\
    --output qa/evidence/2505/qa-2505-narration.mp3`);
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.profile) {
    console.error('ERROR: --profile requerido');
    printHelp();
    process.exit(1);
  }
  if (!args.output) {
    console.error('ERROR: --output requerido');
    process.exit(1);
  }
  if (!args.input && !args.text) {
    console.error('ERROR: --input o --text requerido');
    process.exit(1);
  }

  let text;
  if (args.text) {
    text = args.text;
  } else {
    try {
      text = fs.readFileSync(args.input, 'utf8');
    } catch (e) {
      console.error(`ERROR: no se pudo leer --input '${args.input}': ${e.message}`);
      process.exit(3);
    }
  }

  if (!text.trim()) {
    console.error('ERROR: texto vacío');
    process.exit(1);
  }

  // Cargar multimedia.js del pipeline
  const multimedia = require(path.join(__dirname, '..', 'multimedia'));
  const result = await multimedia.textToSpeechWithMeta(text, { profile: args.profile });

  if (!result || !result.buffer) {
    console.error(`ERROR: TTS falló para profile='${args.profile}' (primary y fallback agotados)`);
    process.exit(2);
  }

  try {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, result.buffer);
  } catch (e) {
    console.error(`ERROR: no se pudo escribir --output '${args.output}': ${e.message}`);
    process.exit(3);
  }

  // #2519: escribir side-metadata `<output>.meta.json` con el proveedor TTS
  // que realmente sintetizó el audio. Consumida por servicio-drive para
  // mapear provider → narrador (Nacho/Rulo del profile qa).
  //
  // Además, si el output está bajo `qa/evidence/<issue>/`, escribimos una
  // copia canónica en `qa/evidence/<issue>/qa-narration.meta.json` — ese es
  // el path que servicio-drive lee.
  try {
    const metaSibling = args.output + '.meta.json';
    const metaPayload = {
      profile: result.profile,
      provider: result.provider,
      voice: result.voice || '',
      character_name: result.characterName || result.character_name || '',
      output: args.output,
      generated_at: new Date().toISOString(),
      source: 'tts-generate.js',
    };
    fs.writeFileSync(metaSibling, JSON.stringify(metaPayload, null, 2));

    // Escritura canónica si reconocemos pattern qa/evidence/<issue>/
    const qaEvidenceRe = /qa[\\/]+evidence[\\/]+(\d+)[\\/]+/;
    const m = args.output.match(qaEvidenceRe);
    if (m) {
      const issueNum = m[1];
      const canonical = path.join(
        path.dirname(args.output),
        'qa-narration.meta.json'
      );
      fs.writeFileSync(canonical, JSON.stringify({
        ...metaPayload,
        issue: issueNum,
      }, null, 2));
    }
  } catch (metaErr) {
    // Best-effort; no bloquear si la meta no se pudo escribir.
    console.warn(`WARN: no se pudo escribir metadata TTS: ${metaErr.message}`);
  }

  console.log(`OK: audio generado con profile='${result.profile}' provider='${result.provider}' size=${result.buffer.length} bytes → ${args.output}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`FATAL: ${e.stack || e.message}`);
  process.exit(2);
});
