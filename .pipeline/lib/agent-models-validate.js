// =============================================================================
// agent-models-validate.js — Validación + sandboxing de agent-models.json (#3081)
//
// Módulo único compartido entre boot del pulpo y pre-commit hook (CA-5 / DRY).
//
// Defensa en profundidad multi-provider (#3065 §6.6, §6.9, §6.10):
//   - Schema JSON estructural (ajv) — additionalProperties:false, tipos cerrados.
//   - ALLOWED_LAUNCHERS hardcoded — fuente única de verdad, schema enum derivado.
//   - ALLOWED_PLACEHOLDERS — set fijo para spawn_args_template.
//   - DENIED_FLAGS — denylist por flag peligroso (--api-base, --proxy, ...).
//   - Cross-validations: default_provider ∈ providers, skills.<x>.provider ∈ providers.
//   - expandSpawnArgs() — función pura testeable (CA-6 fuzzing).
//
// Exit codes (CA-2):
//   0 = OK
//   1 = excepción no controlada (stack trace)
//   2 = config inválida (operador edita JSON)
//   3 = toolchain ausente (operador corre `npm install`)
//
// Uso programático (boot pulpo.js):
//   const { validateOrExit } = require('./lib/agent-models-validate');
//   validateOrExit({ jsonPath: path.join(PIPELINE, 'agent-models.json') });
//
// Uso CLI (pre-commit hook + reproducción manual):
//   node .pipeline/lib/agent-models-validate.js
//   node .pipeline/lib/agent-models-validate.js --file path/to/agent-models.json
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// ─── Constantes inmutables — fuente única de verdad ──────────────────────────

// Allowlist de launchers permitidos. El schema deriva su enum de esta lista
// (composición programática), evitando drift schema↔código (refinamiento Guru #1).
const ALLOWED_LAUNCHERS = Object.freeze(['claude', 'codex', 'gemini', 'ollama', 'node']);

// Launchers que requieren shell:true en spawn (caso heredado del .cmd shim de
// Windows en detectClaudeLauncher pulpo.js:127). Default es shell:false.
// Si un launcher no está acá, debe correr con shell:false + windowsHide:true.
const SHELL_REQUIRED_LAUNCHERS = Object.freeze([]);

// Placeholders válidos en spawn_args_template. Cualquier {nombre} fuera de este
// set hace fail-fast en boot (refinamiento Guru #3, CA-4).
const ALLOWED_PLACEHOLDERS = Object.freeze([
  'user_prompt',
  'system_file',
  'script_path',
  'issue',
  'trabajando_path',
]);

// Denylist de flags peligrosos en spawn_args_template. Bloquea inyección de
// proxy/config/inspect/eval (refinamiento Security #5 + Guru #4, CA-4).
const DENIED_FLAGS = Object.freeze([
  '--api-base',
  '--proxy',
  '--http-proxy',
  '--https-proxy',
  '--config',
  '--inspect',
  '--inspect-brk',
  '--require',
  '-r',
  '-e',
  '--eval',
]);

// Output parsers válidos (composición consistente con el schema).
const ALLOWED_OUTPUT_PARSERS = Object.freeze([
  'anthropic-stream-json',
  'openai-sse',
  'gemini-stream',
  'ollama-jsonl',
  'none',
]);

// Exit codes accionables (CA-2 + UX guideline).
const EXIT_CODES = Object.freeze({
  OK: 0,
  UNCAUGHT: 1,
  INVALID_CONFIG: 2,
  TOOLCHAIN_MISSING: 3,
});

// Regex para detectar placeholders {x} en strings del template.
// No greedy, sin separadores raros — si aparece `{user_prompt:--api-base=x}`
// el match captura `user_prompt:--api-base=x` y se rechaza por no estar en allowlist.
const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

// ─── Schema canónico ─────────────────────────────────────────────────────────

