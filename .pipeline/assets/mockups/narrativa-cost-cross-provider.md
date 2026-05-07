# Narrativa visual — Comparativa cross-provider de costos (#3090)

> Asset producido por el agente `ux` durante la fase `definicion/criterios` del pipeline V3.
> Este documento es la fuente de verdad para el dev: explica QUÉ se ve, CÓMO se compone y
> POR QUÉ está así. El mockup acompañante es `11-cost-cross-provider.svg`.

## Contexto

El usuario del dashboard (Leo) necesita responder dos preguntas:

1. ¿Cuál es el costo real de cada skill cuando corre con un proveedor distinto?
2. ¿Algún switch reciente disparó un costo inesperado (>+30% sobre baseline)?

Esta vista vive dentro del tab **Consumo** del dashboard V3 (`/consumo`), debajo de la
sección "Por skill" existente, como un módulo nuevo titulado **Comparativa cross-provider**.

## Arquitectura visual del módulo

### 1. Encabezado
- Breadcrumb: `Dashboard › Consumo › Cross-provider`.
- Título grande (`26px / 700`): "Comparativa cross-provider".
- Subtítulo (`14px / regular`): ventana, fechas, umbral configurado y debounce activo.
  Toda configuración mostrada es **read-only**: viene de `config.yaml` commiteado
  (decisión de seguridad §7 del análisis). NO existe selector mutable en UI.

### 2. Pill de estado en header (top)
Pill rosa-rojo `--alert-anomaly` (`#FF6B8A`) en el header global cuando hay spike activo.
Texto: `SPIKE CROSS-PROVIDER · <skill> · +<delta>%`. Deep-link al banner persistente.
Cuando no hay spike, este pill **no se renderiza** (no ocupa espacio).

Reusa el mismo patrón del mockup 06 (cost-anomaly): combinación color + icono + texto,
nunca solo color (R2 review de seguridad).

### 3. Banner persistente de spike (cuando aplica)
Un banner full-width debajo del título cuando el detector cross-provider levantó alerta:

- Borde izquierdo `4px` `--alert-anomaly` (separador visual).
- Icono `ic-cost-anomaly` del sprite (no requiere ícono nuevo).
- Texto principal: `Spike post-switch detectado en <skill> después de cambiar de
  <provider-from> a <provider-to>` — los nombres de provider rendean con su color
  identitario de §3.c PROVIDERS (`copper` para Anthropic, `emerald` para OpenAI,
  `deep-emerald` para Codex).
- Línea secundaria: promedio post-switch, baseline pre-switch, delta vs umbral.
- Línea terciaria: hasta 3 issues responsables (links `#XXXX` color `--info`).
- Acciones: "Ver issue origen" (drill-down) + "Silenciar 24h" (snooze por
  `(skill, provider)` con cap 24h hardcoded — ver `feedback_status-audio.md`
  para el patrón).

### 4. Tabla principal (skill × provider × ventana 7d)
La tabla agrupa filas por skill (la primera fila del skill marca su nombre, las
adicionales del mismo skill arrancan con `↳` para indicar subordinación visual).

**Columnas (left to right):**
1. **Skill**: avatar circular con inicial + nombre. Junto a él, badge pill
   `✓ MULTI-PROVIDER` color `--teal` cuando hay ≥2 providers en la ventana.
2. **Badge skill no-degradable**: pill `FIJA` color `--rest-mode` (`#7C5CFF` indigo)
   con icono de candado para `security`, `review`, `builder`, `tester`. Doc multi-provider
   §6.11. Si una skill `FIJA` aparece con un switch, severidad de la alerta es alta
   automática (ver §5 abajo).
3. **Provider**: pill con color identitario, ícono del sprite y nombre. Si la fila
   pertenece al provider actual del skill (más reciente) y hubo cambio, se anota
   `pre-switch` o `+X%` en gris secundario al lado.
4. **Modelo**: nombre técnico monoespaciado (`SF Mono`) en `--text-secondary`.
5. **Sesiones**: cantidad numérica monoespaciada, alineada a la derecha.
6. **Costo 7d**: USD con 2 decimales, monoespaciado, alineado derecha. Si hay alerta
   activa para este (skill, provider), el número rendea en `--alert-anomaly-fg`
   (`#FFD2DC`).
7. **% Share**: porcentaje monoespaciado + mini-barra `40×6px` de progreso usando el
   color del provider de la fila (sumatoria por skill).

**Filas con spike**: fondo `rgba(255, 107, 138, 0.06)` y barra izquierda `3px` rojo,
sutil pero distinguible. El badge del provider lleva sufijo `+X% ⚠`.

**Footer de tabla**: fila resumen con totales (sesiones y costo) en `--surface-2`.

### 5. Severidad de la alerta cuando un skill no-degradable cambia

Pregunta explícita levantada por Guru en el análisis técnico para que PO defina:

> Si `security`/`review`/`builder`/`tester` cambian de provider, ¿alerta priority alta
> + bloqueo? ¿O solo alerta informativa?

**Recomendación UX**: alerta de severidad alta con label `needs-human` automático en
el evento, ya que estos skills tienen contrato de calidad fija (doc §6.11). El badge
`FIJA` indigo se usa también en el mensaje Telegram para que Leo distinga "es solo
costo" vs "es contrato roto".

### 6. Mensaje Telegram (panel derecho)
Mock fiel del mensaje que dispara `lib/cost-cross-provider-alert.js`. Items obligatorios:

