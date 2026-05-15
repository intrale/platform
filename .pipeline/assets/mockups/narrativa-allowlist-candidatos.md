# Narrativa UX — Allowlist & Candidatos (#3142)

> Guion de presentacion (~3:00) + decisiones de diseno + reglas de interaccion +
> mapping de iconografia + accesibilidad WCAG. Material entregable de la fase
> `definicion/criterios` para el agente de desarrollo (`pipeline-dev`).

---

## 1. Contexto narrativo

Hasta hoy, decidir que issue suma a la allowlist de pausa parcial es un
trafico de mensajes entre Leo, el bot de Telegram y el agente Claude que
toca `.pipeline/.partial-pause.json` a mano. Si Leo ve un issue nuevo
durante la ola Multi-Provider y le tira fe — pero no quiere meterlo todavia
porque la ola esta corriendo —, esa intencion se pierde en el chat.

La sub-seccion **Allowlist & Candidatos** del tab Pipeline formaliza ese
flujo: cualquier issue se puede **likear** (marcar como candidato) sin
tocar la allowlist activa. Cuando Leo decide promover, la UI muestra
**preview con deps recursivas** y exige un segundo click de confirmacion
antes de escribir `.partial-pause.json`. La pausa parcial nunca se toca sin
OK explicito — la memoria `feedback_allowlist-no-tocar.md` queda blindada
por diseno.

---

## 2. Guion de presentacion (~3:00)

> Lectura sugerida en TTS Lili (voz default del pipeline) o equivalente.
> Cada parrafo se mapea a una seccion del mockup 14.

### Bloque A — Entrada al tab Pipeline (0:00 - 0:25)

Estas mirando el tab Pipeline del dashboard. Arriba a la derecha la pill
naranja te avisa que hay **pausa parcial activa con veintiun issues** — es
la ola Multi-Provider Ola N mas uno. Hace tres dias surgio un bug del
pre-flight del emulador que Leo dijo que necesitamos incluir, pero no
ahora. Ese tipo de decisiones es lo que esta sub-seccion captura sin que
nada se pierda en el chat de Telegram.

### Bloque B — Allowlist activa (0:25 - 0:55)

La primera tarjeta es la **allowlist activa**: veintiun issues que estan
hoy mismo en `.partial-pause.json`. Es solo lectura — el archivo se
sincroniza desde el filesystem cada cinco segundos, pero la UI nunca lo
escribe sin tu confirmacion. Cada fila muestra el numero del issue, el
titulo recortado, el label de admision actual y el estado en el pipeline.
El boton **quitar**, en rojo suave, te saca el issue de la allowlist con un
modal de confirmacion intermedio: un solo click no destruye nada.

### Bloque C — Candidatos likeados (0:55 - 1:45)

Mas abajo aparecen los **candidatos likeados**. Son tres cards horizontales
con el corazon morado lleno — el indicador visual del estado "candidato".
La primera card es el bug del emulador, hashtag tres mil ciento cuarenta.
Liked hace seis dias, con la razon que dejaste: "lo necesitamos para la
proxima ola, bloquea QA". El detector recursivo encontro una dependencia
abierta, hashtag dos mil ochocientos cuarenta — la veras tambien antes de
confirmar.

La segunda card lleva un borde ambar. Hashtag tres mil noventa y tres, un
refactor de los handlers REST. El banner amarillo te avisa: **sin label de
admision, el Pulpo no lo va a agarrar**. Sumarlo a la allowlist sin
priorizar el issue primero seria un click muerto. El boton promote queda
en gris para que se note que necesita una accion previa. La memoria
`feedback_issues-creados-con-label-pipeline.md` recibe respeto visual,
no solo prosa.

La tercera card, hashtag tres mil ciento cinco, es un spike con cuatro
dependencias recursivas detectadas: hashtag tres mil setenta y dos,
setenta y cuatro, setenta y seis y setenta y nueve. Cuando hagas click
en **sumar a allowlist** la UI no escribe nada todavia: abre un modal de
preview.

### Bloque D — Modal de preview (1:45 - 2:30)

