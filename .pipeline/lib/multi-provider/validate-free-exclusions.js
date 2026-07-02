'use strict';

/**
 * Candado free-only fail-closed para skills sensibles (RS-2 / OWASP A05).
 *
 * Función pura y determinística: no hace I/O, no lee secrets, no tiene deps.
 * El veredicto sale EXCLUSIVAMENTE de la allowlist `APPROVED_FOR_SENSITIVE`
 * (default deny / fail-closed). Un provider nuevo no aprobado en un skill
 * sensible siempre devuelve `ok:false`, aunque no figure en la denylist.
 *
 * `FORBIDDEN_FOR_SENSITIVE` NO participa del booleano del veredicto; solo se
 * usa para enriquecer el texto del mensaje de error.
 */

// Skills cuyo output puede contener código/IP/secrets: nunca deben caer a
// providers free-tier sin garantía TOS de no-entrenamiento.
const SENSITIVE_SKILLS = ['backend-dev', 'pipeline-dev'];

// Única fuente del veredicto. Todo provider fuera de esta lista queda vetado
// para skills sensibles (fail-closed).
const APPROVED_FOR_SENSITIVE = ['anthropic', 'openai-codex', 'deterministic'];

// Solo enriquece mensajes — NUNCA fuente del veredicto (fail-closed).
const FORBIDDEN_FOR_SENSITIVE = ['gemini-google', 'cerebras', 'groq', 'nvidia-nim'];

/**
 * @param {{skills?: Object}} config config estilo `agent-models.json`.
 * @returns {{ok: boolean, errors: string[]}} `ok:false` si algún skill sensible
 *   usa un provider fuera de la allowlist en primary o cualquier fallback.
 */
function validateFreeExclusions(config) {
  const errors = [];
  const skills = (config && config.skills) || {};

  for (const skill of SENSITIVE_SKILLS) {
    const cfg = skills[skill];
    if (!cfg) continue; // skill ausente no es violación de este control

    const positions = [];
    if (typeof cfg.provider === 'string') {
      positions.push({ provider: cfg.provider, at: 'primary' });
    }
    const fallbacks = Array.isArray(cfg.fallbacks) ? cfg.fallbacks : [];
    fallbacks.forEach((fb, i) => {
      const p = fb && fb.provider;
      if (typeof p === 'string') {
        positions.push({ provider: p, at: `fallback[${i}]` });
      }
    });

    for (const { provider, at } of positions) {
      if (!APPROVED_FOR_SENSITIVE.includes(provider)) { // fail-closed: default deny
        const forbiddenHint = FORBIDDEN_FOR_SENSITIVE.includes(provider)
          ? ' (free-tier explícitamente vetado)'
          : '';
        // Mensaje accionable: SOLO skill + provider + posición.
        // Prohibido interpolar cfg, credentials_env, tokens ni rutas.
        errors.push(
          `skill sensible "${skill}" usa provider no aprobado "${provider}" en ${at}${forbiddenHint}`
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  validateFreeExclusions,
  SENSITIVE_SKILLS,
  APPROVED_FOR_SENSITIVE,
  FORBIDDEN_FOR_SENSITIVE,
};
