#!/usr/bin/env node
// =============================================================================
// validate-agent-models.js — CLI humanizado para validar agent-models.json
// Issue #3089 (U4 multi-provider) · épico #3065
//
// Objetivo:
//   Antes de bootear el pulpo, Leo (o cualquier dev del pipeline V3) puede
//   ejecutar `node .pipeline/validate-agent-models.js` y recibir:
//     - validación de schema (ajv 2020-12 vía lib/agent-models-validate.js)
//     - chequeo de env vars de credenciales (presencia, sin leak de valor)
//     - heurística defense-in-depth de secrets hardcoded en cualquier campo
//     - mensajes accionables con archivo:linea + sugerencia
//   Salida humana con colores ANSI + símbolos redundantes con texto.
//
// Diseño:
//   - El script CLI es un WRAPPER fino sobre `lib/agent-models-validate.js`
//     (#3081 dejó la engine completa). NO duplica lógica de validación.
//   - Mapea los errores devueltos a 5 categorías de exit code accionables
//     para CI y hooks.
//   - Idempotente: no escribe en disco, no muta env, no abre red.
//
// Exit codes (CA-EXIT):
//   0 = OK
//   1 = Schema inválido (estructura JSON no matchea schema o cross-refs)
//   2 = Credencial faltante (env var referenciada pero no definida)
//   3 = Credencial hardcoded detectada (literal en lugar de ${VAR})
//   4 = Path inválido / archivo no encontrado / toolchain ausente
//
// CLI:
//   node .pipeline/validate-agent-models.js              # validación completa
//   node .pipeline/validate-agent-models.js --quiet      # 1 línea para CI
//   node .pipeline/validate-agent-models.js --help       # ayuda + exit codes
//   node .pipeline/validate-agent-models.js --no-env     # saltea check env vars
//
// Convenciones (CA-UX consolidadas con security/UX/PO de issue #3089):
//   - Símbolos OK/ERROR/WARN/INFO redundantes con texto (accesibilidad).
//   - Respeta NO_COLOR (https://no-color.org/) y !process.stdout.isTTY.
//   - Tono español neutro, sin imperativos secos ni emojis decorativos.
//   - NUNCA imprime valor de env var (sólo nombre presencia/ausencia).
//   - Happy path silencioso (≤ 5 líneas cuando todo OK).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// Engine reutilizada (#3081 — DRY con boot del pulpo y pre-commit hook).
const validator = require('./lib/agent-models-validate');

// Path fijo al archivo a validar — anti path-traversal (CA-TECH-4).
const PIPELINE_DIR = __dirname;
const AGENT_MODELS_JSON = path.join(PIPELINE_DIR, 'agent-models.json');
const AGENT_MODELS_SCHEMA = path.join(PIPELINE_DIR, 'agent-models.schema.json');

// Exit codes categorizados por causa raíz (CA-EXIT-0..4).
const EXIT = Object.freeze({
  OK: 0,
  SCHEMA_INVALID: 1,
  CREDENTIAL_MISSING: 2,
  CREDENTIAL_HARDCODED: 3,
  PATH_INVALID: 4,
});

// Símbolos unicode (texto puro, NO ANSI — se mantienen en modo no-color).
const SYM = Object.freeze({
  OK: '✅',     // ✅
  ERR: '❌',    // ❌
  WARN: '⚠️', // ⚠️
  INFO: 'ℹ️', // ℹ️
  STOP: '⛔',   // ⛔
});

// ────────────────────────────────────────────────────────────────────────────
// Colorización ANSI con respeto a NO_COLOR y TTY (CA-UX-2).
// ────────────────────────────────────────────────────────────────────────────

function shouldUseColor() {
  // Convención NO_COLOR (https://no-color.org/): cualquier valor no vacío
  // suprime estilos. Se respeta para CI, logs, hooks pre-commit, redirección
  // a archivo. Defensivo: si la env var no existe, sigue normal.
  if (process.env.NO_COLOR && process.env.NO_COLOR.length > 0) return false;
  // No-TTY (pipe a archivo, captura por padre): sin colores.
  if (process.stdout && process.stdout.isTTY === false) return false;
  return true;
}

const USE_COLOR = shouldUseColor();

