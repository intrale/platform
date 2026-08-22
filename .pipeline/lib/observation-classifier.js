// .pipeline/lib/observation-classifier.js
// =============================================================================
// Clasificador de observaciones de `verificacion`: accionable vs ruido (#4160).
//
// La fase `verificacion` (tester / security / qa) a veces rebota un issue por
// una observación que NO es accionable: un comentario estilístico sin defecto
// concreto, o la repetición textual de algo ya resuelto. El Pulpo usa esta
// clasificación para decidir si un rechazo habilita auto-promoción por
// convergencia (sólo el ruido se auto-promueve; lo accionable rebota a dev).
//
// Contrato (puro, sin side-effects):
//   classifyObservation({ motivo, skill, prevMotivos }) → { accionable, razon }
//
// INVARIANTE RIESGO-2 (NO NEGOCIABLE):
//   Un rechazo del skill `security` con un claim empírico (CVE, secret con
//   ubicación, vector con archivo:línea) es SIEMPRE accionable, nunca ruido.
//   El gate de seguridad no se debilita por la clasificación.
//
// Sesgo: ante la duda, clasificar como ACCIONABLE (fail-closed hacia "rebotar").
// Un falso "accionable" sólo cuesta un rebote extra; un falso "ruido" deja pasar
// un defecto real — mucho más caro.
// =============================================================================

'use strict';

// Una referencia archivo:línea — `path/al/archivo.kt:123` o `archivo.js:42`.
const FILE_LINE_RE = /[\w./\\-]+\.[a-z0-9]{1,6}:\d+/i;

// Cita de un criterio de aceptación fallido (CA-1, CA 2, criterio 3, AC-4...).
const CA_RE = /\b(ca|criterio|acceptance|ac)[\s\-:]*\d+/i;

// Indicadores de un comando de verificación concreto.
const COMMAND_RE = /(\$\s|\bgit\b|\bgradlew\b|\bnode\b|\bnpm\b|\b\.\/|\btest\b|\bmd5sum\b|\bsha256sum\b|\bdiff\b|\bls\b|\bgrep\b|\bcurl\b|\bassemble\w*\b|\bBUILD FAILED\b)/i;

// Claims empíricos de seguridad (RIESGO-2). Si el skill es `security` y el
// motivo matchea alguno, es SIEMPRE accionable.
const SECURITY_CLAIM_RE = /(cve-\d{4}-\d+|secret|hardcoded|hardcodead|token|password|api[\s_-]?key|jwt|inyecci[oó]n|injection|xss|csrf|sql[\s_-]?injection|owasp|vector\b)/i;

/**
 * Normaliza un texto para comparación de repeticiones: minúsculas, colapsa
 * whitespace, recorta. Permite detectar que una observación es la repetición
 * textual de otra ya emitida en un ciclo previo.
 * @param {string} s
 * @returns {string}
 */
function normalizeMotivo(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clasifica una observación de rechazo como accionable o ruido.
 *
 * @param {object}   args
 * @param {string}   args.motivo        Texto del motivo de rechazo.
 * @param {string}   args.skill         Skill que emitió el rechazo (tester/security/qa/...).
 * @param {string[]} [args.prevMotivos] Motivos de ciclos previos (para detectar repetición).
 * @returns {{ accionable: boolean, razon: string }}
 */
function classifyObservation({ motivo, skill, prevMotivos } = {}) {
  const texto = String(motivo || '').trim();
  const skillLc = String(skill || '').toLowerCase();

  // Motivo vacío: no hay claim concreto ⇒ ruido (no hay nada que corregir).
  // Excepción de seguridad abajo no aplica: un security sin texto no tiene claim.
  if (texto.length === 0) {
    return { accionable: false, razon: 'motivo vacío, sin claim concreto' };
  }

  // INVARIANTE RIESGO-2 — security con claim empírico ⇒ SIEMPRE accionable.
  if (skillLc === 'security' && SECURITY_CLAIM_RE.test(texto)) {
    return { accionable: true, razon: 'security con claim empírico (RIESGO-2): siempre accionable' };
  }

  // Repetición textual de una observación de un ciclo previo ⇒ ruido.
  // (Algo ya señalado que reaparece idéntico no aporta info nueva.) No aplica
  // a security: si vuelve a aparecer un claim de seguridad, sigue siendo real.
  if (skillLc !== 'security' && Array.isArray(prevMotivos) && prevMotivos.length > 0) {
    const actual = normalizeMotivo(texto);
    const repetida = prevMotivos.some(p => normalizeMotivo(p) === actual);
    if (repetida) {
      return { accionable: false, razon: 'repetición textual de observación previa ya resuelta' };
    }
  }

  // Accionable si tiene un claim concreto y verificable: archivo:línea, CA
  // fallido citado, o un comando de verificación.
  if (FILE_LINE_RE.test(texto)) {
    return { accionable: true, razon: 'referencia archivo:línea concreta' };
  }
  if (CA_RE.test(texto)) {
    return { accionable: true, razon: 'cita un criterio de aceptación fallido' };
  }
  if (COMMAND_RE.test(texto)) {
    return { accionable: true, razon: 'incluye comando de verificación' };
  }

  // Sin ningún anclaje concreto ⇒ ruido (observación estilística/genérica).
  return { accionable: false, razon: 'observación sin defecto concreto ni verificable' };
}

module.exports = {
  classifyObservation,
  normalizeMotivo,
};
