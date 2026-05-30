# Narrativa visual — Mockup 26 · Dashboard main V3 (#3725)

Documento descriptivo del rediseño main del dashboard. Acompaña al mockup
`26-dashboard-main-v3.svg`. Sirve de referencia visual para el dev al
implementar las 6 sub-funciones del refactor (`renderBrandBar`,
`renderControlBar`, `renderInfraHealth`, `renderKpiGrid`, `renderQueueDetailed`,
`renderSystemCard`).

## Filosofía del rediseño

El dashboard V3 es un **kiosk operativo en loopback**. La pantalla principal
debe responder a tres preguntas en el primer vistazo:

1. **¿Cómo está la plataforma?** — brand bar + build status + infra health.
2. **¿Qué está pasando ahora?** — control bar (modos/ventanas activas) +
   KPIs de últimas 24h/7d + cola de issues en curso.
3. **¿Cómo está el host?** — system card con recursos (CPU/RAM/Disk/Uptime).

Cada respuesta se cubre con una sub-función pura, sin que ninguna lea
filesystem o red: el caller compone el `state` saneado y se lo pasa.

## Jerarquía visual y rails de identidad

Cada sub-sección tiene un **rail vertical de 3px** que codifica su rol
operativo y refuerza la jerarquía sin agregar peso visual:

| Sección          | Rail color           | Token                  | Significado                                       |
|------------------|----------------------|------------------------|---------------------------------------------------|
| Brand bar        | gradient brand       | `--brand-cyan→--brand-blue` | Identidad de marca + estado app           |
| Control bar      | azul info            | `--info` (#58A6FF)     | Acciones operativas                              |
| Infra health     | verde success        | `--success` (#3FB950)  | Salud agregada UP — cambia a `--danger` si DOWN  |
| KPI grid         | purple definición    | `--purple` (#BC8CFF)   | Métricas / análisis                              |
| Queue detailed   | warning              | `--warning` (#D29922)  | Atención (cola → trabajo pendiente)              |
| System card      | teal                 | `--teal` (#2DD4BF)     | Recursos del host                                |

Esta convención es coherente con `--lane-*` tokens existentes y permite que
el operador identifique la sección de un vistazo sin leer el título.

## Decisiones congeladas en el mockup

### R-G2 — Qué KPIs viven en main vs ventana `kpis`

**Main (5 KPIs):**

1. **PRs mergeados · 7d** — pulso de entrega. Color `--success` cuando ↑ vs 7d previos.
2. **Tokens · 24h (todos providers)** — costo agregado del día. Color `--info`.
3. **% Rebote · 7d** — calidad. Color `--warning` (delta vs período previo en pp).
4. **Cola size · actual** — backlog inmediato. Color `--retry` cuando >5.
5. **Duración mediana por agente · 24h** — latencia del pipeline. Color `--teal`.

**Ventana `kpis` (deep dive, NO main):**

- Costo USD · 7d (no para kiosk operativo — vista financiera).
- Coverage multi-provider (vive en widget `multi-provider-coverage`).
- Breakdown p50/p95/p99 por skill.
- Series temporales 30d.

### R-G3 — System card vs pill `#hdr-resources`

Coexisten con **un solo endpoint** `/api/resources`. La pill compacta
(`CPU 42% · RAM 78%`) vive en la control bar como atajo de un vistazo.
La system card expandida abajo del main agrega Disk y Uptime para
contexto operacional. NO se hace doble polling: ambos consumen del mismo
endpoint.

### R-G4 — Build status del header

Lee marker local `.pipeline/build-status.json` escrito por `/builder`
(recomendación futura #3756). Si el marker no existe, muestra `unknown`
sin romper. **PROHIBIDO** invocar `gh api` desde el dashboard — la
latencia adicional + el cache TTL inverso degradaría el render.

### R-G5 — Control bar: pausa parcial inline vs wizard

Preserva el **menú inline actual** de pausa parcial pero agrega atributo
`data-view-link="wizard/partial-pause"` como hook al futuro wizard
(#3741/#3742). Esto permite mergear #3725 sin bloquear ni a #3741 ni a
#3742, y la transición al wizard es un cambio de un atributo cuando esté
listo.

### R-G1 — IDs DOM ↔ `renderClientScript`

El mockup nombra los grupos SVG con los IDs que el HTML real debe emitir:
`brand-bar`, `control-bar`, `infra-health`, `kpi-grid`, `queue-detailed`,
`system-card`, `view-content-boundary`. El snapshot test (#3755 futuro)
enumera estos IDs y valida 1:1 contra `document.getElementById(...)` de
`renderClientScript`. Si alguien añade un `id="..."` huérfano o borra uno
usado por el script, falla CI.

## Accesibilidad (CA-3725.11 + CA-E1..E4)

- **Contraste**: todos los colores de texto y status fueron verificados
  contra `--surface-0` (#0D1117) con WebAIM Contrast Checker. Texto
  normal ≥ 4.5:1, iconos/badges ≥ 3:1. Tabla completa en
  `docs/pipeline/design-system.md` sección "Accesibilidad".
- **Focus visible**: cada acción operativa (pill clickeable, toggle,
  fila de cola) debe heredar el token `--focus-ring` cuando recibe foco
  por teclado.
- **aria-label** en pills sin texto visible (ej. badge `V3`, badge
  `PROD · LOOPBACK`, dot de status).
- **Navegación por teclado**: orden tab DEBE ser brand → control bar
  pills (izq→der) → infra-health dots → KPI cards → queue rows → system
  card. NO usar `tabindex="-1"` en acciones operativas.
- **prefers-reduced-motion**: el token `--motion-fast` se respeta. Los
  skeleton rows del queue NO animan con `prefers-reduced-motion: reduce`.
- **prefers-contrast: more**: los bordes y texto secundario se fortifican
  vía media query ya definida en `design-tokens.css`.

## Seguridad — disclaimer obligatorio (CA-3725.12)

El dashboard asume **binding loopback sin auth/CSRF**. Los toggles de la
control bar mutan estado del pipeline sin token de operador. Esto es
aceptable para kiosk en máquina dedicada — pero DEBE estar documentado
explícitamente en `docs/pipeline/dashboard-v3-inventory.md` como
disclaimer de OWASP A01. Si en el futuro se expone fuera de loopback,
agregar CSP estricta + audit log + CSRF (issues independientes — ver
recomendaciones de `/security` en el body del issue).

## Sprite icons — referencias

Todos los iconos del mockup usan IDs que existen en
`.pipeline/assets/icons/sprite.svg`. NO se introduce ningún icono nuevo.

| Pieza            | Icono sugerido          | ID en sprite                |
|------------------|-------------------------|-----------------------------|
| Brand bar logo   | Triángulo Intrale       | `ic-intrale-logo`           |
| Build status OK  | Check (heredado)        | `ic-health-ok`              |
| QA pill          | Lupa fase verificación  | `ic-fase-verificacion`      |
| Build pill       | Caja apilada            | `ic-fase-build`             |
| Rest mode        | Luna nocturna           | (texto + emoji 🌙 fallback) |
| Partial pause    | Pausa + candado         | `ic-estado-partial-pause`   |
| Refresh          | Flecha circular         | (texto ↻ fallback)          |
| Theme            | Sol/luna alternado      | (texto 🌗 fallback)          |
| Agentes activos  | Contador                | `ic-agents-count`           |
| Cola             | Contador issues         | `ic-issues-count`           |
| Skeleton row     | (sin icono)             | —                           |

## Renderización por sub-función

### `renderBrandBar(state)`
- **Input**: `{ env, buildStatus: {status, commit_short, age_min}, clock }`
- **Output**: HTML string del bloque header con logo, título, badge V3,
  badge ambiente, build status pill, reloj.
- **Guarda**: si `buildStatus` falta, pill muestra `unknown` (no rompe).
- **Tooltips**: badge ambiente con `title="Binding loopback · sin auth"`,
  build pill con `title="Build status leído de marker local — CA-3725.1"`.

### `renderControlBar(state)`
- **Input**: `{ pills: [{id, kind, label, value, tip}], counts: {agents_active} }`
- **Output**: HTML string con los pills/toggles agrupados.
- **Cada pill** lleva `title=` y `aria-label=` con tooltip explicando el
  efecto. Strings dinámicos pasan por `escapeAttr()` (CA-3725.10).
- **Pausa parcial**: agregar atributo `data-view-link="wizard/partial-pause"`
  para hookear al wizard futuro sin romper la transición.

### `renderInfraHealth(state)`
- **Input**: `{ services: [{name, status: "UP"|"DOWN", last_ping_iso}] }`
- **Output**: HTML con 3 servicios (pulpo, dashboard, telegram_bot) +
  badge agregado.
- **PROHIBIDO**: emitir token, chat_id, paths internos o el objeto de
  configuración del bot. Tests SSR deben grep-rechazar esos strings.

### `renderKpiGrid(state)`
- **Input**: `{ kpis: [{id, label, value, unit, delta, period}] }`
- **Output**: HTML con grid de 5 cards (192×124 c/u, gap 12).
- **Tokens**: cada card usa `--surface-2` (#1C2128) sobre el panel
  `--surface-1`, con el color del valor según semántica (success/info/
  warning/retry/teal).

### `renderQueueDetailed(state)`
- **Input**: `{ items: [{issue, title, phase, skill, waiting_human, age_s}] }`
- **Output**: HTML con filas reusando `renderLineRow` + esqueletos
  `renderWaveRowSkeleton` para slots libres (DOM morphing anti-flicker).
- **Títulos**: pasan por `escapeHtml()` (vienen de GitHub, atacante-
  controlables — un title puede llevar `<img onerror>`).
- **Scroll interno**: `max-height: 800px` con `overflow-y: auto` cuando
  hay más de 16 items.

### `renderSystemCard(state)`
- **Input**: `{ resources: {cpu_pct, mem_pct, disk_pct, uptime_s} }`
- **Output**: HTML con 4 mini-cards (CPU/RAM/Disk con gauge circular,
  Uptime con valor textual).
- **PROHIBIDO** emitir `os.hostname()`, `process.cwd()`, `os.userInfo()`,
  cualquier path absoluto, `process.env.*`. Tests SSR + grep deben
  rechazar el payload si aparece alguno.
- **Color del gauge**: success ≤ 60%, warning 61-85%, danger > 85%.

## Compatibilidad con QA / screenshot

`.pipeline/lib/screenshot-capture.js` ya tiene `/dashboard` en
`ALLOWED_PATHS`. El screenshot para el PR (CA-3725.15) debe usar
viewport **1080×1920** matching el `kiosk-frame`:

```js
await puppeteer.launch({
  defaultViewport: { width: 1080, height: 1920 }
});
```

El mockup adjunto y el screenshot real comparten resolución, lo que
permite comparación pixel-cercana lado a lado en el body del PR.

## Tokens reusados (CA-F1..F4)

NINGÚN color, fuente, radio o espaciado nuevo se introduce. Todos
provienen de `.pipeline/assets/design-tokens.css`:

- **Colores**: `--brand-cyan`, `--brand-blue`, `--surface-0/1/2`,
  `--border`, `--border-subtle`, `--text-primary/secondary/dim/disabled`,
  `--success`, `--warning`, `--danger`, `--info`, `--purple`, `--teal`,
  `--retry`.
- **Tipografía**: `--font-sans` (system stack), `--font-mono` para issue
  IDs y commit hash, escala `--fs-xs/sm/md/lg/xl/2xl`.
- **Espaciado**: `--space-2/3/4/6` en gap interno y padding.
- **Radios**: `--radius-md` (cards/secciones), `--radius-xl` (pills).
- **Sombras**: `--shadow-md` en hover de KPI cards (definido por theme,
  no se ve en SVG estático).
- **Focus**: `--focus-ring` heredado.

## Próximos pasos para el dev (referencia rápida)

1. Verificar #3722 y #3723 mergeados en `origin/main` (CA-3725.17).
2. Importar `escapeHtml` + `escapeAttr` desde `lib/escape-html.js`.
3. Extraer las 6 sub-funciones de `renderHomeHTML` preservando boundary
   `<main id="view-content">`.
4. Eliminar `escapeHtmlSsr` inline heredado (CA-3725.9).
5. Tooltips con `escapeAttr()` en cada `title=` / `aria-label=`.
6. Snapshot test de IDs DOM ↔ `renderClientScript` (R-G1).
7. Tests SSR + XSS body/atributo (CA-3725.13), cobertura ≥ 80%.
8. Adjuntar al PR: este mockup + screenshot Puppeteer @ 1080×1920 +
   comparación lado a lado.
9. Actualizar `docs/pipeline/dashboard-v3-inventory.md` con decisiones
   R-G2/R-G3/R-G4/R-G5 + disclaimer loopback (CA-3725.12, CA-3725.16).