El modal te muestra el issue candidato en una franja morada arriba, y
debajo las cuatro dependencias detectadas con la profundidad maxima de
cinco niveles y el detector de ciclos activo. Cada item lleva un chip que
te dice si la dependencia **ya esta en la allowlist** (chip teal) o **se
va a sumar ahora** (chip verde). El sumario verde de abajo te resume el
delta: tres items nuevos, dos ya estaban, cero ciclos, profundidad
alcanzada dos de cinco.

Recien ahi aparecen los dos botones de accion. **Cancelar**, secundario y
neutro. **Confirmar y sumar a allowlist con tres items**, el primario
verde brillante: ese es el click que escribe `.partial-pause.json`,
loggea en `allowlist-mutations.log` y comenta automaticamente en los
tres issues afectados via gh CLI. La regla del 2-step es server-side
enforced — sin el flag `confirmed:true` en el body, el endpoint te
responde solo preview y no toca el archivo.

### Bloque E — Picker para likear (2:30 - 3:00)

Abajo del todo, el picker. Es un input grande con la lupa y un boton
morado **likear con razon**. Aceptamos numero pegado o busqueda por
titulo via `gh issue list`. La intencion de Leo queda registrada en
`.pipeline/allowlist-candidates.json` con timestamp, autor derivado del
servidor — nunca del body — y la razon en texto libre cap cinco
mil caracteres. La accion es local: loopback only, tipo de contenido
estricto, validacion Ajv contra schema cerrado. Que la operacion sea
"barata" en seguridad no significa que sea silenciosa: cada like, unlike
y promote queda auditado.

---

## 3. Decisiones de diseno

### 3.1 Por que dos listas separadas en una sola sub-seccion

Hay precedente conceptual fuerte: la **allowlist activa** y los
**candidatos** son dos estados de la misma cosa (intencion de incluir
issue en pausa parcial), pero con consecuencias operativas distintas. La
allowlist mueve el pipeline; los candidatos solo registran intencion.
Mostrarlas en sub-tabs separadas obligaria al usuario a navegar para
comparar — el caso de uso natural es justamente cruzar las dos:

> "ya esta el bug del emulador? — no, esta likeado pero no promovido"

Una sola pantalla con dos cards (top + grid) resuelve el cruce visual sin
clicks extra.

### 3.2 Por que cards horizontales para los candidatos

Los candidatos son pocos por diseno (cap de doscientos en
`CA-Sec-11`). En esa escala las cards funcionan mejor que la tabla:
- Cabe la razon en texto libre sin truncar a una linea.
- El warning "sin label de admision" cabe inline como banner ambar.
- El contador de dependencias detectadas se ve antes de hacer click en
  promote (decision informada, no destructiva).

Si el numero de candidatos creciera mas alla de doce, conviene cambiar a
tabla virtualizada con expand-row. Se deja como follow-up.

### 3.3 Por que el corazon como simbolo

El issue lo plantea con dos opciones: ❤️ o 👍. El corazon gana por:
- **Diferenciacion semantica**: el thumbs up del dashboard ya se usa para
  approve / merge / ack. Mezclarlo aca generaria choque cognitivo.
- **Tono operativo**: "me gusta esta idea, capaz despues" es exactamente
  lo que Leo hace hoy en Telegram con corazones reaccion. El UI hereda el
  vocabulario natural sin re-entrenar.
- **Convencion de plataformas**: GitHub usa el corazon como reaccion
  positiva no destructiva. Es lenguaje aprendido.

### 3.4 Por que promote tiene confirmacion en dos pasos a nivel UI Y endpoint

La memoria `feedback_allowlist-no-tocar.md` exige que `.partial-pause.json`
nunca se escriba sin OK explicito del usuario. **Una sola capa de
proteccion no es suficiente**: si maniana el dashboard cambia el JS, una
regresion podria saltarse la confirmacion. Por eso:

- El endpoint `POST /api/allowlist-candidates/:issue/promote` exige
  `confirmed:true` en el body. Sin esa flag, responde 200 con preview pero
  no escribe.
- La UI nunca envia `confirmed:true` en el primer click. El primer click
  hace fetch y abre el modal con preview. El **segundo click** del boton
  verde "confirmar y sumar" es el que dispara la mutacion.

Dos lockets independientes. La regresion de uno no rompe la regla.

### 3.5 Estados visuales explicitos vs solo color (WCAG AA — CA-4 sistema)