const CANONICAL_SCHEMA_PATH = path.resolve(__dirname, '..', 'agent-models.schema.json');
const CANONICAL_JSON_PATH = path.resolve(__dirname, '..', 'agent-models.json');

/**
 * Carga el schema desde disco e inyecta el enum de launchers desde la constante
 * exportada (composición programática — Guru refinamiento #1). Esto elimina por
 * construcción cualquier drift entre `ALLOWED_LAUNCHERS` y el `enum` del schema:
 * si alguien cambia uno solo, el otro queda sincronizado al cargar.
 */
function loadSchema(schemaPath = CANONICAL_SCHEMA_PATH) {
  const raw = fs.readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(raw);

  // Inyectar el enum desde la constante (override del literal en el JSON).
  if (
    schema &&
    schema.$defs &&
    schema.$defs.providerDef &&
    schema.$defs.providerDef.properties &&
    schema.$defs.providerDef.properties.launcher
  ) {
    schema.$defs.providerDef.properties.launcher.enum = [...ALLOWED_LAUNCHERS];
  }

  // Inyectar el enum de output_parser desde la constante.
  if (
    schema &&
    schema.$defs &&
    schema.$defs.providerDef &&
    schema.$defs.providerDef.properties &&
    schema.$defs.providerDef.properties.output_parser
  ) {
    schema.$defs.providerDef.properties.output_parser.enum = [...ALLOWED_OUTPUT_PARSERS];
  }

  return schema;
}

// ─── Carga defensiva de ajv (toolchain check) ────────────────────────────────

/**
 * Intenta cargar ajv. Si falla, devuelve `null` con motivo. El caller decide si
 * abortar (boot del pulpo → exit 3) o degradar (pre-commit hook → warning + exit 0).
 */
function tryLoadAjv() {
  try {
    // ajv v8 tiene draft 2020-12 en módulo separado.
    const Ajv = require('ajv/dist/2020');
    return { ok: true, Ajv };
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  }
}

// ─── Validaciones cruzadas (no expresables en JSON Schema vanilla) ───────────

/**
 * Valida placeholders y flags peligrosos en cada elemento del template.
 * Devuelve array de errores con jsonPath estilo JSON Pointer.
 */
function validateSpawnArgsTemplate(template, providerKey) {
  const errors = [];
  if (!Array.isArray(template)) return errors;

  for (let i = 0; i < template.length; i++) {
    const item = template[i];
    if (typeof item !== 'string') continue; // ya lo bloquea el schema, defensa redundante

    // Placeholders desconocidos.
    let m;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((m = PLACEHOLDER_RE.exec(item)) !== null) {
      const name = m[1];
      if (!ALLOWED_PLACEHOLDERS.includes(name)) {
        errors.push({
          path: `#/providers/${providerKey}/spawn_args_template/${i}`,
          message: `placeholder "{${name}}" no está en allowlist [${ALLOWED_PLACEHOLDERS.join(', ')}]`,
          fix: 'editar spawn_args_template para usar solo placeholders permitidos (ALLOWED_PLACEHOLDERS en lib/agent-models-validate.js)',
        });
      }
    }

    // Flags denylist (match exacto al string item — los flags se pasan como
    // elementos separados en argv, no concatenados con su valor).
    if (DENIED_FLAGS.includes(item)) {
      errors.push({
        path: `#/providers/${providerKey}/spawn_args_template/${i}`,
        message: `flag peligroso "${item}" en denylist (vector A03 Injection / proxy hijack)`,
        fix: `eliminar "${item}" del template; ver DENIED_FLAGS en lib/agent-models-validate.js`,
      });
    }

    // Defensa adicional: flag denylist concatenado con `=valor` (estilo
    // `--api-base=http://attacker.com`). El schema lo deja pasar como string,
    // pero la denylist debe matchear igual.
    for (const flag of DENIED_FLAGS) {
      if (item.startsWith(flag + '=')) {
        errors.push({
          path: `#/providers/${providerKey}/spawn_args_template/${i}`,
          message: `flag peligroso "${flag}=..." en denylist (vector A03 Injection / proxy hijack)`,
          fix: `eliminar el flag del template; ver DENIED_FLAGS en lib/agent-models-validate.js`,
        });
      }
    }
  }
  return errors;
}