function paint(code, text) {
  if (!USE_COLOR) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const C = Object.freeze({
  green: (s) => paint('32', s),
  red:   (s) => paint('31', s),
  yellow:(s) => paint('33', s),
  cyan:  (s) => paint('36', s),
  bold:  (s) => paint('1',  s),
  dim:   (s) => paint('2',  s),
});

// ────────────────────────────────────────────────────────────────────────────
// Parser CLI minimalista (sin deps).
// ────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    quiet: false,
    help: false,
    checkEnv: true,
  };
  for (const a of args) {
    if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--no-env') opts.checkEnv = false;
    else if (a.startsWith('--')) {
      // Flag desconocido — fail-fast con sugerencia.
      process.stderr.write(`flag desconocido: ${a}\n`);
      process.stderr.write(`usar --help para ver flags válidos\n`);
      process.exit(EXIT.PATH_INVALID);
    }
  }
  return opts;
}

function printHelp() {
  const out = [];
  out.push(C.bold('validate-agent-models') + ' — valida .pipeline/agent-models.json antes del boot del pulpo');
  out.push('');
  out.push('Uso:');
  out.push('  node .pipeline/validate-agent-models.js              ' + C.dim('(validación completa)'));
  out.push('  node .pipeline/validate-agent-models.js --quiet      ' + C.dim('(CI: 1 línea de resumen)'));
  out.push('  node .pipeline/validate-agent-models.js --no-env     ' + C.dim('(saltea check de env vars)'));
  out.push('  node .pipeline/validate-agent-models.js --help       ' + C.dim('(esta ayuda)'));
  out.push('');
  out.push('Exit codes:');
  out.push(`  ${C.green('0')}  OK — el archivo está listo para el boot del pulpo`);
  out.push(`  ${C.red('1')}  Schema inválido — la estructura del JSON no matchea el schema canónico`);
  out.push(`  ${C.red('2')}  Credencial faltante — una env var referenciada por un provider no está definida`);
  out.push(`  ${C.red('3')}  Credencial hardcoded — se detectó un literal con forma de secret en el JSON`);
  out.push(`  ${C.red('4')}  Path inválido — archivo no encontrado o toolchain ausente (ajv)`);
  out.push('');
  out.push('Doc canónica: ' + C.cyan('docs/pipeline-multi-provider.md') + ' §3.2, §7.4');
  out.push('Engine subyacente: ' + C.cyan('.pipeline/lib/agent-models-validate.js') + ' (#3081 S3)');
  process.stdout.write(out.join('\n') + '\n');
}

// ────────────────────────────────────────────────────────────────────────────
// Clasificación de errores → exit code categorizado.
//
// La engine de #3081 devuelve un array de errores con `{ path, message, fix }`.
// Acá los re-categorizamos en buckets para que el exit code refleje la causa
// dominante y el dev sepa por qué falló sin tener que leer toda la salida.
//
// Reglas de clasificación (orden de prioridad — más grave primero):
//   1) hardcoded secret detectado → CREDENTIAL_HARDCODED (3)
//   2) env var ausente             → CREDENTIAL_MISSING (2)
//   3) archivo/toolchain ausente   → PATH_INVALID (4)
//   4) cualquier otro              → SCHEMA_INVALID (1)
//
// Defensa en profundidad: si NINGÚN bucket matchea pero hay errores, default
// a SCHEMA_INVALID (1) — fail-closed, nunca exit 0 con errores.
// ────────────────────────────────────────────────────────────────────────────

function classifyError(err) {
  const msg = String(err.message || '').toLowerCase();
  const pth = String(err.path || '').toLowerCase();

  // Bucket 1 — hardcoded secret. La engine devuelve mensaje literal
  // "valor hardcoded prohibido: parece un X" (validateNoHardcodedSecrets).
  if (msg.includes('hardcoded prohibido') || msg.includes('parece un ')) {
    return 'hardcoded';
  }

  // Bucket 2 — env var ausente. La engine devuelve mensaje literal
  // "requiere env var X pero no está presente en process.env"
  // (validateCredentialsEnvPresence).
  if (msg.includes('no está presente en process.env') || msg.includes('requiere env var')) {
    return 'missing-env';
  }

  // Bucket 3 — archivo/toolchain. La engine usa paths sintéticos:
  //   '(toolchain)' = ajv ausente
  //   '(file)'      = agent-models.json no encontrado
  //   '(schema)'    = agent-models.schema.json no encontrado / inválido
  //   '(parse)'     = JSON inválido (no es path-invalido pero sí estructural)
  if (pth === '(toolchain)' || pth === '(file)' || pth === '(schema)') {
    return 'path';
  }

  // Bucket default — error de schema/cross-validation/placeholder/denied flag.
  return 'schema';
}