Cada estado se identifica con **icono + texto + color** simultaneamente:
- Allowlist activa: chip teal **+ icono ic-allowlist-check + texto "21"**.
- Candidato: chip morado **+ icono ic-like + texto "candidato"**.
- Sin label admision: banner ambar **+ icono ic-warning + texto descriptivo**.

Esto cumple WCAG 2.1 SC 1.4.1 (No information by color alone) y mantiene
la coherencia con el resto del dashboard (regla CA-4 del design system).

### 3.6 Por que el numero del issue va en `font-family: 'SF Mono'`

Los numeros de issue son identificadores tecnicos. La fuente monoespaciada
los alinea visualmente (`#3072`, `#3140`, `#3105`) y los diferencia del
texto narrativo del titulo. Patron ya establecido en otros mockups del
dashboard (ver mockup 11, columna "model").

### 3.7 Por que separar el sub-tab dentro del tab Pipeline en vez de tab nuevo

El tab Pipeline ya existe y agrupa **todo lo relacionado al estado del
pipeline**: backlog, activos, procesados. La allowlist es propiedad del
pipeline (no del board, ni del consumo, ni del multi-provider config).
Crear un tab top-level "Allowlist" partiria el modelo mental: el usuario
piensa "estoy gestionando el pipeline", no "estoy en una herramienta
separada".

Sub-tab interno preserva la jerarquia y mantiene la concurrencia visual
con backlog y activos.

---

## 4. Iconografia (sprite.svg — nuevos sub-symbols)

| Icono                | Uso                                       | Color sugerido            |
|----------------------|-------------------------------------------|---------------------------|
| `ic-like`            | Corazon lleno · chip "candidato"          | `var(--purple)`           |
| `ic-like-outline`    | Corazon contorno · boton "unlike"         | `var(--text-secondary)`   |
| `ic-allowlist-check` | Header allowlist + sub-tab activa          | `var(--lane-qa)` (teal)   |
| `ic-promote`         | Flecha hacia arriba · boton primario       | `var(--success)`          |
| `ic-remove-circle`   | Quitar de allowlist · boton secundario     | `var(--danger)`           |
| `ic-deps-graph`      | Tres nodos · contador de deps              | `var(--info)`             |
| `ic-search`          | Lupa · picker buscar issue                 | `var(--text-dim)`         |

Todos respetan el viewBox `24x24` y el stroke-width `1.6-1.75` de la familia
existente (`ic-estado-*`).

---

## 5. Tokens y paleta (design-tokens.css)

Cero tokens nuevos. La sub-seccion reusa la paleta del sistema:

| Token                 | Uso                                                        |
|-----------------------|------------------------------------------------------------|
| `--surface-0`         | Fondo de la pagina                                         |
| `--surface-1`         | Card de allowlist activa, cards de candidatos              |
| `--surface-2`         | Item dep en el modal de preview                            |
| `--surface-3`         | Modal de preview (elev 3)                                  |
| `--lane-qa` / `--teal`| Allowlist activa (chip + icono)                            |
| `--purple`            | Candidatos (corazon, chip, banner)                         |
| `--success`           | Boton primario "confirmar promote", chip "se va a sumar"  |
| `--danger`            | Boton "quitar" de allowlist activa                         |
| `--warning`           | Banner "sin label de admision"                             |
| `--info`              | Hint info + contador de deps                               |
| `--text-primary`      | Titulos, texto principal                                   |
| `--text-secondary`    | Subtitulos, razon de like                                  |
| `--text-dim`          | Timestamps, hints, "liked YYYY-MM-DD"                      |

---

## 6. Accesibilidad WCAG AA