- Header: `⚠ Spike post-switch cross-provider`.
- Skill (escapado por `escapeMdV2()` — issue #3112 hardening relacionado).
- Cambio: `<provider-from> → <provider-to>` con colores identitarios.
- Baseline + actual + delta vs umbral.
- Sección DRILL-DOWN con links a GitHub (NO al dashboard local, NO con `session_id`):
  `github.com/intrale/platform/issues/<n>`. Decisión de seguridad §6.10.
- Indicador de debounce activo en cursiva: `Silenciado durante 60 min por (qa, openai-codex)`.

**Prohibido** en el mensaje:
- Headers de respuesta del provider (filtrados por whitelist de telemetría #3113).
- Payloads de prompt o respuesta del modelo.
- `session_id` o cualquier identificador interno.

### 7. Histórico de switches (panel derecho, abajo)
Lista compacta (3 filas máximo, scroll vertical para más) de switches en la ventana.
Cada fila lleva color de borde según severidad:
- Rojo `--alert-anomaly` para spike sobre umbral.
- Verde `--success` para switches dentro de tolerancia.
- Azul `--info` para switches con delta neutro o reducción de costo.

Cada fila muestra: skill, fecha+hora, `from → to`, delta porcentual.

## Estados degradados (cuando dependencias no están listas)

### Sin S5 (#3083) — sin campo `provider` en `session:end`
La vista renderea con badge global ámbar `--warning` arriba del título:
`⚠ Datos incompletos — esperando #3083 (campo provider en session:end)`.
La tabla muestra todas las filas con provider `unknown` (color `--warning`,
ícono `ic-provider-unknown`). El detector NO dispara alertas en este estado
(prevalidación: si todos los datos son `unknown`, no hay baseline confiable).

### Sin H3 (#3075) — sin segundo provider corriendo
La tabla degenera a 1 columna por skill. Banner informativo arriba del título:
`ℹ 1 provider activo · datos completos cuando #3075 (adaptador OpenAI/Codex) cierre`.
Sin alerta posible (no hay deltas que medir). El módulo igual se renderiza para
validar el contrato visual contra datos reales.

## Tokens y assets reusados

**100% reuso del sistema visual existente** — esta historia NO requiere íconos nuevos:

- `design-tokens.css` §3.c PROVIDERS (anthropic copper, openai emerald, codex deep emerald,
  deterministic, unknown).
- `design-tokens.css` §3.b semánticos de operación (`--alert-anomaly`, `--rest-mode`).
- `icons/sprite.svg`:
  - `ic-provider-anthropic`, `ic-provider-openai`, `ic-provider-openai-codex`,
    `ic-provider-deterministic`, `ic-provider-unknown` (ya creados en #3086).
  - `ic-cost-anomaly` (ya existente, reusado del mockup 06).
  - `ic-snooze` (ya existente).

## Accesibilidad — checklist verificado

- [x] Contraste WCAG AA en cada combinación color+texto (provider × bg).
- [x] Información nunca solo por color: cada celda combina ícono + texto + color.
- [x] `aria-label` explícito en cada badge multi-provider y badge `FIJA`.
- [x] `prefers-reduced-motion` respetado: sin animaciones pulsantes, solo focus-ring
  estático en interactivos.
- [x] Touch targets mínimo 32px (botones de drill-down 36px alto).

## Seguridad — checklist verificado (alineado con análisis security #3090)

- [x] Threshold solo via `config.yaml` commiteado, sin endpoint mutable.
- [x] Drill-down a GitHub público + `localhost:<PORT>` opcional. Nunca `session_id` en URL externa.
- [x] Mensajes Telegram pasan por `escapeMdV2()` (hardening #3112).
- [x] Cost telemetry con whitelist de campos (hardening #3113).
- [x] Debounce visual `60min` por `(skill, provider)` para prevenir tormenta.
- [x] Ningún payload de prompt/respuesta del provider en preview ni alerta.

## Para el dev (handoff)

**Archivos del repo que deben cambiar** (no toca el UX, lo lista para el dev):

- `views/dashboard/satellites.js` — extender `renderCostos()` con sección nueva
  posicionada debajo de "Por skill", consumiendo el snapshot `crossProvider`
  diseñado por Guru en el análisis técnico (§4.2).
- `dashboard.js` — agregar endpoint `GET /api/dash/cost/cross-provider` que
  devuelva `snapshot.crossProvider` con binding `localhost:*` (sin auth, mismo
  patrón que el resto del dashboard).
- `lib/cost-cross-provider-alert.js` (nuevo) — formateador + sender + debounce.
  Reusa el patrón de `lib/cost-anomaly-alert.js` (sanitize + redact + queue).
- `metrics/aggregator.js` — agregar bucket `crossProvider` al snapshot
  con la estructura definida en el análisis técnico §4.2.
- `config.yaml` — sección nueva `cost_cross_provider` (defaults en §4.6 del análisis).

**Archivos del UX que el dev NO debe modificar**:
- `.pipeline/assets/mockups/11-cost-cross-provider.svg` (este mockup).
- `.pipeline/assets/mockups/narrativa-cost-cross-provider.md` (este documento).
- `.pipeline/assets/design-tokens.css` (sistema visual común).

**Tests visuales que el dev debe agregar**:
- Render con dataset multi-provider real (qa con anthropic + codex).
- Render con dataset 1-provider (estado degradado sin H3 #3075).
- Render con dataset vacío (estado degradado sin S5 #3083).
- Render con spike activo (banner + pill + fila resaltada).
- Render con skill no-degradable cambiando de provider (badge FIJA + alerta alta).
- Verificación que `escapeMdV2()` aplicó correctamente en mensaje Telegram con
  strings hostiles (`_`, `*`, `[`, `]`, etc.).
