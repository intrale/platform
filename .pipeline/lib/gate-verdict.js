// .pipeline/lib/gate-verdict.js
// =============================================================================
// GATE 0 — Veredicto honesto de gates automáticos (#4572, épico #4570).
//
// Los verificadores automáticos (tester/qa/security/review) NO pueden emitir un
// `passed` global si algún criterio de aceptación es *solo-humano* (visual, UX,
// "¿es lo que quiso el operador?"). Este módulo es el corazón determinístico del
// enforcement: clasifica cada criterio en dos baldes (máquina-verificable vs
// solo-humano) y computa el veredicto del gate. Es una **lib pura** (sin
// `fs`/`net`), invocada por el Pulpo con datos del **preflight** (cuerpo del
// issue), NUNCA desde el YAML/output del agente verificador (SEC-R1: no
// self-report). Molde: `.pipeline/lib/observation-classifier.js`.
//
// Contrato (puro, sin side-effects):
//   classifyCriterion({ text })            → 'machine' | 'human'
//   extractCriteria({ body })              → [{ text, checked }]
//   computeGateVerdict({ criteria, gateResults })
//        → { verdict: 'pass'|'fail'|'requires-operator', humanOnlyCount, humanOnly[], reason }
//   buildGate2Handoff({ humanOnly })       → { count, checksum, criteria }
//   verifyHandoffIntegrity({ handoff, expectedCount })
//        → { ok, reason }
//
// Chicken-and-egg con GATE 1 (#4574): mientras #4574 no entregue el etiquetado
// estructurado de criterios, este clasificador determinístico interino es la
// fuente. Cuando #4574 exista, GATE 0 prefiere su etiquetado y el clasificador
// queda de fallback.
//
// SESGO FAIL-CLOSED (SEC-R3, NO NEGOCIABLE):
//   Ante ambigüedad → el criterio es SOLO-HUMANO y el gate NO emite `pass`.
//   Un falso "solo-humano" sólo cuesta una firma humana extra; un falso
//   "máquina-verificable" = verde falso silencioso = exactamente el escape
//   #4531/#4568 que este feature previene.
// =============================================================================

'use strict';

// Feature flag de enforcement de GATE 0 (SEC-R6, CA-8). Default OFF: mientras
// esté en `0` el gate es INERTE — el Pulpo se comporta igual que hoy. Sólo con
// `PIPELINE_GATE0_ENABLED=1` el veredicto descompuesto sustituye el `qa:passed`
// self-reportado. Rollout gradual, patrón `PIPELINE_VISUAL_GATE_ENABLED`.
const GATE0_ENV = 'PIPELINE_GATE0_ENABLED';

/**
 * ¿Está activo el enforcement de GATE 0? Se puede inyectar `env` para testear
 * sin tocar `process.env` real.
 * @param {object} [env]
 * @returns {boolean}
 */
function isGate0Enabled(env = process.env) {
  return String((env && env[GATE0_ENV]) || '0').trim() === '1';
}

/**
 * Predicado de aplicabilidad: ¿debe correr GATE 0 en esta transición? Sólo en
 * el pipeline `desarrollo` cuando se completa la fase `verificacion` (el punto
 * donde el veredicto QA se cristaliza antes de las fases de aprobación LLM).
 * @param {object} opts
 * @param {string} opts.pipelineName
 * @param {string} opts.fromFase
 * @param {object} [opts.env]
 * @returns {boolean}
 */
function shouldEvaluateGate0({ pipelineName, fromFase, env } = {}) {
  if (!isGate0Enabled(env)) return false;
  if (pipelineName !== 'desarrollo') return false;
  if (fromFase !== 'verificacion') return false;
  return true;
}

// Una referencia archivo:línea concreta — `path/al/archivo.kt:123`, `foo.js:42`.
const FILE_LINE_RE = /[\w./\\-]+\.[a-z0-9]{1,6}:\d+/i;

// Cita de un criterio de aceptación verificable (CA-1, CA 2, criterio 3, AC-4…).
const CA_RE = /\b(ca|criterio|acceptance|ac)[\s\-:]*\d+/i;