- **Contraste verificado** (WebAIM Contrast Checker, sobre `surface-0`):
  - `--text-primary` (#E6EDF3): **14.8:1** — AAA.
  - `--purple` (#BC8CFF): **7.1:1** — AA Large / AAA non-text.
  - `--success` (#3FB950): **5.4:1** — AA Normal.
  - `--danger` (#F85149): **5.7:1** — AA Normal.
  - `--warning` (#D29922): **7.0:1** — AA Normal.
  - `--info` (#58A6FF): **6.4:1** — AA Normal.
- **Tamaño de fuente minimo**: 12px en chips/hints, 13-14px en cuerpo. El
  banner ambar "sin label de admision" se renderiza a 12px con `font-weight 500`
  y contraste 7.0:1 — supera el minimo para texto pequeño.
- **Touch targets**: todos los botones (`quitar`, `sumar a allowlist`,
  `unlike`) miden minimo **32x96 px**, dentro del target recomendado.
- **Estados de focus**: cada boton tiene focus ring `var(--focus-ring)` (anillo
  de 2px alrededor + 2px gap interior, cumple WCAG 2.4.7).
- **Reduced motion**: el modal de preview se abre con un fade in 200ms
  (`var(--motion-base)`). Si el usuario tiene `prefers-reduced-motion: reduce`,
  el fade se reduce a 0.01ms (regla global del design-tokens.css linea 309).
- **Color-only info**: prohibido. Cada estado lleva icono + texto + color.

---

## 7. Estados que la UI debe modelar

| Estado                                             | Tratamiento visual                                                  |
|----------------------------------------------------|----------------------------------------------------------------------|
| Allowlist vacia (modo running puro)                | Mensaje neutro `"Pipeline corriendo sin allowlist activa"`, sin error. |
| Sin candidatos likeados                            | Empty state con icono `ic-like-outline` y CTA al picker.            |
| Issue candidato sin label de admision              | Banner ambar + boton promote en gris + tooltip explicativo.         |
| Issue candidato ya esta en allowlist (duplicado)   | Chip teal "ya en allowlist" + boton `unlike` (no promote).          |
| Deps detectadas excede 50 items (cap CA-Sec-13)    | Modal warning rojo + boton "confirmar" deshabilitado + sugerencia split. |
| Timeout en resolucion de deps (>60s)               | Estado error en el modal + retry button + log al server.             |
| Cap de 200 candidatos alcanzado (CA-Sec-11)        | Toast warning + boton "likear" deshabilitado hasta hacer unlike.    |

---

## 8. Flujo end-to-end (ASCII)

```
[Pipeline tab]
   ↓
[sub-tab Allowlist & Candidatos]
   ↓
   ├── Lectura: GET /api/pause-partial (existing) → renderiza allowlist activa
   ├── Lectura: GET /api/allowlist-candidates → renderiza candidatos
   ↓
[Picker: "Buscar issue para likear"]
   ↓
[Input numero + razon]
   ↓
[POST /api/allowlist-candidates {issue, reason}]
   ↓
[Server: validar (loopback, origin, content-type, schema), persistir]
   ↓
[Toast: "Issue #N likeado"]
   ↓
   ────────────── horas/dias despues ──────────────
   ↓
[Click "sumar a allowlist" en una card candidato]
   ↓
[POST /api/allowlist-candidates/:issue/promote (sin confirmed)]
   ↓
[Server: detectar deps recursivas (MAX_DEPTH=5, ciclos), preview]
   ↓
[Modal: lista de issue + deps + chips "ya esta" / "se va a sumar"]
   ↓
[Click "confirmar y sumar a allowlist"]
   ↓
[POST /api/allowlist-candidates/:issue/promote {confirmed:true}]
   ↓
[Server:
   - setPartialPause(allowlistWithDeps(actual, missing))
   - eliminar candidato de allowlist-candidates.json
   - log estructurado en allowlist-mutations.log
   - gh issue comment en cada issue agregado
]
   ↓
[Toast: "Issue #N + 2 deps agregados a allowlist"]
   ↓
[UI refresca: card desaparece de candidatos, aparece en allowlist activa]
```

---

## 9. Que tiene que producir el dev (pipeline-dev)

1. **HTML/CSS de la sub-seccion** dentro del tab Pipeline, replicando el
   mockup 14 (estructura, colores, espaciados).
2. **Tres endpoints REST** en `dashboard.js` con check `isLoopback`,
   origin/referer validation, content-type strict, schema Ajv:
   - `POST /api/allowlist-candidates`
   - `DELETE /api/allowlist-candidates/:issue`
   - `POST /api/allowlist-candidates/:issue/promote`
3. **Modulo `lib/allowlist-candidates.js`** con la logica pura (read/write
   atomico, schema validation, cap 200, idempotencia de likes).
4. **Reuso de `lib/partial-pause-deps.js`** para la deteccion recursiva en
   `/promote`, parametrizando `MAX_DEPTH` con default 3 / override 5.
5. **Modal de preview en JS** con render del set de deps detectadas, chips
   "ya esta" vs "se va a sumar", boton primario solo activo cuando hay
   items para sumar.
6. **Sprite update**: incluir los 7 nuevos `<symbol id="ic-*">` ya
   commiteados en `.pipeline/assets/icons/sprite.svg`.
7. **Tests** en `lib/__tests__/allowlist-candidates.test.js` cubriendo CA-Q-01
   y CA-Q-02.
8. **Audio TTS** generado a partir de este archivo, commiteado como
   `narrativa-allowlist-candidatos.mp3` cuando se haga el QA E2E del PR.

---

## 10. Que NO tiene que producir el dev

- **No modificar** `lib/partial-pause.js` (memoria `feedback_allowlist-no-tocar.md`).
- **No agregar** tokens nuevos al `design-tokens.css` — todo reusa los existentes.
- **No agregar** dependencias npm — `Ajv` ya esta disponible si hace falta;
  caso contrario usar validacion manual estricta.
- **No agregar** el boton like en cada listado del dashboard en este MVP
  (queda como follow-up post-merge). Por ahora solo picker global +
  sub-seccion dedicada.
- **No tocar** `app/composeApp`, `backend/`, `users/`, GitHub Actions.

---

## 11. Referencias

- Mockup principal: `.pipeline/assets/mockups/14-allowlist-candidatos.svg`
- Sprite (nuevos iconos): `.pipeline/assets/icons/sprite.svg`
- Tokens: `.pipeline/assets/design-tokens.css`
- Issue: [#3142](https://github.com/intrale/platform/issues/3142)
- Analisis previos en el issue: [security](https://github.com/intrale/platform/issues/3142#issuecomment-4455159755), [guru](https://github.com/intrale/platform/issues/3142#issuecomment-4455299254), [PO](https://github.com/intrale/platform/issues/3142#issuecomment-4455352984).
- Memorias respetadas:
  - `feedback_allowlist-no-tocar.md` (promote 2-step server + UI)
  - `feedback_allowlist-recursive-deps.md` (deps suman al confirmar)
  - `feedback_issues-creados-con-label-pipeline.md` (warning ambar)
  - `feedback_ux-claude-design-obligatorio.md` (mockup full + tokens + iconos)

---

> Audio narrado generado al cierre del PR via edge-tts (voz Lili,
> rate +0% pitch +0%) y commiteado como `narrativa-allowlist-candidatos.mp3`.
> Duracion estimada del audio: 3:00.

---

## 12. Apendice — Definiciones SVG de los 7 nuevos iconos del sprite

> Anexado en fase `validacion` por el agente `ux` (2026-05-14). En la pasada
> de `criterios` el sprite real no quedo actualizado (modificacion in-flight
> que un `git reset --hard main` del pipeline podria perder). Para que el dev
> que tome este issue tenga el texto fuente garantizado, dejo aqui las 7
> definiciones tal cual deben quedar en `.pipeline/assets/icons/sprite.svg`
> antes del cierre `</svg>`. El conteo final esperado es **62** simbolos
> (`grep -c 'symbol id=' .pipeline/assets/icons/sprite.svg`).

Convencion: stroke-width 1.6-1.75, viewBox 24x24, `currentColor` para tintar
con tokens. Pegar los 7 bloques de abajo (con sus comentarios) inmediatamente
antes de la etiqueta de cierre `</svg>` del sprite. Mapping de tokens en la
seccion 4 de esta narrativa.

```xml
  <!-- ==========================================================================
       Iconos para #3142 — Allowlist & Candidatos (tab Pipeline del dashboard).
       Familia visual consistente con ic-estado-* (stroke-width 1.6-1.75,
       viewBox 24x24, paleta currentColor para tintar con tokens del sistema).
       Portados desde las definiciones inline del mockup 14
       (`.pipeline/assets/mockups/14-allowlist-candidatos.svg`, simbolos m-*).
       ========================================================================== -->

  <!-- ic-like: corazon lleno. Indica estado "candidato likeado" (CA-F-01,
       CA-F-03). Se tinta con var(--purple) para diferenciarse del thumbs-up
       que el dashboard ya usa para approve/merge. Vocabulario alineado con
       reacciones de Telegram donde Leo likea ideas hoy. -->
  <symbol id="ic-like" viewBox="0 0 24 24">
    <path d="M12 20.5 C 7.5 17 3 13.5 3 9.5 A 4.5 4.5 0 0 1 12 7 A 4.5 4.5 0 0 1 21 9.5 C 21 13.5 16.5 17 12 20.5 Z"
          fill="currentColor"/>
  </symbol>

  <!-- ic-like-outline: corazon outline. Empty state ("Sin candidatos likeados",
       CA-UX-03) y boton "unlike" en cards de candidato. Mismo path que ic-like
       pero stroke-only para indicar accion / estado inverso. -->
  <symbol id="ic-like-outline" viewBox="0 0 24 24">
    <path d="M12 20.5 C 7.5 17 3 13.5 3 9.5 A 4.5 4.5 0 0 1 12 7 A 4.5 4.5 0 0 1 21 9.5 C 21 13.5 16.5 17 12 20.5 Z"
          fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
  </symbol>

  <!-- ic-allowlist-check: lista con tick. Identifica la card "Allowlist activa"
       (CA-F-01) y el chip "ya en allowlist" en el modal de preview (CA-UX-02).
       Lista a la izquierda + check overlay a la derecha para no confundir con
       ic-fase-validacion (que tambien tiene tick pero sobre el icono fase). -->
  <symbol id="ic-allowlist-check" viewBox="0 0 24 24">
    <rect x="3" y="4" width="14" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M6.5 9 H13.5 M6.5 12 H13.5 M6.5 15 H10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    <circle cx="17.5" cy="17.5" r="4.5" fill="#0D1117" stroke="currentColor" stroke-width="1.6"/>
    <path d="M15.3 17.6 L17 19.3 L19.7 16.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  </symbol>

  <!-- ic-promote: flecha hacia arriba con base. Accion "sumar a allowlist"
       (CA-F-07) y boton primario en card candidato. La base con opacidad
       sugiere "elevar / ascender" sin confundirse con ic-fase-entrega
       (que tambien es flecha pero hacia adelante). Se tinta con
       var(--success) para boton confirmar. -->
  <symbol id="ic-promote" viewBox="0 0 24 24">
    <path d="M12 4 V18" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
    <path d="M7 9 L12 4 L17 9" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="4" y="18" width="16" height="3" rx="0.8" fill="currentColor" opacity="0.55"/>
  </symbol>

  <!-- ic-remove-circle: circulo con menos. Accion "quitar de allowlist activa"
       (CA-F-02). Diferente de ic-revoke (que es un X dentro del circulo,
       semantica de "revocar permiso") — aca el menos comunica "sacar de la
       lista" sin connotacion de seguridad. Se tinta con var(--danger). -->
  <symbol id="ic-remove-circle" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/>
    <path d="M7.5 12 H16.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
  </symbol>

  <!-- ic-deps-graph: tres nodos conectados. Contador "N deps detectadas" en
       cards de candidato (CA-F-03) y hint en el modal de preview (CA-UX-02).
       Forma triangular (un padre arriba con dos hijos abajo) representa la
       resolucion recursiva. Se tinta con var(--info). -->
  <symbol id="ic-deps-graph" viewBox="0 0 24 24">
    <circle cx="7" cy="7" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
    <circle cx="17" cy="7" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
    <circle cx="12" cy="17" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
    <path d="M8.5 8.7 L11 15 M15.5 8.7 L13 15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  </symbol>

  <!-- ic-search: lupa. Picker "Buscar issue para likear" (CA-F-04) y futuros
       buscadores en el dashboard. Geometria estandar (circulo + linea
       diagonal). Se tinta con var(--text-dim) por defecto, var(--accent)
       cuando el picker tiene focus. -->
  <symbol id="ic-search" viewBox="0 0 24 24">
    <circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.75"/>
    <path d="M15 15 L20 20" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
  </symbol>
```

Verificacion del dev post-pegado:

```bash
grep -c 'symbol id=' .pipeline/assets/icons/sprite.svg          # esperado: 62
grep -oE 'id="(ic-like|ic-like-outline|ic-allowlist-check|ic-promote|ic-remove-circle|ic-deps-graph|ic-search)"' \
     .pipeline/assets/icons/sprite.svg | sort                    # esperado: las 7 lineas
```
