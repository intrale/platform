# #4160 — Auto-promoción por convergencia (verificacion)

## Qué se hizo
Se eliminó el loop de rebotes "en falso" de la fase verificacion. Cuando un issue rebota a dev sin observación accionable real y el dev produce el mismo diff que en el rebote anterior (con build verde), el pipeline auto-promueve a la fase siguiente en lugar de seguir rebotando hasta el circuit breaker.

## Archivos
- NUEVO lib/convergence-detector.js — diff-hash sha256 (--ignore-all-space, fail-closed), isConvergent, isEligibleForAutoPromote, decideAutoPromote.
- NUEVO lib/observation-classifier.js — accionable vs ruido; security con claim empírico SIEMPRE accionable (RIESGO-2).
- pulpo.js — gate de auto-promoción tras el circuit breaker (sólo fase verificacion, código, no-routing); persiste diff_hash_previo en el rebote.
- config.yaml — circuit_breaker: auto_promote_on_convergence, convergence_requires_build_green, convergence_excludes_skills: [security].
- roles qa/tester/security — sección observación accionable vs ruido.

## Invariantes de seguridad
- RIESGO-1: rechazos de security (o accionables) NUNCA auto-promueven — siguen el circuit breaker. Excluido por config + por código.
- RIESGO-3: issue validado numérico antes de interpolar; comando git fijo.
- RIESGO-5: --ignore-all-space; fail-closed cuando el hash es null.
- Auditoría JSONL en logs/audit-convergence.jsonl + Telegram + comentario GitHub por cada auto-promoción.

## Tests
- 39 tests node --test. Cobertura líneas 100% en ambas libs.
- Test funcional del gate (convergence-gate.test.js): converge→promueve; security→NO promueve.