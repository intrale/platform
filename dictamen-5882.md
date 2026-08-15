## Dictamen de integridad técnica — issue #5882

> Gate de adherencia `architect` Fase 2 corrió **salteado** (`architect.enabled: false`,
> `gate_mode: dry-run` → `evaluateGate` devolvió `decision: aprobado`, `skipped: true`,
> `gate_mode: disabled`). No hay PR todavía (lo crea la fase `entrega`).
> Aun así se evaluó la adherencia contra la receta firmada usando el diff real de
> `agent/5882-pipeline-dev` vs `origin/main`, de modo que el dictamen es sustantivo
> y no una excepción N/A. Su carácter es **informativo**: no bloquea.

### Adherencia al diseño/diagramas

**Respetó el diseño.** Los 7 puntos de producción de la sección `## Detalles Técnicos`
tienen correlato verificado en el árbol:

| Paso de la receta | Verificación empírica |
|---|---|
| 1. `wave-audit.js` persiste `source` | `wave-audit.js:162` → `source: sanitizeField(evt.source) ?? null`; legacy sin `source` queda `null` |
| 2. `waves.js` propaga `source` al audit | presente en ambos `emitWaveAudit` |
| 3. `waves.rollbackIssueAdd` acotada | `waves.js:804` + `rollbackIssueAddLocked:852`, con `authorizedBy:'wave-add-rollback'` (`:812`) y `expectedVersion` obligatorio (`:820`) |
| 4-5. `commander-deterministic.js` sin `catch` vacío | `grep "catch {[[:space:]]*}"` → **0 resultados**; `partial_sync_failed` en `:2929/:2938/:3015` |
| 6. Predicado hermano | `legit-add-trace.js:173 isLegitimateRecentWaveAdd`, enum cerrado en `:148` |
| 7-8. Realign del Pulpo | `pulpo.js:17830 repairAllowlistFromLegitWaveAdd`, enganchado en `:18734/:18746` |
| 9. Tests en `.pipeline/lib/__tests__/` | 4 suites nuevas, 1672 líneas |

Diffstat: 10 archivos, +2397/−12.

Los tres guardrails de seguridad que la receta marcaba como no negociables están donde
corresponde: el enum es `Object.freeze(new Set(['telegram-commander/wave-add']))` —
`split-github-reconcile` y `wave-promote:resync-additive` quedan **excluidos**, que era
el riesgo de escalación de privilegio (crear un issue en GitHub ⇒ despacho automático);
el guard `EWAVES_ACTIVE_LOCKED` de `removeIssueFromWave` sigue intacto en `waves.js:723`
sin `force` ni relajación, y el rollback entra por una operación nueva y acotada; la
reparación es **aditiva pura** (`pulpo.js:17856` → `[...current, ...toAdd]`), preservando
la no-regresión de #4753/#5516.

### Desvíos vs. diseño

**Uno, menor y justificado.** `.pipeline/lib/commander/templates/wave-add-ok.md` (+4/−2)
no figura en la lista de "Archivos a tocar" de la receta. Es un bloque condicional
`{{#if sync-warning}}` que expone al operador el caso `landed === true` — la rama donde
`setPartialPause` reporta error pero la escritura sí quedó y por lo tanto **no** se
revierte. Esa rama sí está especificada en la receta (§B, patrón técnico), así que el
archivo es la superficie de presentación de una decisión ya aprobada, no alcance nuevo.
No amerita rebote ni issue separado.

Los commits intermedios que tocaban `CODEOWNERS` y el inventario de secretos
(`e23d37df4`, `eefb14825`) **no sobreviven** en el diff final contra `origin/main`:
fueron reconciliados en `9b8749b82` al integrar main. El árbol final está limpio de
archivos espurios, que es lo que el pre-checklist pedía.

### Deuda técnica / riesgos introducidos

- **CAS best-effort heredado del diseño.** `versionToken` es `meta.updated_at`, ISO con
  resolución de milisegundo: dos writes en el mismo ms colisionan. La receta ya lo
  anticipaba y el código lo compensa con `rollbackToken` obligatorio (`waves.js:839`) más
  verificación de presencia del issue bajo el mismo lock. Mitigado, no eliminado — la
  deuda real es que `waves.json` no tiene un contador de versión monotónico. Candidato a
  issue propio, fuera de alcance acá.
- **Superficie de audit ampliada.** Persistir `source` por entry agranda el registro
  encadenado. Las entries legacy sin el campo quedan en `null` y por diseño **no**
  legitiman (fail-safe correcto), pero conviene que `verifyChain()` quede verde en el
  gate de tests antes del merge — está en el pre-checklist.
- **Dependencia del enum como único gate.** Toda la seguridad del camino de reparación
  automática descansa en un `Set` de un solo elemento sin validación en el writer
  (delegada a #5884). Ampliarlo a futuro es una decisión que hay que tomar mirando este
  dictamen; el comentario en el código lo deja explícito, que es lo correcto.
- **No introduce deuda de acoplamiento**: `pulpo.js` consume el predicado por require del
  módulo, sin duplicar lógica de legitimidad.

### Integridad estructural

**Sólida.** El cambio ataca la causa raíz declarada — falta de atomicidad *entre* dos
escrituras individualmente atómicas — en vez de silenciar el detector, que era el
anti-patrón obvio y tentador. La estructura elegida es correcta en las tres decisiones
que importaban: operación de rollback **nueva y acotada** en lugar de aflojar un guard
compartido por todos los callers; predicado **hermano** en lugar de sobrecargar
`isLegitimateRecentAdd`, que opera en la dirección opuesta; y reparación **aditiva pura**
que nunca puede podar la allowlist. El fail-closed del detector queda intacto: sin traza
legítima el pipeline sigue frenado, que era el CA-5.

La relación test/producción (1672 líneas de test sobre ~730 de producción) es apropiada
para un módulo cuyo modo de falla es paralizar el pipeline entero, y cubre explícitamente
la batería negativa —incluido el test de que `split-github-reconcile` no legitima, que es
el más importante del conjunto.

Sin objeciones estructurales. El issue está en condiciones de avanzar a `entrega`.
