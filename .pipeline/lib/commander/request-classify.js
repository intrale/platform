// =============================================================================
// request-classify.js — Clasificador PURO del resultado de una petición del
// Commander (#3951 / EP7-H4).
//
// Mapea las dos fuentes de verdad ya existentes — la resolución de dispatch
// (`multi-provider.js`: provider/fallbackUsed/crossProvider) y el veredicto de
// Sherlock (`sherlock-verifier.js`: verdict/sameProvider) — a un ENUM CERRADO de
// resultado: `ok | ajustada | fallback | error`, con precedencia explícita
// `error > ajustada > fallback > ok`.
//
// El módulo es PURO y determinístico: no toca disco más que `validateProvider`,
// que lee `agent-models.json` (path FIJO vía `safeReadJson`, NUNCA `require`
// dinámico con path construido — patrón de `dashboard-slices.js`). Así es
// unit-testeable sin levantar el pulpo (que no se puede unit-testear).
//
// Requisitos de seguridad incorporados (security — fase análisis EP7-H4):
//   SEC-2 (anti log-forging / A09): `resultado` es un enum CERRADO y `provider`
//          se valida contra el set declarado en `agent-models.json`; si no
//          matchea → coerción a `'desconocido'`. NUNCA se deriva el resultado ni
//          el provider del texto libre de la respuesta del LLM.
// =============================================================================
'use strict';

const path = require('path');
const fs = require('fs');

// Enum cerrado de resultado. Congelado para que no se mute en runtime.
const RESULTADOS = Object.freeze(['ok', 'ajustada', 'fallback', 'error']);

// #3951 rebote — verdicts de Sherlock que representan una verificación EFECTIVA:
// Sherlock CORRIÓ y emitió un veredicto comparando el análisis contra el estado
// real (mismo criterio que `sherlockInvoked = verdict.verdict !== 'skipped'` en
// `pulpo.js`). Sólo en estos casos el flag `sameProvider` tiene sentido. Un
// `skipped` (config OFF / provider no disponible) o la AUSENCIA de verdict
// (Sherlock no invocado) significan "no hubo verificación" ⇒ el clasificador
// emite `sameProviderVerification: null` (tri-estado) para que el render NO
// invente un estado cross/same-provider (CA-3 / guideline UX).
const VERIFIED_VERDICTS = Object.freeze(['ok', 'rechazado', 'aborted']);

// Valor de coerción cuando el provider no matchea la allowlist de
// `agent-models.json` (anti log-forging). NO es un provider real.
const PROVIDER_DESCONOCIDO = 'desconocido';

// Set mínimo de providers conocido como fallback si `agent-models.json` no está
// disponible (caso edge en tests/arranque). Se filtra `deterministic` (no es un
// provider de chat con cuota). Coincide con el set declarado por los CA.
const FALLBACK_PROVIDERS = Object.freeze([
  'anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim',
]);

// Path FIJO al `agent-models.json` (dos niveles arriba de `lib/commander/`).
// SEC: jamás se construye a partir de input — siempre el mismo archivo.
const AGENT_MODELS_PATH = path.join(__dirname, '..', '..', 'agent-models.json');

// Cache del set de providers declarados. La lectura es barata pero se cachea
// para no golpear disco por cada petición clasificada.
let _providersCache = null;

/**
 * Lectura defensiva de un JSON. Devuelve `fallback` ante cualquier error
 * (archivo inexistente, JSON inválido, permisos). NUNCA tira.
 */
function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Resuelve el set de providers válidos desde `agent-models.json` (path fijo).
 * Filtra `deterministic` (no consume cuota / no es provider de chat). Si el
 * archivo no se puede leer, cae al set mínimo conocido.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.noCache]  fuerza relectura (para tests).
 * @returns {Set<string>}
 */
function resolveDeclaredProviders(opts) {
  if (_providersCache && !(opts && opts.noCache)) return _providersCache;
  let set = new Set(FALLBACK_PROVIDERS);
  const models = safeReadJson(AGENT_MODELS_PATH, null);
  if (models && models.providers && typeof models.providers === 'object') {
    const fromConfig = Object.keys(models.providers).filter((p) => p !== 'deterministic');
    if (fromConfig.length > 0) set = new Set(fromConfig);
  }
  if (!(opts && opts.noCache)) _providersCache = set;
  return set;
}

/**
 * Valida un nombre de provider contra el set declarado en `agent-models.json`.
 * Si no matchea (o no es string) → `'desconocido'` (anti log-forging, SEC-2).
 *
 * @param {*} provider
 * @param {object} [opts]  passthrough a `resolveDeclaredProviders` (test hook).
 * @returns {string} un provider declarado o `'desconocido'`.
 */
