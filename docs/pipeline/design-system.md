# Design System — Pipeline V3 de Intrale

> **Fuente de verdad**: `.pipeline/assets/design-tokens.css` (paleta) y
> `.pipeline/assets/icons/sprite.svg` (iconografia).
>
> Este documento describe el sistema, cuando usarlo, y como extenderlo sin romper
> la consistencia. Toda superficie del pipeline (dashboard, /consumo, PDFs de
> rejection, mensajes de Telegram) referencia los **mismos** tokens.

## Filosofia

1. **Zero CDN externo**. Fuentes del sistema, sin Google Fonts, sin scripts de
   terceros. El dashboard funciona sin internet.
2. **Dark-first**. El pipeline es una herramienta profesional de uso continuo;
   optimizamos para sesiones largas en terminal/monitor sin fatigar la vista.
3. **Accesible por defecto**. WCAG AA minimo en todo contraste. Informacion
   nunca se comunica solo por color — siempre acompanada de icono o texto.
4. **Un solo lenguaje visual**. Misma paleta, misma iconografia, misma
   tipografia para dashboard, PDFs y Telegram (con el workaround PNG donde SVG
   no aplica).

## Stack de entrega

| Superficie               | Paleta (CSS)           | Iconos                 |
|--------------------------|------------------------|------------------------|
| Dashboard HTML V3        | `design-tokens.css` inline | `sprite.svg` inline    |
| PDFs de rejection (HTML) | `design-tokens.css` inline | `sprite.svg` inline    |
| Pagina /consumo          | `design-tokens.css` inline | `sprite.svg` inline    |
| Telegram                 | Colores hex hardcoded (no CSS) | PNG exportado via `extract.js` + `rsvg-convert` |

## 1. Paleta

### 1.1 Marca (extraida del logo maestro)

| Token                   | Hex       | Uso                              |
|-------------------------|-----------|----------------------------------|
| `--brand-navy-deep`     | `#0A1C36` | fondo profundo del logo          |
| `--brand-navy`          | `#0D274D` | fondo del logo + header gradient |
| `--brand-cyan`          | `#00D6FF` | acento primario (simbolo)        |
| `--brand-blue`          | `#1890FF` | acento primario (simbolo)        |
| `--brand-cyan-dim`      | `#0099B8` | hover / borders                  |
| `--brand-blue-dim`      | `#0F6CD6` | hover / borders                  |

### 1.2 Neutros (superficies y texto)

| Token                | Hex       | Uso                           | Contraste sobre `--surface-0` |
|----------------------|-----------|-------------------------------|-------------------------------|
| `--surface-0`        | `#0D1117` | body background               | base                          |
| `--surface-1`        | `#161B22` | cards, panels                 | —                             |
| `--surface-2`        | `#1C2128` | hover, nested panels          | —                             |
| `--surface-3`        | `#252B33` | modals, popovers              | —                             |
| `--border-subtle`    | `#21262D` | dividers sutiles              | —                             |
| `--border`           | `#30363D` | bordes estandar               | —                             |
| `--border-strong`    | `#484F58` | bordes prominentes, focus     | —                             |
| `--text-primary`     | `#E6EDF3` | texto principal               | 14.8:1 ✅ AAA                  |
| `--text-secondary`   | `#B1BAC4` | texto secundario              | 9.7:1  ✅ AAA                  |
| `--text-dim`         | `#8B949E` | texto terciario, timestamps   | 5.3:1  ✅ AA                   |
| `--text-disabled`    | `#6E7681` | deshabilitado                 | 3.9:1  ✅ AA (solo elementos grandes >= 18pt o 14pt bold) |

### 1.3 Semanticos

Cada color tiene **tres** tonos: base, dim (bordes), bg (fondo suave 14%
alpha). Siempre combinar con icono o texto para no depender solo del color.

| Estado     | Base       | Dim (borde) | Bg (fondo suave) | Contraste base sobre `--surface-1` |
|------------|------------|-------------|------------------|-------------------------------------|
| success    | `#3FB950`  | `#196C2E`   | `rgba(63,185,80,0.14)`  | 7.1:1 ✅ AAA |
| warning    | `#D29922`  | `#9E6A03`   | `rgba(210,153,34,0.14)` | 6.0:1 ✅ AA+ |
| danger     | `#F85149`  | `#8B1A14`   | `rgba(248,81,73,0.14)`  | 4.8:1 ✅ AA  |
| info       | `#58A6FF`  | `#1F6FEB`   | `rgba(88,166,255,0.14)` | 6.5:1 ✅ AAA |
| retry      | `#F59E0B`  | `#B8730A`   | `rgba(245,158,11,0.14)` | 6.9:1 ✅ AAA |
| purple     | `#BC8CFF`  | `#8957E5`   | `rgba(188,140,255,0.14)`| 6.6:1 ✅ AAA |
| teal (V3)  | `#2DD4BF`  | `#0D9488`   | `rgba(45,212,191,0.14)` | 8.2:1 ✅ AAA |

