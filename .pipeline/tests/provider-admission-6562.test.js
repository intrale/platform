// =============================================================================
// provider-admission-6562.test.js — Criterio de admisión de proveedores (#6562)
//
// Un proveedor entra al ruteo sólo si cumple LAS TRES condiciones:
//   1. CLI local capaz de editar archivos.
//   2. Reporta consumo verificable.
//   3. Términos que no entrenan con nuestro código.
//
// Cubre:
//   - Gherkin 1: alta de un proveedor que cumple las tres → se acepta.
//   - Gherkin 2: alta de un proveedor sin reporte de consumo → falla y el
//     mensaje dice "no reporta consumo verificable".
//   - CA-3: el mensaje nombra la condición incumplida, distingue "declaró
//     false" de "no declaró", agrupa todas las condiciones en un solo error y
//     dice dónde corregir (path JSON + campo).
//   - Fail-closed: bloque `admission` ausente = no cumple ninguna.
//   - Exención explícita `non_llm` (sólo con output_parser none).
//   - Coherencia cli_edits_files ↔ capabilities (una sola verdad).
//   - Excepción temporal con vencimiento (vigente pasa; vencida, eterna o
//     malformada rompe la carga).
//   - Las dos vías de alta comparten el guardrail: boot (validate) y write
//     path del dashboard (agent-models-rw.writeConfig).
//   - CA-2 / CA-4 (policy): el JSON canónico declara las tres por proveedor y
//     la evaluación vigente quedó registrada en docs/pipeline/multi-provider.md.
//
// Framework: node --test (built-in, sin deps).
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const validator = require('../lib/agent-models-validate');
const rw = require('../lib/multi-provider/agent-models-rw');

const PIPELINE_DIR = path.resolve(__dirname, '..');
const CANONICAL_JSON = path.join(PIPELINE_DIR, 'agent-models.json');
const DOC_PATH = path.resolve(PIPELINE_DIR, '..', 'docs', 'pipeline', 'multi-provider.md');

// Reloj fijo para que las excepciones con fecha sean determinísticas.
const NOW = new Date('2026-09-16T12:00:00Z');
const daysFromNow = (n) => new Date(NOW.getTime() + n * 86400000).toISOString().slice(0, 10);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tmpJson(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-admission-6562-'));
  const file = path.join(dir, 'agent-models.json');
  fs.writeFileSync(file, JSON.stringify(content, null, 2));
  return { file, dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* no-op */ } } };
}

function llmProvider(overrides = {}) {
  return Object.assign({
    launcher: 'claude',
    model: 'claude-opus-4-7',
    spawn_args_template: ['-p', '{user_prompt}', '--system-prompt-file', '{system_file}'],
    output_parser: 'anthropic-stream-json',
    quota_error_types: ['usage_limit_error'],
    supports_tool_use: true,
    capabilities: ['agentic-tool-use'],
    prompt_caching: { supported: true },
    auth_mode: 'oauth',
  }, overrides);
}

function deterministicProvider(overrides = {}) {
  return Object.assign({
    launcher: 'node',
    model: 'deterministic',
    spawn_args_template: ['{script_path}', '{issue}', '--trabajando={trabajando_path}'],
    output_parser: 'none',
    quota_error_types: [],
    supports_tool_use: false,
    capabilities: ['agentic-tool-use'],
    prompt_caching: { supported: false },
    admission: { non_llm: true },
  }, overrides);
}

const ADMITTED = Object.freeze({ cli_edits_files: true, reports_usage: true, terms_no_training: true });

/** Config mínima: `anthropic` admitido como default + un provider bajo prueba activado en el ruteo. */
function configWithCandidate(candidateDef, { routed = true } = {}) {
  const cfg = {
    default_provider: 'anthropic',
    providers: {
      anthropic: llmProvider({ admission: Object.assign({}, ADMITTED) }),
      candidato: candidateDef,
      deterministic: deterministicProvider(),
    },
    skills: {
      'backend-dev': { provider: 'anthropic' },
      build: { provider: 'deterministic' },
    },
  };
  if (routed) cfg.skills['backend-dev'].fallbacks = [{ provider: 'candidato' }];
  return cfg;
}

function admissionErrors(cfg, opts = {}) {
  return validator.validateProviderAdmission(cfg, Object.assign({ now: NOW }, opts));
}

function runValidate(cfg) {
  const t = tmpJson(cfg);
  try {
    return validator.validate(t.file, { now: NOW });
  } finally {
    t.cleanup();
  }
}

// ─── Gherkin ─────────────────────────────────────────────────────────────────

