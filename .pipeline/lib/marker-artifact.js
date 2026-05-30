'use strict';

/**
 * Single source of truth para detectar artifacts auxiliares en carpetas
 * operacionales del pipeline V2 (`.pipeline/definicion/**`,
 * `.pipeline/desarrollo/**`).
 *
 * **Marker válido**: `<issue>.<skill>` con exactamente 2 segmentos separados
 * por punto. Los skills configurados en `config.yaml` (po, ux, guru, security,
 * planner, backend-dev, android-dev, web-dev, pipeline-dev, build, tester,
 * qa, linter, review, delivery) NO contienen puntos.
 *
 * **Artifact auxiliar** (NO marker): cualquier filename con más de 2 segmentos
 * separados por punto, o que termine en uno de los sufijos conocidos
 * (`.reason.json`, `.guidance.txt`, `.comment.md`). Estos archivos son
 * metadata operativa (criterios PO, guidance de destrabe humano, motivos de
 * rechazo) y NO deben aparecer en listados de markers de agente.
 *
 * Historia: defensa original implementada inline en 6 módulos por #2854
 * (`pulpo.js`, `dashboard.js`, `lib/dashboard-slices.js`, `lib/human-block.js`,
 * `lib/wave-state.js`, `lib/eta-markers.js`). Centralizada acá por #3638
 * (CA-F-1) para que el lint pueda exigir un único import y prevenir
 * regresiones cuando nuevos componentes lean directorios operacionales.
 *
 * Equivalencia funcional: las 6 implementaciones previas eran idénticas en
 * lógica (`> 2 segmentos` OR `endsWith(.reason.json|.guidance.txt|.comment.md)`).
 * Esta versión preserva la semántica exacta. Tests verifican equivalencia.
 *
 * @param {string} name — basename del archivo (no path completo).
 * @returns {boolean} — `true` si es un artifact auxiliar (debe filtrarse).
 */
function isMarkerArtifact(name) {
    if (typeof name !== 'string') return false;
    if (name.split('.').length > 2) return true;
    return name.endsWith('.reason.json')
        || name.endsWith('.guidance.txt')
        || name.endsWith('.comment.md');
}

module.exports = { isMarkerArtifact };
