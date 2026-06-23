# Narrativa UX — Matriz → heat-map interactivo (#3959 · EP8-H6)

Mockup: `38-matriz-heatmap-v3.svg`
Fase: definición / criterios · Pipeline: definicion
Stack destino: dashboard V3 (Node SSR + hidratación), `.pipeline/views/dashboard/matriz.js`
Paleta: `theme.css` (dark mode, identidad Intrale) — **no se inventan colores nuevos**.

## Por qué este diseño

La matriz hoy es una grilla pasiva de números con tres estados sólo-color
(`mtx-cell-0/active/hot`, umbral simple `n>=5`). El rediseño la convierte en un
**heat-map operable**: quien monitorea el pipeline salta de una celda al detalle,
lee la tendencia de carga, y ubica el cuello de botella sin interpretar números a
mano. Las decisiones de diseño abajo cierran los CA del PO y los requisitos de
accesibilidad y seguridad.

## Sistema visual de estados (CA-5 — paleta accesible)

Regla rectora: **ningún estado se distingue sólo por color**. Cada estado lleva
color + patrón CSS + glifo/símbolo. Un usuario con daltonismo (deuteranopía /
protanopía) los diferencia por la textura y el símbolo.

| Estado | Color (token) | Patrón | Glifo swatch | Cuándo |
|---|---|---|---|---|
| Sin carga | `--in-bg-2` plano | ninguno | `·` | conteo = 0 |
| Carga normal | `--in-accent` / `--in-accent-soft` | puntos sutiles | `●` | 1–4 issues |
| Carga alta | `--in-warn` / `--in-warn-soft` | rayado diagonal | `◣` | 5+ issues |
| Cuello de botella | `--in-bad` / `--in-bad-soft` | cross-hatch denso + borde 2px | `▦` + badge texto | máx. `conteo × edad media` |

Implementación sugerida (CSS puro, sin assets binarios):

```css
/* puntos sutiles — carga normal */
.mtx-cell-active {
  background-color: var(--in-accent-soft);
  background-image: radial-gradient(rgba(46,230,193,0.55) 0.9px, transparent 0.9px);
  background-size: 6px 6px;
  color: var(--in-accent); font-weight: 600;
}
/* rayado diagonal — carga alta */
.mtx-cell-hot {
  background-color: var(--in-warn-soft);
  background-image: repeating-linear-gradient(45deg,
    rgba(210,153,34,0.7) 0 1.6px, transparent 1.6px 7px);
  color: var(--in-warn); font-weight: 600;
}
/* cross-hatch — cuello de botella (gana 1 sola celda) */
.mtx-cell-neck {
  background-color: var(--in-bad-soft);
  background-image:
    repeating-linear-gradient(45deg,  rgba(248,81,73,0.85) 0 1.4px, transparent 1.4px 6px),
    repeating-linear-gradient(-45deg, rgba(248,81,73,0.45) 0 1px,   transparent 1px 6px);
  border: 2px solid var(--in-bad);
}
```

La **leyenda** replica los cuatro swatches con el mismo patrón + glifo + texto, de
modo que el significado sea autoexplicativo (no hace falta tooltip para entenderlo).

## Cuello de botella con texto (CA-3)

- El umbral simple `n>=5` se reemplaza por **`conteo × edad media`** (edad media
  derivada server-side en `matrixAgeAvg`, no recalculada en cliente).
- **Una sola celda gana** (la de mayor producto) y se destaca con un **badge de
  texto explícito** `⚠ cuello de botella`, no sólo con color. El badge es texto
  legible, no un ícono ambiguo.
- Si dos celdas empatan, gana la de mayor edad media (lo que está parado más
  tiempo pesa más que lo que sólo es voluminoso).
- Si no hay celdas con carga, no se destaca ninguna (degradación limpia).

## Tendencia ▲▼ por celda (CA-2)

- Junto al número: `▲` (subió), `▼` (bajó), `▬` (estable) vs ≈24h atrás.
- **El glifo ES la señal** — el color sólo refuerza (rojo `--in-bad` para subió,
  verde `--in-ok` para bajó, dim para estable). Un daltónico lee la dirección por
  la forma del glifo.
- **Semántica de color invertida a propósito**: "subió" la carga = peor = rojo;
  "bajó" = mejor = verde. Coherente con que la matriz mide presión/atascos.
- Cada flecha lleva `aria-label` descriptivo, p.ej. `aria-label="subió respecto
  de hace 24 horas"`. El lector de pantalla no depende del glifo.
- Sin dato histórico de 24h → **no se dibuja flecha** (nunca una flecha falsa).

## Drill-down por celda (CA-1)

- Celdas **con carga** (conteo ≥ 1) son operables: `role="button"` + `tabindex=0`
  + `aria-label` ("android-dev en dev/desarrollo, 7 issues, abrir detalle").
  Las celdas vacías NO son focusables (no aportan nada que abrir).
- **Estado de foco visible**: anillo `2px var(--in-info)` (ver fila `ux` del
  mockup). Operable por teclado con Enter / Espacio, no sólo mouse.
- Abre un **`<dialog>` modal nativo** (`showModal()`): focus trap del browser,
  cierre con Esc gratis. Patrón clonado de `issues.js::renderIssuesDialog` — no se
  inventa un panel nuevo.
- **Header del panel**: `skill × pipeline/fase` + badge de cuello de botella si
  aplica + resumen `N issues · edad media X días`.
- **Cada fila de issue**: `#número` (monoespaciado, color info) + título +
  pill de estado (mismos tokens que el resto del dashboard) + edad.
- **Contenido externo (títulos/labels) con `textContent`/`createElement`** — nunca
  `innerHTML` de datos crudos. Mantiene verde el guard XSS de `matriz.test.js:96-106`.
- Link "Ver en GitHub" valida `/^\d+$/` sobre el número antes de interpolar el href.

## Orden de skills (CA-4)

Mismo orden que Pipeline y Equipo, desde una fuente única (`skill-catalog.js`,
catálogo por categoría). El usuario no debe re-aprender el orden al cambiar de
pestaña: la consistencia espacial es parte de la experiencia.

## READ-ONLY (CA-6)

El drill-down es sólo lectura/navegación. Sin `<form>` / POST. La acción "Ver en
GitHub" es un link de navegación, no una mutación. Se mantiene verde el test
`matriz.test.js:134-139`.

## Checklist de accesibilidad que el dev debe respetar

- [ ] Contraste texto/fondo ≥ WCAG AA (4.5:1) en cada estado de celda. Los tokens
      `--in-accent`/`--in-warn`/`--in-bad` sobre `--in-bg-2` ya cumplen; verificar
      el texto del badge sobre fondo `--in-bad`.
- [ ] Estado distinguible sin color (patrón + glifo) en celda y leyenda.
- [ ] Foco de teclado visible en celdas operables.
- [ ] `aria-label` en celdas operables y en flechas de tendencia.
- [ ] `<dialog>` con focus trap y cierre por Esc (lo da `showModal()`).
- [ ] Touch target de celda ≥ 32px de alto (el padding actual `9px 11px` + número
      lo cumple en filas de 40px del mockup).

## Entregable de esta fase

Este mockup + narrativa son la guía visual para el dev de implementación. No se
commitean archivos de producción Compose (la matriz es dashboard interno Node, no
producto Intrale). Los assets visuales reales del cambio son **CSS** (patrones
arriba) que el dev integra en `MATRIZ_CSS`.