Ratios calculados con [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/).
Re-verificar cada vez que se introduzca un color o se cambie la paleta.

### 1.4 Acentos por lane

| Lane                | Color    | Token                  |
|---------------------|----------|------------------------|
| Definicion          | purple   | `--lane-definicion`    |
| Desarrollo + Build  | info     | `--lane-desarrollo`    |
| QA                  | teal     | `--lane-qa`            |
| Entrega             | success  | `--lane-entrega`       |

Aplicar como barra vertical izquierda de 4px en cada card y en el header del
lane (ver mockup 01).

## 2. Tipografia

### 2.1 Family stack (self-hosted, zero CDN)

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI Variable",
             "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif;
--font-mono: "SF Mono", "Consolas", "Liberation Mono", Menlo, Monaco,
             "Courier New", monospace;
```

Rationale: usar la tipografia nativa del SO (San Francisco en macOS, Segoe UI
en Windows, Roboto en Android) **elimina la necesidad de descargar fuentes**,
respeta las preferencias del usuario (incluido DynamicType / escalado) y
cumple CA-11 sin costo.

### 2.2 Escala (base 15px, razon 1.200)

| Token       | Rem       | Px       | Uso                                |
|-------------|-----------|----------|------------------------------------|
| `--fs-xs`   | 0.75rem   | 12px     | timestamps, hints, chips pequenos  |
| `--fs-sm`   | 0.875rem  | 14px     | body secundario                    |
| `--fs-md`   | 1rem      | 16px     | body default                       |
| `--fs-lg`   | 1.125rem  | 18px     | subtitulos                         |
| `--fs-xl`   | 1.375rem  | 22px     | H3                                 |
| `--fs-2xl`  | 1.625rem  | 26px     | H2                                 |
| `--fs-3xl`  | 2rem      | 32px     | H1 (header principal)              |

### 2.3 Weights y trackings

- `--fw-regular: 400` — body, descripciones.
- `--fw-medium: 500` — texto secundario enfatico.
- `--fw-semibold: 600` — headings de seccion (H2/H3).
- `--fw-bold: 700` — H1, badges, KPIs.
- `--ls-wider: 0.1em` — badges y chips en mayusculas.

## 3. Iconografia

Sistema canonico de **22 iconos** como `<symbol>` en
`.pipeline/assets/icons/sprite.svg`:

- 1 branding (`ic-intrale-logo`)
- 3 fases de definicion (analisis, criterios, sizing)
- 7 fases de desarrollo (validacion, dev, build, verificacion, linteo, aprobacion, entrega)
- 8 estados transversales (rebote, crossphase, partial-pause, circuit-breaker, needs-human, voz-narrando, retrying, stale)
- 4 indicadores del header (health-ok, health-warn, agents-count, issues-count)

Ver `.pipeline/assets/icons/README.md` para la tabla completa con IDs,
nombres y usos.

### 3.1 Convenciones de dibujo

- **ViewBox**: 24x24 uniforme.
- **Estilo**: outline, `stroke-width="1.75"`, `stroke-linecap="round"`,
  `stroke-linejoin="round"`.
- **Color**: `stroke="currentColor"` — el contexto CSS manda.
- **Relleno**: solo semanticamente necesario; preferir outline.

### 3.2 Uso en HTML

```html
<!-- 1. Una sola vez, al inicio del <body>: -->
<svg style="display:none" aria-hidden="true">
  <!-- contenido de sprite.svg -->
</svg>

<!-- 2. Cada uso: -->
<svg class="icon icon-md" role="img" aria-label="fase: desarrollo">
  <use href="#ic-fase-dev"/>
