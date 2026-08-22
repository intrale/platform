'use strict';

// =============================================================================
// issue-risk.js — Riesgo EXPLICABLE de un issue del pipeline (#3958, EP8-H5).
//
// Reemplaza el `riskScore` numérico opaco del board por reglas simples con
// razón textual, para la vista tabla y el drawer lateral del Issue Tracker.
//
// Reglas (CA-4):
//   1. rebotes ≥ 2.
//   2. edad > p90 de la población (issues activos — decisión cerrada: la
//      población NO incluye histórico `procesado/`, para que la regla sea
//      estable y no ruidosa; alinea con guru/PO).
//   3. dependencia abierta (label `blocked:dependencies`).
//
// `level`:  'alto'  si ≥2 reglas se disparan,
//           'medio' si 1 regla,
//           'bajo'  si ninguna.
// `score`:  valor ordenable para el sort de la tabla (no opaco: deriva del
//           nivel + magnitud, mayor = más riesgo).
//
// Módulo server-side puro (no DOM): el dashboard lo consume al renderear las
// filas y el drawer. Testeado con `node --test`.
// =============================================================================

const LEVEL_RANK = { bajo: 0, medio: 1, alto: 2 };

/**
 * @param {Object} input
 * @param {number} [input.bounces=0]   - rebotes acumulados del issue.
 * @param {number} [input.ageMin=0]    - edad/estancamiento en minutos.
 * @param {number} [input.ageP90=Infinity] - p90 de edad de la población activa.
 * @param {string[]} [input.labels=[]] - labels del issue.
 * @returns {{ level: 'alto'|'medio'|'bajo', reasons: string[], score: number }}
 */
function computeRisk({ bounces = 0, ageMin = 0, ageP90 = Infinity, labels = [] } = {}) {
    const b = Number.isFinite(bounces) ? bounces : 0;
    const age = Number.isFinite(ageMin) ? ageMin : 0;
    const p90 = (typeof ageP90 === 'number' && ageP90 > 0) ? ageP90 : Infinity;
    const lbls = Array.isArray(labels) ? labels : [];

    const reasons = [];
    if (b >= 2) reasons.push(b + ' rebotes (>=2)');
    if (age > p90) reasons.push('edad ' + Math.round(age) + 'm > p90 (' + Math.round(p90) + 'm)');
    if (lbls.includes('blocked:dependencies')) reasons.push('dependencia abierta');

    const level = reasons.length >= 2 ? 'alto' : reasons.length === 1 ? 'medio' : 'bajo';

    // Score ordenable: el nivel domina (rank*1000) y dentro del mismo nivel
    // desempata por magnitud (rebotes + exceso de edad sobre p90). No es opaco:
    // un score mayor siempre corresponde a un riesgo mayor y explicable.
    const overAge = (p90 !== Infinity && age > p90) ? (age - p90) : 0;
    const score = LEVEL_RANK[level] * 1000 + b * 50 + Math.min(overAge, 949);

    return { level, reasons, score };
}

module.exports = { computeRisk, LEVEL_RANK };