// Indicadores de un comando de verificación concreto y ejecutable.
const COMMAND_RE = /(\$\s|\bgit\b|\bgradlew\b|\bnode\b|\bnpm\b|\b\.\/|\btest\b|\bmd5sum\b|\bsha256sum\b|\bdiff\b|\bls\b|\bgrep\b|\bcurl\b|\bassemble\w*\b|\bBUILD FAILED\b)/i;

// Señales EXPLÍCITAS de que un criterio sólo lo puede validar un humano:
// juicio visual/estético, conformidad con mockup, "¿es lo que quiso el operador?".
// Tiene prioridad sobre cualquier señal máquina (un criterio visual con un
// comando adentro sigue siendo solo-humano).
const HUMAN_RE = /(visual|mockup|ux|dise[ñn]o|est[eé]tic|se ve bien|luce bien|acordad|"?es lo que|lo que quiso|look and feel|pixel|maqueta|apariencia)/i;

/**
 * Clasifica el texto de un criterio en 'machine' (verificable por máquina) o
 * 'human' (requiere firma humana). 100% reglado: el texto se trata como DATO,
 * nunca como instrucción (SEC-R2 — resistencia a prompt-injection). Ante
 * ausencia de señal máquina legítima → 'human' (fail-closed, SEC-R3).
 *
 * @param {object} args
 * @param {string} [args.text] Texto del criterio de aceptación.
 * @returns {'machine'|'human'}
 */
function classifyCriterion({ text = '' } = {}) {
  const texto = String(text || '').trim();

  // Vacío → no hay señal máquina alguna ⇒ fail-closed a solo-humano.
  if (texto.length === 0) return 'human';

  // Señal humana explícita ⇒ solo-humano (prioridad sobre señales máquina).
  if (HUMAN_RE.test(texto)) return 'human';

  // Señal máquina explícita ⇒ máquina-verificable.
  if (FILE_LINE_RE.test(texto)) return 'machine';
  if (CA_RE.test(texto)) return 'machine';
  if (COMMAND_RE.test(texto)) return 'machine';

  // Sin ninguna señal concreta ⇒ fail-closed a solo-humano (SEC-R3).
  return 'human';
}

/**
 * Extrae los criterios de aceptación del cuerpo (markdown) de un issue.
 * Reconoce checkboxes de tarea GitHub: `- [ ] ...` / `- [x] ...` (también `*`).
 * Puro: no consulta red ni disco. El texto extraído es DATO no confiable.
 *
 * @param {object} args
 * @param {string} [args.body] Cuerpo markdown del issue.
 * @returns {Array<{ text: string, checked: boolean }>}
 */
function extractCriteria({ body = '' } = {}) {
  const src = String(body || '');
  if (src.length === 0) return [];
  const out = [];
  const lines = src.split(/\r?\n/);
  const CHECKBOX_RE = /^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/;
  for (const line of lines) {
    const m = CHECKBOX_RE.exec(line);
    if (!m) continue;
    const checked = m[1].toLowerCase() === 'x';
    const text = m[2].trim();
    if (text.length === 0) continue;
    out.push({ text, checked });
  }
  return out;
}

/**
 * Computa el veredicto de GATE 0 sobre un set de criterios y los resultados de
 * los gates automáticos.
 *
 * REGLA DURA (CA-1): si `humanOnlyCount > 0` el veredicto NUNCA es `pass` —
 * se rutea a `requires-operator` (firma humana, ver #4571). Sólo cuando todos
 * los criterios son máquina-verificables se evalúan los resultados de gate:
 * `fail` si alguno falló, `pass` si todos pasaron.
 *
 * @param {object} args
 * @param {Array<{text:string}|string>} [args.criteria] Criterios de aceptación.
 * @param {Object<string,string>} [args.gateResults] Resultado por gate: 'pass'|'fail'|...
 * @returns {{ verdict:'pass'|'fail'|'requires-operator', humanOnlyCount:number, humanOnly:Array, reason:string }}
 */
function computeGateVerdict({ criteria = [], gateResults = {} } = {}) {
  const list = Array.isArray(criteria) ? criteria : [];
  // Normalizar cada criterio a { text }. Acepta strings o { text }.
  const normalized = list.map((c) => (typeof c === 'string' ? { text: c } : (c || {})));

  const humanOnly = normalized.filter((c) => classifyCriterion({ text: c.text }) === 'human');
  const humanOnlyCount = humanOnly.length;

  if (humanOnlyCount > 0) {
    return {
      verdict: 'requires-operator',
      humanOnlyCount,
      humanOnly,
      reason: `${humanOnlyCount} criterio(s) solo-humano sin resolver — rutea a firma de operador (GATE 2)`,
    };
  }

  const results = (gateResults && typeof gateResults === 'object') ? gateResults : {};
  const anyFail = Object.values(results).some((r) => r === 'fail');
  if (anyFail) {
    return {
      verdict: 'fail',
      humanOnlyCount: 0,
      humanOnly: [],
      reason: 'al menos un gate automático reportó fail',
    };
  }

  return {
    verdict: 'pass',
    humanOnlyCount: 0,
    humanOnly: [],
    reason: 'todos los criterios son máquina-verificables y todos los gates pasaron',
  };
}

/**
 * Checksum determinístico (FNV-1a 32-bit, hex) de un texto. Sin dependencias
 * de `crypto` para mantener la lib pura y portátil. Sirve para detectar
 * truncado silencioso en el handoff a GATE 2 (SEC-R5).
 *
 * @param {string} s
 * @returns {string} hex de 8 dígitos.
 */
function fnv1a(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // Multiplicación FNV-1a con enteros de 32 bits sin desbordar el double.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Arma el paquete de handoff hacia GATE 2 (firma humana) con los criterios
 * solo-humano. Transporta `count` y `checksum` para que el receptor pueda
 * verificar que no hubo truncado silencioso (SEC-R5 / CA-4).
 *
 * @param {object} args
 * @param {Array<{text:string}|string>} [args.humanOnly] Criterios solo-humano.
 * @returns {{ count:number, checksum:string, criteria:Array<{text:string}> }}
 */
function buildGate2Handoff({ humanOnly = [] } = {}) {
  const list = Array.isArray(humanOnly) ? humanOnly : [];
  const criteria = list.map((c) => ({ text: String((typeof c === 'string' ? c : (c && c.text)) || '') }));
  const checksum = fnv1a(criteria.map((c) => c.text).join(' '));
  return { count: criteria.length, checksum, criteria };
}

/**
 * Verifica la integridad del handoff a GATE 2: el conteo transportado debe
 * cerrar contra `expectedCount` y el checksum debe recomputar igual. Si no
 * cierra → `ok:false` con razón (el llamador debe bloquear + `log()`, SEC-R5).
 *
 * @param {object} args
 * @param {{count:number, checksum:string, criteria:Array}} args.handoff
 * @param {number} args.expectedCount Conteo esperado de criterios solo-humano.
 * @returns {{ ok:boolean, reason:string }}
 */
function verifyHandoffIntegrity({ handoff, expectedCount } = {}) {
  if (!handoff || typeof handoff !== 'object') {
    return { ok: false, reason: 'handoff ausente o no es objeto' };
  }
  const criteria = Array.isArray(handoff.criteria) ? handoff.criteria : [];
  if (criteria.length !== handoff.count) {
    return { ok: false, reason: `count declarado (${handoff.count}) != criterios transportados (${criteria.length})` };
  }
  if (typeof expectedCount === 'number' && handoff.count !== expectedCount) {
    return { ok: false, reason: `count transportado (${handoff.count}) != esperado (${expectedCount}) — posible truncado` };
  }
  const recomputed = fnv1a(criteria.map((c) => String((c && c.text) || '')).join(' '));
  if (recomputed !== handoff.checksum) {
    return { ok: false, reason: `checksum no coincide (esperado ${handoff.checksum}, recomputado ${recomputed})` };
  }
  return { ok: true, reason: 'handoff íntegro' };
}

module.exports = {
  GATE0_ENV,
  isGate0Enabled,
  shouldEvaluateGate0,
  classifyCriterion,
  extractCriteria,
  computeGateVerdict,
  buildGate2Handoff,
  verifyHandoffIntegrity,
  // exportados para test de reglas
  FILE_LINE_RE,
  CA_RE,
  COMMAND_RE,
  HUMAN_RE,
};
