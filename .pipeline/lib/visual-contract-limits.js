'use strict';

// =============================================================================
// #5708 / CA-13 · D12 — Fuente ÚNICA de verdad de los topes del contrato visual.
//
// Antes existían dos declaraciones desincronizables: `MAX_JSON_BYTES` /
// `MAX_DIFFS` en `hooks/visual-report-shape-gate.js` (declaradas y con cero
// usos) y `MAX_VISUAL_JSON_BYTES` / `MAX_DIFFS_RENDER` en `rejection-report.js`
// (el tope real). Ambos consumidores ahora requieren este módulo, y un test
// ata las constantes para que nadie las vuelva a duplicar.
//
// Sin dependencias a propósito: lo requieren un hook (que debe seguir siendo
// una decisión pura, sin red ni LLM) y el generador de reportes.
// =============================================================================

module.exports = {
  // Tope de bytes del archivo `visual-comparison.json` en disco. Superarlo es
  // fallo DECLARADO (`skip.reason = 'oversize'`), nunca un `null` mudo (SEC-4).
  MAX_VISUAL_JSON_BYTES: 1048576,
  // La cobertura se persiste en un segundo artefacto. Estos topes evitan que
  // una lista adversarial amplifique el contrato al escribir el baseline.
  MAX_VISUAL_COVERAGE_SECTIONS: 1000,
  MAX_VISUAL_SECTION_BYTES: 256,
  // Tope de desvíos que el PDF renderiza. Superarlo se declara en el reporte y
  // el gate lo bloquea con `reason: 'diffs-over-limit'`.
  MAX_DIFFS_RENDER: 50,
};
