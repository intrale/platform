# Narrativa — Mockup KPIs V3 (#3733)

> Mockup adjunto: `.pipeline/assets/mockups/30-kpis-v3.html`
> Split: #3733 (parte de #3715 — rediseño UX integral del Dashboard V3).
> Decisión D-UX-1: **UN solo HTML con todas las sub-secciones de la ventana KPIs** (mantiene la coherencia con `29-matriz-v3.html`).

## Por qué un único mockup

La ventana "KPIs" del dashboard V3 es **el panel de instrumentos del operador**. No es una vista de trabajo (eso vive en `home` / `matriz`), no es donde el operador interviene (eso vive en `bloqueados`/`matriz`): es donde el operador **mira el pulso del pipeline** sin interactuar. Por eso es deliberadamente **read-only**, y por eso todos sus sub-bloques están juntos en un solo HTML — sacarlos a archivos separados rompería la lectura de un vistazo.

El operador entra a esta ventana en uno de tres momentos:

1. **Cada mañana** para chequear que el pipeline arrancó bien (sys-mini en verde, throughput 24h no se cayó).
2. **Cuando algo va mal** (un agente le avisó por Telegram) y quiere cuantificar el dolor: ¿bloqueados crecieron?, ¿el lead time se disparó?, ¿algún proveedor LLM se está cayendo?
3. **Cuando va a presentar al equipo / a Leo** un reporte sintético del estado del sistema.

El mockup está pensado para los tres casos, en ese orden vertical.

## Recorrido del mockup, de arriba hacia abajo

### 1. Header de ventana (slug `kpis`)

Título grande con badge teal **V3** (mismo token `--teal` que usan las otras ventanas del rediseño — coherencia visual). A la derecha, dos acciones: volver a Home y abrir el reporte completo histórico `/metrics`. El botón a `/metrics` está marcado como `primary` (info-bg) porque **es el entry point recuperado** de la memoria `project_metrics-endpoint-lost`: la implementación de #3733 cierra esa memoria al colocar este botón visible.

### 2. KPI Row principal (6 cards + sys-mini)

Los 6 KPIs siguen el orden de **lectura natural del flujo del pipeline** (de izquierda a derecha):

`Definidos → En cola → Ejecución → Entregados 24h → Bloqueados → Necesitan humano`

Es la **línea de tiempo del trabajo**: lo que entró, lo que espera, lo que corre, lo que salió, y lo que se trabó. La sys-mini-card a la derecha (Salud + gauges CPU/RAM) cierra la fila como "y mientras tanto, el sistema mismo está así". El operador absorbe los 7 datos críticos en menos de 2 segundos.

**Por qué cada card lleva `title=` + `aria-label=` y `cursor:help`:**

- Cada `title` explica **la fórmula** y **el target** del KPI ("Throughput: issues entregados por día (promedio rolling 7d). Target: > 2/día").
- Los `aria-label` repiten el valor numérico para lectores de pantalla.
- `cursor:help` (excepto en las dos cards clickeables) marca que el operador puede hover sin miedo a disparar acción.

**Los dos KPIs accionables** son `Bloqueados` y `Necesitan humano`:

- `Bloqueados` filtra el Issue Tracker por bloqueados + dependencias.
- `Necesitan humano` colapsa/expande el listado de incidentes en la ventana Matriz.

Llevan `role="button"`, son operables por teclado (Tab → Enter), y el cursor cambia a `pointer`.

**Por qué `Necesitan humano` usa `--danger` y no `--warning`:** misma razón que el panel rojo de `matriz-v3` — el operador no debería poder no verlo. El pulse del icono `🚨` con `@keyframes pulse 1.8s` rompe el orden visual.

### 3. Leyenda (CA-13)

Bloque seco, baja jerarquía visual, **explícito de que la ventana es read-only**. Es la primera vez que un operador nuevo aterriza acá y entiende:
- Los colores que va a ver durante toda la sesión (success/warn/danger/info/purple).
- Que **acá no rompe nada** — no hay botones que disparen acciones state-changing.

La frase "Ventana **read-only** · sin acciones state-changing" cierra automáticamente el CA-20 ("Si la ventana queda read-only, declararlo explícitamente").

### 4. DORA Metrics

Mini-grid de 4 columnas: Lead Time, Throughput, Failure Rate, Entregas 7d. La referencia "Nicole Forsgren" en el subtítulo es deliberada: legitima la elección de métricas, no son inventadas por nosotros. El link "Ver detalle →" lleva a `/metrics#dora` (anchor del reporte completo).

Cada card lleva `tabindex="0"` para que el lector de pantalla pueda navegar y leer el `aria-label` con el target. Los colores del valor (`ok`/`warn`/`crit`) son **dual-encoding** con el target visible en la metric-target: WCAG AA cubre operadores con daltonismo.

### 5. Commander Routing (det. vs LLM)

Misma estructura visual que DORA — coherencia tipográfica. La métrica clave es `% Determinístico hoy` con target > 60%. Cada comando determinístico es un ahorro de ~3-5k tokens según la memoria del proyecto. El link "JSON →" descarga el audit raw para análisis profundo.

