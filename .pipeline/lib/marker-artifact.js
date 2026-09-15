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
 * (`.reason.json`, `.guidance.txt`, `.guidance.agent.txt`, `.comment.md`). Estos archivos son
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
/**
 * #7240 — Sufijos de los artifacts de ORIENTACIÓN de destrabe. Fuente única
 * para los cuatro actores del canal, que hasta este issue tenían el sufijo
 * hardcodeado cada uno por su lado y por eso escritor y lector divergieron
 * (`human-block.js` escribía en `pendiente/`, `pulpo.js` leía en `trabajando/`):
 *
 *   - escritor humano  → `lib/human-block.guidanceFilePath`
 *   - escritor agente  → `lib/human-block.guidanceAgentFilePath` (#6296 SEC-A)
 *   - transporte       → `lib/guidance-injection.transportGuidanceArtifacts`
 *   - lector one-shot  → `lib/guidance-injection.buildGuidanceBlocks`
 *   - cleaner          → `lib/ghost-artifact-cleaner` (`ARTIFACT_SUFFIXES`)
 *
 * El orden importa para el lector: el bloque humano se inyecta antes que el
 * del validador. Agregar un sufijo acá lo vuelve artifact (`isMarkerArtifact`)
 * y candidato a transporte/limpieza en el mismo acto.
 */
const GUIDANCE_SUFFIXES = Object.freeze(['.guidance.txt', '.guidance.agent.txt']);

function isMarkerArtifact(name) {
    if (typeof name !== 'string') return false;
    if (name.split('.').length > 2) return true;
    if (name.endsWith('.reason.json') || name.endsWith('.comment.md')) return true;
    // #6296 SEC-A — el canal de guidance de origen AGENTE ya cae por la regla
    // de `> 2 segmentos`; se lista explícito (vía `GUIDANCE_SUFFIXES`) para que
    // el contrato quede escrito y un futuro cambio de la regla genérica no lo
    // re-exponga como marker (el incidente 2026-05-11 fue exactamente eso con
    // `.guidance.txt`). Semántica idéntica a los `endsWith` que reemplaza
    // (#3638: los tests de equivalencia siguen vigentes).
    return GUIDANCE_SUFFIXES.some((sufijo) => name.endsWith(sufijo));
}

module.exports = { isMarkerArtifact, GUIDANCE_SUFFIXES };
