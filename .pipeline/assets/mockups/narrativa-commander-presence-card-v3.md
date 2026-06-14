# Narrativa de diseño — Card observacional del Commander (#3948 · EP7-H1)

> Spec UX vinculante para la fase de desarrollo. Acompaña a
> `28-commander-presence-card-v3.svg`. Render: kiosk del operador (dark-first),
> banda "Ejecutando ahora" en Home + vista "Equipo".

## Problema de UX que resuelve

El Commander es hoy invisible en "Ejecutando ahora"/"Equipo" pese a ser un actor
activo. La historia lo hace visible **sin** que consuma slot ni se confunda con un
agente real (CA-2). El riesgo de experiencia: que el operador vea la card del
Commander y crea que es uno de los 3 agentes en ejecución, o intente cancelarlo.

La solución de diseño no inventa un componente nuevo: **reutiliza `.active-card`**
(home.js L294) y lo diferencia con tres señales **redundantes** (icono + texto +
borde, nunca sólo color → WCAG AA).

## Las tres señales de "presencia observacional"

1. **Borde izquierdo punteado azul-info + superficie levemente atenuada.**
   `border-left: 2px dashed var(--in-info)` sobre un `background` un punto más
   apagado que `--in-bg-3`. Comunica "presencia, no asignación de slot". Es la
   señal periférica que el operador capta sin leer.

2. **Pill "👁 observa" en lugar del botón "✕ cancelar".** En la celda
   `grid-column: 3 / grid-row: 2` donde el agente real renderiza
   `.active-card-kill`, la card observacional renderiza un chip no interactivo
   `background: var(--in-info-soft); color: var(--in-info)` con icono 👁 + texto
   "observa". Cumple CA-3/CA-4 (sin acción destructiva) y además **explica** por
   qué no se puede cancelar, en vez de simplemente omitir el botón.

3. **Identificador "Commander" (no `#NNNN`) + `petitionId` opaco.** El campo que
   en agentes reales muestra `#issue · skill` aquí muestra `Commander` (issue es
   `null`). El subtítulo puede incluir el `petitionId` opaco corto (ej.
   `pet_7f3a9c`) — nunca contenido del mensaje (CA-6/SEC-1). Sin link `↗`
   (`hasLog:false`, CA-10).

## Tratamiento de cada campo

| Campo | Agente real | Commander observacional |
|---|---|---|
| Badge skill | icono+color del skill | 🎖 `#f778ba` (ya en SKILL_ICONS/COLORS) |
| Título primario | `#3812 · android-dev` | `Commander` |
| Fase (uppercase dim) | DESARROLLO | enum: TRANSCRIBIENDO / PENSANDO / VERIFICANDO / ENVIANDO |
| Subtítulo | título del issue | `Atendiendo petición de Telegram · <petitionId>` |
| Tiempo (mono accent) | `04:21` | `00:12` (mismo formato `fmtDur`) |
| Acción | botón `✕ cancelar` | pill `👁 observa` (no interactiva) |
| Barra de progreso | % sobre ETA | **indeterminada** (pulse), sin % |

### Barra de progreso indeterminada

Los agentes reales muestran `% = durationMs/etaMs`. La presencia del Commander
**no tiene ETA**, así que pintar un 4% fijo daría falsa señal de avance.
Recomendación: barra **indeterminada** (gradiente que recorre el track, animación
CSS `@keyframes`). Alternativa aceptable si se prefiere mínima superficie: omitir
la barra. NO usar porcentaje fijo.

## Mapa de fases (enum cerrado · CA-5)

| Fase | Icono sugerido | Momento del flujo |
|---|---|---|
| `transcribiendo` | 🎙 | descarga/STT del audio (listener) |
| `pensando` | 🧠 | dispatch LLM |
| `verificando` | 🔍 | sólo cuando corre Sherlock (camino LLM) |
| `enviando` | 📤 | antes de `sendMessage` |

Los iconos son sugerencia de copy visual; el dato persistido es el **enum en
texto** (validado contra whitelist al escribir y antes de render, defensa en
profundidad). El camino determinístico **no** pasa por `verificando`.

## Accesibilidad (WCAG AA)

- Texto sobre `--in-bg-3`/superficie atenuada ≥ 4.5:1 (tokens del tema ya lo
  cumplen).
- El estado "observacional" se transmite por **icono 👁 + texto "observa" +
  borde punteado**, nunca sólo por color (daltonismo-safe).
- La pill no interactiva no debe tener `cursor:pointer` ni foco de teclado
  (no es un control). `aria-label="presencia observacional, no cancelable"`.
- Tooltip en la pill explicando que el Commander no ocupa slot.

## Restricciones de implementación (heredadas de criterios)

- 100% tokens de `theme.css` — **cero colores nuevos**.
- Todos los campos escapados con `escapeHtmlText`/`escapeHtmlAttr`
  (`lib/escape-html.js`, #3722) en SSR y cliente (CA-7/SEC-2).
- La diferenciación visual aplica **idéntica en Home y en Equipo** (mismo
  gating `observational===true`/`cancelable===false`).