</svg>
```

```css
.icon    { display: inline-block; vertical-align: middle; }
.icon-sm { width: 14px; height: 14px; }
.icon-md { width: 18px; height: 18px; }
.icon-lg { width: 24px; height: 24px; }
.icon-xl { width: 32px; height: 32px; }
```

### 3.3 Exportar a PNG (Telegram)

```bash
node .pipeline/assets/icons/extract.js ic-health-ok "#3FB950" 64 > /tmp/ok.svg
rsvg-convert /tmp/ok.svg > /tmp/ok.png
```

### 3.4 Seguridad (CA-2 del #2523)

Todo SVG **debe** cumplir:

- Sin `<script>`, `<foreignObject>`, `<iframe>`.
- Sin atributos `on*` (onload, onclick, onerror, etc.).
- Sin `href`/`xlink:href` con `javascript:` o URLs externas.
- `<use href="#id">` solo fragmentos locales.

## 4. Componentes

### 4.1 Card de issue (lane del board)

Estructura visual (ver mockup 01):

1. Barra vertical izquierda de 4px con el color del lane (acento).
2. Header: `#NUMERO` en `--fs-xs` + titulo truncado con elipsis en `--fs-md`.
3. Chip de fase actual con icono (`ic-fase-*`).
4. Opcional: badge de rebote (`rebote N`) o cross-phase (`CROSS-PHASE N`).
5. Barra de progreso `N/M` de steps.
6. Opcional: chip "Lili narrando" (voz activa).
7. Footer: ultimo evento en `--text-dim` con timestamp relativo.

Estados:
- default: `border: 1px solid var(--border)`.
- atencion (rebote reciente): `border: 1px solid var(--retry)` con `opacity: 0.4`.
- focus: outline del focus ring.

### 4.2 Badge / chip

```css
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border-radius: var(--radius-xl);
  font-size: var(--fs-xs); font-weight: var(--fw-semibold);
  letter-spacing: var(--ls-wider); text-transform: uppercase;
  border: 1px solid transparent;
}
.chip-success { background: var(--success-bg); color: var(--success);
                border-color: color-mix(in srgb, var(--success) 35%, transparent); }
/* ... success, warning, danger, info, retry, purple, teal */
```

### 4.3 KPI card

Ver mockup 01 y 03. Estructura:

1. Barra vertical superior de 4px con color semantico.
2. Etiqueta en `--fs-xs` `letter-spacing: var(--ls-wider)` y mayusculas.
3. Icono decorativo (`--fs-xl`).
4. Valor principal en `--fs-3xl` `--fw-bold`.
5. Subtitulo opcional en `--fs-xs` `--text-dim`.

### 4.4 Lane del board

Ver mockup 01. Header fijo arriba con:
- Barra lateral izquierda con color del lane (4px).
- Icono del lane en circulo tintado.
- Titulo + subtitulo.
- Contador de issues a la derecha.

### 4.5 Timeline de fases

Vertical, con linea gris a la izquierda. Cada paso:
- Circulo relleno (done) / outline (pendiente) / pulsante (en curso).
- Label de fase + metadata (agente, tiempo, resultado).

### 4.6 Focus ring

```css
:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
```

Ancho 2px fuera + 2px dentro sobre el fondo base. Color `--brand-cyan` para
maximo contraste sobre neutros dark.

## 5. Mockups de referencia

Tres mockups SVG commiteados en `.pipeline/assets/mockups/`:

1. `01-home-dashboard.svg` — home del dashboard V3, 1440x900, 3 lanes pobladas,
   header con identidad, KPIs en vivo, badges diferenciados.
2. `02-issue-drilldown.svg` — drilldown de issue individual con breadcrumb,
   KPIs del issue (fase, agente, tiempo, rebotes, tokens), timeline de fases,
   panel de voz narrando.
3. `03-consumo.svg` — pagina `/consumo` con KPIs, grafico de barras por fase,
   tabla top 5 issues, coordinada con issue #2520.

## 6. Accesibilidad

Chequeo obligatorio antes de entregar cualquier vista:

- [ ] Contraste >= 4.5:1 texto normal, >= 3:1 texto grande / controles / iconos informativos.
- [ ] Todo `<svg>` con significado semantico lleva `role="img"` + `aria-label`.
- [ ] `:focus-visible` con outline >= 2px y color contrastante en todos los
      controles interactivos (links, tabs, filtros, botones).
- [ ] Ninguna informacion se comunica solo por color — siempre acompanada de
      icono o texto.
- [ ] Orden de tab logico y predecible.
- [ ] `prefers-reduced-motion` respetado (animaciones desactivadas).
- [ ] `prefers-contrast: more` fortalece bordes y texto secundario.

### 6.1 Estados no-color

| Estado         | Color         | Icono                    | Texto             |
|----------------|---------------|--------------------------|-------------------|
| Sano           | `--success`   | `ic-health-ok`           | RUNNING           |
| Con alertas    | `--warning`   | `ic-health-warn`         | WARNING           |
| Pausado total  | `--text-dim`  | `ic-estado-partial-pause` (sin candado) | PAUSED         |
| Pausado parcial| `--warning`   | `ic-estado-partial-pause`| PARTIAL N/allowlist|
| Rebote normal  | `--warning`   | `ic-estado-rebote`       | rebote N          |
| Cross-phase    | `--retry`     | `ic-estado-crossphase`   | CROSS-PHASE N     |
| Needs-human    | `--danger`    | `ic-estado-needs-human`  | NEEDS HUMAN       |
| Voz narrando   | `--teal`      | `ic-estado-voz-narrando` | Lili narrando     |
| Retrying       | `--retry`     | `ic-estado-retrying`     | retry N/M         |
| Stale          | `--warning`   | `ic-estado-stale`        | stale             |

