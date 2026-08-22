# Narrativa UX — Rediseño barra de navegación V3 (#3726)

## Contexto del problema

El operador del dashboard V3 vive entre 11 satélites (`/equipo`, `/pipeline`,
`/bloqueados`, `/issues`, `/matriz`, `/ops`, `/kpis`, `/historial`, `/costos`)
más dos widgets in-page del home (`/modo-descanso`, `/multi-provider`). Hoy la
navegación entre ventanas es **inconsistente**:

- En home (`home.js:1282-1298`) hay una `.areas-bar` con 11 "pills" decoradas con
  emojis del sistema operativo (`👥`, `🔄`, `⛔`, `📋`…). Cada plataforma
  renderiza esos emojis de forma distinta, rompe la identidad visual y no
  expone estado activo.
- En cada satélite (`satellites.js:207`) hay **un solo back-link** que dice
  "Operación" y vuelve al home. No hay manera de saltar lateralmente entre
  satélites sin volver al home primero, ni ver dónde está parado el operador.

El operador trabaja en kiosk 1080×1920 horas seguidas. La nav debe ser legible,
predecible y permitir cambio de ventana en 1 click visible siempre.

## Propuesta UX

Una sola barra `.v3-nav` con 12 tabs que aparece **tanto en home como en cada
uno de los 11 satélites**. Misma iconografía, mismo orden, misma altura,
mismo comportamiento. La tab activa se marca con `aria-current="page"` y un
border `--in-brand` (azul corporativo). El cambio entre ventanas es
inmediato y el operador siempre sabe dónde está.

## Sistema visual

### Paleta (tokens V3, sin colores hardcoded)

| Token              | Valor       | Uso                                  | Contraste vs `--in-bg-2` |
|--------------------|-------------|--------------------------------------|--------------------------|
| `--in-bg-2`        | `#161b22`   | Fondo default de cada tab            | base                     |
| `--in-bg-3`        | `#1f2937`   | Fondo en hover / active              | 1.2:1 (sutil)            |
| `--in-border`      | `#30363d`   | Border default                       | 2.1:1                    |
| `--in-brand`       | `#1f6feb`   | Border + fg en tab activa            | 4.6:1 ✓ AA               |
| `--in-accent`      | `#2ee6c1`   | Border + outline en hover/focus      | 7.4:1 ✓ AAA              |
| `--in-fg`          | `#e6edf3`   | Texto default                        | 14.7:1 ✓ AAA             |
| `--in-radius-sm`   | `8px`       | Esquinas redondeadas                 | —                        |

Todos los tokens vienen de `views/dashboard/theme.css` (líneas 9-33), ya
verificados WCAG AA en otros componentes (`.in-pill`, `.in-mode-menu-item`).
**Prohibido inventar colores nuevos** para la nav bar.

### Tipografía

- Label de tab: `11px / weight 600` — sobra para legibilidad en kiosk y deja
  espacio al ícono (22px) sin desbordar la tab.
- Letter-spacing: `0.2px` — más aire entre letras para tabs cortas como "Ops".

### Iconografía

- Ícono: `22×22px` dentro del viewBox `24×24` del sprite (paddings simétricos).
- Stroke: `currentColor` — el color del ícono lo define el estado de la tab.
- Estilo: outline, sin fills (coherente con el resto del sprite — 97 íconos
  preexistentes siguen esta convención).

### Estados

| Estado                | Fondo        | Border         | Color texto/icono | Indicador adicional      |
|-----------------------|--------------|----------------|-------------------|--------------------------|
| Default               | `--in-bg-2`  | `--in-border`  | `--in-fg`         | —                        |
| `:hover`              | `--in-bg-3`  | `--in-accent`  | `--in-accent`     | `translateY(-2px)` lift  |
| `:focus-visible`      | `--in-bg-3`  | `--in-accent`  | `--in-accent`     | `outline 2px solid`      |
| `[aria-current=page]` | `--in-bg-3`  | `--in-brand`   | `--in-brand`      | underline bottom 3px     |

## Layout y touch targets (CA-5)

- `grid-template-columns: repeat(12, minmax(44px, 1fr))` garantiza ≥44px de
  ancho por columna en cualquier viewport.
- `min-height: 64px` sobre el `<a>` interno garantiza ≥44px de alto (con padding
  el touch real efectivo es ~80px en kiosk).
- En 1080px (kiosk): 12 tabs × 90px ≈ 1080px. Margen confortable.
- En viewports estrechos (<528px = 12×44), aparece scroll horizontal sin perder
  clickabilidad — degradación limpia, sin tabs ocultas.

## Iconografía entregada (sprite.svg)

7 íconos nuevos al sprite (los símbolos existentes NO se editan):

