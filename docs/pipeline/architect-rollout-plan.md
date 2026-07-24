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

### 2.X Métricas del piloto (datos reales)

Las 4 métricas requeridas por CA-PO-PILOT-METRICS se computan **exclusivamente** desde fuentes append-only (CA-IMPL-PILOT-METRICS-SOURCE, A08 Integrity):

- `.pipeline/audit/architect-tokens.jsonl` (writer `lib/architect-audit.js`, spec B4 de #3613).
- `.pipeline/audit/prompt-injection-attempts.jsonl` (lazy creation; ENOENT → 0 intentos).

Prohibido leer de `.pipeline/logs/*.log` o `pipeline-state-*.json` (no append-only, tampering ex-post posible). El script enforza esta policy con un test bloqueante (`node --test .pipeline/lib/__tests__/architect-pilot-metrics.test.js`) que falla si el source de `architect-pilot-metrics.js` referencia paths prohibidos.

**Cómo regenerar el bloque automático:**

```bash
export PATH="/c/Workspaces/gh-cli/bin:$PATH"
node .pipeline/scripts/architect-pilot-metrics.js --limit=5 --update-rollout-plan
```

El script reemplaza idempotentemente el contenido entre `<!-- pilot-metrics:auto -->` y `<!-- /pilot-metrics:auto -->`. Ejecuciones sucesivas sobreescriben, no duplican.

<!-- pilot-metrics:auto -->

### Métricas del piloto (datos reales, auto-generadas)

_Pendientes — el script `architect-pilot-metrics.js` aún no se ejecutó sobre los issues del piloto. Para regenerar: `node .pipeline/scripts/architect-pilot-metrics.js --limit=5 --update-rollout-plan`._

| Métrica | Valor | n | Umbral | Fuente |
|---|---|---|---|---|
| Latencia P50 criterios→signoff (min) | _pendiente_ | 0 | informativo | append-only |
| Latencia P95 criterios→signoff (min) | _pendiente_ | 0 | informativo (n<10 indicativo) | append-only |
| Tasa rechazo Fase 2 | _pendiente_ | 0 | < 30% | append-only |
| Costo USD agregado piloto | _pendiente_ | 0 entries | ±30% vs $29/día×piloto | append-only |
| Ratio qa:passed sin rebote architect | _pendiente_ | 0 | informativo | gh-api-mutable |
| Intentos prompt-injection registrados | 0 | — | informativo | append-only |

**Issues considerados:** _(ninguno — el piloto operativo todavía no fue ejecutado; el código del script + tests están listos para correr cuando los 5 issues `architect:enabled` cierren)._

> **Nota sobre integridad (A08):** los valores marcados como `append-only` provienen exclusivamente de `.pipeline/audit/architect-tokens.jsonl` y `.pipeline/audit/prompt-injection-attempts.jsonl`. El valor marcado como `gh-api-mutable` cruza con labels GitHub (informativo, no decisorio para el go/no-go).

> **Nota estadística:** con `n<10` los percentiles son indicativos, no robustos. Re-evaluar tras 4 semanas post-go-live total con `n>30` (alineado con el spike #3526).

<!-- /pilot-metrics:auto -->

### 2.Y Decisión go/no-go firmada (manual, NO auto-generado)

**Esta sección la completa @leitolarreta al cerrar el piloto.** Plantilla a usar (CA-PO-PILOT-DECISION-TRACEABLE):

```markdown
#### Decisión go/no-go — piloto cerrado <YYYY-MM-DD>

**Valores crudos** (de `.pipeline/audit/architect-tokens.jsonl` en commit `<SHA>`):

- Latencia P50 criterios→signoff: `<min>` min
- Latencia P95 criterios→signoff: `<min>` min
- Tasa rechazo Fase 2: `<%>` (umbral aceptable: <30%)
- Costo USD agregado piloto: `$<USD>` (estimación R4 base: $29/día × duración del piloto — desviación tolerada ±30%)
- Ratio qa:passed sin rebote architect: `<%>` (informativo, gh-api-mutable)
- Intentos prompt-injection registrados: `<N>`

**Decisión:** [GO | NO-GO]

**Justificación:** <texto explicando por qué los valores soportan la decisión>

**Sign-off:** @leitolarreta — `<YYYY-MM-DDTHH:MM:SSZ>` — audit commit `<SHA>`
```

Reglas del sign-off:

1. Los 5 valores cuantitativos deben citarse textualmente desde el bloque auto-generado de §2.X (no parafrasear ni redondear "a ojo").
2. El commit SHA al que se refiere es el `git log -n1 .pipeline/audit/architect-tokens.jsonl` al momento del corte (defensa A08 contra ajuste post-hoc del JSONL).
3. Sin sign-off humano firmado, el rollout total (semana 4) NO debe activarse — el gate de la decisión es esta sección, no el calendario.

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

### Decisión cerrada (#3614, CA-6) — Opción A

**Resolución:** se adopta **Opción A** (`architect-bot` dedicado).

**Motivación:**

- El gate B3 (criterios → Ready) es infraestructura de seguridad: el `author.login` del marker comment debe ser inequívoco para que `evalMarker` rechace markers de terceros. Mezclar con `github-actions[bot]` (Opción B) diluye la atribución porque GitHub Actions ya emite events de CI/checks/releases bajo la misma cuenta.
- El gate ya consume `comment.authorAssociation` (`OWNER`/`MEMBER`/`COLLABORATOR`) y `author.login` simultáneamente (CA-3). Tener un login dedicado permite reglas más estrictas a futuro (`authorAssociation = MEMBER`, sin OWNER ni COLLABORATOR) sin colisionar con bots legacy.
- El costo operativo del PAT se compensa por el resto del flujo: la rotación está cubierta por #3607 (rotación de credenciales) y el secret vive ya en `~/.claude/secrets/credentials.json` (memoria `feedback_credentials-unified.md`).

**PAT scope mínimo de `architect-bot`:**

| Permiso | Necesario | Justificación |
|---|---|---|
| `repo > metadata` | Read | Listar issues + comments del repo intrale/platform |
| `repo > issues` | Read+Write | Postear comment con marker `<!-- architect-signoff issue=NNNN -->` |
| Cualquier otro | NO | El bot NO crea PRs, NO mergea, NO toca branches, NO ejecuta workflows |

PAT con expiración a 90 días, rotación trackeada por #3607 (mismo ciclo que el resto de credenciales del pipeline).

**Default operativo durante el piloto** (semanas 1-2):

```yaml
architect:
  enabled: false              # kill switch fail-safe — operador activa cuando esté listo
  gate_mode: dry-run          # nunca bloquea en piloto
  go_live_date: '2026-05-29T00:00:00Z'
  bot_login: architect-bot    # Opción A
```

**Fallback si Opción A no se materializa:** si la cuenta dedicada no se crea antes del piloto, el operador puede cambiar `bot_login: 'github-actions[bot]'` para usar Opción B temporalmente. El gate sigue funcionando con `authorAssociation` como salvaguarda adicional. Documentar la elección en el commit que active el piloto.

## 5. Comunicación al equipo

Los **3 comunicados** (pre-go-live, durante piloto, post-go-live) cumplen los 4 puntos de **CA-PO-COMM-CONTENT**:

1. **Qué cambia en el flujo del dev**: cuándo verá la tarjeta architect en el dashboard y qué significa cada estado (los 4 estados del widget se entregaron en #3642).
2. **Cómo destrabar un issue rechazado por architect en Fase 2**: rebote a `criterios`, qué corregir en la receta, plazo esperado.
3. **Quién mira el audit** `prompt-injection-attempts.jsonl` y `architect-codebase-sanitized.jsonl` ante sospecha (responsabilidad de monitoreo).
4. **Cap de polling default (30 min)** y cómo identificar un issue "esperando architect" en el dashboard.

Canal estándar verificado (CA-PO-COMMS-CHANNEL-VERIFIED): **Telegram (canal del equipo)** como push primario + **comment en el issue umbrella #3559** como ancla persistente. Cada comunicado requiere al menos 1 acuse de recibo humano (reacción 👍 en Telegram o reply en el comment) registrado en §7 (DoD).

### 5.1 Pre-go-live (semana 0, día del merge CA-C3)

**Canal:** Telegram + comment en #3559.

**Texto Telegram:**

> 📣 *Architect en dry-run — sin cambios de gate aún*
>
> Lo que cambia para vos como dev (a partir de hoy):
> 1. **Dashboard:** vas a empezar a ver la tarjeta `architect` con 4 estados posibles (pending / in_progress / signoff / rebote). Detalle visual: #3642. **No bloquea** en esta etapa, sólo informa.
> 2. **Si un issue te rebota por architect en Fase 2** (post-merge): el ciclo manda el issue de vuelta a `criterios`, ajustás la receta según el motivo de rechazo y reentras. Plazo esperado de re-firma: ~30 min (cap de polling).
> 3. **Audit de seguridad:** si sospechás de prompt-injection o redacción de codebase, los logs `prompt-injection-attempts.jsonl` y `architect-codebase-sanitized.jsonl` los monitorea @leitolarreta + el rol `security` semanalmente.
> 4. **Polling:** issues "esperando architect" aparecen con el badge de estado `pending` o `in_progress` en el dashboard; el cap por default es 30 min.
>
> Detalles completos: `docs/pipeline/architect-role.md` y `architect-rollout-plan.md`. Cualquier duda o reacción negativa, replicar en este hilo.

**Comment en issue umbrella #3559** (idéntico contenido, formato markdown nativo de GitHub).

**Acuse de recibo registrado en:** §7 (DoD), checkbox "5.1 acuse recibido".

### 5.2 Durante el piloto (semanas 1–2)

**Canal:** Telegram (daily digest) + comment en #3559 al cierre de la semana 2.

**Texto Telegram (digest diario, plantilla):**

> 📊 *Piloto architect — día N/14*
>
> 1. **Estados del dashboard hoy:** `<N issues con signoff / N pending / N rebote>`. Si veías un issue tuyo en `pending` >30 min y te preocupó la latencia, comentá en el hilo.
> 2. **Rebotes Fase 2 acumulados:** `<N>` issues. Si te rebotó alguno, el patrón documentado para destrabar está en §2 del rollout-plan.
> 3. **Monitor de injection logs:** `<N intentos hoy>` (todos bloqueados). Sin sospechas → no requiere acción. Si subiera abruptamente, @leitolarreta investiga.
> 4. **Cap polling sin cambios:** 30 min. Si ves issues "colgados" más de eso, abrí ticket pinneando la tarjeta del dashboard (#3642 documenta los estados visuales esperados).
>
> Métricas crudas del día: `node .pipeline/scripts/architect-pilot-metrics.js --limit=5 | jq`.

**Survey corto al final de semana 2** (Telegram, anónimo): "¿La receta del architect te ahorró tiempo? 1–5. ¿Algún rebote injusto? Sí/No + detalle."

**Acuse de recibo registrado en:** §7 (DoD), checkbox "5.2 acuse recibido".

### 5.3 Post-go-live (semana 4)

**Canal:** Telegram (anuncio formal) + comment en #3559 + update de `CLAUDE.md`.

**Texto Telegram:**

> 🚀 *Architect en go-live total*
>
> Decisión go/no-go firmada por @leitolarreta el `<YYYY-MM-DD>` (ver §2.Y del rollout-plan, sign-off con commit SHA del audit).
>
> 1. **Cambio en tu flujo:** el gate de promoción `criterios → Ready` ahora es activo para TODOS los dominios (`area:pipeline`, `area:backend`, `area:frontend`, etc.). La tarjeta architect en el dashboard pasa a ser bloqueante: sin signoff no hay promoción.
> 2. **Destrabe Fase 2 sin cambios respecto al piloto:** rebote → `criterios` → ajustar receta → reentra. Si dudás del motivo, comentar en el issue para que @leitolarreta arbitre.
> 3. **Audit semanal de injection logs:** @leitolarreta + `security` revisan `prompt-injection-attempts.jsonl` cada lunes. Si querés que se audite un comment específico, mencioná `@leitolarreta` con el `source_id` del comment.
> 4. **Cap polling default (30 min):** si tu equipo opera con SLAs distintos, abrí issue solicitando override en `agent-models.json`.
>
> Toda la documentación actualizada en `docs/pipeline/architect-role.md` y `docs/pipeline-v2-diseno.md`.

**Comment en issue umbrella #3559** anunciando cierre operativo del rollout.

**Update de** `CLAUDE.md` (sección Pipeline) con referencia al nuevo gate activo.

**Acuse de recibo registrado en:** §7 (DoD), checkbox "5.3 acuse recibido".

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

### Código (independiente del piloto operativo)

- [x] Issue hijo CA-C3 mergeado a `main`.
- [x] Audit logs operativos: `architect-tokens.jsonl`, `architect-signoff.jsonl`, `architect-grandfathered.jsonl`, `prompt-injection-attempts.jsonl` (writer en `lib/architect-audit.js`).
- [x] Gate de promoción `criterios → Ready` activo y validado para `area:pipeline` (#3667 mergeado).
- [x] Dashboard V3 muestra widget de 4 estados (#3642 mergeado).
- [x] Cuenta del bot (Opción A `architect-bot`) documentada en §4.
- [x] Script `architect-pilot-metrics.js` + tests bloqueantes (policy-as-test A08 + cómputo + ENOENT + idempotencia marker) mergeados (#3644).
- [x] Comunicados redactados en §5 con los 4 puntos de CA-PO-COMM-CONTENT (#3644).

### Operativo (requiere ejecución del piloto)

- [ ] Piloto cerrado con 5 issues `architect:enabled` procesados.
- [ ] Métricas capturadas: ejecutar `node .pipeline/scripts/architect-pilot-metrics.js --limit=5 --update-rollout-plan` y commitear el bloque actualizado en §2.X.
- [ ] §2.Y "Decisión go/no-go firmada" completada por @leitolarreta con los 5 valores crudos + umbral + justificación + sign-off + fecha + commit SHA del audit.
- [ ] KPIs §11 doc role medidos a 4 semanas post-go-live total.

### Comunicación (acuses de recibo)

- [ ] Comunicado §5.1 (pre-go-live) enviado en Telegram + comment en #3559.
- [ ] Acuse §5.1 registrado: <persona, fecha>.
- [ ] Comunicado §5.2 (durante piloto) enviado al menos 1 vez por día durante semanas 1–2.
- [ ] Acuse §5.2 registrado: <persona, fecha>.
- [ ] Comunicado §5.3 (post-go-live) enviado en Telegram + comment en #3559 + update `CLAUDE.md`.
- [ ] Acuse §5.3 registrado: <persona, fecha>.

## 8. Referencias

- Doc del rol: [`architect-role.md`](architect-role.md)
- Spike retrospectivo: [`spike-3526-architect-savings.md`](spike-3526-architect-savings.md)
- Multi-provider: [`multi-provider.md`](multi-provider.md)
- Issue padre: [#3507](https://github.com/intrale/platform/issues/3507)
- Issue hijo (CA-C3): se crea al cierre de este spike, ver comment de cierre
