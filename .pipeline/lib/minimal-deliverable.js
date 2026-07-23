'use strict';

// #4523 — Helper puro para sintetizar el `.md` mínimo obligatorio del fallback
// determinístico de `pipeline-dev/dev`. Se factoriza fuera de `pulpo.js` (archivo
// gigante, inauditable por unit test) para poder testear la síntesis del
// contenido en aislamiento: función pura, sin FS, sin `require` de pulpo.
//
// Contrato clave: NUNCA devuelve string vacío. `writeDeliverable` exige `md`
// no-nulo (write-deliverable.js:165), por eso el contenido mínimo debe estar
// siempre poblado aunque las notas del cierre sean vacías o triviales.

const NOTAS_AUSENTES = '(sin notas)';

/**
 * Construye el cuerpo `.md` mínimo de un entregable de cierre.
 *
 * @param {object} params
 * @param {number|string} params.issue - número de issue (`^\d+$`). Sólo se
 *     interpola en el cuerpo humano, nunca en un path.
 * @param {string} [params.fase='desarrollo/dev'] - etiqueta humana de la fase.
 * @param {string} [params.skill='pipeline-dev'] - skill que cierra.
 * @param {string} [params.resultado] - resultado del cierre (ej. 'aprobado').
 * @param {string} [params.notas] - notas/motivo disponibles; si están vacías o
 *     son sólo whitespace se materializa el marcador `(sin notas)`.
 * @param {string} [params.timestamp] - ISO inyectable para determinismo en
 *     tests; si no se pasa se estampa `new Date().toISOString()` al cierre.
 * @returns {string} cuerpo markdown NO vacío.
 */
function buildMinimalDeliverableMd(params = {}) {
    const issue = params.issue != null ? String(params.issue).trim() : '';
    const fase = (typeof params.fase === 'string' && params.fase.trim())
        ? params.fase.trim()
        : 'desarrollo/dev';
    const skill = (typeof params.skill === 'string' && params.skill.trim())
        ? params.skill.trim()
        : 'pipeline-dev';
    const resultado = (typeof params.resultado === 'string' && params.resultado.trim())
        ? params.resultado.trim()
        : '(sin resultado)';
    const notas = (typeof params.notas === 'string' && params.notas.trim())
        ? params.notas.trim()
        : NOTAS_AUSENTES;
    const timestamp = (typeof params.timestamp === 'string' && params.timestamp.trim())
        ? params.timestamp.trim()
        : new Date().toISOString();

    // El cuerpo se sintetiza siempre con contenido no-nulo (contrato con
    // writeDeliverable). El heading + los campos garantizan bytes > 0 aun cuando
    // cada valor caiga a su marcador por defecto.
    const lines = [
        `# Entregable de cierre — issue #${issue || '(desconocido)'}`,
        '',
        `- **Issue:** #${issue || '(desconocido)'}`,
        `- **Fase:** ${fase}`,
        `- **Skill:** ${skill}`,
        `- **Resultado:** ${resultado}`,
        `- **Cierre:** ${timestamp}`,
        '',
        '## Notas / motivo',
        '',
        notas,
        '',
    ];

    return lines.join('\n');
}

module.exports = { buildMinimalDeliverableMd, NOTAS_AUSENTES };