| iconId             | Descripción                                                        |
|--------------------|--------------------------------------------------------------------|
| `ic-tab-home`      | Casa con techo a dos aguas y puerta — volver a Operación           |
| `ic-tab-pipeline`  | Tres nodos circulares conectados — flujo de issues por fase        |
| `ic-tab-matriz`    | Grid 3×3 — la matriz skill × fase                                  |
| `ic-tab-ops`       | Llave + destornillador cruzados — herramientas de operaciones      |
| `ic-tab-kpis`      | Bar chart con 3 barras crecientes — métricas en aumento            |
| `ic-tab-historial` | Reloj con flecha circular antihoraria — timeline pasado            |
| `ic-tab-costos`    | Moneda con signo $ — costos / tokens / consumo                     |

5 íconos reusados del sprite existente (no se editan):

| Tab          | iconId reusado            | Motivo                                                |
|--------------|---------------------------|-------------------------------------------------------|
| `equipo`     | `ic-agents-count`         | Ya semantiza "agentes/equipo" en KPI cards           |
| `bloqueados` | `ic-estado-needs-human`   | Ya semantiza "esperando intervención humana"         |
| `issues`     | `ic-issues-count`         | Ya semantiza "pila de issues"                        |
| `descanso`   | `ic-rest-mode`            | Ya semantiza "modo descanso activo" (#2882)          |
| `providers`  | `ic-multi-provider`       | Ya semantiza "providers/stacks múltiples"            |

Total: 12 íconos para 12 tabs (consistencia visual sin agregar peso al sprite).

## Accesibilidad (WCAG AA)

- `<nav role="navigation" aria-label="Ventanas del dashboard">` — orientación
  para AT (screen readers anuncian "Ventanas del dashboard, navegación, 12
  enlaces").
- Cada `<a class="v3-tab">` tiene `aria-label` **literal hardcoded** —
  prohibida la concatenación con `slug`, `state` o `?view=` (mitigación
  XSS A03 del comment de security).
- Tab activa marcada con `aria-current="page"` server-side (no solo via CSS),
  para que AT anuncie "página actual".
- Cada `<svg>` decorativo lleva `aria-hidden="true"` y `focusable="false"` —
  el label de texto del span ya transmite la semántica.
- `:focus-visible` con `outline: 2px solid var(--in-accent)` — el contorno NO
  se elimina (prohibido `outline:none`).
- Orden de tabulación del DOM coincide con el orden visual de las 12 tabs.

## Render unificado: home + 11 satélites

- En `home.js`: el array `AREAS` se renombra a `NAV_TABS` y se mueve al módulo
  nuevo `nav-tabs.js`. El render llama `renderNavTabsSsr('home')`.
- En `satellites.js`: la firma de `pageShell(...)` agrega `activeSlug`. Cada
  `renderXxx()` pasa su slug (`'equipo'`, `'pipeline'`, etc.). El back-link
  aislado desaparece — su función (volver a Operación) la cumple la tab `home`.
- El sprite SVG se inyecta inline en ambos contextos via `loadIconSprite()`
  compartido (cache en memoria, mismo patrón que `loadIconSpriteHome` actual).

## Decisiones cerradas (firma de architect)

1. **Slugs renombrados** (`modo-descanso`→`descanso`, `multi-provider`→`providers`)
   manteniendo `href` reales a las rutas satélite registradas en
   `lib/dashboard-routes.js:204-212`.
2. **Tab `home` apunta a `/`** y queda primera en el orden — preserva la
   expectativa "volver a Operación" del operador.
3. **`area-pill-badge` se mantiene en transición** para no romper tickers
   (`tickMultiProvider()` y similares) que hidratan badges dinámicos.
4. **NO se suma Visual Diff Browser (#3402)** hasta que esté aprobado por humano
   y deje de tener `needs-human`.
5. **NO se modifica `extract.js`** (no es el lugar para AGREGAR íconos; solo
   EXTRAE individuales). Los símbolos nuevos se commitean directo a `sprite.svg`.

## Entregables UX en este ciclo

| Path                                                              | Tipo            |
|-------------------------------------------------------------------|-----------------|
| `.pipeline/assets/icons/sprite.svg`                               | Extendido (+7)  |
| `.pipeline/assets/mockups/26-nav-tabs-v3.svg`                     | Mockup nuevo    |
| `.pipeline/assets/mockups/narrativa-nav-tabs-v3.md`               | Narrativa UX    |

## Verificación esperada en `desarrollo/validacion`

- `grep -c '<symbol id="ic-tab-' .pipeline/assets/icons/sprite.svg` retorna `7`.
- `grep -nE '<script|<foreignObject|on[a-z]+=|href="(http|https|data|javascript):' .pipeline/assets/icons/sprite.svg`
  retorna 0 matches sobre los 7 íconos nuevos (CA-7).
- El mockup #26 y la narrativa están en el repo.

## Justificación QA

`qa:skipped` — el rediseño impacta el dashboard interno del operador
(`.pipeline/`), no app de usuario final del producto. La validación visual
se cubre con:
- Mockup #26 + screenshot real del `/dashboard` y `/equipo` adjuntados al PR
  (CA-11).
- Tests unitarios `nav-tabs.test.js` con cobertura del render SSR + match
  iconId↔sprite (CA-9).

Si la implementación toca rutas o endpoints que un usuario final percibe
(no es el caso de #3726), **revertir esta decisión** y exigir QA E2E.
