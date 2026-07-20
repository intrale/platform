// =============================================================================
// kernel-scheduler.js — Scheduler global de dos niveles del kernel multi-producto
// (Ola Puente P5a · #4775, split de #4690). Diseño:
// docs/pipeline/ola-puente-kernel-multiproducto.md §4.5 y §4.9.
//
// Es el CORAZÓN del reparto de slots entre productos. Módulo PURO:
//   - NO importa `os` ni `getSystemResourceUsage`: la señal de presión RAM/CPU
//     la calcula `pulpo.js` (getResourcePressure) — único dueño — y se INYECTA.
//   - NO hace IO de proceso ni de FS. Recibe el descriptor ya derivado y la
//     señal de presión, y decide el reparto. Determinístico: mismas entradas →
//     misma decisión (testeable con `node --test`).
//
// Dos niveles (CA-1):
//   1. Techo global de RAM/CPU (autoridad final): Σ slots asignados ≤ techo global.
//   2. Cap por producto (`agentCap`): ningún producto excede su cap.
// Con piso anti-starvation (`minAgentFloor`): cada producto `active` con demanda
// recibe un piso mínimo antes de repartir el excedente por prioridad; un producto
// saturado no puede dejar a otro en 0.
//
// Modo degradado (CA-6): cuando la máquina no da abasto, el producto se encola con
// un EVENTO ESTRUCTURADO (no string), distinguiendo la causa (cuota propia vs
// cuota global vs presión RAM/CPU).
// =============================================================================
'use strict';

const { isSafeId, deriveProviderOrder } = require('./project-descriptor');

// Causas de encolado (CA-6). Enum CERRADO — nunca texto libre en el evento.
const ENQUEUE_REASONS = Object.freeze({
  QUOTA_PRODUCT: 'quota_product',   // el producto alcanzó su propio agentCap
  QUOTA_GLOBAL: 'quota_global',     // el techo global se agotó (sin presión)
  PRESSURE: 'pressure_ram_cpu',     // el techo global se redujo por presión RAM/CPU
});
const ENQUEUE_REASON_SET = Object.freeze(new Set(Object.values(ENQUEUE_REASONS)));

const DECISION_ENQUEUED = 'enqueued';

// Niveles de presión que reducen el techo global (deben coincidir con pulpo.js).
const PRESSURE_LEVEL_GREEN = 'green';

// -----------------------------------------------------------------------------
// Helpers puros.
// -----------------------------------------------------------------------------

function toNonNegInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

/**
 * Resuelve la cadena ORDENADA de providers de un producto (#4807 · CA-2/CA-5).
 * Delega en `deriveProviderOrder` (fuente única, fail-closed): el orden persistido
 * en `providerOrder` fluye al scheduling; ausente/vacío ⇒ orden default del kernel.
 * Se pasa la lista cruda a la derivación canónica — el scheduler NUNCA interpola
 * estos valores en un spawn/CLI (ya validados por enum del schema; defense-in-depth).
 *
 * @param {string[]|undefined} providerOrder  lista persistida (claves internas).
 * @returns {string[]} orden resuelto, siempre no vacío.
 */
function resolveProviderChain(providerOrder) {
  return deriveProviderOrder({ thresholds: { providerOrder } });
}

/**
 * Normaliza un producto de entrada a la forma interna del scheduler, clampeando
 * defensivamente el cap del producto al techo global (anti-DoS · CA-1).
 *
 * @param {object} p  { productId, active, agentCap, minFloor, priority, demand }
 * @param {number} globalCap  techo global efectivo (ya reducido por presión).
 * @returns {object} forma interna normalizada.
 */
function normalizeProduct(p, globalCap) {
  const productId = p && p.productId;
  const active = !!(p && p.active);
  // Clamp al techo global aunque el descriptor haya pasado validación.
  const rawCap = toNonNegInt(p && p.agentCap, 0);
  const cap = Math.min(rawCap, globalCap);
  const demand = toNonNegInt(p && p.demand, 0);
  // El piso no puede exceder ni el cap ni la demanda real.
  const floor = Math.min(toNonNegInt(p && p.minFloor, 0), cap, demand);
  // `want` = lo que el producto pediría si el global fuera infinito, acotado por su cap.
  const want = Math.min(demand, cap);
  const priority = Number.isFinite(Number(p && p.priority)) ? Number(p.priority) : 0;
  // Cadena de providers del producto (#4807): el orden persistido fluye al
  // scheduling; ausente ⇒ orden default del kernel (fail-closed).
  const providerChain = resolveProviderChain(p && p.providerOrder);
  return { productId, active, cap, demand, floor, want, priority, providerChain };
}