/**
 * Cross-checks que JSON Schema vanilla no expresa (refinamiento Guru #2):
 *   - default_provider debe ser key de providers.
 *   - skills.<x>.provider debe ser key de providers.
 *   - placeholders + denylist en spawn_args_template (delegado a validateSpawnArgsTemplate).
 */
function validateCrossReferences(config) {
  const errors = [];
  if (!config || typeof config !== 'object') return errors;

  const providerKeys = config.providers && typeof config.providers === 'object'
    ? Object.keys(config.providers)
    : [];

  // default_provider ∈ providers
  if (config.default_provider && !providerKeys.includes(config.default_provider)) {
    errors.push({
      path: '#/default_provider',
      message: `default_provider "${config.default_provider}" no es key de providers (válidos: [${providerKeys.join(', ')}])`,
      fix: `declarar el provider "${config.default_provider}" en la sección providers o cambiar default_provider`,
    });
  }

  // skills.<x>.provider ∈ providers + spawn_args_template per provider
  if (config.providers && typeof config.providers === 'object') {
    for (const [key, providerDef] of Object.entries(config.providers)) {
      if (providerDef && Array.isArray(providerDef.spawn_args_template)) {
        errors.push(...validateSpawnArgsTemplate(providerDef.spawn_args_template, key));
      }
    }
  }

  if (config.skills && typeof config.skills === 'object') {
    for (const [skillKey, skillDef] of Object.entries(config.skills)) {
      if (skillDef && typeof skillDef.provider === 'string' && !providerKeys.includes(skillDef.provider)) {
        errors.push({
          path: `#/skills/${skillKey}/provider`,
          message: `provider "${skillDef.provider}" no es key de providers (válidos: [${providerKeys.join(', ')}])`,
          fix: `declarar el provider en la sección providers o cambiar el assignment del skill`,
        });
      }
    }
  }

  return errors;
}

// ─── API principal: validate(jsonPath) ───────────────────────────────────────

/**
 * Valida `agent-models.json` contra el schema y los cross-checks.
 * Devuelve `{ ok, errors, exitCode, config }` sin lanzar (CA-2: el caller decide).
 */