test('Gherkin 1 · alta de un proveedor que cumple las tres condiciones se acepta', () => {
  const cfg = configWithCandidate(llmProvider({ admission: Object.assign({}, ADMITTED) }));
  const r = runValidate(cfg);
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
  assert.deepEqual(admissionErrors(cfg), []);
});

test('Gherkin 2 · alta de un proveedor que edita archivos pero no reporta consumo falla y el mensaje lo dice', () => {
  const cfg = configWithCandidate(llmProvider({
    admission: { cli_edits_files: true, reports_usage: false, terms_no_training: true },
  }));
  const r = runValidate(cfg);
  assert.equal(r.ok, false, 'la activación debe fallar');
  const errs = r.errors.filter((e) => e.message.startsWith('[provider-admission]'));
  assert.equal(errs.length, 1, `un solo error por proveedor: ${JSON.stringify(errs)}`);
  const e = errs[0];
  assert.match(e.message, /"candidato"/);
  assert.match(e.message, /no reporta consumo verificable/);
  assert.match(e.message, /admission\.reports_usage: declaró false/);
  // Las condiciones que sí cumple no se mencionan como incumplidas.
  assert.doesNotMatch(e.message, /su CLI no edita archivos/);
  assert.doesNotMatch(e.message, /sus términos entrenan con el código/);
  // Dónde corregir: path JSON + campo.
  assert.equal(e.path, '#/providers/candidato/admission');
  assert.match(e.fix, /providers\.candidato\.admission/);
  assert.match(e.fix, /docs\/pipeline\/multi-provider\.md/);
});

// ─── CA-3: mensaje que nombra la condición incumplida ────────────────────────

test('el mensaje distingue "declaró false" de "no declaró" y agrupa todas las condiciones en un solo error', () => {
  const cfg = configWithCandidate(llmProvider({
    capabilities: [],
    admission: { cli_edits_files: false, terms_no_training: false }, // reports_usage ausente
  }));
  const errs = admissionErrors(cfg);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  const m = errs[0].message;
  assert.match(m, /su CLI no edita archivos \(admission\.cli_edits_files: declaró false\)/);
  assert.match(m, /no reporta consumo verificable \(admission\.reports_usage: no declaró\)/);
  assert.match(m, /sus términos entrenan con el código \(admission\.terms_no_training: declaró false\)/);
  // Dice dónde está activado el proveedor.
  assert.match(m, /#\/skills\/backend-dev\/fallbacks\/0/);
});

test('fail-closed · un proveedor ruteado sin bloque admission no cumple ninguna de las tres', () => {
  const cfg = configWithCandidate(llmProvider()); // sin admission
  const errs = admissionErrors(cfg);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  const m = errs[0].message;
  assert.match(m, /falta el bloque admission/);
  for (const c of validator.ADMISSION_CONDITIONS) {
    assert.match(m, new RegExp(`admission\\.${c.field}: no declaró`));
  }
});

test('fail-closed · un valor no booleano (string "true") cuenta como "no declaró"', () => {
  const cfg = configWithCandidate(llmProvider({
    admission: { cli_edits_files: true, reports_usage: 'true', terms_no_training: true },
  }));
  const errs = admissionErrors(cfg);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /admission\.reports_usage: no declaró/);
});

test('un proveedor declarado pero no referenciado por el ruteo no rompe la carga aunque no cumpla', () => {
  const cfg = configWithCandidate(llmProvider({ admission: { cli_edits_files: true } }), { routed: false });
  assert.deepEqual(admissionErrors(cfg), []);
  // …pero en cuanto entra al ruteo (default_provider también cuenta) falla.
  cfg.default_provider = 'candidato';
  const errs = admissionErrors(cfg);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /#\/default_provider/);
});

test('el ruteo cuenta primario, fallbacks objeto y fallbacks string (legacy)', () => {
  const cfg = configWithCandidate(llmProvider({ admission: {} }), { routed: false });
  cfg.skills.qa = { provider: 'anthropic', fallbacks: ['candidato'] };
  const routed = validator.collectRoutedProviders(cfg);
  assert.deepEqual(routed.get('candidato'), ['#/skills/qa/fallbacks/0']);
  assert.ok(routed.get('anthropic').includes('#/default_provider'));
  assert.ok(routed.get('anthropic').includes('#/skills/backend-dev/provider'));
  assert.equal(admissionErrors(cfg).length, 1);
});

// ─── Exención non_llm ────────────────────────────────────────────────────────