### 6. Proveedores LLM (Decisión D-UX-1)

**Decisión documentada acá** sobre el dilema del scope ("Evaluar mover KPIs de proveedor a la ventana `providers`"):

- **Se quedan en KPIs por ahora** con TODO explícito de migración.
- **Razón**: la ventana `providers` (sub-historia hermana del épico) aún no aterriza. Si los movemos antes, queda un hueco. Mejor mantenerlos en KPIs con feature flag y migrar cuando aterrice.
- **Sólo metadata operativa**: nombre, tasa de éxito, p95, tokens, costo estimado. **Jamás la API key** (CA-19 explícito del PO). Eso vive masked en `/providers` cuando exista.

Los 5 providers están ordenados por **importancia operativa real** del pipeline (default order de la memoria `feedback_multi-provider-default-order`): Claude → Codex → Gemini → Groq → Cerebras. Color identitario por provider (sin reinventarlo — usa los mismos tokens que `multi-provider.js` ya consume).

### 7. CTA hacia /metrics

Card más grande, gradient con `--info-bg`, botón con `min-height: 44px` (touch target WCAG AA). Es la **reincorporación visible del entry point** que estaba perdido (memoria `project_metrics-endpoint-lost`). Texto explica qué hay del otro lado: snapshots del Pulpo, throughput por fase, timeline de archivos procesados, tokens por sesión.

### 8. Footer

Recordatorio sobrio de **canales redundantes**: si el dashboard se cae, Telegram `/kpis` o `/metrics` siguen funcionando, y `/api/metrics` da JSON crudo. Misma filosofía que el footer de `matriz-v3` (canales redundantes para desbloqueo).

## Decisiones cromáticas explicadas

| Color | Reservado para | Por qué |
|---|---|---|
| `--danger` + pulse | `Necesitan humano`, `Bloqueados`, `Failure Rate` fuera de target | Urgencia operativa real, no decoración |
| `--success` | Healthy / dentro del target, throughput consistente | Confirmación de que algo va bien |
| `--warning` | Cerca del límite (CPU 60-85%, RAM 65-85%, throughput < target pero no cero) | Atención sin pánico |
| `--info` | CTA hacia /metrics, link primario | Acción neutral / informativa |
| `--purple` | `Definidos` (backlog), gradient del mockup-banner | Estado de definición / planificación |
| `--teal` (badge V3) | Identidad del rediseño | Distintivo del nuevo dashboard sin opacar las señales semánticas |
| `--brand-cyan` (Claude) | Provider Claude | Coherencia con `multi-provider.js` ya existente |

## Por qué no hay acciones state-changing

El issue plantea explícitamente en CA-12: *"Si la ventana queda 100% read-only, queda documentado explícitamente"*. Decidimos **dejarla 100% read-only** por tres razones:

1. **Separación de responsabilidades**: las acciones operativas viven en otras ventanas (`matriz` para reactivar bloqueados, `ops` para reiniciar servicios, `providers` para masking de keys). Mezclar acción en KPIs confunde el rol mental ("acá miro, allá hago").
2. **Seguridad simétrica**: si no hay POST en KPIs, no hay vector CSRF ni audit-log que mantener para esta ventana. CA-20 se cumple por construcción.
3. **Estabilidad de scope**: las únicas acciones que podrían vivir acá (purgar `metrics-history.jsonl`, resetear contadores) son destructivas y deberían vivir en `ops` con doble-check, no acá.

Las dos cards "clickeables" (`Bloqueados`, `Necesitan humano`) **no son acciones state-changing**: son **filtros visuales locales** sobre otras vistas del mismo dashboard. Quedan documentadas como tales en el inventario.

## Sobre los KPIs de proveedor: por qué nunca la API key

CA-19 lo dice taxativamente. El mockup respeta:
- **Nombre del proveedor** (Claude/Codex/Gemini/Groq/Cerebras) — público.
- **Tasa de éxito** — métrica operativa.
- **p95 de latencia** — métrica operativa.
- **Tokens consumidos** — métrica operativa.
- **Costo estimado** (USD) o "FREE" para los del free tier.
- **NUNCA** la API key (ni completa, ni masked, ni los últimos 4 chars). El masking vive en `/providers` cuando esa ventana hija aterrice; acá no tiene razón de existir.

Esto previene **information disclosure por screenshot** (vector A05 del análisis security): si alguien comparte un screenshot del dashboard, la API key no está nunca en frame.

## Sobre el endpoint /metrics y los headers

El mockup **no representa headers HTTP** (es HTML), pero el CTA hacia /metrics asume que la implementación dev cumple:
- `Cache-Control: no-store, no-cache` en `/metrics` y `/api/metrics` (CA-15).
- Sin `Access-Control-Allow-Origin: *` (CA-15).
- Same-origin enforced (CA-18).
- Session IDs siempre truncados a 8 chars (CA-17).

