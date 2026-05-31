# Narrativa Wizard "Configurar período de descanso" — Lili (perfil `ux`)

> Texto que Lili narra acompañando el mockup
> [`29-wizard-descanso-flow.svg`](./29-wizard-descanso-flow.svg) del issue
> [#3739](https://github.com/intrale/platform/issues/3739) — hija del split
> [#3715](https://github.com/intrale/platform/issues/3715) del rediseño UX
> integral del Dashboard V3.
>
> El audio se genera con `edge-tts`, voz `es-AR-ElenaNeural`, pitch `+10Hz`,
> tono cálido y didáctico (heredado de `narrativa-modo-descanso.md`).
>
> Salida sugerida: `.pipeline/assets/mockups/narrativa-wizard-descanso.mp3`
> (la genera `pipeline-dev` en la fase `desarrollo`, junto al video QA, cuando
> las hijas hermanas #3722 y #3724 cierren).

## Contexto rápido para el lector que no abrió el SVG todavía

Este wizard es la cara amable del modo descanso. Antes, el operador tenía
que abrir `config.yaml` y tipear bloques horarios JSON crudos. Con el wizard,
el operador entra a `/dashboard?view=descanso` y completa tres pasos
guiados que terminan con una persistencia atómica y una entrada audit
chained con hash SHA-256.

El wizard depende de tres piezas que vienen del mismo split del padre:

- **#3722** — helper unificado `lib/escape-html.js` para evitar XSS en el
  preview y los tooltips.
- **#3723** — router cliente con vista `?view=descanso` (ya cerrado).
- **#3724** — base de wizards genéricos: CSRF, sesión con TTL 15 min,
  idempotencia y timeout de step token.

Mientras #3722 y #3724 sigan abiertos, el brazo de desbloqueo del pipeline
retiene esta historia.

## Script narrado

Hola equipo, soy Lili. Les paso el sistema visual del wizard de
configuración del modo descanso, la historia tres mil setecientos treinta
y nueve. Es una de las hijas del rediseño UX del dashboard V3 que estamos
amasando en el split del tres mil setecientos quince.

Antes de meternos en los pasos, dos cosas sobre el contexto. Primero, este
wizard es una capa amigable arriba de la lógica que ya existe en
`lib/rest-mode-window.js` y `lib/rest-mode-state.js`. No reinvento ningún
modelo. Reuso el calendario semanal del mockup cinco, la función
`describeRestModeNow` para saber el estado actual, y la constante
hardcodeada `MAX_SNOOZE_HOURS` igual a veinticuatro horas. La novedad es
puramente de superficie: un flow de tres pasos que reduce el costo
cognitivo y empuja la decisión de validación al servidor, donde no se
puede bypassear.

Segundo, este wizard depende de dos piezas hermanas del mismo split. La
sub-historia tres mil setecientos veintidós entrega el helper unificado
de escape HTML que evita XSS en el preview y en los tooltips. La
sub-historia tres mil setecientos veinticuatro entrega la base de wizards
genéricos con CSRF, sesión con time to live de quince minutos,
idempotencia por step token y timeout. Cuando ambas cierren, el brazo de
desbloqueo del pipeline empuja este issue a desarrollo. Mientras tanto,
todo el contrato está pre-aprobado por arquitecto y producto.

Vamos al header. Es una barra angosta con el logo, el breadcrumb que
indica Dashboard, Pipeline, Wizard Configurar período de descanso, y a la
derecha una pildora con el método y el path del endpoint, post barra
dashboard barra wizard barra descanso barra step. Lo expongo porque
quiero que el operador entienda visualmente que el wizard, cuando llegue
el momento, ataca un endpoint concreto, idempotente, gobernado por la
misma sesión.

Abajo del header está el stepper, una barra horizontal con tres
indicadores de paso. Los dos primeros aparecen completados con un check
doble verde, el tercero está activo, marcado con el gradiente brand cyan
azul. A la derecha del stepper hay un countdown ambar de la sesión, once
minutos veinticuatro segundos, recordando que la base wizards genérica
expira en quince minutos.

Paso uno, ventana horaria. Acá el operador define los bloques de
descanso por día. Reuso el calendario semanal del mockup cinco con siete
columnas, lunes a domingo, y en cada columna las celdas representan los
periodos. Cross-midnight permitido, lo respeta la lógica que ya está. Lo
único nuevo que muestro respecto al settings clásico es el cap continuous
window menor o igual a veinticuatro horas, indicado con una pildora
violeta de modo descanso y un signo de interrogación que abre un tooltip
explicativo. Para hacerlo concreto, en el mockup el sábado aparece con
borde rojo y un ícono de warning porque el operador, jugando, le clavó
dos periodos que totalizan dos mil ochocientos ochenta minutos, casi el
doble del cap. La validación es server side, no es solo decorativa. El
botón de continuar al pie se ve atenuado, con el texto "corregir y
continuar" en gris. No hay forma de saltearlo desde la UI ni con curl.
El cap vive en `validatePayload` y rechaza con cuatrocientos, no con un
mensaje en la UI.

Paso dos, detector de anomalías, en modo solo lectura. Esta es una
decisión consciente cerrada por arquitecto y validada por producto. La
historia trata de configurar el período de descanso, no de tunear el
detector de anomalías. Si el operador necesita modificar
ratio threshold, lookback hours o el cap del snooze, abre config dot
yaml. El step dos muestra los tres umbrales vigentes en tarjetas grises
con tipografía mono, cada una con su tooltip explicativo, y al pie un
checkbox verde grande que dice leí los umbrales vigentes, con el flag
acknowledged en true. Sin ese acknowledge el wizard no avanza. Y si el
operador hace post manual con cualquier campo distinto al acknowledge,
el server rechaza con cuatrocientos field not editable. La defensa está
abajo del wizard, no en el wizard.

Paso tres, confirmación y preview. Es el corazón del valor del wizard.
Tres bloques. Primero un diff prev next del schedule, mostrando día por
día qué entró nuevo, qué cambió, qué quedó igual. Verde para los nuevos
o los que persisten en next, gris para los previos, ámbar y rojo para el
viernes que el operador editó de veintitrés a ocho. Después un panel
indigo bien visible con la próxima transición, calculada server side con
`describeRestModeNow` más `nextWindowTransition`. El texto dice modo
descanso comienza en tres horas veinticuatro minutos, y abajo en mono
detalla kind enter, when today, at veintidós cero cero. Esto le da al
operador la certeza de cuándo va a entrar en efecto su cambio. Tercer
bloque, un input opcional de motivo, máximo quinientos caracteres, con
un contador y una nota que dice render server side con escapeHtmlText
de la librería escape html que entrega la hija tres mil setecientos
veintidós. La nota muestra explícitamente que si el operador tipea menor
img, queda escapado a ampersand l t img. Eso no es decoración, es el
contrato pintado en la UI para que se vea que está cubierto.

Al pie del paso tres está el preview del audit chain. Un cuadrito que
dice config descanso audit punto jsonl, con el prev hash y la action
config descanso. Es el primer renglón del lazo de trazabilidad. Al
confirmar se persiste atómicamente con `setWindow` y se chained con
SHA dos cinco seis. Si una entrada se corrompe a futuro, la cadena lo
delata.

Abajo del filmstrip puse una fila de estados de error. Cinco tarjetas,
una por test obligatorio. La primera, en rojo, es el cuatrocientos CA D2
por continuous window mayor a veinticuatro horas. La segunda, también
roja, es el cuatrocientos field not editable cuando el operador intenta
editar un threshold por POST. La tercera, ámbar, es el cuatrocientos
diez Gone heredado de la base wizard cuando la sesión expira por TTL
quince minutos. La cuarta, roja, es el cuatrocientos tres no loopback
que rechaza POST desde IP externa antes de parsear el body. La quinta,
en verde porque es una defensa que funciona, muestra que un motivo con
backslash n literal queda escapado como backslash backslash n y persiste
en una sola línea del NDJSON, sin partir el log.

Más abajo, ocupando todo el ancho, la fila del audit chain. Es un cuadro
ancho con la chain real esperada en producción: timestamp ISO, actor
commander leo, action config descanso, config diff con prev y next del
schedule, prev hash y curr hash en color púrpura, y una pildora verde
con chain OK. Es la garantía visual de CA D5 del PO.

Al fondo dejé el contrato para pipeline dev. Cuatro chips mono cyan que
listan los reusos obligatorios: var surface star, var rest mode, var
alert anomaly del archivo de design tokens. Use href ic moon sobre
sprite svg, prohibido SVG inline. escapeHtmlText y escapeHtmlAttr del
helper compartido. role tooltip más aria describedby con delay
trescientos milisegundos. Cierro con la tabla WCAG AA verificada,
indigo nocturno sobre surface cero siete coma cuatro a uno triple A,
alerta anomalía sobre surface cero trece a uno triple A, y el púrpura
del chain sobre surface uno cinco coma seis a uno doble A.

Eso es el wizard de descanso. Tres pasos, una atomicidad transaccional
en el último paso, y todo el contrato server side donde no se puede
bypassear. No reinventé ningún modelo, reutilicé todo lo que ya está,
y produje únicamente la capa de superficie que faltaba. Hasta acá Lili.

## Decisiones de diseño que el dev no debe renegociar

| ID | Decisión | Por qué la cerré yo |
|----|----------|---------------------|
| D-1 | Stepper horizontal de 3 dots fijos, no scrolleable. | Tres pasos cabe siempre en cualquier viewport ≥ 1280px. Coherencia con el mockup 25 del wizard de allowlist. |
| D-2 | Step 2 read-only, solo `acknowledged: true` editable. | Cerrado por architect en sign-off de #3739. Edición de thresholds fuera de scope. |
| D-3 | Cap continuous-window 24h visible como pildora del Step 1. | El operador entiende el límite **antes** de chocar contra él. Reduce errores y soporte. |
| D-4 | Preview de la próxima transición con `kind / when / atHHMM / minutesFromNow`. | Comunica el efecto inmediato del cambio. Sin esto el wizard sería un "ok confiá". |
| D-5 | Diff prev / next visible en Step 3 antes del confirmar. | Doble check anti-error. El operador puede cancelar si nota algo raro. |
| D-6 | Motivo opcional con escape explícito en la UI. | Hace visible el contrato CA-G3 / R-4. El dev no puede saltearse `escapeHtmlText`. |
| D-7 | Estados de error como tarjetas en una fila bajo el filmstrip. | El dev ve los 5 tests obligatorios pintados. No hay forma de implementarlos a medias. |
| D-8 | Audit chain visible al pie con prev_hash + curr_hash mock. | Hace tangible el contrato CA-D5. La chain es tamper-evident, no decorativa. |
| D-9 | Tipografía: stack system + `'SF Mono','Consolas',monospace` para HH:MM, hashes y IDs. | Coherente con el sistema visual del dashboard V3. Mono para datos verificables. |
| D-10 | Iconografía: `m-moon` para descanso, `m-shield` para defensas, `m-audit` para audit, `m-clock` para TTL. | El dev usa `<use href="#ic-*"/>` sobre `sprite.svg` — los símbolos inline en el mockup son solo para preview standalone. |

## Tokens consumidos del sistema (`design-tokens.css`)

| Token | Uso en este mockup |
|-------|---------------------|
| `--surface-0` (#0D1117) | Fondo del body. |
| `--surface-1` (#161B22) | Cards, panels, header. |
| `--surface-2` (#1C2128) | Tooltip flotante del Step 1. |
| `--brand-cyan` (#00D6FF) / `--brand-blue` (#1890FF) | Gradiente del stepper activo y de los CTAs. |
| `--rest-mode` (#7C5CFF) | Pildora cap CA-D2, panel del preview, calendario LUN activo. |
| `--rest-mode-fg` (#C5B7FF) | Texto sobre `--rest-mode-bg`. |
| `--alert-anomaly` (#FF6B8A) | Icono del Step 2 (shield rosa-rojo) para diferenciarlo de danger puro. |
| `--success` (#3FB950) | Stepper completado, chain OK, escape OK, motivo escapado visible. |
| `--warning` / `--retry` (#F0A500) | TTL countdown del header, 410 session_expired. |
| `--danger` (#F85149) | Cap CA-D2 excedido, field not editable, 403 no loopback. |
| `--purple` (#BC8CFF) | Audit chain icon + hashes. |
| `--text-primary` (#E6EDF3), `--text-secondary` (#B1BAC4), `--text-dim` (#8B949E), `--text-disabled` (#6E7681) | Jerarquía tipográfica. |
| `--border` (#30363D), `--border-subtle` (#21262D), `--border-strong` (#484F58) | Divisores y outlines. |

## Iconos consumidos del sprite (`assets/icons/sprite.svg`)

Los símbolos inline en el SVG son sólo para preview standalone. El dev usa:

- `<use href="sprite.svg#ic-moon"/>` — pildora descanso + preview Step 3.
- `<use href="sprite.svg#ic-shield"/>` o `#ic-shield-check` — Step 2 header + nota de escape.
- `<use href="sprite.svg#ic-clock"/>` — TTL countdown del stepper + 410.
- `<use href="sprite.svg#ic-info"/>` — tooltips read-only y hints.
- `<use href="sprite.svg#ic-warning"/>` — cap CA-D2 excedido.
- `<use href="sprite.svg#ic-danger"/>` — 403 no loopback.
- `<use href="sprite.svg#ic-check"/>` y `#ic-check-double` — checkbox acknowledged + chain OK + step completado.
- `<use href="sprite.svg#ic-lock"/>` — pildora cap, badge HARDCODED, field not editable.
- `<use href="sprite.svg#ic-audit"/>` — chain footer.
- `<use href="sprite.svg#ic-arrow"/>` y `#ic-arrow-back` — botones de navegación entre steps.

Si alguno de estos símbolos no existe en `sprite.svg`, se agrega en
`assets/icons/extract.js` siguiendo la convención outline 24×24 `currentColor`.

## Accesibilidad (WCAG AA verificada)

- Contraste mínimo 4.5:1 sobre `--surface-0` y `--surface-1` en todos los pares
  texto/fondo del mockup. Verificación local:
  - `--rest-mode-fg` sobre `--surface-0` = **7.4:1** (AAA).
  - `--alert-anomaly-fg` (#FFD2DC) sobre `--surface-0` = **13:1** (AAA).
  - `--purple` (#BC8CFF) sobre `--surface-1` = **5.6:1** (AA).
  - `--success` (#3FB950) sobre `--surface-1` = **5.9:1** (AA).
  - `--danger` (#F85149) sobre `--surface-1` = **5.2:1** (AA).
- Estados de error usan **ícono + texto**, nunca sólo color.
- Tooltips: `<button>` + `aria-describedby="<tooltip-id>"` + `role="tooltip"`.
  Delay 300ms hover, instantáneo focus, cerrables con Esc.
- Botones de navegación: targets táctiles ≥ 44×44 px.
- Foco visible obligatorio con outline 2px brand-cyan en todos los CTAs.
- Animaciones (countdown del TTL): respeta `prefers-reduced-motion: reduce`.

## Cómo se entrega esto al dev

1. El SVG `29-wizard-descanso-flow.svg` queda commiteado en
   `.pipeline/assets/mockups/` para que el dev lo abra en visor directo o
   embeba como referencia visual.
2. La narrativa MD queda al lado para que el dev entienda la intención sin
   leer issue + comentarios + análisis security/architect/PO uno por uno.
3. El audio `.mp3` lo genera `pipeline-dev` en fase `desarrollo` con
   `node .pipeline/scripts/generate-narrative-audio.js wizard-descanso`,
   parseando este mismo MD. Mismo perfil de voz que la narrativa modo
   descanso del mockup 04-06.
4. Cuando el dev levante #3739 en `desarrollo`, debe:
   - Crear `views/dashboard/wizard-descanso.js` consumiendo los tokens del
     listado y los íconos del sprite. Nada de HEX literales.
   - Implementar `lib/wizard-descanso-flow.js` con los 3 handlers
     descritos en la receta del architect.
   - Extender `validatePayload` en `lib/rest-mode-window.js` con
     `totalContinuousMinutesPerDay` + cap 24h.
   - Agregar el helper puro `nextWindowTransition` en el mismo archivo.
   - Cubrir los 10 tests obligatorios listados por el architect, mapeados
     1 a 1 contra las 5 tarjetas de error del mockup (T-1 → 400 CA-D2,
     T-3 → 400 field not editable, T-7 → 410, T-8 → 403, T-4 → NDJSON
     escapada).
5. Si el operador acepta más adelante editar thresholds desde el wizard
   (out of scope ahora), se abre un issue nuevo y se extiende el Step 2 —
   pero esa decisión está pre-cerrada en este slice.

## Recomendaciones de mejora (no bloqueantes — pendientes de aprobación humana)

Detecté tres oportunidades a futuro que NO bloquean #3739 pero pueden
aportar valor cuando el wizard esté en producción. Las dejo listadas
para que `/po` o `/planner` decidan abrirlas como issues independientes
con `tipo:recomendacion + needs-human` después de mergeada esta historia.
Las dejo escritas acá (no creo issues nuevos en este pasada porque el
trabajo de #3739 ya está completo y crear issues sobre infra es
contraproducente para el watchlist del pulpo):

1. **Live preview del countdown** — el preview Step 3 muestra hoy
   "3h 24min" como string estático. Podría auto-decrementar con un
   `setInterval` cliente, respetando `prefers-reduced-motion`. Aporta
   sensación de "tiempo vivo" sin tocar el servidor.
2. **Diff visual semanal** — el diff prev/next actual es una lista
   día-por-día. Una visualización compacta de calendario (chips
   superpuestos prev vs next) facilitaría detectar cambios en períodos
   irregulares. Costo: medio (~150 líneas SVG + lógica de diff).
3. **Export del schedule a ICS** — los operadores que viven en su
   calendario podrían suscribirse al modo descanso como evento recurrente
   ICS. Aporta visibilidad cross-tool. Costo: bajo (lib pura).

Estas oportunidades **no se crean ahora como issues** porque la prioridad
es cerrar el split #3715 sin scope creep. Si Leo las quiere abrir, el
texto de arriba es body listo para `gh issue create`.
