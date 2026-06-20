// =============================================================================
// request-classify.test.js — Cobertura del clasificador puro del resultado de
// una petición del Commander (#3951 / EP7-H4).
//
// Estructura:
//   T-1  Precedencia del enum: error > ajustada > fallback > ok.
//   T-2  `error` por hadError / disclaimer F-6 / respuesta vacía.
//   T-3  `ajustada` por verdict rechazado (gana a fallback/ok).
//   T-4  `fallback` por crossProvider o fallbackUsed (gana a ok).
//   T-5  `ok` caso base.
//   T-6  provider validado contra agent-models.json; inválido → 'desconocido'.
//   T-7  sameProviderVerification refleja verdict.sameProvider.
//   T-8  robustez: input vacío / parcial no tira.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../request-classify');
const { classifyCommanderResult, validateProvider, RESULTADOS, PROVIDER_DESCONOCIDO } = mod;

// --- T-1 precedencia -----------------------------------------------------------
test('precedencia: error gana a ajustada/fallback/ok', () => {
  const r = classifyCommanderResult({
    hadError: true,
    sherlockVerdict: { verdict: 'rechazado', sameProvider: true },
    dispatchResolution: { provider: 'anthropic', crossProvider: true, fallbackUsed: 'gemini-google' },
  });
  assert.equal(r.resultado, 'error');
});

test('precedencia: ajustada gana a fallback/ok (verdict rechazado + crossProvider)', () => {
  const r = classifyCommanderResult({
    hadError: false,
    sherlockVerdict: { verdict: 'rechazado' },
    dispatchResolution: { provider: 'anthropic', crossProvider: true, fallbackUsed: 'cerebras' },
  });
  assert.equal(r.resultado, 'ajustada');
});

test('precedencia: fallback gana a ok (crossProvider sin rechazo)', () => {
  const r = classifyCommanderResult({
    sherlockVerdict: { verdict: 'ok' },
    dispatchResolution: { provider: 'anthropic', crossProvider: true, fallbackUsed: null },
  });
  assert.equal(r.resultado, 'fallback');
});

// --- T-2 error ----------------------------------------------------------------
test('error ← hadError true', () => {
  const r = classifyCommanderResult({ hadError: true, dispatchResolution: { provider: 'anthropic' } });
  assert.equal(r.resultado, 'error');
});

test('error ← disclaimer de tipo timeout/sin-provider (F-6)', () => {
  for (const disc of ['TIMEOUT_OR_NO_PROVIDER', 'sherlock_timeout', 'no_provider', 'persistent_inconsistency']) {
    const r = classifyCommanderResult({ sherlockDisclaimerType: disc, dispatchResolution: { provider: 'anthropic' } });
    assert.equal(r.resultado, 'error', `disclaimer ${disc} debe mapear a error`);
  }
});

test('error ← respuesta vacía (emptyResponse)', () => {
  const r = classifyCommanderResult({ emptyResponse: true, dispatchResolution: { provider: 'anthropic' } });
  assert.equal(r.resultado, 'error');
});

test('un disclaimer NO-error (ej. same_provider aditivo) NO fuerza error', () => {
  // Un disclaimer que no matchea el patrón timeout/no-provider/persistent no
  // debe degradar a error. Usamos un tipo arbitrario fuera del patrón.
  const r = classifyCommanderResult({ sherlockDisclaimerType: 'same_provider_notice', dispatchResolution: { provider: 'anthropic' }, sherlockVerdict: { verdict: 'ok' } });
  assert.equal(r.resultado, 'ok');
});

// --- T-3 ajustada -------------------------------------------------------------
test('ajustada ← verdict rechazado', () => {
  const r = classifyCommanderResult({ sherlockVerdict: { verdict: 'rechazado' }, dispatchResolution: { provider: 'anthropic' } });
  assert.equal(r.resultado, 'ajustada');
});

// --- T-4 fallback -------------------------------------------------------------
test('fallback ← fallbackUsed != null (aunque crossProvider sea false)', () => {
  const r = classifyCommanderResult({ dispatchResolution: { provider: 'gemini-google', crossProvider: false, fallbackUsed: 'gemini-google' } });
  assert.equal(r.resultado, 'fallback');
  assert.equal(r.fallbackUsed, true);
});

