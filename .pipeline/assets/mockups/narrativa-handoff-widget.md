# Narrativa visual — Widget de Handoff cross-agente (#2993)

> Documento UX que acompaña al mockup `09-handoff-widget.svg` y a los íconos
> agregados al sprite (`ic-handoff`, `ic-tokens-saved`). Define el sistema
> visual del widget que se incorpora al dashboard interno V3 (página
> `/consumo`) para visibilizar el cumplimiento de los CAs C1 y C2 del issue
> #2993.

## Contexto del feature

El handoff cross-agente es un mecanismo del pipeline V3 que reduce los tokens
recargados por issue: cada agente que cierra fase deja un resumen
estructurado en `.pipeline/handoff/<issue>.md`, y el siguiente lo recibe
inyectado en su `userPrompt` envuelto en delimitadores `<handoff_externo>`.
El issue es **infra pura** del pipeline (label `area:pipeline` + `tipo:infra`,
sin `app:*`) — no afecta UX del producto al usuario final del cliente. La
única superficie visual es el widget interno del dashboard del equipo
Intrale, que vive en `localhost`.

## Decisiones de diseño

### 1. Reuso integral del sistema de tokens existente
- 100 % del color, tipografía y espaciado vienen de
  `.pipeline/assets/design-tokens.css`. Cero tonos nuevos.
- Se eligió `--teal` (`#2DD4BF`) como acento del widget: ya está reservado
  como "acento alternativo / V3 badge" en los tokens, y diferencia
  visualmente al handoff del bloque de consumo general (`--info` azul) sin
  romper la paleta.

### 2. Coherencia con el mockup `03-consumo.svg`
- Header, breadcrumb, filtros de ventana (`7 dias / 24h / Mes`) y la
  estructura de "4 KPI cards en fila + 2 paneles abajo" son idénticos a la
  página `/consumo` ya commiteada. El widget se inserta como una nueva
  pestaña/sección de esa página, no como una ruta nueva.

### 3. Hit rate como métrica primaria, ahorro como secundaria
- KPI 1 = `% hit rate del handoff` (cobertura) en posición destacada porque
  responde a la pregunta operativa "¿está funcionando el sistema?".
