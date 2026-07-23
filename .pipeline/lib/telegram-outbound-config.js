// =============================================================================
// telegram-outbound-config.js — Política de reintentos/timeout de SALIENTES (#4082/#4750)
// =============================================================================
//
// Fuente ÚNICA de la política de reintentos de la cola de salientes de Telegram
// (max_retries + backoff). Antes vivía sólo en `servicio-telegram.js`; el sweep
// de chunks de audio (#4750) corre en OTRO proceso (el Commander/pulpo) y debe
// usar EXACTAMENTE los mismos valores — SEC-R4: "no inventar valores nuevos,
// alinear con #4082". Este módulo puro elimina la duplicación.
//
// Módulo puro: sin side-effects al requerir, sin red, sin credenciales.
// =============================================================================
'use strict';

// Defaults seguros. NO confundir con los reintentos de RED de una sola request
// del http-client: esto es la cola lógica de salientes (reintento cross-tick).
const OUTBOUND_DEFAULTS = {
  max_retries: 5,
  backoff_base_ms: 5000,
  backoff_max_ms: 300000,
  stale_ttl_ms: 86400000,
  sweep_stagger_ms: 3000,
};

// resolveOutboundConfig — dado el objeto de config del pipeline ya parseado
// (config.yaml), extrae `telegram_outbound` con clamping defensivo: cualquier
// valor inválido/ausente/fuera de rango cae al default. Config inválida nunca
// rompe el servicio ni el sweep.
function resolveOutboundConfig(rawPipelineConfig) {
  const cfg = (rawPipelineConfig || {}).telegram_outbound || {};
  const num = (v, def, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) return def;
    return n;
  };
  return {
    max_retries: num(cfg.max_retries, OUTBOUND_DEFAULTS.max_retries, 1, 100),
    backoff_base_ms: num(cfg.backoff_base_ms, OUTBOUND_DEFAULTS.backoff_base_ms, 100, 600000),
    backoff_max_ms: num(cfg.backoff_max_ms, OUTBOUND_DEFAULTS.backoff_max_ms, 1000, 3600000),
    stale_ttl_ms: num(cfg.stale_ttl_ms, OUTBOUND_DEFAULTS.stale_ttl_ms, 60000, 30 * 86400000),
    sweep_stagger_ms: num(cfg.sweep_stagger_ms, OUTBOUND_DEFAULTS.sweep_stagger_ms, 0, 600000),
  };
}

module.exports = { OUTBOUND_DEFAULTS, resolveOutboundConfig };