test('non_llm · el ejecutor determinista queda exento con una marca explícita en su declaración', () => {
  const cfg = configWithCandidate(llmProvider({ admission: Object.assign({}, ADMITTED) }));
  assert.deepEqual(admissionErrors(cfg), []);
  const ev = validator.evaluateProviderAdmission('deterministic', cfg.providers.deterministic, { now: NOW });
  assert.equal(ev.exempt, true);
  assert.equal(ev.verdict, 'exento (sin LLM)');
  // Sin la marca, el mismo provider deja de estar exento (no hay caso especial por nombre).
  delete cfg.providers.deterministic.admission;
  const errs = admissionErrors(cfg);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /"deterministic"/);
});

test('non_llm · un proveedor LLM no puede eximirse: output_parser distinto de none es error', () => {
  const cfg = configWithCandidate(llmProvider({ admission: { non_llm: true } }));
  const errs = admissionErrors(cfg);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.equal(errs[0].path, '#/providers/candidato/admission/non_llm');
  assert.match(errs[0].message, /output_parser es "anthropic-stream-json"/);
});

// ─── Coherencia con capabilities ─────────────────────────────────────────────

test('cli_edits_files=true sin capability agentic-tool-use es una contradicción y rompe la carga', () => {
  const cfg = configWithCandidate(llmProvider({ capabilities: [], admission: Object.assign({}, ADMITTED) }));
  const errs = admissionErrors(cfg);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.equal(errs[0].path, '#/providers/candidato/admission/cli_edits_files');
  assert.match(errs[0].message, /agentic-tool-use/);
});

// ─── Excepción temporal ──────────────────────────────────────────────────────

function withException(exception) {
  return llmProvider({
    capabilities: [],
    admission: { cli_edits_files: false, reports_usage: false, terms_no_training: false, exception },
  });
}

test('exception · vigente: el proveedor sigue en el ruteo y el veredicto lo declara', () => {
  const cfg = configWithCandidate(withException({ reason: 'baja programada en #6563', until: daysFromNow(30), issue: 6563 }));
  assert.deepEqual(admissionErrors(cfg), []);
  assert.equal(runValidate(cfg).ok, true);
  const ev = validator.evaluateProviderAdmission('candidato', cfg.providers.candidato, { now: NOW });
  assert.equal(ev.admissible, false);
  assert.equal(ev.verdict, 'no admisible — excepción vigente');
});

test('exception · el día `until` es inclusivo; al día siguiente vence y rompe la carga nombrando el vencimiento', () => {
  const cfg = configWithCandidate(withException({ reason: 'baja programada en #6563', until: daysFromNow(0) }));
  assert.deepEqual(admissionErrors(cfg), []);
  const errs = admissionErrors(cfg, { now: new Date(NOW.getTime() + 86400000) });
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0].message, /venció el /);
  assert.match(errs[0].message, /no reporta consumo verificable/);
});

test('exception · no existe la excepción eterna: más de ADMISSION_EXCEPTION_MAX_DAYS es error', () => {
  const max = validator.ADMISSION_EXCEPTION_MAX_DAYS;
  const ok = configWithCandidate(withException({ reason: 'x', until: daysFromNow(max) }));
  assert.deepEqual(admissionErrors(ok), []);
  const bad = configWithCandidate(withException({ reason: 'x', until: daysFromNow(max + 1) }));
  const errs = admissionErrors(bad);
  assert.ok(errs.some((e) => e.path === '#/providers/candidato/admission/exception/until'), JSON.stringify(errs));
  // Y además el proveedor queda bloqueado (la excepción demasiado larga no está activa).
  assert.ok(errs.some((e) => e.path === '#/providers/candidato/admission'));
});

test('exception · malformada (reason vacío o until sin formato) es error y no habilita el ruteo', () => {
  for (const exception of [{ reason: '  ', until: daysFromNow(10) }, { reason: 'x', until: '31/10/2026' }, { reason: 'x', until: '2026-13-45' }]) {
    const cfg = configWithCandidate(withException(exception));
    const errs = admissionErrors(cfg);
    assert.ok(errs.some((e) => e.path === '#/providers/candidato/admission/exception'), JSON.stringify({ exception, errs }));
    assert.ok(errs.some((e) => e.path === '#/providers/candidato/admission'), 'sigue bloqueado');
  }
});

test('schema · claves desconocidas dentro de admission se rechazan (additionalProperties false)', () => {
  const cfg = configWithCandidate(llmProvider({ admission: Object.assign({ edita: true }, ADMITTED) }));
  const r = runValidate(cfg);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.includes('/providers/candidato/admission') && /additional/i.test(e.message)), JSON.stringify(r.errors));
});

// ─── Las dos vías de alta comparten el guardrail ─────────────────────────────

