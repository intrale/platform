'use strict';

const FLAG_ENV_NAME = 'VISUAL_REPORT_SHAPE_GATE_ENABLED';
const MAX_JSON_BYTES = 1048576;
const MAX_DIFFS = 50;

function evaluate(report, opts) {
  const options = opts || {};
  const flag = options.flag != null ? options.flag : process.env[FLAG_ENV_NAME];
  if (flag !== '1') return { gate: 'disabled' };
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { gate: 'block', reason: 'report-malformed' };
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

module.exports = { evaluate, FLAG_ENV_NAME, MAX_JSON_BYTES, MAX_DIFFS };
