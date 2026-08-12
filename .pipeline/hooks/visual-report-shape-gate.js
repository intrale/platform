'use strict';

// =============================================================================
// #5708 — Guardrail estructural del rejection report visual.
//
// Linter puro: sin red, sin LLM, sin puppeteer, sin GitHub. Recibe el contrato
// `visual-comparison.json` ya parseado y decide si su FORMA es aceptable.
//
// Call-site real (D14 · CA-16 · SEC-10): `loadVisualComparison` en
// `.pipeline/rejection-report.js`, justo después del `JSON.parse`. Es el choke
// point por el que pasan los dos consumidores (render del PDF y narración del
// audio), así que un solo call-site los cubre a ambos.
//
// Rollout gradual (CA-6): flag `VISUAL_REPORT_SHAPE_GATE_ENABLED`, default OFF.
// Con el flag apagado devuelve `{gate:'disabled'}` y no bloquea nada.
// =============================================================================

// #5708 / CA-13 · D12 — los topes viven en UNA sola fuente de verdad.
const { MAX_VISUAL_JSON_BYTES, MAX_DIFFS_RENDER } = require('../lib/visual-contract-limits');

const FLAG_ENV_NAME = 'VISUAL_REPORT_SHAPE_GATE_ENABLED';

function evaluate(report, opts) {
  const options = opts || {};
  const flag = options.flag != null ? options.flag : process.env[FLAG_ENV_NAME];
  if (flag !== '1') return { gate: 'disabled' };
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { gate: 'block', reason: 'report-malformed' };
  // CA-13 — el tope de desvíos se USA, no sólo se exporta.
  const diffs = Array.isArray(report.diffs) ? report.diffs : [];
  if (diffs.length > MAX_DIFFS_RENDER) {
    return { gate: 'block', reason: 'diffs-over-limit', missing: [`${diffs.length} > ${MAX_DIFFS_RENDER}`] };
  }
  const coverage = report.coverage;
  if (!coverage || !Array.isArray(coverage.secciones_declaradas)) return { gate: 'block', reason: 'coverage-missing' };
  const declared = new Set(coverage.secciones_declaradas.map(String));
  const verified = new Set(Array.isArray(coverage.verificadas) ? coverage.verificadas.map(String) : []);
  const notVerifiedItems = Array.isArray(coverage.no_verificadas) ? coverage.no_verificadas : [];
  const notVerified = new Set(notVerifiedItems.map(item => String(item && item.section)));
  const overlap = [...verified].filter(section => notVerified.has(section));
  const extras = [...verified, ...notVerified].filter(section => !declared.has(section));
  const missing = [...declared].filter(section => !verified.has(section) && !notVerified.has(section));
  const withoutReason = notVerifiedItems.filter(item => !item || !String(item.motivo || '').trim()).map(item => String(item && item.section));
  const invalid = [...new Set([...missing, ...overlap, ...extras, ...withoutReason])];
  if (invalid.length) return { gate: 'block', reason: 'coverage-incomplete', missing: invalid };
  return { gate: 'ok' };
}

module.exports = {
  evaluate,
  FLAG_ENV_NAME,
  // Re-export desde la fuente única (D12): quien ya importaba estos nombres
  // desde el gate sigue funcionando, pero el valor sale de un solo lugar.
  MAX_JSON_BYTES: MAX_VISUAL_JSON_BYTES,
  MAX_DIFFS: MAX_DIFFS_RENDER,
  MAX_VISUAL_JSON_BYTES,
  MAX_DIFFS_RENDER,
};