function bucketToExitCode(bucket) {
  switch (bucket) {
    case 'hardcoded':   return EXIT.CREDENTIAL_HARDCODED;
    case 'missing-env': return EXIT.CREDENTIAL_MISSING;
    case 'path':        return EXIT.PATH_INVALID;
    case 'schema':
    default:            return EXIT.SCHEMA_INVALID;
  }
}

function bucketLabel(bucket) {
  switch (bucket) {
    case 'hardcoded':   return 'credencial hardcoded';
    case 'missing-env': return 'credencial faltante';
    case 'path':        return 'archivo / toolchain';
    case 'schema':
    default:            return 'schema inválido';
  }
}

// El exit code dominante es el más grave (lower number = peor causa de boot).
// Orden de gravedad: 3 (hardcoded) > 2 (missing) > 1 (schema) > 4 (path).
// Path queda último porque casi siempre es ambiente local (npm install, etc.).
function selectDominantExit(errors) {
  const buckets = errors.map(classifyError);
  if (buckets.includes('hardcoded'))   return EXIT.CREDENTIAL_HARDCODED;
  if (buckets.includes('missing-env')) return EXIT.CREDENTIAL_MISSING;
  if (buckets.includes('schema'))      return EXIT.SCHEMA_INVALID;
  if (buckets.includes('path'))        return EXIT.PATH_INVALID;
  return EXIT.SCHEMA_INVALID;
}

// ────────────────────────────────────────────────────────────────────────────
// Cálculo de línea aproximada en agent-models.json para una jsonPointer.
//
// La engine devuelve `path` estilo JSON Pointer (`#/providers/anthropic/...`).
// JSON.parse nativo no expone offsets de keys → calculamos la línea por
// búsqueda de la última segment-key en el texto crudo (best-effort).
//
// Caso boundary: si el JSON tiene varias keys con el mismo nombre, devolvemos
// la última ocurrencia previa al cierre del objeto padre. Para un schema
// validator es aceptable: el dev ve la línea aproximada y el contexto sobra.
// ────────────────────────────────────────────────────────────────────────────

function locateLine(jsonText, jsonPointer) {
  if (!jsonText || typeof jsonPointer !== 'string') return null;
  // Despoja el `#` líder.
  let p = jsonPointer.replace(/^#\/?/, '');
  if (!p) return 1;

  const segments = p.split('/').filter(Boolean);
  if (segments.length === 0) return 1;

  // Walk: para cada segment textual, buscamos su "key" en el JSON.
  // Es heurística — no parseo el árbol entero. Si segmento es índice numérico
  // de array, hacemos best-effort buscando la N-ésima ocurrencia de `[` o `,`
  // pero como fallback devolvemos la línea de la última key conocida.
  const lines = jsonText.split(/\r?\n/);
  let lineGuess = 1;
  for (const seg of segments) {
    if (/^\d+$/.test(seg)) {
      // Índice de array — skip refinamiento.
      continue;
    }
    // Busca la primera ocurrencia de `"seg":` después de lineGuess-1.
    const escaped = seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`"${escaped}"\\s*:`);
    for (let i = lineGuess - 1; i < lines.length; i++) {
      if (re.test(lines[i])) {
        lineGuess = i + 1;
        break;
      }
    }
  }
  return lineGuess;
}

// ────────────────────────────────────────────────────────────────────────────
// Renderer humano de un error (formato canónico CA-UX-3).
//
//   ❌  <descripción>
//       archivo:   .pipeline/agent-models.json:<línea>
//       campo:     <jsonpath>
//       categoría: <bucket label>
//       sugerencia: <fix>
//
// 4 espacios de indent (NO tabs — inconsistencia entre terminales).
// ────────────────────────────────────────────────────────────────────────────

