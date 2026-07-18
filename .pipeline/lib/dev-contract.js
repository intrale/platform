'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const { detectInjection } = require('./handoff');

const SCHEMA_PATH = path.resolve(__dirname, '..', 'contracts', 'dev.schema.json');
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const ajv = new Ajv({ allErrors: true, verbose: false });
const validateSchema = ajv.compile(schema);

function validateDevPortPayload(payload) {
  const schemaValid = validateSchema(payload);
  const errors = schemaValid ? [] : redactAjvErrors(validateSchema.errors);
  const injectionHits = collectInjectionHits(payload);

  for (const hit of injectionHits) {
    errors.push({
      path: hit.path,
      keyword: 'promptInjection',
      detail: 'dato no confiable contiene patrón de prompt-injection',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function collectInjectionHits(payload) {
  const workItem = payload && payload.input && payload.input.workItemRef;
  const handoff = payload && payload.output && payload.output.handoff;
  const candidates = [
    ['input.workItemRef.title', workItem && workItem.title],
    ['input.workItemRef.body', workItem && workItem.body],
    ['output.handoff.section', handoff && handoff.section],
  ];

  if (workItem && Array.isArray(workItem.comments)) {
    workItem.comments.forEach((comment, index) => {
      candidates.push([`input.workItemRef.comments[${index}]`, comment]);
    });
  }

  const hits = [];
  for (const [pathLabel, value] of candidates) {
    if (typeof value !== 'string' || value === '') continue;
    const result = detectInjection(value);
    if (result.hits.length > 0) hits.push({ path: pathLabel, hits: result.hits });
  }
  return hits;
}

function redactAjvErrors(ajvErrors) {
  if (!Array.isArray(ajvErrors)) return [];
  return ajvErrors.map((error) => {
    const pathLabel = error.instancePath || '(root)';
    const params = error.params || {};
    let detail = error.message || error.keyword;
    if (error.keyword === 'required') detail = `falta clave requerida: ${params.missingProperty}`;
    if (error.keyword === 'enum') detail = `valor fuera del enum permitido`;
    if (error.keyword === 'pattern') detail = `valor fuera del patrón esperado`;
    if (error.keyword === 'const') detail = `valor debe coincidir con la constante del contrato`;
    return { path: pathLabel, keyword: error.keyword, detail };
  });
}

module.exports = {
  SCHEMA_PATH,
  schema,
  validateDevPortPayload,
  collectInjectionHits,
  redactAjvErrors,
};