test('el write path del dashboard (agent-models-rw.writeConfig) rechaza activar un proveedor no admisible sin tocar disco', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-admission-6562-rw-'));
  try {
    const jsonPath = path.join(dir, 'agent-models.json');
    const good = configWithCandidate(llmProvider({ admission: Object.assign({}, ADMITTED) }));
    fs.writeFileSync(jsonPath, JSON.stringify(good, null, 2));
    const bad = configWithCandidate(llmProvider({ admission: { cli_edits_files: true, reports_usage: false, terms_no_training: true } }));
    assert.throws(
      () => rw.writeConfig({ newConfig: bad, jsonPath, backupDir: path.join(dir, 'backups'), lockPath: path.join(dir, 'lock') }),
      (err) => Array.isArray(err.errors) && err.errors.some((e) => /no reporta consumo verificable/.test(e.message)),
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(jsonPath, 'utf8')), good, 'el archivo no se modificó');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* no-op */ }
  }
});

// ─── Policy sobre el JSON canónico y la doc (CA-1, CA-2, CA-4) ───────────────

test('CA-2 · cada proveedor del JSON canónico declara las tres condiciones o la exención non_llm', () => {
  const cfg = JSON.parse(fs.readFileSync(CANONICAL_JSON, 'utf8'));
  for (const [key, def] of Object.entries(cfg.providers)) {
    assert.ok(def.admission && typeof def.admission === 'object', `${key} no declara admission`);
    if (def.admission.non_llm === true) {
      assert.equal(def.output_parser, 'none', `${key} se exime como non_llm pero parsea output de LLM`);
      continue;
    }
    for (const c of validator.ADMISSION_CONDITIONS) {
      assert.equal(typeof def.admission[c.field], 'boolean', `${key}: admission.${c.field} debe ser booleano explícito`);
    }
  }
});

test('CA-4 · los proveedores activos quedan evaluados: sólo anthropic y openai-codex son admisibles; gemini-google sigue por excepción con vencimiento e issue #6564', () => {
  const cfg = JSON.parse(fs.readFileSync(CANONICAL_JSON, 'utf8'));
  const routed = validator.collectRoutedProviders(cfg);
  const verdicts = {};
  for (const [key, def] of Object.entries(cfg.providers)) {
    verdicts[key] = validator.evaluateProviderAdmission(key, def, { now: NOW }).verdict;
  }
  assert.equal(verdicts.anthropic, 'admisible');
  assert.equal(verdicts['openai-codex'], 'admisible');
  assert.equal(verdicts.deterministic, 'exento (sin LLM)');
  // #6563 — cerebras / nvidia-nim / kimi-moonshot dados de baja: ya no están
  // declarados ni ruteados. La excepción de gemini-google se reasignó a #6564.
  for (const retired of ['cerebras', 'nvidia-nim', 'kimi-moonshot']) {
    assert.equal(cfg.providers[retired], undefined, `${retired} no debería seguir declarado tras #6563`);
    assert.ok(!routed.has(retired), `${retired} no debería seguir ruteado tras #6563`);
  }
  for (const key of ['gemini-google']) {
    assert.ok(routed.has(key), `${key} debería seguir ruteado hasta #6564`);
    assert.equal(verdicts[key], 'no admisible — excepción vigente', `${key}: ${verdicts[key]}`);
    assert.equal(cfg.providers[key].admission.exception.issue, 6564);
  }
  // Y el boot acepta el JSON canónico con el reloj de la medición.
  const r = validator.validate(CANONICAL_JSON, { now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
});

test('CA-1 · el criterio y la tabla de evaluación están en docs/pipeline/multi-provider.md con el mismo vocabulario que el guardrail', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  assert.match(doc, /^## 16\. Criterio de admisión de proveedores \(#6562\)/m);
  for (const c of validator.ADMISSION_CONDITIONS) {
    assert.ok(doc.includes(c.failLabel), `la doc no usa el rótulo "${c.failLabel}"`);
    assert.ok(doc.includes('`' + c.field + '`'), `la doc no nombra el campo ${c.field}`);
  }
  assert.match(doc, /\[provider-admission\]/);
  assert.match(doc, /non_llm/);
  assert.match(doc, /Evaluación vigente.*2026-09-16|medición.*2026-09-16/s);
  // Cada proveedor del JSON canónico aparece en la tabla de evaluación.
  const cfg = JSON.parse(fs.readFileSync(CANONICAL_JSON, 'utf8'));
  const section = doc.slice(doc.indexOf('## 16. Criterio de admisión'));
  for (const key of Object.keys(cfg.providers)) {
    assert.ok(section.includes('`' + key + '`'), `la tabla de evaluación no incluye ${key}`);
  }
});
