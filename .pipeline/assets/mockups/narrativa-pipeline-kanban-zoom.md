# Narrativa UX — Pipeline kanban con zoom semántico (EP8-H3 · #3956)

> Fase: definición/criterios · Agente: `ux` · Mockup: `35-pipeline-kanban-zoom-v3.svg`
> Tokens: `design-tokens.css` §14 · Iconos: `sprite.svg` (`ic-stage-not-entered`, `ic-stage-finalized`, `ic-overflow-more`)

## El problema que resolvemos

Hoy el tablero de pipeline muestra 3 carriles fijos (Definición / Desarrollo+Build /
QA+Entrega) y, **aparte**, una sección colapsable "Completados recientes". El operador
tiene que leer el ciclo de vida de una ola en dos lugares distintos, y los issues que
todavía no entraron al flujo (bloqueados por deps o esperando slot) ni siquiera aparecen.
A distancia (kiosk) los conteos y semáforos no se leen.

El rediseño unifica todo en **una sola línea de proceso** que representa el ciclo de
vida íntegro de la ola, de punta a punta, y permite leerlo a tres niveles de zoom.

## Principio rector: una sola línea, sin bandejas

La ola completa vive en una línea horizontal:

```
⏳ No ingresados  →  Definición  →  Desarrollo  →  QA + Entrega  →  ✅ Finalizados
```

- **No existe ninguna sección "fuera de flujo"** (CA-7). La vieja sección "Completados
  recientes" se **fusiona** como etapa terminal `✅ Finalizados` dentro de la misma línea.
- Cuando hay más etapas que ancho visible, la línea hace **scroll horizontal** con un
  indicador **"+N fases"** (CA-4) y un fade en el borde derecho como afordancia.

## Las dos etapas terminales

### ⏳ No ingresados (CA-5)
Issues miembros de la ola activa que todavía no entraron al flujo. Cada card muestra el
**motivo de no-ingreso**:
- **Deps abiertas** → chip rojo con **link al issue bloqueante** (`#3958`), esquema
  `https://github.com/...` validado.
- **Esperando slot** → chip neutro con la posición en cola (`pos. 2`).
- Si no hay dato de deps (`waves.json:dependencies` vacío), **degrada** a "esperando slot"
  — nunca rompe el render.

### ✅ Finalizados (CA-6)
Issues implementados totalmente (PR mergeado). Cada card muestra **fecha de cierre** y
**link al PR mergeado** (`PR #4028`). Si `pr-info-fetcher` falla o hay rate-limit,
**degrada** a "sin link" — no bloquea el render.

## Zoom semántico: tres densidades (CA-1)

Una clase en el contenedor (`.zoom-lejos` / por defecto normal / `.zoom-foco`) reescribe
las variables `--zoom-*` de `design-tokens.css` §14. **No hay tamaños hardcodeados**.

| Densidad | Uso | Qué se ve |
|----------|-----|-----------|
| **lejos** (kiosk) | pantalla de pared, lectura a ~3 m | Conteo por etapa en 72 px, semáforos de 32 px, detalle de card oculto |
| **normal** (default) | operador sentado | Cards con pills **≥14 px**, micro-progreso, popover de detalle al click/hover |
| **foco** | investigar un agente | Columna ensanchada con **timeline** vertical de fases (completado/rechazado/en curso/pendiente) |

La regla de accesibilidad del sistema se mantiene: las pills nunca bajan de 14 px en
normal/foco; en kiosk escalan hacia arriba para lectura a distancia. Todos los estados van
con **icono + texto**, nunca solo color (WCAG AA).

## Popover del agente (CA-2)

Al interactuar con una card aparece un popover (`surface-3` + borde `border-strong`) con:
issue, skill, fase, estado, edad y **motivo del último rebote**, más botones **Ver log** y
**Pausar**.
- El botón log apunta a `/logs/view/<file>` con el identificador **codificado**
  (`encodeURIComponent`).
- Los botones de acción **reutilizan los endpoints existentes** — sin endpoint nuevo de
  cambio de estado.

## Badge único de pausa (CA-3)

Se reemplazan los tres estados actuales (`running` / `paused` / `partial`) por **un solo
badge** con dos estados claros: `Pausado` / `fuera de allowlist: N`. Color ámbar
(`--retry`) + icono de pausa + candado para el conteo fuera de allowlist.

## Seguridad incorporada al diseño (CA-8/9/10)

El rediseño renderiza texto de origen no confiable (motivo de rebote, título de issue,
motivo de no-ingreso). El diseño asume:
- **Todo texto dinámico escapado** (`escapeHtmlText`/`escapeHtmlAttr` o `textContent`).
  Corrige el XSS confirmado en `showDotPopup` (L6298-6301). En el mockup el motivo de
  rebote aparece anotado como "(escapado)".
- **Links seguros**: `href` con esquema `https://github.com/...` validado, `target="_blank"
  rel="noopener noreferrer"`.
- **Sin datos sensibles** en los payloads: solo issue/skill/fase/estado/edad/motivo/links.

## Identidad visual

- Paleta y escala 100 % desde `design-tokens.css` (EP8-H0 #3953). Acentos por fase:
  definición `--purple`, desarrollo `--info`, QA `--teal`, finalizado `--success`,
  no-ingresado `--text-dim`.
- Iconografía propia del sprite — **se evitan los emojis del SO** (⏳/✅) en el render real:
  se agregaron `ic-stage-not-entered`, `ic-stage-finalized` e `ic-overflow-more` al sprite,
  coherentes con el estilo outline 24×24 / `currentColor` existente.

## Entregables de esta fase

1. `35-pipeline-kanban-zoom-v3.svg` — mockup objetivo (referencia de implementación).
2. `design-tokens.css` §14 — tokens de zoom semántico/kiosk + semáforos de etapas terminales.
3. `sprite.svg` — 3 iconos nuevos (etapas terminales + overflow).
4. Esta narrativa.

## Verificación de cierre (para dev/QA)

Render real con `curl + grep` del HTML servido (no solo sintaxis JS) para los 10 CAs,
incluyendo el caso XSS: un `motivo` con `<script>` y comillas debe salir como
`&lt;script&gt;`, no como markup vivo.