function validateProvider(provider, opts) {
  if (typeof provider !== 'string' || provider.length === 0) return PROVIDER_DESCONOCIDO;
  const declared = resolveDeclaredProviders(opts);
  return declared.has(provider) ? provider : PROVIDER_DESCONOCIDO;
}

/**
 * Clasifica el resultado de un turno consolidado del Commander a un enum cerrado.
 *
 * Precedencia (de mayor a menor): `error > ajustada > fallback > ok`.
 *   - `error`    ← `hadError === true`, o `sherlockDisclaimerType` de tipo
 *                  timeout/sin-provider/persistente (F-5/F-6), o respuesta vacía.
 *   - `ajustada` ← `sherlockVerdict.verdict === 'rechazado'` (Sherlock
 *                  reelaboró/ajustó la respuesta).
 *   - `fallback` ← `dispatchResolution.fallbackUsed != null` o
 *                  `dispatchResolution.crossProvider === true` (provider distinto
 *                  al primario).
 *   - `ok`       ← caso base.
 *
 * @param {object} args
 * @param {object} [args.dispatchResolution]  `{ provider, fallbackUsed, crossProvider }`.
 * @param {object} [args.sherlockVerdict]     `{ verdict, sameProvider }`.
 * @param {string|null} [args.sherlockDisclaimerType]  tipo de disclaimer de Sherlock.
 * @param {boolean} [args.hadError]           hubo excepción / fallo total de providers.
 * @param {boolean} [args.emptyResponse]      la respuesta final fue vacía.
 * @param {object} [args._providerOpts]       hook de test para `validateProvider`.
 * @returns {{
 *   resultado: 'ok'|'ajustada'|'fallback'|'error',
 *   provider: string,
 *   fallbackUsed: boolean,
 *   crossProviderDispatch: boolean,
 *   sameProviderVerification: boolean|null,
 * }}
 *
 * `sameProviderVerification` es TRI-ESTADO:
 *   - `true`  ← hubo verificación efectiva (verdict ∈ {ok,rechazado,aborted}) y el
 *               verificador usó el MISMO proveedor (`sameProvider === true`).
 *   - `false` ← hubo verificación efectiva pero con OTRO proveedor (cross).
 *   - `null`  ← NO hubo verificación efectiva (verdict `skipped` / Sherlock no
 *               invocado). El render NO debe emitir chip cross/same (CA-3).
 */
function classifyCommanderResult(args) {
  const {
    dispatchResolution = {},
    sherlockVerdict = {},
    sherlockDisclaimerType = null,
    hadError = false,
    emptyResponse = false,
    _providerOpts = undefined,
  } = (args && typeof args === 'object') ? args : {};

  // Un disclaimer de Sherlock tipo timeout / sin-provider / inconsistencia
  // persistente marca un cierre de turno degradado → `error`. Los tipos exactos
  // viven en `sherlock-verifier.js` (DISCLAIMER_TYPES); acá matcheamos por
  // patrón laxo para no acoplar el clasificador puro a esas constantes.
  const isErrorDisclaimer = !!sherlockDisclaimerType
    && /timeout|no.?provider|persistent|persistente|sin.?provider/i.test(String(sherlockDisclaimerType));

  // ¿Hubo verificación efectiva de Sherlock? Sólo entonces `sameProvider` aplica.
  // En otro caso el flag queda `null` (no inventar estado — CA-3 / guideline UX).
  const sherlockVerificationHappened = !!(
    sherlockVerdict
    && typeof sherlockVerdict.verdict === 'string'
    && VERIFIED_VERDICTS.includes(sherlockVerdict.verdict)
  );

  let resultado;
  if (hadError === true || emptyResponse === true || isErrorDisclaimer) {
    resultado = 'error';
  } else if (sherlockVerdict && sherlockVerdict.verdict === 'rechazado') {
    resultado = 'ajustada';
  } else if (
    (dispatchResolution && dispatchResolution.fallbackUsed != null)
    || (dispatchResolution && dispatchResolution.crossProvider === true)
  ) {
    resultado = 'fallback';
  } else {
    resultado = 'ok';
  }

  return {
    resultado,
    provider: validateProvider(dispatchResolution && dispatchResolution.provider, _providerOpts),
    fallbackUsed: !!(dispatchResolution && dispatchResolution.fallbackUsed != null),
    crossProviderDispatch: !!(dispatchResolution && dispatchResolution.crossProvider === true),
    sameProviderVerification: sherlockVerificationHappened
      ? (sherlockVerdict.sameProvider === true)
      : null,
  };
}

module.exports = {
  classifyCommanderResult,
  validateProvider,
  resolveDeclaredProviders,
  RESULTADOS,
  VERIFIED_VERDICTS,
  PROVIDER_DESCONOCIDO,
};
