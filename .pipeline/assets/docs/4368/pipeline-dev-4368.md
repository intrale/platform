# #4368 — Transición automática de ola (dev)

## Cambio
- **NUEVO** `.pipeline/lib/wave-auto-transition.js`: detector fail-closed (`detectWaveComplete`) + orquestador notify/auto (`autoTransitionIfComplete`).
- **HOOK** `.pipeline/pulpo.js`: `brazoTransicionOla(config)` fire-and-forget tras `brazoDesbloqueo`, con guard de re-entrada `_transicionOlaRunning` y corto-circuito si está deshabilitado.
- **CONFIG** `.pipeline/config.yaml`: bloque `wave_auto_transition` (default OFF, mode notify, gh_timeout_ms 30000).
- **TESTS** `.pipeline/lib/__tests__/wave-auto-transition.test.js`: 17 tests, cobertura 93% líneas / 100% funciones.

## Doctrina
- Default OFF + mode notify (approach cerrado por PO). Respeta diseño §3 ("nunca abrir ola por automatismo").
- Fail-closed ante ambigüedad de gh (exit≠0, timeout, issue ausente). Anti-doble-promoción via isWavePromoteBlocked + re-verificación TOCTOU.
- CA-5: proyección recursiva del allowlist con expandRecursiveOpenIssues sobre el grafo dependencies[] (sin red).
- Reusa promoteWaveAtomic, appendChained, notifyTelegram (no reimplementa primitivas).

## Verificación
- node --test suite nueva: 17/17 verde.
- Regresión waves (promote-atomic, create-planned-wave, allowlist-recursive-expand): 35/35 verde.
- node --check pulpo.js + módulo: OK.
- QA: qa:skipped (infra de pipeline, sin UI ni endpoint de producto).