/**
 * Orden determinístico del reparto: prioridad asc (menor número = más urgente),
 * desempate por productId asc. Estable ante mismas entradas.
 */
function compareForAllocation(a, b) {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const ida = String(a.productId);
  const idb = String(b.productId);
  return ida < idb ? -1 : ida > idb ? 1 : 0;
}

/**
 * Clasifica la causa de encolado de un producto que no llegó a cubrir su demanda.
 *
 * - Si su asignación quedó topada por SU PROPIO cap (`want < demand`) → quota_product.
 * - Si quedó topada porque el techo global se agotó:
 *     - bajo presión (level != green) → pressure_ram_cpu
 *     - sin presión                    → quota_global
 *
 * @returns {string|null} causa (enum) o null si cubrió toda su demanda.
 */
function classifyEnqueueReason(product, assigned, pressureLevel) {
  if (assigned >= product.demand) return null; // cubrió su demanda, no se encola.
  // ¿El techo del producto fue el limitante? (quería más de lo que su cap permite)
  if (product.want < product.demand && assigned >= product.want) {
    return ENQUEUE_REASONS.QUOTA_PRODUCT;
  }
  // Si no, el limitante fue el techo global.
  if (pressureLevel && pressureLevel !== PRESSURE_LEVEL_GREEN) {
    return ENQUEUE_REASONS.PRESSURE;
  }
  return ENQUEUE_REASONS.QUOTA_GLOBAL;
}

/**
 * Construye el EVENTO ESTRUCTURADO de encolado (CA-6). Objeto puro (no string) →
 * evita log-injection. Valida la forma fail-closed.
 *
 * @param {object} args { productId, reason, slotsGlobal, slotsUsados, prioridad }
 * @returns {{ productId, decision, reason, slotsGlobal, slotsUsados, prioridad }}
 * @throws {Error} si productId no es un id seguro o reason no está en el enum.
 */
function buildEnqueueEvent(args) {
  const productId = args && args.productId;
  const reason = args && args.reason;
  if (!isSafeId(productId)) {
    throw new Error(`buildEnqueueEvent: productId inseguro: ${JSON.stringify(productId)}`);
  }
  if (!ENQUEUE_REASON_SET.has(reason)) {
    throw new Error(`buildEnqueueEvent: reason fuera del enum cerrado: ${JSON.stringify(reason)}`);
  }
  return {
    productId,
    decision: DECISION_ENQUEUED,
    reason,
    slotsGlobal: toNonNegInt(args.slotsGlobal, 0),
    slotsUsados: toNonNegInt(args.slotsUsados, 0),
    prioridad: Number.isFinite(Number(args.prioridad)) ? Number(args.prioridad) : 0,
  };
}

/**
 * Reparte los slots globales entre productos (CA-1). Dos niveles + anti-starvation.
 *
 * @param {object} input
 * @param {number} input.effectiveGlobalCap  techo global YA reducido por presión
 *   (lo calcula pulpo.js; el scheduler NO recalcula RAM/CPU).
 * @param {object} [input.pressure]  { level } — sólo para clasificar la causa de encolado.
 * @param {Array<object>} input.products  [{ productId, active, agentCap, minFloor, priority, demand }]
 * @returns {{ allocations: Object<string,number>, events: Array<object>, slotsUsados:number, slotsGlobal:number }}
 */