function validate(jsonPath = CANONICAL_JSON_PATH, options = {}) {
  const schemaPath = options.schemaPath || CANONICAL_SCHEMA_PATH;

  // 1. Toolchain check — ajv disponible.
  const ajvResult = tryLoadAjv();
  if (!ajvResult.ok) {
    return {
      ok: false,
      exitCode: EXIT_CODES.TOOLCHAIN_MISSING,
      errors: [{
        path: '(toolchain)',
        message: `no se pudo cargar ajv: ${ajvResult.reason}`,
        fix: "correr 'npm install' en la raíz del repo para instalar ajv y ajv-formats",
      }],
    };
  }

  // 2. Schema disponible.
  let schema;
  try {
    schema = loadSchema(schemaPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        ok: false,
        exitCode: EXIT_CODES.INVALID_CONFIG,
        errors: [{
          path: '(schema)',
          message: `falta agent-models.schema.json en ${schemaPath}`,
          fix: 'restaurar el schema canónico desde main o regenerarlo desde docs/pipeline-multi-provider/agent-models.schema.json',
        }],
      };
    }
    return {
      ok: false,
      exitCode: EXIT_CODES.INVALID_CONFIG,
      errors: [{
        path: '(schema)',
        message: `error parseando agent-models.schema.json: ${err.message}`,
        fix: 'verificar JSON válido del schema',
      }],
    };
  }

  // 3. JSON config disponible. CA-2: archivo ausente → mensaje accionable, NO ENOENT.
  let raw;
  try {
    raw = fs.readFileSync(jsonPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        ok: false,
        exitCode: EXIT_CODES.INVALID_CONFIG,
        errors: [{
          path: '(file)',
          message: `falta crear agent-models.json en ${jsonPath} (ver #3072)`,
          fix: 'mergear #3072 (H1) que crea el archivo canónico, o esperar a que esté disponible',
        }],
      };
    }
    return {
      ok: false,
      exitCode: EXIT_CODES.INVALID_CONFIG,
      errors: [{
        path: '(file)',
        message: `error leyendo agent-models.json: ${err.message}`,
        fix: 'verificar permisos y existencia del archivo',
      }],
    };
  }

  // 4. JSON parse defensivo (acepta .json y .jsonc strip básico de comentarios).
  let config;
  try {
    config = parseJsonOrJsonc(raw, jsonPath);
  } catch (err) {
    return {
      ok: false,
      exitCode: EXIT_CODES.INVALID_CONFIG,
      errors: [{
        path: '(parse)',
        message: `JSON inválido: ${err.message}`,
        fix: 'corregir sintaxis JSON (líneas/columna en el mensaje)',
      }],
    };
  }

  // 5. Schema validation (ajv).
  const ajv = new ajvResult.Ajv({ allErrors: true, strict: false });
  const validateFn = ajv.compile(schema);
  const ok = validateFn(config);
  const schemaErrors = ok ? [] : (validateFn.errors || []).map((e) => ({
    path: `${e.instancePath || '#/'}`,
    message: `${e.message || 'error de schema'}${e.params ? ` — ${JSON.stringify(e.params)}` : ''}`,
    fix: 'ajustar el campo al tipo/forma esperada por agent-models.schema.json',
  }));

  // 6. Cross-validations (independiente del schema, siempre corre).
  const crossErrors = validateCrossReferences(config);

  const allErrors = [...schemaErrors, ...crossErrors];

  return {
    ok: allErrors.length === 0,
    exitCode: allErrors.length === 0 ? EXIT_CODES.OK : EXIT_CODES.INVALID_CONFIG,
    errors: allErrors,
    config,
  };
}

/**
 * Strip básico de comentarios estilo `//` y `/* * /` para soportar `.jsonc`.
 * Diseño conservador — no usa parser completo de JSONC para no agregar deps.
 * Si un comentario contiene `"//"` dentro de un string JSON, no rompe porque
 * solo se eliminan comentarios de línea iniciados con `//` precedidos por
 * espacios o newline.
 */
function parseJsonOrJsonc(raw, filePath) {
  const isJsonc = filePath.endsWith('.jsonc');
  let text = raw;
  if (isJsonc) {
    text = stripJsoncComments(raw);
  }
  return JSON.parse(text);
}

/**
 * Strip de comentarios `//` y `/* * /` preservando contenido de strings.
 */
function stripJsoncComments(text) {
  let out = '';
  let i = 0;
  let inString = false;
  let stringChar = null;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < text.length) { out += text[i + 1]; i += 2; continue; }
      if (c === stringChar) { inString = false; stringChar = null; }
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      // Línea de comentario: skip hasta newline.
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      // Bloque de comentario: skip hasta */.
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ─── Formateo de errores estilo UX (4 líneas) ────────────────────────────────

/**
 * Formatea un error siguiendo el patrón obligatorio UX (CA-2):
 *   Línea 1: severidad + síntoma
 *   Línea 2: archivo + path
 *   Línea 3: problema concreto
 *   Línea 4: fix accionable + reproducir
 */
function formatError(err, options = {}) {
  const {
    contextLabel = 'boot abortado',
    filePath = CANONICAL_JSON_PATH,
    reproduceCmd = 'node .pipeline/lib/agent-models-validate.js',
  } = options;
  const lines = [];
  lines.push(`[validate] FATAL agent-models.json inválido — ${contextLabel}`);
  lines.push(`  archivo: ${filePath}`);
  lines.push(`  problema: ${err.path} ${err.message}`);
  if (err.fix) lines.push(`  solución: ${err.fix}`);
  lines.push(`  reproducir: ${reproduceCmd}`);
  return lines.join('\n');
}

