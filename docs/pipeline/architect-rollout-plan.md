# Plan de rollout — rol Arquitecto

**Issue padre:** [#3507](https://github.com/intrale/platform/issues/3507).
**Doc del rol:** [`architect-role.md`](architect-role.md).
**Estado:** spec del plan. La aplicación real va en el issue hijo de implementación (CA-C3).

Este documento responde a CA-A2: fecha de go-live propuesta, plan de piloto opcional, y cálculo de impacto en cuota Anthropic.

---

## 1. Go-live propuesto

**Fecha objetivo:** **4 semanas después del merge a `main` del issue hijo de implementación (CA-C3)**.

**Por qué 4 semanas y no inmediato:**

| Hito | Duración | Acción |
|---|---|---|
| **Semana 0** — merge CA-C3 a `main` | — | Specs B1–B7 en código, schema actualizado, audit JSONL operativo, gate de promoción listo PERO en **modo dry-run** |
| **Semana 1** — piloto con 5 issues seleccionados | 7 días | Label `architect:enabled` aplicado a 5 issues `area:pipeline / size:medium` recién creados. Architect corre, gate **NO bloquea**, audit captura todo |
| **Semana 2** — revisión piloto + ajustes | 7 días | Análisis manual de las 5 recetas generadas: ¿son útiles? ¿el dev las leyó? ¿hubo reducción de rebotes vs baseline? Ajustar template, prompts del role, sanitizer si corresponde |
| **Semana 3** — go-live parcial: gate activo SOLO para `area:pipeline` | 7 días | Gate de promoción bloquea para issues con `area:pipeline`. Otros dominios siguen en dry-run. Monitorear KPIs §11 del role doc |
| **Semana 4** — go-live total | — | Gate activo para todos los dominios (`area:backend`, `area:frontend`, `area:pipeline`, etc.) |

**Por qué este esquema escalonado:**
- El spike #3526 validó el ahorro con `n=3` issues. Necesitamos `n=5+` con datos reales del rol corriendo para confirmar antes de hacer mandatory.
- El gate de promoción es nueva infra (Guru §riesgo 2). Mejor descubrir bugs con dry-run que bloqueando pipeline en producción.
- `area:pipeline` primero porque es el dominio donde el spike midió (eat your own dog food) y los rebotes ahí son visibles para el equipo dev.

## 2. Plan de piloto (semana 1) — detalle operativo

### Selección de issues

- **5 issues** `area:pipeline / size:medium` creados a partir de `go_live_date - 7d`.
- Excluir issues con label `priority:critical` (hotfix → no es el contexto para experimentar).
- Excluir issues con `size:simple` (overhead del architect supera el ahorro) y `size:large` (más variabilidad, mejor medir con base sólida).
- Si no hay 5 issues `area:pipeline` orgánicos en 7 días, extender la ventana hasta llegar a 5.

### Métricas a capturar en el piloto

| Métrica | Captura | Decisión |
|---|---|---|
| Costo Sonnet 4.7 real por receta | `.pipeline/audit/architect-tokens.jsonl` | ¿Está dentro del rango proyectado ($1–2/issue)? |
| Tiempo elapsed del architect en `criterios` | `.pipeline/metrics/phase-duration.jsonl` | ¿Cabe en la ventana de PO/UX (no agrega latencia secuencial)? |
| Rebotes evitados vs baseline (mismos dominios, 4 semanas anteriores) | YAMLs `procesado/<id>.<skill>` | ¿Reducción >20%? Si no, ajustar template antes de go-live |
| Rechazos UX/dev sobre la receta | Comments en GitHub | ¿>20% rechazos? Iterar formato Detalles Técnicos |
| Falsos positivos del gate (en dry-run) | Audit log | ¿>5% bloqueos injustos? Ajustar regex de validación del body |

### Criterio go / no-go al final de semana 2

- **Go:** ahorro proyectado >25%, latencia sin aumento, <5% falsos positivos. → activar gate parcial (semana 3).
- **No-go:** retroceder a dry-run otra semana, iterar, repetir piloto.
- **Kill switch:** si en cualquier semana el architect causa caída del pipeline (gate bloqueando todo o consumiendo cuota desmedida), apagar el skill via `agent-models.json` (remover entrada `"architect"`) y volver a `criterios: [po, ux]`.

## 3. Cálculo de impacto en cuota Anthropic

### Baseline actual (referencia)

Datos de `.pipeline/metrics/snapshot.json` (ventana `all` al 2026-05-26):
- Issues procesados por skill `pipeline-dev`: ~20/día (orden de magnitud).
- Costo promedio por dev session (Opus 4.7, área pipeline): $4–37 según complejidad (spike #3526).
- Costo total skill `pipeline-dev`: ~$80/día (estimación).

### Impacto del architect

| Concepto | Cálculo | Subtotal |
|---|---|---|
| Issues totales por día en el pipeline (todos los dominios) | ~30/día (orden de magnitud) | — |
| Tokens promedio por receta del architect | ~500K input + ~12K output + cache hits | — |
| Costo Sonnet 4.7 por receta | (500K × $3/M) + (12K × $15/M) + cache savings | ~$1.50/receta |
| **Costo bruto diario del architect (Fase 1)** | 30 issues × $1.50 | **~$45/día** |
| Costo Fase 2 (verificación post-dev) por issue | Sonnet 4.7 con receta ya hecha, ~100K in / ~5K out | ~$0.40/issue |
| **Costo bruto diario del architect (Fase 2)** | 30 issues × $0.40 | **~$12/día** |
| **Total bruto architect** | $45 + $12 | **~$57/día** |
| Ahorro estimado en dev sessions (-35% sobre $80/día) | $80 × 0.35 | **-$28/día** |
| **Costo neto del architect (bruto − ahorro)** | $57 − $28 | **~$29/día extra** |

> **Nota:** Guru estimó +$36/día baseline en el análisis técnico. La diferencia ($29 vs $36) viene de que Guru no descontó el ahorro proyectado en dev sessions. **El balance neto sigue siendo positivo en costo total**: por cada $29 invertidos en architect, se ahorran $28 en dev — el saldo extra ($1/día neto) compra reducción de rebotes (KPI §11 doc role: -30%) y reducción de latencia elapsed dev (3–6h → 1–2h, KPI no monetizado).

### Cuota Anthropic Plan Max (semanal)

- Plan Max actual: 7 días de uso continuo. Reset semanal.
- Consumo actual estimado: ~$560/semana ($80 dev × 7).
- Consumo con architect: ~$760/semana ($80 dev + $29 architect neto × 7 + $40 buffer cache misses).
- **Holgura proyectada:** validar contra `.pipeline/metrics/snapshot-24h.json` antes de go-live. Si la cuota está apretada (>85% del cap weekly), considerar:
  - Diferir go-live hasta liberar cuota.
  - Activar el piloto con `architect:enabled` solo para un subset (no todos los issues) durante semanas 1–2.
  - Reducir frecuencia de Fase 2 (verificar solo issues `size:medium+`, saltar `size:simple`).

### Salvaguardas operativas

- **Quota detector ya calibrado** para el consumo actual. Si el architect dispara cuota agotada, fallback chain (Codex → Gemini → Cerebras) absorbe el pico. Sin gasto extra Anthropic.
- **`agent-models.json` con kill switch implícito:** remover la entrada `"architect"` desactiva el skill sin tocar config.yaml ni hooks.
- **Audit log `.pipeline/audit/architect-tokens.jsonl`** permite reconstruir consumo retroactivo si la cuota se dispara. Visibilidad antes que el incidente.

## 4. Decisión pendiente — cuenta del bot que firma

**El implementer debe resolver y documentar en este plan antes de go-live.**

### Opción A: `architect-bot` dedicado

- Crear cuenta GitHub `architect-bot` con scope mínimo (issues read/write en el repo `intrale/platform`).
- Token en `~/.claude/secrets/credentials.json` siguiendo la convención del proyecto (memoria `feedback_credentials-unified.md`).
- **Pro:** atribución limpia, auditable. El `author.login` del marker comment es inequívoco.
- **Contra:** una cuenta más que mantener, token que rotar.

### Opción B: `github-actions` (bot existente)

- Usar la cuenta default de GitHub Actions, que ya firma con `author.login == "github-actions[bot]"`.
- **Pro:** cero overhead operativo, ya está. El intake gate (#3175) ya usa esta cuenta.
- **Contra:** se mezcla con otros eventos del bot. El audit cruzado (signature_marker_hash) compensa, pero la inspección humana es menos limpia.

### Recomendación

**Opción A** si el architect se va a operacionalizar como rol estable. **Opción B** si el rollout queda en piloto extendido (menos costo de setup). El implementer decide al cerrar CA-C3.

## 5. Comunicación al equipo

### Pre-go-live (semana 0, día del merge CA-C3)

- Notificación Telegram al canal del equipo: `"Architect en dry-run. Sin cambios de gate aún. Detalles: architect-role.md"`.
- Comment en issues activos del momento: `"A partir de YYYY-MM-DD, este issue podría recibir sección 'Detalles Técnicos' del rol Arquitecto. No requiere acción."`.

### Durante el piloto (semanas 1–2)

- Daily digest en Telegram con métricas del piloto (issues procesados, costo, rebotes evitados).
- Survey corto al equipo dev: "¿La receta del architect te ahorró tiempo? 1–5".

### Go-live total (semana 4)

- Anuncio Telegram + canal del equipo.
- Update de `CLAUDE.md` (sección Pipeline) con referencia al nuevo gate.
- Update de `docs/pipeline-v2-diseno.md` con la nueva fase y skill.

## 6. Rollback plan

Si tras 4 semanas post-go-live los KPIs no se cumplen:

| Indicador de problema | Acción |
|---|---|
| Ahorro <20% (vs target 35%) | Rever template Detalles Técnicos + iterar prompts del role. Mantener dry-run otra semana |
| Rebotes evitables NO se reducen | El architect no está generando recetas accionables. Pausar gate, volver a piloto |
| Latencia `criterios` aumenta | Espera blanda mal calibrada. Reducir cap de polling a 15 min |
| Cuota Anthropic >90% sostenido | Activar fallback Codex forzado para architect. Si no alcanza, kill switch |
| Falsos positivos gate >5% | Relajar validación de longitud (200 → 150 chars). Si persiste, revisar regex del marker |
| Bug crítico del gate bloquea pipeline | **Kill switch inmediato**: remover `"architect"` de `agent-models.json` + revertir `config.yaml` a `criterios: [po, ux]`. Pipeline vuelve a estado pre-architect en <5 min |

## 7. Definition of Done del rollout

- [ ] Issue hijo CA-C3 mergeado a `main`.
- [ ] Audit logs operativos: `architect-tokens.jsonl`, `architect-signoff.jsonl`, `architect-grandfathered.jsonl`, `prompt-injection-attempts.jsonl`.
- [ ] Piloto cerrado con 5 issues procesados, métricas capturadas.
- [ ] Gate de promoción `criterios → Ready` activo y validado para `area:pipeline`.
- [ ] Dashboard V3 muestra widget de 4 estados.
- [ ] Cuenta del bot (Opción A o B) documentada y operativa.
- [ ] KPIs §11 doc role medidos a 4 semanas post-go-live total.
- [ ] Comunicación al equipo enviada (pre + post).

## 8. Referencias

- Doc del rol: [`architect-role.md`](architect-role.md)
- Spike retrospectivo: [`spike-3526-architect-savings.md`](spike-3526-architect-savings.md)
- Multi-provider: [`multi-provider.md`](multi-provider.md)
- Issue padre: [#3507](https://github.com/intrale/platform/issues/3507)
- Issue hijo (CA-C3): se crea al cierre de este spike, ver comment de cierre
