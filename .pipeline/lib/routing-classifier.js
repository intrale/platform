// =============================================================================
// routing-classifier.js — Clasificación de rechazos por routing mismatch
//
// Cuando un dev rechaza un issue por "fuera de alcance" (el issue no pertenece
// a su dominio), el pulpo debe devolver el issue a definición en vez de
// reencolarlo en el mismo dev → evita bucles hasta circuit breaker y consume
// el motivo como feedback para re-clasificar correctamente.
//
// Este módulo detecta esos motivos y extrae, cuando el agente lo indica, el
// skill/label sugeridos. No toma decisiones — solo extrae información.
// =============================================================================

// Patrones que indican que el agente considera el issue fuera de su alcance.
// Listado ampliable: agregar patrones cuando aparezcan formas nuevas en logs.
const ROUTING_PATTERNS = [
  /fuera de alcance/i,
  /fuera del alcance/i,
  /out\s+of\s+scope/i,
  /no\s+(es|son)\s+(de\s+)?(mi|nuestro)\s+(alcance|dominio|scope)/i,
  /no\s+soy\s+el\s+agente\s+correcto/i,
  /dominio\s+exclusivo\s+(del?\s+)?(rol\s+)?[\w-]+/i,
  /corresponde\s+a\s+[\w-]+/i,
  /(debe|debería|deberia)\s+ir\s+a\s+[\w-]+/i,
  /(rutear|enrutar|re?direccionar)\s+(a|hacia)\s+[\w-]+/i,
  /(este|el)\s+issue\s+(es|pertenece)\s+(al|del)?\s*(rol|dominio|skill|agente)?\s*[\w-]+/i,
  /agregar\s+label\s+['"]?area:[\w-]+/i,
];

// Skills conocidos del pipeline (debe coincidir con config.yaml dev_skill_mapping).
// Usado para validar que lo extraído es un skill real, no un falso positivo.
const KNOWN_DEV_SKILLS = new Set([
  'backend-dev',
  'android-dev',
  'web-dev',
  'pipeline-dev',
  'ios-dev',
  'desktop-dev',
]);

// Áreas conocidas (labels area:*). Sincronizar con dev_skill_mapping del config.
const KNOWN_AREAS = new Set([
  'pipeline',
  'infra',
  'backend',
  'web',
  'productos',
  'pedidos',
  'carrito',
  'pagos',
  'seguridad',
]);

// Extrae el primer skill conocido mencionado en el texto.
function extractSkillSugerido(motivo) {
  if (!motivo || typeof motivo !== 'string') return null;
  // Buscar patrones "corresponde a X", "rutear a X", "dominio exclusivo del rol X",
  // "rol X", "agente X", o simplemente el skill mencionado directamente.
  const re = /(?:corresponde\s+a|rutear\s+(?:a|hacia)|enrutar\s+(?:a|hacia)|dominio\s+exclusivo(?:\s+del?\s+rol)?|rol|agente|skill)\s+([a-z][\w-]+)/gi;
  let m;
  while ((m = re.exec(motivo)) !== null) {
    const candidate = m[1].toLowerCase();
    if (KNOWN_DEV_SKILLS.has(candidate)) return candidate;
  }
  // Fallback: buscar cualquier mención directa a un skill conocido en el texto.
  for (const skill of KNOWN_DEV_SKILLS) {
    const skillRe = new RegExp(`\\b${skill}\\b`, 'i');
    if (skillRe.test(motivo)) return skill;
  }
  return null;
}

// Extrae el primer label area:X conocido mencionado en el texto.
function extractLabelSugerido(motivo) {
  if (!motivo || typeof motivo !== 'string') return null;
  const re = /area:([\w-]+)/gi;
  let m;
  while ((m = re.exec(motivo)) !== null) {
    const area = m[1].toLowerCase();
    if (KNOWN_AREAS.has(area)) return `area:${area}`;
  }
  return null;
}

/**
 * Clasifica un motivo de rechazo como routing-mismatch o no.
 *
 * @param {string} motivo Texto del motivo de rechazo escrito por el agente.
 * @returns {{isRouting: boolean, skillSugerido: string|null, labelSugerido: string|null, pattern: string|null}}
 */
function classifyRoutingMismatch(motivo) {
  const result = { isRouting: false, skillSugerido: null, labelSugerido: null, pattern: null };
  if (!motivo || typeof motivo !== 'string') return result;

  for (const pattern of ROUTING_PATTERNS) {
    if (pattern.test(motivo)) {
      result.isRouting = true;
      result.pattern = pattern.source;
      break;
    }
  }

  if (result.isRouting) {
    result.skillSugerido = extractSkillSugerido(motivo);
    result.labelSugerido = extractLabelSugerido(motivo);
  }

  return result;
}

module.exports = {
  classifyRoutingMismatch,
  KNOWN_DEV_SKILLS,
  KNOWN_AREAS,
};