/**
 * Formatea N errores. Sólo el primero usa el patrón completo; los demás se
 * agregan compactados para no sepultar al operador (refinamiento UX).
 */
function formatAllErrors(errors, options = {}) {
  if (!errors || errors.length === 0) return '';
  const head = formatError(errors[0], options);
  if (errors.length === 1) return head;
  const tail = errors.slice(1).map((e) => `  + ${e.path} ${e.message}`).join('\n');
  return `${head}\n  (${errors.length - 1} error(es) adicional(es):)\n${tail}`;
}

// ─── API: validateOrExit (boot-style fail-fast) ──────────────────────────────

/**
 * Ejecuta validate() y, si falla, imprime el formato UX a stderr y llama
 * `process.exit(N)` con el exit code apropiado.
 *
 * Llamada típica desde pulpo.js boot:
 *   require('./lib/agent-models-validate').validateOrExit({ contextLabel: 'boot abortado' });
 */
function validateOrExit(options = {}) {
  const {
    jsonPath = CANONICAL_JSON_PATH,
    schemaPath = CANONICAL_SCHEMA_PATH,
    contextLabel = 'boot abortado',
    onErrorWrite = (msg) => { process.stderr.write(msg + '\n'); },
    exitFn = (code) => process.exit(code),
  } = options;

  const result = validate(jsonPath, { schemaPath });
  if (result.ok) return result;

  const msg = formatAllErrors(result.errors, { contextLabel, filePath: jsonPath });
  onErrorWrite(msg);
  exitFn(result.exitCode);
  return result;
}

// ─── expandSpawnArgs — función pura testeable (CA-6 fuzzing) ─────────────────

/**
 * Expande `template` (array de strings) con valores de `context` (Map de
 * placeholder → valor crudo). Diseño anti-injection:
 *   - Cada elemento del template es un string crudo del argv resultante.
 *   - El valor del placeholder aparece como **un único elemento** del argv.
 *   - NO se ejecuta shell parsing, NO se reentra a expandir placeholders dentro
 *     del valor del placeholder, NO se splittea por whitespace.
 *
 * Garantía testeable (CA-6): para cualquier `user_prompt` malicioso (`'; rm -rf /'`,
 * `'$(whoami)'`, NUL byte, 10MB, RTL, BOM), el resultado devuelve el string
 * exacto en `argv[N]` sin escape ni split.
 */
function expandSpawnArgs(template, context) {
  if (!Array.isArray(template)) {
    throw new Error('expandSpawnArgs: template debe ser array');
  }
  if (!context || typeof context !== 'object') {
    throw new Error('expandSpawnArgs: context debe ser objeto');
  }

  const out = [];
  for (let i = 0; i < template.length; i++) {
    const tmpl = template[i];
    if (typeof tmpl !== 'string') {
      throw new Error(`expandSpawnArgs: template[${i}] no es string`);
    }
    // Caso 1: el item es un placeholder puro (la mayoría de los casos):
    // se reemplaza 1:1 con el valor crudo de context, sin re-parseo.
    const pureMatch = /^\{([^{}]+)\}$/.exec(tmpl);
    if (pureMatch) {
      const name = pureMatch[1];
      if (!ALLOWED_PLACEHOLDERS.includes(name)) {
        throw new Error(`expandSpawnArgs: placeholder "{${name}}" no está en allowlist`);
      }
      const value = Object.prototype.hasOwnProperty.call(context, name) ? context[name] : '';
      // value puede ser cualquier string — lo emitimos crudo, sin split.
      out.push(stringifyContextValue(value));
      continue;
    }
    // Caso 2: el item es un string mixto (literal con placeholders embebidos).
    // Reemplazamos todos los placeholders pero el resultado queda como UN solo
    // elemento del argv. Validamos que cada placeholder esté en allowlist;
    // si no, fail-fast — esto debería ya haber sido rechazado por la validación
    // en validateSpawnArgsTemplate, defensa redundante.
    const expanded = tmpl.replace(PLACEHOLDER_RE, (full, name) => {
      if (!ALLOWED_PLACEHOLDERS.includes(name)) {
        throw new Error(`expandSpawnArgs: placeholder "{${name}}" no está en allowlist`);
      }
      const v = Object.prototype.hasOwnProperty.call(context, name) ? context[name] : '';
      return stringifyContextValue(v);
    });
    out.push(expanded);
  }
  return out;
}

