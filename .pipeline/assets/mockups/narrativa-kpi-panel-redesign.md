# Narrativa — Panel KPI post-fix (issue #3357)

**Issue:** [#3357](https://github.com/intrale/platform/issues/3357)
**Mockup:** [`19-kpi-panel-redesign.svg`](19-kpi-panel-redesign.svg)
**Autor:** agente `ux` durante fase `definicion/criterios`
**Contexto previo:** análisis del agente `guru` ([comentario](https://github.com/intrale/platform/issues/3357#issuecomment-4483452950)) + criterios del `po` ([comentario](https://github.com/intrale/platform/issues/3357#issuecomment-4483468692)) + seguridad ([comentario](https://github.com/intrale/platform/issues/3357#issuecomment-4483305824))

---

## Por qué este rediseño

El panel KPI actual del dashboard miente en cuatro de cinco indicadores:

1. **PRs últimos 7 días** funciona casi bien, pero si la primera llamada a `gh pr list` falla, el cache cae a `null` y queda atrapado ahí hasta el próximo TTL — el operador ve "—" y no sabe si es real o un bug intermitente.
2. **"Tokens 24h"** es un nombre que engaña: el aggregator devuelve `window: "all"`, no 24h. Y los tokens están sumados de todos los providers (anthropic, openai-codex, groq, gemini, cerebras) en un solo número sin breakdown. El operador no distingue si gastó el día en Claude o se le fue en Codex.
3. **"Cycle time estimado"** mide la mediana de duración de un agente por marker, no el cycle time DORA (creación → cierre del issue). Cuando el operador ve 1h 15min se asusta — pero en realidad eso es lo que tardó el agente más lento en una fase, no el flujo completo.
4. **"% rebote"** cuenta cada marker como una unidad. Un issue que rebota 2 veces y aprueba al tercer intento aporta 66% al rate — el operador piensa "dos de cada tres pasan". La intuición correcta es "1 issue de N rebotó al menos una vez". Y nunca dice **en qué fase** rebotó, que es la información clave para mejorar.
5. **"Quota Plan Max"** suma horas de **todos** los providers al contador de Anthropic — los runs de Groq y Codex inflan el % del plan Max. Y el panel solo muestra Anthropic, no los demás providers.

**Decisión de UX:** los cinco KPIs se mantienen visibles en una fila de 5 tarjetas (la sexta posición existente — "Quota" — pasa a ser una tabla independiente debajo, porque multi-provider necesita filas y no entra en una sola card). Cada card tiene:

- **Label semánticamente correcto** (sin engañar).
- **Sub-label** que aclara el alcance temporal y la regla de cálculo.
- **Indicador de tooltip** (`ⓘ`) en los KPIs con breakdown (Tokens 24h y % rebote).
- **Badge "NUEVO"** en Cycle time del issue (es métrica nueva, distinguible de la mediana por agente).

Adicionalmente: una **tabla "Quota por provider"** ocupa el ancho completo debajo, con una fila por cada provider declarado en `agent-models.json`.

---

## Sistema visual

### Tokens reutilizados (cero paleta nueva)

| Token | Uso en este mockup |
|---|---|
| `--surface-0` (#0D1117) | Body background |
| `--surface-1` (#161B22) | Cards KPI · contenedor de la tabla |
| `--surface-2` (#1C2128) | Header de la tabla · tooltips · zebra |
| `--border` (#30363D) | Borde estándar cards y tabla |
| `--border-subtle` (#21262D) | Dividers de filas dentro de la tabla |
| `--text-primary` (#E6EDF3) | Valores numéricos y nombres de provider |
| `--text-secondary` (#B1BAC4) | Labels, sub-totales, unidades |
| `--text-dim` (#8B949E) | Sub-labels (ventana temporal, regla de cálculo) |
| `--text-disabled` (#6E7681) | Notas técnicas pequeñas |
| `--radius-md` (10px) | Esquinas redondeadas de cards y tooltip |

### Acentos semánticos por card

Cada KPI usa un color identitario coherente con el sistema existente. **El borde izquierdo de 3px** comunica la categoría:

| KPI | Acento | Token | Por qué |
|---|---|---|---|
| PRs últimos 7d | púrpura | `--purple` (#BC8CFF) | Coherente con `--lane-definicion` — el PR es el cierre del flujo definición→entrega |
| Tokens últimas 24h | cyan | `--brand-cyan` (#00D6FF) | Identidad de marca · multi-provider (no se pinta de un provider específico) |
| Duración mediana · agente | azul | `--info` (#58A6FF) | Métrica operacional informativa, no de salud ni alerta |
| Cycle time del issue | teal | `--teal` (#2DD4BF) | Misma familia que badge V3 — métrica nueva del rediseño |
| % rebote · issues 7d | ámbar | `--warning` (#D29922) | Alerta blanda — no es error, pero pide atención |

### Iconografía

Los íconos en cada card son inline pero **deben mapearse al sprite** `.pipeline/assets/icons/sprite.svg` cuando se implemente en HTML:

- KPI PRs → `ic-git-pull-request` (existente) o reutilizar `ic-fase-entrega`
- KPI Tokens → `ic-tokens` o `ic-bars-horizontal` (definir en sprite si no existe)
- KPI Duración agente → `ic-clock`
- KPI Cycle time issue → `ic-flow` o crear `ic-cycle` con dos nodos enlazados
- KPI % rebote → `ic-refresh` con rotación 360 (existente)
- Tooltip `ⓘ` → `ic-info` (existente)

**Colores de provider** (en tooltips y filas de tabla):
- Anthropic → `--provider-anthropic` (#E5946B copper)
- OpenAI Codex → `--provider-openai-codex` (#10B981 emerald oscuro)
- Groq → `--provider-groq` (#FF6B47 coral)
- Gemini → `--provider-gemini` (#8AB4F8 azul Google)
- Cerebras → `--provider-cerebras` (#FFD166 amarillo wafer)

Todos ya existen en `design-tokens.css` sección 3.c / 3.d — **no se agregan tokens nuevos**.

---

## Las 5 cards KPI

### KPI 1 — PRs últimos 7d (`prsLast7d`)

**Valor demo:** `51`
**Sub-label:** "merged · since 2026-05-12 UTC"
**Nota:** "cache 60s · CA-1.3 preserva valor"

**Notas de UX:**
- Si `gh` falla en una iteración pero el cache previo existe → mostrar el último valor + indicador sutil (no implementado en el mockup pero documentado: un punto ámbar pequeño en la esquina superior derecha cuando el dato tiene más de 5 minutos).
- Si nunca hubo dato → mostrar `—` (em-dash) en `--text-dim`, NO `0`.
- Sub-label explicita la ventana en UTC para evitar la confusión TZ que mencionó guru (CA-1.4 — documentar en JSDoc).

### KPI 2 — Tokens últimas 24h (`tokens24h`)

**Valor demo:** `847k` (in + out)
**Sub-label:** "todos los providers"
**Tooltip on hover:** breakdown por provider con barras de porcentaje.

**Notas de UX:**
- El número grande es el total agregado. La granularidad la da el tooltip — no se pinta del color de ningún provider porque es la suma.
- El tooltip tiene 6 filas: 5 providers + TOTAL. Cada fila: dot del color del provider · nombre · tokens · porcentaje del total.
- Las cifras y porcentajes alineados a la derecha con `font-variant-numeric: tabular-nums` para que las columnas se vean parejas.
- Footer del tooltip aclara la fuente: `snapshot.json window=24h · cutoff_ts ISO` — el operador puede verificar empíricamente con `jq` (CA-2 verificable).

### KPI 3 — Duración mediana · agente (`agentDurationMedianMs`)

**Valor demo:** `4m 18s`
**Sub-label:** "CA-3.1 · ex 'Cycle time'"
**Nota:** "listo ∪ procesado deduplicado"

**Notas de UX:**
- El label aclara que ANTES se llamaba "Cycle time" y por qué se renombró — durante 1 release coexisten el campo deprecado y el nuevo (CA-3.1). En la UI definitiva, la nota deprecada desaparece después del primer release.
- El número refleja la mediana, no el promedio — más resistente a outliers (un build de 30 minutos no la distorsiona).

### KPI 4 — Cycle time del issue (`issueCycleTimeMs`) · NUEVO

**Valor demo:** `2h 47m`
**Sub-label:** "creación → cierre · mediana 7d"
**Nota:** "CA-3.2 · DORA-aligned"
**Badge:** `NUEVO` (teal pill) en la esquina superior derecha durante 1 release.

**Notas de UX:**
- Es la métrica que el operador piensa cuando lee "cycle time" — desde que un issue entra al pipeline hasta que se mergea su PR.
- El badge `NUEVO` ayuda a re-aprender el panel sin manual. Una vez que pase el primer release, el badge sale (heurística: 30 días desde merge del fix).
- Sub-label aclara qué se mide (creación del issue → cierre/merge del PR) — sin esto el operador podría asumir "tiempo en estado abierto", "tiempo en cada fase", etc.

### KPI 5 — % rebote · issues 7d (`bouncePct`)

**Valor demo:** `18%` con sub-valor `3 / 17`
**Sub-label:** "≥1 rebote · ventana 7d"
**Tooltip on hover:** breakdown por fase con barras horizontales.

**Notas de UX:**
- El número grande es el porcentaje (CA-4.1). El sub-valor `3 / 17` da el contexto absoluto — sin él, `18%` se siente abstracto.
- El tooltip muestra **dónde** se concentran los rebotes (CA-4.3). En el mockup, `aprobacion` se ve en rojo con la barra más larga — eso comunica "el cuello de botella es review/qa, no análisis técnico".
- La barra de cada fase usa el color semántico: `--success` cuando ≤10%, `--warning` cuando 11-25%, `--danger` cuando >25%. Coherente con la paleta operacional.
- Si total = 0 (semana sin issues completados) → la card muestra `—`, no `0%`. NO dividir por cero. (CA-4.4)

---

## La tabla "Quota por provider"

### Estructura

| Columna | Contenido | Alineación |
|---|---|---|
| Provider | Nombre + dot identitario + slug (`claude.ai/max`) | Izquierda |
| Plan | "Plan Max" / "Plus" / "Free tier" | Izquierda |
| Uso 7d | Horas o USD según el provider | Derecha (tabular-nums) |
| Max | Cap del plan o "sin cap" | Derecha (tabular-nums) |
| % usado | Porcentaje del cap | Derecha (tabular-nums) |
| Barra | Barra horizontal de 336px con fill del % | Centro |
| Estado | Pill semántico (HEALTHY / WARNING / OVER / FREE) | Derecha |

### Filas demo (en el mockup)

1. **Anthropic — Plan Max** · `12.5 h` / `37 h` = `34%` · estado `WARNING` (ámbar) · barra al 34%.
   - Coherente con CA-5.1: este número refleja **solo** uso de Claude después del fix del filtro `provider === 'anthropic'`.
2. **OpenAI Codex — Plus** · `$3.40` / `$50/mes` = `6.8%` · estado `HEALTHY` (verde).
   - El adapter expone USD en lugar de horas porque el plan Plus es por consumo, no por tiempo.
3. **Groq — Free tier** · todo `—` · estado `FREE` (neutro gris) · barra punteada con texto "free · sin quota tracking".
   - CA-5.4: los free no muestran números, muestran "—" y una franja punteada decorativa.
4. **Gemini — Free tier** · mismo patrón que Groq pero la nota dice "free · TOS: prompts entrenan modelo" — recuerda al operador que ciertos skills sensibles están excluidos del routing a Gemini.
5. **Cerebras — Free tier** · mismo patrón que Groq.

### Notas de UX

- La tabla es **una sola** unidad visual (no 5 cards individuales) porque la información se compara mejor en filas — el operador escanea de arriba abajo, no de izquierda a derecha.
- El orden de las filas: Anthropic primero (es el plan pago principal), después Codex (pago), después los free.
- Los estados se mapean directamente a los tokens semánticos: `--success` / `--warning` / `--danger` / `--deterministic` (gris). Sin colores inventados.
- Hover sobre una fila → el cursor cambia y la fila se eleva sutilmente con `--surface-2`. (No mostrado en el SVG pero documentado para la implementación.)
- Click en una fila → navega a `/consumo?provider=<id>` para el detalle del provider (no implementado todavía, queda como nice-to-have para una iteración futura).

---

## Cobertura de los criterios de aceptación del PO

| CA | Cubierto en el mockup |
|---|---|
| CA-1 (`prsLast7d`) | Card 1 con sub-label `since YYYY-MM-DD UTC` y nota de preservación de cache |
| CA-2 (`tokens24h` con breakdown) | Card 2 + tooltip con 5 providers + total. Sub-label aclara `window=24h` |
| CA-3.1 (`agentDurationMedianMs`) | Card 3 con label correcto + nota explicando el rename |
| CA-3.2 (`issueCycleTimeMs` nuevo) | Card 4 con badge `NUEVO` durante 1 release |
| CA-4 (`bouncePct` semántico + breakdown) | Card 5 + tooltip con 5 fases + overall |
| CA-4.4 (división por cero) | Convención documentada: card muestra `—`, NO `0%` |
| CA-5 (Quota multi-provider) | Tabla completa con 5 providers + estados |
| CA-5.4 (free sin quota) | Filas Groq/Gemini/Cerebras con dashes + nota "free" |
| CA-UX-2 (labels semánticos en UI) | Labels exactos del mockup matchean los strings que la implementación tiene que usar |

---

## Implementación (notas para `pipeline-dev`)

1. **Estructura HTML del KPI grid**: agregar una clase `kpis-5` adicional al sistema existente (`kpis-6` ya existe). Layout: `display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px;`.
2. **Tooltip**: usar `<details>` HTML5 o un wrapper con `aria-describedby` para accesibilidad. Cuando se hace hover sobre la `ⓘ`, mostrar el popover con `position: absolute` y `--shadow-elev-3` (token existente). El popover NO debe sangrar fuera del viewport — usar `popover` API o un fallback con `getBoundingClientRect`.
3. **Tabla**: HTML semántico `<table>` con `<thead>` + `<tbody>`. `role="grid"` si la implementación tiene interactividad por fila. El thead sticky cuando el panel scrollea.
4. **Estados vacíos**:
   - Card vacía (sin datos) → mostrar `—` (em-dash) en `--text-dim`. NO mostrar `null`, NO mostrar `0` si el dato no se midió.
   - Tooltip vacío (sin providers en 24h) → mostrar "Sin actividad en las últimas 24h" centrado.
   - Tabla vacía (aggregator no corrió) → mostrar "Snapshot no disponible · iniciá el aggregator" con icono de warning.
5. **Animación de hover**: 150ms con `cubic-bezier(0.4, 0, 0.2, 1)` — la transición ya está definida en `design-tokens.css` como `--ease-standard`. Evitar animaciones >300ms (la UI ya es densa, animar mucho cansa).

---

## Restricciones inquebrantables

1. **Sin código activo en el SVG**: el mockup no tiene `<script>` ni atributos `on*` ni `href` externos.
2. **WCAG AA mínimo**: todos los pares texto/fondo del mockup superan 4.5:1 para texto normal y 3:1 para texto grande. Los acentos de provider sobre fondos `*-bg` también — verificado contra la tabla de `design-tokens.css`.
3. **Zero paleta nueva**: todos los colores referencian tokens ya existentes.
4. **Coherencia con el dashboard actual**: el mockup vive sobre el `body` `#0D1117` del dashboard real — se puede embeber sin chocar con el resto del layout.
5. **Sin fonts externas**: el mockup usa el system font stack del dashboard (`-apple-system, 'Segoe UI', system-ui, sans-serif`).

---

> Narrativa generada por el agente `ux` durante la fase `definicion/criterios` del pipeline V3. El mockup SVG (`19-kpi-panel-redesign.svg`) + esta narrativa (`narrativa-kpi-panel-redesign.md`) son la fuente única de verdad para `pipeline-dev` cuando tome el issue en la fase `desarrollo/dev`. Si durante la implementación surge una ambigüedad, se prioriza esta narrativa por sobre interpretaciones libres del SVG — y si la narrativa no cubre el caso, escalar al agente `ux` antes de improvisar.