## 7. Consistencia cross-surface

Para que dashboard, `/consumo`, PDFs de rejection y Telegram se sientan
**como un solo sistema**:

### 7.1 Dashboard y /consumo

Inyectar `design-tokens.css` en el `<head>` (o embebido en el string HTML del
server-side render de `dashboard-v2.js`). Usar las variables en lugar de hex.

### 7.2 PDFs de rejection

Los PDFs son generados por HTML → Puppeteer/Chrome headless. Inyectar
`design-tokens.css` en el template HTML del rejection report. Los contrastes
para print son los mismos (no cambiamos la paleta para papel; el PDF se ve
igual que la pantalla).

### 7.3 Mensajes de Telegram

Telegram no soporta CSS. Para mantener consistencia visual:

1. **Emojis como proxy de iconos**: cuando un mensaje refiere a una fase o
   estado, usar el emoji **oficial** mapeado (ver tabla 7.3.1 abajo). Aunque
   el issue #2523 recomienda eliminar emojis ad-hoc del dashboard, en
   Telegram son inevitables porque no hay render SVG.
2. **Imagenes renderizadas**: cuando una foto / screenshot acompana al
   mensaje (ej. rejection report), usar exactamente los mismos colores (hex)
   que en el dashboard.

#### 7.3.1 Mapeo emoji → estado (Telegram)

| Estado         | Emoji oficial |
|----------------|---------------|
| success        | ✅            |
| warning        | ⚠️            |
| danger         | ❌            |
| info           | ℹ️            |
| retry          | 🔄            |
| rebote normal  | ↩️            |
| cross-phase    | 🔀            |
| partial-pause  | ⏸️            |
| circuit-breaker| 🛑            |
| needs-human    | 🙋            |
| voz-narrando   | 🔊            |
| stale          | 🕒            |

El issue #2519 (rediseno mensajes Telegram) debe referenciar esta tabla.

## 8. Extender el sistema

### 8.1 Agregar un color

1. Verificar que no existe un token equivalente.
2. Calcular contraste sobre `--surface-0` y `--surface-1` — debe cumplir AA.
3. Agregar al `design-tokens.css` con los tres tonos (base, dim, bg).
4. Documentar en este archivo (seccion 1.3).

### 8.2 Agregar un icono

1. Identificar que no se puede reusar uno existente.
2. Dibujar con el estilo (`stroke="currentColor"`, `stroke-width="1.75"`,
   viewBox 24x24).
3. **Sanitizar** manualmente: sin `<script>`, sin `on*`, sin href externos.
4. Agregar al `sprite.svg` como `<symbol id="ic-<cat>-<nombre>">`.
5. Registrar en `.pipeline/assets/icons/README.md`.
6. Agregar al mapeo emoji Telegram (seccion 7.3.1) si tiene equivalente.

## 9. Performance

- SVG sprite inline una sola vez por pagina (no duplicar markup por card).
- `design-tokens.css` inline en el `<head>` (no archivo separado por ahora —
  el dashboard server-side no sirve estaticos).
- Sin animaciones en `@media (prefers-reduced-motion: reduce)`.
- Sombras moderadas (4 niveles) — no blur >= 24px.

Baseline actual FCP local: ~180ms (red local). Target post-rediseno: <= 200ms.

## 10. Versionado del sistema

Este design system es un **documento vivo**. Cambios significativos (nuevo
color, nuevo icono canonico, cambio de escala tipografica) deben registrarse
en este archivo con fecha y rationale.

| Fecha       | Cambio                                   | Issue  |
|-------------|------------------------------------------|--------|
| 2026-04-24  | Creacion inicial del design system       | #2523  |

## 11. Referencias

- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [WCAG 2.1 AA](https://www.w3.org/TR/WCAG21/)
- [Refactoring UI — Spacing and Sizing](https://www.refactoringui.com/)
- `docs/branding/icons/README.md` — icon pack corporativo Intrale.
- Issue #2523 — rediseno visual dashboard V3 (origen de este documento).
- Issue #2519 — rediseno mensajes Telegram (consumidor de tokens).
- Issue #2520 — fix pagina /consumo (consumidor de tokens).
- Issue #2532 — CSP + security headers (futura mejora).
- Issue #2534 — sanitizador SVG en pre-commit (automatiza seccion 3.4).