- KPI 2 = `tokens ahorrados acumulados` con conversión a USD estimada
  (proxy: tokens del handoff inyectado − bytes equivalentes del issue
  completo que hubiera tenido que recargar). Cumple CA-C2 ("ahorro
  estimado").
- KPI 3 = "issues procesados" desglosado en `con handoff` vs `fallback` —
  cumple el requisito explícito de CA-C2 de exponer
  "% de invocaciones con handoff válido vs fallback".
- KPI 4 = panel de auditoría (eventos de seguridad) — anclado al CA-B7 y
  CA-C1: el dashboard tiene que dejar visible que el módulo está siendo
  monitoreado contra prompt-injection y secrets/PII, sin esto la confianza
  operativa se diluye.

### 4. Sparkline 7 días con umbral configurable
- Línea de tendencia + área degradada `--teal` para señalar dirección sin
  carga visual.
- Línea horizontal punteada en 50 % marcada como **umbral**: refuerza la
  sugerencia del bloque "Notas técnicas" del issue ("alertar si cache hit
  rate cae bajo 20 %"). El umbral es configurable; el mockup lo posiciona
  en 50 % a propósito para mostrar el caso "estamos bien".

### 5. Tabla de top issues con estados claros
- Estado `activo` (teal) vs `fallback` (warning ámbar) — siempre con icono
  + texto, nunca solo color (regla de accesibilidad del repo).
- Las "secciones" (cuántos skills escribieron en el handoff de ese issue)
  son la unidad concreta de cumplimiento de CA-A3 (escritura append-only
  por skill).

### 6. Banda inferior de auditoría
- Banda de 92 px que muestra los últimos 4 eventos del handoff con tipo,
  timestamp, agente, mensaje y estado. Cumple **visiblemente**:
  - CA-B7 (auditoría): el dashboard expone los writes registrados en
    `handoff-audit.jsonl`.
  - CA-B3 (filtrado de secrets/PII): el evento `REDACTED` deja claro que el
    sistema redactó algo sin filtrarlo.
  - CA-A5 (validez temporal): el evento `FALLBACK` muestra cuando un
    handoff expiró.

### 7. Indicador de kill-switch en el header
- Pill compacta arriba a la derecha (`handoff: activo · kill-switch OFF`) —
  cumple CA-B7: el kill-switch debe ser **visible y accionable** desde el
  dashboard. El estado `activo + kill-switch OFF` se muestra en verde;
  `activo + kill-switch ON` se mostraría en `--quota-degraded` (ámbar).

### 8. Iconografía nueva (extensión del sprite)
- **`ic-handoff`**: dos nodos circulares (origen y destino) con curva
  descendente que carga un paquete a mid-camino. La línea punteada vertical
  en el agente origen sugiere de manera sutil el fallback al issue
  ("no autoritativo").
- **`ic-tokens-saved`**: moneda con `$` tenue al centro y check-badge en
  esquina superior derecha. Diferencia visualmente "ahorro" del icono
  existente `ic-cost-anomaly` (que comunica problema, no logro).

Ambos íconos siguen las convenciones del sprite:
- ViewBox 24×24, `stroke="currentColor"`, `stroke-width="1.6/1.75"`,
  outline coherente con el resto.
- Sin scripts, sin hrefs externos.
- Sin `<title>` propio (el `aria-label` del contexto manda).

## Mapeo CA → elemento visual

| CA del issue | Elemento del mockup | Ubicación |
|---|---|---|
| CA-C1 (telemetría sin contenido) | KPI 4 + banda de auditoría | top-right + bottom |
| CA-C2 (widget hit rate + ahorro USD/mes + tendencia 7d + actualización 30s) | KPI 1, KPI 2 + sparkline | row 1 + chart panel |
| CA-C2 ("% invocaciones con handoff válido vs fallback") | KPI 3 (desglose verde/ámbar) | row 1, slot 3 |
| CA-A3 (append-only por skill) | columna "secciones" en top issues | tabla derecha |
| CA-A5 (validez temporal) | evento `FALLBACK` en auditoría | banda inferior |
| CA-B1 (sanitización prompt-injection) | KPI 4 ("0 prompt-injection detectado") | row 1, slot 4 |
| CA-B3 (filtrado de secrets/PII) | "2 secrets redactados" en KPI 4 + evento `REDACTED` | row 1 + bottom |
| CA-B6 (sección truncada por tamaño) | "1 sección truncada (10kb)" en KPI 4 | row 1, slot 4 |
| CA-B7 (kill-switch + auditoría) | pill del header + banda de auditoría | top-right + bottom |
| CA-D1 (flag enabled/disabled) | pill `handoff: activo` | header |

## Accesibilidad

- **Contraste verificado** sobre `--surface-0` (`#0D1117`) y
  `--surface-1` (`#161B22`):
  - Texto primario `--text-primary` (`#E6EDF3`): 14.8:1 (AAA)
  - Texto secundario `--text-secondary` (`#B1BAC4`): 9.7:1 (AAA)
  - Texto dim `--text-dim` (`#8B949E`): 5.3:1 (AA)
- **Información nunca solo por color**: cada estado lleva ícono
  (`ic-handoff`, `ic-tokens-saved`, `ic-health-ok`, `ic-health-warn`) +
  texto.
- **Touch targets**: chips de filtro (≥30 px), CTA "Ver listado completo"
  (40 px) cumplen WCAG 2.5.5.
- **Foco visible**: pendiente para implementación — usar `--info` con
  outline 2 px y radio 4 px.

## No-goals visuales

- **No se diseña una página standalone para el handoff.** Se inserta como
  sub-sección de `/consumo` reutilizando layout y header.
- **No se introducen nuevos tonos de marca.** El acento `--teal` ya existe
  en los design-tokens.
- **No se diseñan estados loading/empty distintos** — heredan los patrones
  del dashboard (skeleton + texto neutro). Si la implementación encuentra
  un caso especial, `/ux` puede iterar en fase `validacion`.
- **No se afecta UX del producto al usuario final** (cliente / negocio /
  delivery). El widget es interno del equipo Intrale, accesible solo desde
  el dashboard `localhost` del pipeline V3.

## Archivos entregados

| Path | Tipo | Descripción |
|---|---|---|
| `.pipeline/assets/mockups/09-handoff-widget.svg` | SVG (1440×900) | Mockup del widget integrado al dashboard |
| `.pipeline/assets/icons/sprite.svg` | SVG sprite (extendido) | Agrega `<symbol id="ic-handoff">` y `<symbol id="ic-tokens-saved">` |
| `.pipeline/assets/mockups/narrativa-handoff-widget.md` | Markdown | Esta narrativa |

## Para los devs (pipeline-dev / android-dev)

1. **Sumar el widget a `dashboard.js`** consumiendo los tokens existentes
   (`var(--teal)`, `var(--surface-1)`, etc).
2. **Referenciar los íconos del sprite** con
   `<svg aria-label="Handoff cross-agente"><use href="#ic-handoff" /></svg>`.
3. **Endpoint**: `/api/handoff-metrics` (CA-C2). Reusar `metrics-history.jsonl`
   que ya escribe `lib/traceability.js` — NO crear `cache-metrics.jsonl`
   (deuda evitable, ya advertida por guru en fase analisis).
4. **Auto-refresh**: 30 s (CA-C2 "Actualización en tiempo real cada 30s").
   Reusar el patrón SSE/polling ya existente en el dashboard de consumo.
5. **Kill-switch UI**: el pill del header debe enviar `POST` al endpoint del
   commander para activar/desactivar la flag — sin tocar `config.yaml`
   directamente desde el browser.
