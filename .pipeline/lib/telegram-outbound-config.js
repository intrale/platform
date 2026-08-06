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

// =============================================================================
// #5573 — Política de reenvío de PARTES DE AUDIO, separada de la de texto.
// =============================================================================
//
// Por qué separada: hasta #5573 el sweep de chunks de voz (#4750) reusaba
// `resolveOutboundConfig` — la política de TEXTO. Pero la latencia real de
// entrega de un `.ogg` medida en producción es de ~62-74s (upload multipart +
// procesamiento serial de la cola + sleep anti rate-limit de 1200ms por
// adjunto), contra los 5s de base del texto. Con backoff 5s→10s→20s el sweep
// disparaba reenvíos sobre envíos TODAVÍA EN VUELO y el operador recibía el
// mismo audio 2-4 veces. Peor: cada reenvío se encola en la MISMA cola,
// alargando la latencia de las partes que faltan → bola de nieve.
//
// La cola de TEXTO no cambia: `resolveOutboundConfig` queda intacta.
const VOICE_OUTBOUND_DEFAULTS = {
  max_retries: 3,            // menos agresivo que texto: cada reenvío alarga la cola
  backoff_base_ms: 150000,   // 2.5 min > p95 observado (~74s), con margen bajo carga
  backoff_max_ms: 900000,    // 15 min
  stale_ttl_ms: 86400000,    // 24h — igual que texto
  in_flight_max_ms: 600000,  // SEC-A: techo de la supresión por "en vuelo" (10 min)
};

// resolveVoiceOutboundConfig — mismo patrón de clamping defensivo que
// `resolveOutboundConfig`: valor inválido/ausente/fuera de rango → default.
// Config rota nunca rompe el sweep.
//
// NOTA: `backoff_base_ms` es PROVISIONAL. Se recalibra con el p50/p95 real que
// emite el JSONL de `lib/voice-delivery-audit.js`; no es una constante mágica.
function resolveVoiceOutboundConfig(rawPipelineConfig) {
  const cfg = (rawPipelineConfig || {}).telegram_voice_outbound || {};
  const num = (v, def, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) return def;
    return n;
  };
  return {
    max_retries: num(cfg.max_retries, VOICE_OUTBOUND_DEFAULTS.max_retries, 1, 100),
    backoff_base_ms: num(cfg.backoff_base_ms, VOICE_OUTBOUND_DEFAULTS.backoff_base_ms, 1000, 1800000),
    backoff_max_ms: num(cfg.backoff_max_ms, VOICE_OUTBOUND_DEFAULTS.backoff_max_ms, 1000, 3600000),
    stale_ttl_ms: num(cfg.stale_ttl_ms, VOICE_OUTBOUND_DEFAULTS.stale_ttl_ms, 60000, 30 * 86400000),
    in_flight_max_ms: num(cfg.in_flight_max_ms, VOICE_OUTBOUND_DEFAULTS.in_flight_max_ms, 60000, 3600000),
  };
}

module.exports = {
  OUTBOUND_DEFAULTS,
  resolveOutboundConfig,
  // #5573 — política propia de voz
  VOICE_OUTBOUND_DEFAULTS,
  resolveVoiceOutboundConfig,
};
