# GATE 0 — Veredicto honesto de gates automáticos (#4572)

> Parte del épico #4570 (gates de firma de operador). Elimina el **"verde falso"**:
> hoy un agente verificador (tester/qa/security/review) puede auto-declarar
> `qa:passed` aunque existan criterios que sólo un humano puede validar (visual,
> UX, "¿es lo que quiso el operador?"). Es la raíz de los escapes #4531 / #4568.

## Qué hace

GATE 0 descompone el veredicto de la fase `verificacion` en **dos baldes**:

- **Máquina-verificable** — el criterio cita un `archivo:línea`, un `CA-N`, o un
  comando concreto (`node --test`, `gradlew`, `curl`, `diff`, `md5sum`, …).
- **Solo-humano** — el criterio menciona algo visual/estético/UX/mockup, o no
  tiene ninguna señal máquina concreta (**fail-closed**: ante la duda → humano).

**Regla dura (CA-1):** si hay ≥1 criterio solo-humano, el veredicto **nunca** es
`pass`. Se rutea a `requires-operator` (firma humana, GATE 2 · contrato #4571) y
el issue **se retiene** (no promueve) hasta la firma.

El enforcement es **estructural**, no auto-reporte del LLM (SEC-R1): la
clasificación y el veredicto viven en libs puras del kernel
(`.pipeline/lib/gate-verdict.js`) invocadas por el Pulpo con datos del
**preflight** (cuerpo del issue), **nunca** desde el YAML/output del agente.

## Componentes

| Archivo | Rol |
|---------|-----|
| `.pipeline/lib/gate-verdict.js` | Lib pura: `classifyCriterion`, `computeGateVerdict`, `extractCriteria`, handoff a GATE 2 con checksum, flag `shouldEvaluateGate0`. |
| `.pipeline/lib/gate-label-reconciler.js` | **Dueño único determinístico** de los labels de gate (`qa:passed`/`qa:failed`/`qa:pending`). Semántica *remove-then-add* + validador que rechaza la combinación ilegal `qa:passed`+`qa:failed` (SEC-R4 / CA-3). |
| `.pipeline/pulpo.js` (enganche `verificacion → linteo`) | Cablea GATE 0 en la promoción: computa veredicto, reconcilia labels, arma el handoff, audita, y retiene el issue si `requires-operator`. |
| `.pipeline/audit/gate-verdicts.jsonl` | Audit trail hash-encadenado (vía `audit-log.appendChained`, reusado) de cada clasificación, veredicto y cambio de label con `actor` + `timestamp` (SEC-R8). |

Reusa `visual-gate.js` y `qa-evidence-gate.js` (no los reimplementa, CA-9).
La absorción de #4568 (QA visual) queda satisfecha a nivel estado (#4568 CLOSED).

## Feature flag y downgrade (CA-8 / SEC-R6)

GATE 0 arranca **detrás de un flag default OFF**:

```
PIPELINE_GATE0_ENABLED=0   # (default) — GATE 0 INERTE, el pipeline se comporta igual que hoy
PIPELINE_GATE0_ENABLED=1   # enforcement activo — sustituye el qa:passed self-reportado
```

- Con el flag en `0`, el bloque de GATE 0 en `pulpo.js` **no ejecuta**: cero
  cambio de comportamiento (rollout gradual, mismo patrón que
  `PIPELINE_VISUAL_GATE_ENABLED`).
- Con el flag en `1`:
  - Si todos los criterios son máquina-verificables → ratifica `qa:passed` de
    forma determinística (dueño único de labels).
  - Si hay criterios solo-humano → emite `qa:pending`, remueve cualquier
    `qa:passed` self-reportado, postea un comentario idempotente hacia el
    operador (marker `<!-- gate0-requires-operator -->`), y **retiene** el issue.

### Downgrade / bypass auditados

- `qa:skipped` **no** debe aplicarse a un issue con criterios solo-humano sin
  firma del operador (SEC-R6). Todo bypass queda logueado con actor.
- Cualquier fallo de GATE 0 (fetch de criterios, error inesperado, handoff
  inconsistente) es **fail-closed**: retiene la promoción y alerta por Telegram,
  nunca deja pasar un `pass` no verificado (SEC-R3).

## Kill-switch

Poner `PIPELINE_GATE0_ENABLED=0` (o quitar la variable) desactiva el gate por
completo en el siguiente barrido del Pulpo. No requiere redeploy de código.

## Dependencias

- **#4571** (CLOSED, en `main`) — veredicto `requires-operator` + estado
  `waiting-operator` en el contrato kernel↔adaptador
  (`docs/pipeline/contrato-kernel-adaptador.md` §3/§5.1). GATE 0 consume ese
  veredicto para rutear a firma humana.
- **#4574** (GATE 1, posterior) — entregará el etiquetado estructurado de
  criterios. Mientras no exista, el clasificador determinístico interino de
  `gate-verdict.js` es la fuente (fail-closed); cuando #4574 exista, GATE 0
  preferirá su etiquetado y el clasificador quedará de fallback.

## Tests

```
node --test .pipeline/lib/gate-verdict.test.js .pipeline/lib/gate-label-reconciler.test.js
```

Cobertura: **100% de líneas, ramas y funciones** en ambas libs puras (son el
corazón del enforcement). Cubren fail-closed ante ambigüedad, `pass` imposible
con ≥1 criterio solo-humano, resistencia a prompt-injection en el texto del
criterio (SEC-R2), rechazo de `qa:passed`+`qa:failed` simultáneos, y
convergencia bajo doble reconciliación (race ≤3 agentes).