test('fallback ← crossProvider true (fallbackUsed null)', () => {
  const r = classifyCommanderResult({ dispatchResolution: { provider: 'cerebras', crossProvider: true, fallbackUsed: null } });
  assert.equal(r.resultado, 'fallback');
  assert.equal(r.crossProviderDispatch, true);
});

// --- T-5 ok -------------------------------------------------------------------
test('ok ← caso base (Anthropic primario, verdict ok, sin fallback)', () => {
  const r = classifyCommanderResult({
    sherlockVerdict: { verdict: 'ok', sameProvider: false },
    dispatchResolution: { provider: 'anthropic', crossProvider: false, fallbackUsed: null },
  });
  assert.equal(r.resultado, 'ok');
  assert.equal(r.fallbackUsed, false);
  assert.equal(r.crossProviderDispatch, false);
});

test('el enum cerrado sólo contiene los 4 valores esperados', () => {
  assert.deepEqual([...RESULTADOS].sort(), ['ajustada', 'error', 'fallback', 'ok']);
});

// --- T-6 provider validado ----------------------------------------------------
test('provider válido (anthropic) se preserva', () => {
  const r = classifyCommanderResult({ dispatchResolution: { provider: 'anthropic' } });
  assert.equal(r.provider, 'anthropic');
});

test('provider de la allowlist de agent-models.json se preserva (gemini-google)', () => {
  const r = classifyCommanderResult({ dispatchResolution: { provider: 'gemini-google', fallbackUsed: 'gemini-google' } });
  assert.equal(r.provider, 'gemini-google');
});

test('provider inválido → desconocido (anti log-forging)', () => {
  for (const bad of ['<script>', 'fakeprovider', '', null, undefined, 123, 'anthropic; rm -rf']) {
    const r = classifyCommanderResult({ dispatchResolution: { provider: bad } });
    assert.equal(r.provider, PROVIDER_DESCONOCIDO, `provider ${JSON.stringify(bad)} debe coaccionar a desconocido`);
  }
});

test('validateProvider devuelve desconocido para no-string', () => {
  assert.equal(validateProvider(null), PROVIDER_DESCONOCIDO);
  assert.equal(validateProvider({}), PROVIDER_DESCONOCIDO);
  assert.equal(validateProvider('anthropic'), 'anthropic');
});

test('deterministic NO es un provider válido para el Historial', () => {
  // `deterministic` se filtra explícitamente del set declarado.
  const r = classifyCommanderResult({ dispatchResolution: { provider: 'deterministic' } });
  assert.equal(r.provider, PROVIDER_DESCONOCIDO);
});

// --- T-7 sameProviderVerification ---------------------------------------------
test('sameProviderVerification refleja verdict.sameProvider === true', () => {
  const yes = classifyCommanderResult({ sherlockVerdict: { verdict: 'ok', sameProvider: true }, dispatchResolution: { provider: 'anthropic' } });
  assert.equal(yes.sameProviderVerification, true);
  const no = classifyCommanderResult({ sherlockVerdict: { verdict: 'ok', sameProvider: false }, dispatchResolution: { provider: 'anthropic' } });
  assert.equal(no.sameProviderVerification, false);
  const missing = classifyCommanderResult({ sherlockVerdict: { verdict: 'ok' }, dispatchResolution: { provider: 'anthropic' } });
  assert.equal(missing.sameProviderVerification, false);
});

// --- T-8 robustez -------------------------------------------------------------
test('input vacío / undefined no tira y devuelve shape completo', () => {
  for (const arg of [undefined, null, {}, 'no-objeto', 42]) {
    const r = classifyCommanderResult(arg);
    assert.equal(r.resultado, 'ok');
    assert.equal(r.provider, PROVIDER_DESCONOCIDO);
    assert.equal(typeof r.fallbackUsed, 'boolean');
    assert.equal(typeof r.crossProviderDispatch, 'boolean');
    assert.equal(typeof r.sameProviderVerification, 'boolean');
  }
});

test('el resultado siempre pertenece al enum cerrado', () => {
  const cases = [
    { hadError: true },
    { sherlockVerdict: { verdict: 'rechazado' } },
    { dispatchResolution: { crossProvider: true } },
    {},
  ];
  for (const c of cases) {
    const r = classifyCommanderResult(c);
    assert.ok(RESULTADOS.includes(r.resultado), `resultado ${r.resultado} fuera del enum`);
  }
});