function allocateSlots(input) {
  const globalCap = toNonNegInt(input && input.effectiveGlobalCap, 0);
  const pressureLevel = (input && input.pressure && input.pressure.level) || PRESSURE_LEVEL_GREEN;
  const rawProducts = (input && Array.isArray(input.products)) ? input.products : [];

  // Sólo productos `active` participan del reparto.
  const products = rawProducts
    .map((p) => normalizeProduct(p, globalCap))
    .filter((p) => p.active)
    .sort(compareForAllocation);

  const allocations = {};
  // Cadena de providers resuelta por producto (#4807): el orden elegido en el
  // descriptor == orden aplicado en el scheduling del Pulpo del producto.
  const providerChains = {};
  for (const p of products) {
    allocations[p.productId] = 0;
    providerChains[p.productId] = p.providerChain;
  }

  let remaining = globalCap;

  // --- Nivel anti-starvation: repartir primero el piso mínimo por producto ---
  // El piso se asigna en orden de prioridad para que, si Σpisos > techo global,
  // los más prioritarios reciban su piso primero (determinístico, no arbitrario).
  for (const p of products) {
    if (remaining <= 0) break;
    const give = Math.min(p.floor, remaining);
    allocations[p.productId] += give;
    remaining -= give;
  }

  // --- Nivel excedente: repartir lo que queda por prioridad hasta cubrir `want` ---
  for (const p of products) {
    if (remaining <= 0) break;
    const headroom = p.want - allocations[p.productId];
    if (headroom <= 0) continue;
    const give = Math.min(headroom, remaining);
    allocations[p.productId] += give;
    remaining -= give;
  }

  const slotsUsados = globalCap - remaining;

  // --- Modo degradado: eventos de encolado para productos con demanda insatisfecha ---
  const events = [];
  for (const p of products) {
    const assigned = allocations[p.productId];
    const reason = classifyEnqueueReason(p, assigned, pressureLevel);
    if (reason) {
      events.push(buildEnqueueEvent({
        productId: p.productId,
        reason,
        slotsGlobal: globalCap,
        slotsUsados,
        prioridad: p.priority,
      }));
    }
  }

  return { allocations, providerChains, events, slotsUsados, slotsGlobal: globalCap };
}

/**
 * Acota el `providerBudget` de un producto al presupuesto global por provider
 * (CA-3): el techo global es la autoridad final. Nunca deja que un producto
 * pida más cuota de la que el kernel concede globalmente.
 *
 * @param {Object<string,number>} productBudget
 * @param {Object<string,number>} globalBudget
 * @returns {Object<string,number>} copia acotada.
 */
function clampProviderBudgetToGlobal(productBudget, globalBudget) {
  const out = {};
  const pb = (productBudget && typeof productBudget === 'object') ? productBudget : {};
  const gb = (globalBudget && typeof globalBudget === 'object') ? globalBudget : {};
  for (const [provider, value] of Object.entries(pb)) {
    const v = Number(value);
    if (!Number.isFinite(v)) continue;
    const ceil = Number(gb[provider]);
    out[provider] = Number.isFinite(ceil) ? Math.min(v, ceil) : v;
  }
  return out;
}

/**
 * Acota las ventanas por producto al techo global (CA-3). El producto puede
 * definir sus propias ventanas (QA>Build>Dev), pero nunca por encima de los
 * valores globales que fija el kernel.
 *
 * @param {object} productWindows  { activationThreshold, safetyTimeoutHours }
 * @param {object} globalWindows   { activationThreshold, safetyTimeoutHours }
 * @returns {object} copia acotada.
 */
function clampWindowsToGlobal(productWindows, globalWindows) {
  const pw = (productWindows && typeof productWindows === 'object') ? productWindows : {};
  const gw = (globalWindows && typeof globalWindows === 'object') ? globalWindows : {};
  const out = { ...pw };
  for (const key of ['activationThreshold', 'safetyTimeoutHours']) {
    const pv = Number(pw[key]);
    const gv = Number(gw[key]);
    if (Number.isFinite(pv) && Number.isFinite(gv)) out[key] = Math.min(pv, gv);
    else if (Number.isFinite(gv) && !Number.isFinite(pv)) out[key] = gv;
  }
  return out;
}

module.exports = {
  ENQUEUE_REASONS,
  DECISION_ENQUEUED,
  allocateSlots,
  resolveProviderChain,
  buildEnqueueEvent,
  classifyEnqueueReason,
  clampProviderBudgetToGlobal,
  clampWindowsToGlobal,
};
