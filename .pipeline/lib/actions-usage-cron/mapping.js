// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// Mapeo de nombres de workflow viejos → nuevos para comparar la baseline de
// #7594 contra la semana medida (#7688, parte 2/4 de #7661).
//
// Lógica pura: sin I/O ni variables de entorno.
//
// La regla `lints-consolidate` de `pricing.json` sólo dice QUÉ workflows se
// consolidan, no a qué nombre. Por eso el destino sale únicamente de
// `workflow_map` (config `actions_usage_measure.workflow_map`), que además
// tiene precedencia. Un lint de la regla sin destino declarado NO se mapea:
// aparece como `eliminado` y el consolidado como `nuevo`. No se inventan nombres.

const CONSOLIDATE_RULE_ID = 'lints-consolidate';

// Claves que nunca se aceptan en `workflow_map` (RS-A). El trabajo interno usa
// `Map`, pero igual se descartan para no propagarlas a ningún consumidor.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// Workflows candidatos a "viejo" según la regla de consolidación. Tolera que
// falten `optimization_rules`, la regla o su lista.
function consolidateCandidates(pricing) {
  const rules = pricing && typeof pricing === 'object' ? pricing.optimization_rules : undefined;
  if (!Array.isArray(rules)) return [];
  const rule = rules.find((r) => r && typeof r === 'object' && r.id === CONSOLIDATE_RULE_ID);
  if (!rule || !Array.isArray(rule.workflows)) return [];
  return rule.workflows.filter(isNonEmptyString);
}

/**
 * Arma el mapeo viejo → nuevo.
 *
 * @param {object} pricing      `docs/pipeline/evidence/7594/pricing.json` parseado.
 * @param {object} workflowMap  `{viejo: nuevo}` de la config; tiene precedencia.
 * @returns {Map<string,string>}
 */
function buildMapping(pricing, workflowMap) {
  const mapping = new Map();
  const declared = new Map();
  if (workflowMap && typeof workflowMap === 'object' && !Array.isArray(workflowMap)) {
    // `Object.keys` sólo devuelve claves propias y enumerables: lo heredado
    // del prototipo nunca entra.
    for (const oldName of Object.keys(workflowMap)) {
      const newName = workflowMap[oldName];
      if (FORBIDDEN_KEYS.has(oldName)) continue;
      if (!isNonEmptyString(oldName) || !isNonEmptyString(newName)) continue;
      declared.set(oldName, newName);
    }
  }
  // Los candidatos de la regla sólo entran si tienen destino declarado.
  for (const oldName of consolidateCandidates(pricing)) {
    if (declared.has(oldName)) mapping.set(oldName, declared.get(oldName));
  }
  // `workflow_map` manda: también renombres fuera de la regla.
  for (const [oldName, newName] of declared) mapping.set(oldName, newName);
  return mapping;
}

/** Devuelve el nombre nuevo, o el mismo si no está mapeado. */
function resolve(mapping, name) {
  if (mapping instanceof Map && mapping.has(name)) return mapping.get(name);
  return name;
}

module.exports = { buildMapping, resolve, CONSOLIDATE_RULE_ID };
