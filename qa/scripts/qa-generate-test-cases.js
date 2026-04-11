#!/usr/bin/env node
/**
 * qa-generate-test-cases.js — Genera test cases QA-API desde los criterios de aceptación de un issue.
 *
 * Uso: QA_ISSUE=2041 node qa/scripts/qa-generate-test-cases.js
 *
 * Este script es un FALLBACK para cuando los test cases no fueron generados en la etapa
 * de definición. Los marca con "generated_at": "qa" para dejar registro.
 *
 * El flujo ideal es que se generen en definición (/doc, /po, /qa).
 *
 * Salida: qa/test-cases/{issue}.json
 *
 * Exit codes:
 *   0 — Test cases generados exitosamente
 *   1 — Error (issue no encontrado, sin criterios, etc.)
 *   2 — Test cases ya existen (no se sobreescriben)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ISSUE = process.env.QA_ISSUE;
if (!ISSUE) {
  console.error('ERROR: QA_ISSUE es requerido');
  process.exit(1);
}

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TEST_CASES_DIR = path.join(PROJECT_ROOT, 'qa', 'test-cases');
const OUTPUT_FILE = path.join(TEST_CASES_DIR, `${ISSUE}.json`);

// No sobreescribir si ya existe
if (fs.existsSync(OUTPUT_FILE)) {
  console.log(`[qa-gen] Test cases ya existen para issue #${ISSUE}: ${OUTPUT_FILE}`);
  process.exit(2);
}

// Obtener datos del issue desde GitHub
let issueData;
try {
  const ghPath = process.env.GH_PATH || 'gh';
  const raw = execSync(
    `"${ghPath}" issue view ${ISSUE} --json title,body,labels`,
    { encoding: 'utf8', timeout: 15000, windowsHide: true }
  ).trim();
  issueData = JSON.parse(raw);
} catch (e) {
  console.error(`ERROR: No se pudo leer issue #${ISSUE} desde GitHub: ${e.message}`);
  process.exit(1);
}

const { title, body, labels } = issueData;
const labelNames = (labels || []).map(l => l.name || l);

// Determinar tipo de QA
const isBackend = labelNames.includes('area:backend');
const isApp = labelNames.some(l => ['app:client', 'app:business', 'app:delivery'].includes(l));

console.log(`[qa-gen] Issue #${ISSUE}: "${title}"`);
console.log(`[qa-gen] Labels: ${labelNames.join(', ')}`);
console.log(`[qa-gen] Tipo: ${isApp ? 'android' : isBackend ? 'api' : 'structural'}`);

// Extraer criterios de aceptación del body
const criterios = extractCriterios(body || '');

if (criterios.length === 0) {
  console.error(`[qa-gen] No se encontraron criterios de aceptación en issue #${ISSUE}`);
  console.error('[qa-gen] El issue necesita criterios antes de generar test cases.');
  // Generar un test case genérico mínimo para no bloquear
  const fallback = [{
    id: 'TC-01',
    title: `Validación básica del issue #${ISSUE}`,
    criteria: `El issue #${ISSUE} (${title}) fue implementado correctamente`,
    generated_at: 'qa',
    generated_reason: 'Sin criterios de aceptación en el issue — test case genérico'
  }];

  if (isBackend) {
    // Intentar inferir endpoint del título
    const endpoint = inferEndpoint(title, body);
    fallback[0].method = 'GET';
    fallback[0].endpoint = endpoint;
    fallback[0].expected_status = 200;
    fallback[0].expected_body_contains = [];
  }

  fs.mkdirSync(TEST_CASES_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(fallback, null, 2));
  console.log(`[qa-gen] Generado test case genérico (fallback): ${OUTPUT_FILE}`);
  process.exit(0);
}

console.log(`[qa-gen] Criterios encontrados: ${criterios.length}`);

// Generar test cases
const testCases = criterios.map((criterio, i) => {
  const tc = {
    id: `TC-${String(i + 1).padStart(2, '0')}`,
    title: criterio.summary || `Criterio ${i + 1}`,
    criteria: criterio.text,
    generated_at: 'qa',
    generated_reason: 'Test case generado como fallback — no existía en etapa de definición'
  };

  if (isBackend || !isApp) {
    // Para QA-API: intentar inferir endpoint y método
    const inferred = inferRequestFromCriteria(criterio.text, title, body);
    tc.method = inferred.method;
    tc.endpoint = inferred.endpoint;
    tc.expected_status = inferred.expectedStatus;
    tc.expected_body_contains = inferred.expectedBody;
    if (inferred.body) tc.body = inferred.body;
  } else {
    // Para QA-Android: dejar como criterio sin flow (el agente QA lo resuelve manualmente)
    tc.flow = null;
  }

  return tc;
});

fs.mkdirSync(TEST_CASES_DIR, { recursive: true });
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(testCases, null, 2));
console.log(`[qa-gen] Generados ${testCases.length} test cases para issue #${ISSUE}: ${OUTPUT_FILE}`);
process.exit(0);

// --- Funciones auxiliares ---

function extractCriterios(body) {
  const criterios = [];
  const lines = body.split('\n');

  let inCriteriosSection = false;
  for (const line of lines) {
    const trimmed = line.trim();

    // Detectar sección de criterios de aceptación
    if (/criterios?\s+de\s+aceptaci[oó]n/i.test(trimmed) ||
        /acceptance\s+criteria/i.test(trimmed)) {
      inCriteriosSection = true;
      continue;
    }

    // Salir de la sección si encontramos otro heading
    if (inCriteriosSection && /^#{1,3}\s/.test(trimmed) &&
        !/criterio/i.test(trimmed)) {
      inCriteriosSection = false;
      continue;
    }

    // Capturar líneas que son criterios (con checkbox, guión, o numeradas)
    if (inCriteriosSection) {
      const match = trimmed.match(/^(?:[-*•]\s*(?:\[.\]\s*)?|(?:\d+[.)]\s*))(.+)/);
      if (match) {
        const text = match[1].trim();
        if (text.length > 5) { // Filtrar líneas muy cortas
          criterios.push({
            text: text,
            summary: text.length > 80 ? text.slice(0, 77) + '...' : text
          });
        }
      }
    }
  }

  // Fallback: buscar cualquier checkbox en el body
  if (criterios.length === 0) {
    const checkboxes = body.match(/- \[.\]\s+.+/g) || [];
    for (const cb of checkboxes) {
      const text = cb.replace(/^- \[.\]\s+/, '').trim();
      if (text.length > 5) {
        criterios.push({ text, summary: text.length > 80 ? text.slice(0, 77) + '...' : text });
      }
    }
  }

  return criterios;
}

function inferEndpoint(title, body) {
  // Buscar patrones de endpoint en el título o body
  const patterns = [
    /\/intrale\/[\w/-]+/,
    /\/api\/[\w/-]+/,
    /endpoint[:\s]+[`"]?(\/[\w/-]+)[`"]?/i,
    /ruta[:\s]+[`"]?(\/[\w/-]+)[`"]?/i
  ];

  const text = `${title}\n${body}`;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }

  return '/intrale/status'; // Default genérico
}

function inferRequestFromCriteria(criteria, title, body) {
  const result = {
    method: 'GET',
    endpoint: inferEndpoint(title, body),
    expectedStatus: 200,
    expectedBody: [],
    body: null
  };

  const lowerCriteria = criteria.toLowerCase();

  // Inferir método
  if (/crear|registrar|agregar|nuevo|insert|post/i.test(lowerCriteria)) {
    result.method = 'POST';
    result.expectedStatus = 200;
  } else if (/actualizar|modificar|editar|update|put/i.test(lowerCriteria)) {
    result.method = 'PUT';
  } else if (/eliminar|borrar|delete/i.test(lowerCriteria)) {
    result.method = 'DELETE';
  } else if (/devuelve?\s+4[0-9]{2}|unauthorized|sin\s+token|no\s+autenticado/i.test(lowerCriteria)) {
    result.method = 'POST';
    result.expectedStatus = 401;
  } else if (/devuelve?\s+40[034]/i.test(lowerCriteria)) {
    const match = lowerCriteria.match(/devuelve?\s+(4\d{2})/);
    if (match) result.expectedStatus = parseInt(match[1]);
  }

  // Inferir body contains
  const containsMatch = criteria.match(/(?:contiene|incluye|devuelve|retorna|tiene)\s+["`]?(\w+)["`]?/i);
  if (containsMatch) {
    result.expectedBody.push(containsMatch[1]);
  }

  return result;
}