/**
 * Convierte cualquier valor de context a string crudo. No coerce a JSON, no
 * stringifica, sólo `String(v)`. Si v ya es string, lo devuelve tal cual.
 */
function stringifyContextValue(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return String(v);
}

// ─── Helpers de export para schema sincronización ────────────────────────────

/**
 * Devuelve el schema "efectivo" tras inyectar la constante de launchers.
 * Útil para testing.
 */
function getEffectiveSchema(schemaPath = CANONICAL_SCHEMA_PATH) {
  return loadSchema(schemaPath);
}

// ─── CLI entrypoint (pre-commit hook + reproducción manual) ──────────────────

function cliMain(argv) {
  const args = argv.slice(2);
  let jsonPath = CANONICAL_JSON_PATH;
  let schemaPath = CANONICAL_SCHEMA_PATH;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--file' && args[i + 1]) { jsonPath = path.resolve(args[++i]); }
    else if (a === '--schema' && args[i + 1]) { schemaPath = path.resolve(args[++i]); }
    else if (a === '--quiet') { quiet = true; }
    else if (a === '--help' || a === '-h') {
      process.stdout.write([
        'agent-models-validate — valida agent-models.json',
        '',
        'Uso: node .pipeline/lib/agent-models-validate.js [--file PATH] [--schema PATH] [--quiet]',
        '',
        'Exit codes:',
        '  0 = OK',
        '  1 = excepción no controlada',
        '  2 = config inválida',
        '  3 = toolchain ausente (correr npm install)',
        '',
      ].join('\n'));
      process.exit(0);
    }
  }

  const result = validate(jsonPath, { schemaPath });
  if (result.ok) {
    if (!quiet) process.stdout.write(`[validate] OK ${path.relative(process.cwd(), jsonPath)}\n`);
    process.exit(EXIT_CODES.OK);
  }
  const msg = formatAllErrors(result.errors, {
    contextLabel: 'commit/boot rechazado',
    filePath: jsonPath,
  });
  process.stderr.write(msg + '\n');
  process.exit(result.exitCode);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Constantes inmutables (fuente única de verdad).
  ALLOWED_LAUNCHERS,
  SHELL_REQUIRED_LAUNCHERS,
  ALLOWED_PLACEHOLDERS,
  DENIED_FLAGS,
  ALLOWED_OUTPUT_PARSERS,
  EXIT_CODES,
  CANONICAL_SCHEMA_PATH,
  CANONICAL_JSON_PATH,

  // API pública.
  validate,
  validateOrExit,
  expandSpawnArgs,

  // Helpers (testing).
  loadSchema,
  getEffectiveSchema,
  validateSpawnArgsTemplate,
  validateCrossReferences,
  formatError,
  formatAllErrors,
  parseJsonOrJsonc,
  stripJsoncComments,
  stringifyContextValue,
  tryLoadAjv,
};

// Si el módulo se ejecuta como CLI, arrancar.
if (require.main === module) {
  try {
    cliMain(process.argv);
  } catch (err) {
    process.stderr.write(`[validate] FATAL excepción no controlada: ${err.stack || err.message}\n`);
    process.exit(EXIT_CODES.UNCAUGHT);
  }
}