El operador no ve los headers, pero el contrato visual del CTA depende de que el endpoint sea seguro. Eso queda en `docs/pipeline/metrics-endpoint.md` (CA-10) y se verifica en `aprobacion`.

## Tokens y CSS: no hay HEX libre en el mockup

Cada color del mockup viene de `design-tokens.css`:
- Surfaces: `--surface-0`, `--surface-1`, `--surface-2`.
- Texto: `--text-primary`, `--text-secondary`, `--text-dim`.
- Semánticos: `--success`, `--warning`, `--danger`, `--info`, `--purple`, `--teal`, `--brand-cyan`.
- Backgrounds suaves: `--danger-bg`, `--info-bg`, `--teal-bg`, `--purple-bg`.
- Bordes: `--border-subtle`, `--border`, `--border-strong`.

Si la implementación dev encuentra un valor que necesita pero no está en `design-tokens.css`, **lo agrega al archivo central** (CA-27). Prohibido hardcodear.

## Iconografía

El mockup usa emoji unicode como **fallback visual self-contained** (📊, 📐, ⚙️, 🚨, 🧠, 📈, 🔬, ←). En la integración SSR, el dev debe reemplazar por el sprite (`<use href="./icons/sprite.svg#ic-*">`) usando los IDs canónicos cuando existan (`ic-fase-criterios`, `ic-estado-needs-human`, etc.). Si falta algún icono necesario (gauge, brain, microscope), se **extiende `sprite.svg` via `assets/icons/extract.js`** (CA-28), no se inlinea SVG raw.

## Accesibilidad (heredado CA-21..24)

- **Contraste WCAG AA** verificado con los tokens existentes:
  - `--text-primary` (#E6EDF3) sobre `--surface-0` (#0D1117) = 14.8:1 (AAA).
  - `--text-secondary` sobre `--surface-1` = 9.7:1 (AAA).
  - `--success` (#3FB950) sobre `--surface-1` = 4.6:1 (AA large) — combinado con texto del trend.
  - `--danger` (#F85149) sobre `--surface-1` = 5.1:1 (AA normal).
- **Touch targets ≥44px**: botón "Abrir /metrics" tiene `min-height: 44px`. Los KPI clickeables ocupan toda la card (~92px alto × 168px ancho).
- **Focus visible**: cada elemento interactivo gana `outline: 2px solid var(--info); outline-offset: 2px` en `:focus-visible`. Coherente con `home.js`.
- **Operable por teclado**: `tabindex="0"` en cada KPI y metric-card; los clickeables además `role="button"`.
- **`aria-label`** en cada KPI repite el valor numérico para lectores de pantalla.

## Coherencia con las otras ventanas del épico

| Aspecto | Coincide con |
|---|---|
| Layout kiosk 1080×1920 | `27-bloqueados-v3`, `28-ops-v3`, `28-pipeline-v3`, `29-matriz-v3` |
| `mockup-banner` purple dashed | `29-matriz-v3` |
| `view-header` con título + badge V3 + acciones | Patrón común del épico |
| Tokens via `design-tokens.css` | Todas |
| `section` con `--shadow-elev-1` | `29-matriz-v3`, `28-ops-v3` |
| Footer note con `<kbd>` | `29-matriz-v3` |

## Lo que NO está en este mockup (deliberado)

- **Gráficos / sparklines en tiempo real**: no es scope de #3733 (es scope del reporte `/metrics` o de un panel futuro de "tendencias"). Los KPIs son **snapshots numéricos** del estado actual.
- **Tabla histórica detallada**: vive en `/metrics`, este mockup la enlaza con CTA explícita.
- **Configuración de targets**: los targets son **hardcoded** (lead time < 6h, throughput > 2/d, failure < 15%, determinístico > 60%). Si en el futuro se quiere parametrizar, es otra historia.
- **Comparativa vs sprint anterior**: scope futuro (issue separado si Leo lo quiere).

## Coordinación con la sub-historia 0 (`lib/escape-html.js`)

Cuando el dev implemente `kpis.js`, todo render dinámico (números, nombres de proveedor, mensajes de error en KPI labels) debe ir por `escapeHtmlText()`. El mockup HTML **es estático** así que no demuestra el escape, pero la narrativa lo deja explícito: cada interpolación pasa por el helper. Test XSS canónico con ≥4 payloads (CA-14) se ejecuta sobre los slots dinámicos detectados por `guru` en su inventario:

1. Skill name (en provider-card si futuro incluye breakdown por skill).
2. Slug de fase (en commander-routing si se rompe por skill).
3. Número de issue (en `Bloqueados` cuando muestre los IDs en tooltip).
4. Mensaje de error (en sys-mini si el agente health-check reporta falla).
5. Latencias / costos (números, escape igual por defense in depth).
6. Nombre de proveedor (`config.providers[].label`, asumido texto libre).

## Memoria a cerrar al mergear

- `project_metrics-endpoint-lost.md` — actualizar diciendo "entry point recuperado en #3733 con CTA en ventana KPIs + doc en `docs/pipeline/metrics-endpoint.md`". Es deuda explícita del PO (CA-11).