function renderError(err, jsonText, options) {
  const bucket = classifyError(err);
  const isCritical = bucket === 'hardcoded';
  const icon = isCritical ? `${SYM.STOP} ${C.bold(C.red('CRÍTICO'))}` : `${SYM.ERR} ${C.red('error')}`;

  const lines = [];
  const headerMsg = err.message || '(sin descripción)';
  lines.push(`${icon}  ${headerMsg}`);

  const line = locateLine(jsonText, err.path);
  const filePath = path.relative(process.cwd(), options.filePath);
  const fileRef = line ? `${filePath}:${line}` : filePath;
  lines.push(`    ${C.dim('archivo:   ')}${fileRef}`);
  lines.push(`    ${C.dim('campo:     ')}${err.path || '#/'}`);
  lines.push(`    ${C.dim('categoría: ')}${bucketLabel(bucket)}`);
  if (err.fix) lines.push(`    ${C.dim('sugerencia:')} ${err.fix}`);
  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// Conteo de stats por bucket para el resumen final (CA-UX-4).
// ────────────────────────────────────────────────────────────────────────────

function countByBucket(errors) {
  const counts = { 'hardcoded': 0, 'missing-env': 0, 'path': 0, 'schema': 0 };
  for (const e of errors) {
    counts[classifyError(e)]++;
  }
  return counts;
}

function summarize(result, exitCode, options) {
  const config = result.config || null;
  const providersCount = config && config.providers ? Object.keys(config.providers).length : 0;
  const skillsCount    = config && config.skills    ? Object.keys(config.skills).length    : 0;

  // Env vars verificadas: union de credentials_env de providers referenciados.
  let envVarsChecked = 0;
  if (config && options.checkEnv) {
    const referenced = new Set();
    if (config.default_provider) referenced.add(config.default_provider);
    if (config.skills) {
      for (const k of Object.keys(config.skills)) {
        const s = config.skills[k];
        if (s && typeof s.provider === 'string') referenced.add(s.provider);
      }
    }
    for (const p of referenced) {
      const def = config.providers && config.providers[p];
      if (def && Array.isArray(def.credentials_env)) envVarsChecked += def.credentials_env.length;
    }
  }

  const sep = '─'.repeat(45);
  const lines = [];
  lines.push(C.dim(sep));
  lines.push(C.bold(' Resumen'));
  lines.push(C.dim(sep));
  lines.push(`  Providers definidos:   ${providersCount}`);
  lines.push(`  Skills asignados:      ${skillsCount}`);
  if (options.checkEnv) {
    lines.push(`  Env vars verificadas:  ${envVarsChecked}`);
  } else {
    lines.push(`  Env vars verificadas:  ${C.dim('(saltado por --no-env)')}`);
  }

  if (exitCode === EXIT.OK) {
    lines.push('');
    lines.push(`  ${SYM.OK} ${C.green('Validación OK')} — agent-models.json listo para el boot del pulpo.`);
    lines.push(`  ${C.dim('Salida: exit 0')}`);
  } else {
    const counts = countByBucket(result.errors || []);
    lines.push('');
    if (counts['hardcoded']   > 0) lines.push(`  ${SYM.STOP} ${C.bold(C.red('credenciales hardcoded:'))} ${counts['hardcoded']}`);
    if (counts['missing-env'] > 0) lines.push(`  ${SYM.ERR} ${C.red('credenciales faltantes: ')} ${counts['missing-env']}`);
    if (counts['schema']      > 0) lines.push(`  ${SYM.ERR} ${C.red('errores de schema:      ')} ${counts['schema']}`);
    if (counts['path']        > 0) lines.push(`  ${SYM.ERR} ${C.red('archivo/toolchain:      ')} ${counts['path']}`);
    lines.push('');
    const label = ({
      [EXIT.SCHEMA_INVALID]: 'schema inválido',
      [EXIT.CREDENTIAL_MISSING]: 'credencial faltante',
      [EXIT.CREDENTIAL_HARDCODED]: 'credencial hardcoded',
      [EXIT.PATH_INVALID]: 'archivo / toolchain',
    })[exitCode] || 'error';
    lines.push(`  ${SYM.ERR} ${C.red('Validación FALLÓ.')} Corregí los errores listados arriba.`);
    lines.push(`  ${C.dim(`Salida: exit ${exitCode} (${label})`)}`);
  }
  lines.push(C.dim(sep));
  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// Modo --quiet: una sola línea para CI / hooks.
// ────────────────────────────────────────────────────────────────────────────

function summarizeQuiet(result, exitCode) {
  if (exitCode === EXIT.OK) {
    return `${SYM.OK} agent-models.json OK`;
  }
  const counts = countByBucket(result.errors || []);
  const fragments = [];
  if (counts['hardcoded']   > 0) fragments.push(`hardcoded=${counts['hardcoded']}`);
  if (counts['missing-env'] > 0) fragments.push(`missing=${counts['missing-env']}`);
  if (counts['schema']      > 0) fragments.push(`schema=${counts['schema']}`);
  if (counts['path']        > 0) fragments.push(`path=${counts['path']}`);
  return `${SYM.ERR} agent-models.json FAIL (${fragments.join(', ')}) exit=${exitCode}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Lectura defensiva del JSON raw — para cálculo de archivo:línea.
// ────────────────────────────────────────────────────────────────────────────

function readJsonRaw(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return ''; // si no se puede leer, locateLine devolverá null pero seguimos.
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main entrypoint (idempotente, sin side effects).
// ────────────────────────────────────────────────────────────────────────────

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    return EXIT.OK;
  }

  // Banner mínimo (NO se imprime en --quiet ni en happy path final).
  // Sólo cuando vamos a fallar daremos contexto al dev.
  const jsonText = readJsonRaw(AGENT_MODELS_JSON);

  // Delegar a la engine de #3081. Le pasamos processEnv sólo si checkEnv=true,
  // así CI puede correr `--no-env` para validar estructura sin tener las creds
  // del provider seteadas en su shell.
  const result = validator.validate(AGENT_MODELS_JSON, {
    schemaPath: AGENT_MODELS_SCHEMA,
    processEnv: opts.checkEnv ? process.env : undefined,
  });

  if (result.ok) {
    // Happy path silencioso (CA-UX-8): ≤ 5 líneas.
    if (opts.quiet) {
      process.stdout.write(summarizeQuiet(result, EXIT.OK) + '\n');
    } else {
      process.stdout.write(
        `${SYM.OK} ${C.green('Validación OK')} — agent-models.json listo para el boot del pulpo.\n` +
        `${C.dim('  Providers:')} ${Object.keys(result.config.providers || {}).join(', ')}\n` +
        `${C.dim('  Skills:')}    ${Object.keys(result.config.skills || {}).length} asignados\n`
      );
    }
    return EXIT.OK;
  }

  const exitCode = selectDominantExit(result.errors || []);

  if (opts.quiet) {
    process.stderr.write(summarizeQuiet(result, exitCode) + '\n');
    return exitCode;
  }

  // Modo completo: header + cada error con formato canónico + resumen final.
  const out = [];
  out.push(`${SYM.STOP} ${C.bold(C.red('agent-models.json no pasó la validación.'))}`);
  out.push('');
  for (const err of result.errors || []) {
    out.push(renderError(err, jsonText, { filePath: AGENT_MODELS_JSON }));
    out.push('');
  }
  out.push(summarize(result, exitCode, opts));
  process.stderr.write(out.join('\n') + '\n');
  return exitCode;
}

// ────────────────────────────────────────────────────────────────────────────
// Module exports (para tests + reuso programático).
// ────────────────────────────────────────────────────────────────────────────

module.exports = {
  EXIT,
  SYM,
  classifyError,
  bucketToExitCode,
  bucketLabel,
  countByBucket,
  selectDominantExit,
  locateLine,
  parseArgs,
  shouldUseColor,
  main,
  // Paths canónicos (útil para tests con fixtures).
  AGENT_MODELS_JSON,
  AGENT_MODELS_SCHEMA,
};

// CLI entrypoint — sólo si se invoca como `node validate-agent-models.js`,
// NUNCA al hacer `require(...)` desde un test.
if (require.main === module) {
  try {
    const code = main(process.argv);
    process.exit(code);
  } catch (err) {
    // Excepción no controlada — defense-in-depth, NO debería pasar.
    // Imprimimos a stderr sin volcar process.env ni stack con creds.
    process.stderr.write(`${SYM.ERR} excepción no controlada en validate-agent-models: ${err && err.message ? err.message : 'desconocida'}\n`);
    process.exit(EXIT.PATH_INVALID);
  }
}
