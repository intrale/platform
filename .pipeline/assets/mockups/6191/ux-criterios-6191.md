# Contrato de UX — #6191 · La tarjeta de bloqueados encabeza con la decisión

Fase `definicion/criterios`. Complementa el contrato de la madre #6173
(`.pipeline/assets/mockups/6173/ux-criterios-6173.md`), no lo reemplaza.

**Regla que gobierna todo lo de abajo:** el copy de la tarjeta lo redacta
`decision-card.js` (#6190). `bloqueados.js` aporta **jerarquía, orden y estado
de colapso**. Cero copy propio (CA-4 de la madre).

---

## Entregables (verificados en disco en este ciclo)

```
$ ls -la .pipeline/assets/mockups/6191/
6191-00-actual-ventana-bloqueados.png    baseline REAL renderizado por renderBloqueadosSsr()
6191-01-esperado-tarjeta-decision.png    mockup del estado esperado (4 estados)
ux-criterios-6191.md                     este contrato
```

Los dos PNG se generaron con **Anthropic SDK + HTML/CSS + Puppeteer**
(`.pipeline/lib/screenshot-capture.js` → `renderHtmlToPng`), scripts en
`.pipeline/tmp/ux6191/`. Tokens: `theme.css` del dashboard (`--in-*`).
**Cero color nuevo, cero ícono nuevo.**

El baseline **no es un dibujo**: invoca `renderBloqueadosSsr()` de producción
con markers reales del pipeline (`5207.po`, `5805.delivery`, `5798.po`), así que
lo que se ve es exactamente lo que el operador ve hoy.

El mockup esperado **tampoco redacta copy**: cada string de las tarjetas sale de
`buildDecisionCard()` ejecutado sobre esos mismos markers. Si el dev cambia el
copy respecto del mockup, o el mockup está desactualizado o el dev está
violando CA-4 — no hay tercera opción.

---

## Hallazgos empíricos de esta pasada (endurecen los criterios)

### H-6191-1 — Hoy la decisión no es de la tarjeta: es un subtítulo del grupo

Verificado en el baseline (`6191-00`): el texto de decisión aparece **una vez por
grupo**, en gris, itálica, 12px, al lado del rótulo del motivo
(«Destrabar manualmente (override) o esperar a que cierre la dependencia»), y la
tarjeta abre con `#6191 — <título>`. Con 4 bloqueos de 2 motivos, el operador lee
2 frases de decisión para 4 decisiones distintas. Es el defecto que CA-1 cierra.

### H-6191-2 — Sobre markers reales, 2 de 3 fichas salen SIN opciones

```
$ node -e "buildDecisionCard(<marker real>, now)"   # los 3 markers de bloqueado-humano/
#5207  tipo=indeterminado  opciones=0
#5805  tipo=indeterminado  opciones=0
#5798  tipo=pregunta       opciones=3
```

Causa verificada: `esPreguntaUsable()` exige que la `question` termine en `?` y
mida ≤160 chars. Las `question` que escriben hoy los agentes son de 300–400
chars y terminan cortadas a mitad de palabra (`…Delivery frenad`), así que no se
pueden citar literal y la ficha cae —correctamente— en `indeterminado`.

**Consecuencia para los criterios:** «opciones visibles sin abrir nada» describe
el caso minoritario. El estado *cero opciones* **no es un edge case**, es el
más frecuente, y necesita diseño propio (ver CA-UX-2). Que el dev no lo trate
como excepción, y que QA **no rebote** porque una tarjeta salga sin opciones:
es comportamiento correcto de la ficha.

### H-6191-3 — El saneo de la ficha deja pasar `"` y `&`: hay que escapar igual

Re-verificado con el título más hostil que se puede escribir en un repo público:

```
$ node -e "buildDecisionCard({title:'Bug\" onmouseover=alert(1) x=\"  & <script>alert(2)</script> R&D', ...})"
titulo en ficha  : "#9999 «Bug\" onmouseover=alert(1) x=\" & scriptalert(2)script R&D»"
tiene comilla "  : true
tiene ampersand &: true
tiene < o >      : false
```

Suscribe R-SEC-1 del análisis de `security`. El saneo mata `<`/`>` (que es lo que
rompe Telegram) pero **no toca `"` ni `&`** — que es justo lo que rompe un
atributo HTML. Sin `escapeHtmlAttr` en `title=`/`aria-label=`, ese título cierra
el atributo e inyecta un handler **sin usar un solo `<`**.

### H-6191-4 — Los nombres de campo del análisis de seguridad NO existen en la ficha

```
$ node -e "Object.keys(buildDecisionCard(...))"
tipo, issue, que_esta_frenado, por_que_esta_frenado, que_se_decide,
que_se_decide_corto, opciones, evidencia_minima, costo_de_no_decidir,
sugerencia_del_pipeline, sin_recomendacion_porque, indeterminado, falta,
ejemplo_de_valor, pie_destrabe

card.por_que  existe? false
card.evidencia existe? false
card.costo     existe? false
```

El requisito R-SEC-1 nombra `card.por_que`, `card.evidencia[]` y `card.costo`.
Los campos reales son `por_que_esta_frenado`, `evidencia_minima[]` y
`costo_de_no_decidir`. **La intención de R-SEC-1 se conserva entera**; sólo se
corrigen los nombres, para que la checklist de revisión no valide campos
inexistentes y dé un falso verde.

### H-6191-5 — 21 opciones en la tabla congelada contra 4 handlers ejecutables

```
$ node -e "Object.keys(OPCION).length"                       21
$ grep -n "window.needsHuman" views/dashboard/bloqueados.js   4  (Cta, Reactivate, Dismiss, Respond)
```

Y `card.opciones[]` tiene 4 claves —`etiqueta`, `consecuencia`, `es_recomendada`,
`razon_recomendacion`— **ninguna es un identificador de acción**. Suscribe G-1 del
`guru`. Es lo que obliga a reescribir CA-6 (abajo).

---

## Decisiones de UX que cierro yo

### D-1 · Las opciones son INFORMACIÓN, no botones

Las `card.opciones[]` se renderizan como **lista de texto**: etiqueta en negrita +
consecuencia debajo. **No** son botones ni links en esta historia.

Razones, en orden:

1. **No hay a qué mapearlas** (H-6191-5): 21 etiquetas contra 4 handlers, y la
   opción no trae identificador. Cualquier mapeo sería un heurístico por texto
   — exactamente lo que R-SEC-3 prohíbe.
2. **Un botón que no hace lo que dice es el peor defecto de UX posible.**
   «Sacarlo del plan de esta ola» no tiene handler; renderizarlo como botón es
   prometer una acción inexistente.
3. La opción sirve para **decidir**, no para ejecutar: el operador necesita saber
   qué pasa por cada camino. La ejecución sigue por los botones que ya existen y
   por `/unblock` en Telegram.

Darles acción a las 21 opciones es **#6184**, y ahí es donde tiene que ir el
campo `accion` de `opcion()`. Fuera de alcance acá.

### D-2 · «Desestimar queda arriba» = queda VISIBLE, no queda PRIMERA

Precisión sobre mi propia decisión 4 del contrato de la madre, porque se
malinterpreta fácil. «Arriba» significa **en el bloque visible de la tarjeta**,
no dentro del `<details>` — no significa «primer botón de la fila». Una acción
destructiva no se pone primera en el orden de lectura.

Layout de la fila de acciones (mockup, panel A):

```
[↻ Reintentar]  [🔓 Destrabar]  ─────── espacio flexible ───────  [✕ Desestimar]
   CTA primario    secundaria                                       destructiva,
   (relleno)       (contorno)                                       separada y a la derecha
```

Y el `<details>` cerrado se lleva **Ver issue / Ver logs / Telegram**.
La confirmación por `prompt` de Desestimar **se conserva intacta** (R-SEC-3): que
la acción sea más visible no puede saltear la confirmación.

### D-3 · `pie_destrabe` NO se renderiza en la tarjeta

`pie_destrabe` («Para decidir, respondé: `/unblock 6191 …`») es la superficie de
acción **de Telegram**. En el dashboard esa función la cumplen los botones, y el
panel ya tiene su pie global de `/unblock`.

Esto **no viola CA-4**: consumir la misma ficha significa que ningún canal
redacta copy propio. **No** significa que todo canal renderice todos los campos.
Cada canal elige el subconjunto que su superficie soporta; el texto sigue siendo
uno solo.

Campos que la tarjeta **sí** renderiza: `que_se_decide`, `que_esta_frenado.titulo`,
`que_esta_frenado.desde`, `por_que_esta_frenado`, `opciones[]`,
`sin_recomendacion_porque`, `falta`, `costo_de_no_decidir`, `evidencia_minima[]`.
Campos que **no**: `que_se_decide_corto` (es el de la lista agrupada de Telegram),
`pie_destrabe`, `ejemplo_de_valor`.

### D-4 · El `<summary>` tiene que decir qué hay adentro

Nada de «Ver más» / «Detalle» pelado. El rótulo del colapsable nombra su
contenido: **«Detalle técnico del bloqueo · motivo completo, actividad reciente
y accesos»**. Con 2 de 3 fichas indeterminadas (H-6191-2), ese `<details>` es a
menudo la única información accionable: si el rótulo no dice qué guarda, el
operador no lo abre.

---

## Criterios de aceptación — ajustes y agregados

### CA-6 · REESCRITO (el original es incumplible — G-1 / H-6191-5)

> ~~La fila de 6 botones actual se reordena: las opciones de la ficha reemplazan
> CTA y Destrabar; Desestimar queda arriba; Ver issue / Ver logs / Telegram bajan
> al detalle colapsado.~~

**Nueva redacción:**

> Las `card.opciones[]` se muestran como **lista de texto** (etiqueta +
> consecuencia), no como botones. La fila de acciones ejecutables **conserva**
> CTA y Destrabar, y **baja al `<details>`** Ver issue / Ver logs / Telegram.
> Desestimar permanece **visible** (fuera del `<details>`), separada del grupo de
> acciones no destructivas y con su confirmación actual intacta. Ninguna
> etiqueta de opción se convierte en `onclick`, `href` ni `data-action`.

### CA-UX-1 (agregado) · Jerarquía tipográfica de la tarjeta

`que_se_decide` es el elemento de mayor peso visual de la tarjeta: **encabezado
semántico** (`<h3>` o equivalente), ~16–17px, bold. El `#N «título»` pasa a
subtítulo secundario (~12,5px, color atenuado). Hoy es al revés (baseline
`6191-00`): el título grita y la decisión susurra desde el grupo.

### CA-UX-2 (agregado) · Estado «cero opciones» diseñado, no vacío

Cuando `card.opciones.length === 0` (ficha indeterminada — el caso más frecuente,
H-6191-2), la tarjeta muestra **visible** el campo `card.falta` de la ficha, en el
lugar donde irían las opciones, con tratamiento de nota (fondo tenue, borde
punteado). Prohibido dejar el hueco vacío y prohibido redactar un texto propio
tipo «sin opciones disponibles»: `falta` ya existe justamente para esto.
El `<details>` **sigue cerrado por default** también en este caso (CA-3 no se
toca); lo que compensa el vacío es `falta` + `por_que_esta_frenado` +
`costo_de_no_decidir`, los tres visibles.

### CA-UX-3 (agregado) · La opción recomendada se distingue sin depender del color

Cuando alguna opción trae `es_recomendada: true`, se marca con **glifo `★` +
barra de acento a la izquierda + la `razon_recomendacion` visible**. Tres señales,
una de ellas no cromática (WCAG 1.4.1: el color no puede ser el único portador).
Cuando **ninguna** opción es recomendada, se renderiza
`card.sin_recomendacion_porque` como línea propia. **Prohibido** inventar una
estrella cuando la ficha no la trae: cero recomendadas es válido y esperado en
`firma` y `pregunta`.

### CA-UX-4 (agregado) · `costo_de_no_decidir` siempre visible

`card.costo_de_no_decidir` se renderiza **siempre**, fuera del `<details>`, con
rótulo de urgencia. Es lo único de la tarjeta que responde «¿y si no hago nada?»,
que es la pregunta que hoy el panel no contesta en ningún lado.

### CA-5 · PRECISIÓN de nombres (H-6191-4)

Los campos que pasan **obligatoriamente** por `escapeHtmlText` (nodo texto) o
`escapeHtmlAttr` (atributo) son, con sus nombres reales:

```
card.que_se_decide
card.que_esta_frenado.titulo      ← el vector de H-6191-3 (título de repo público)
card.que_esta_frenado.desde
card.por_que_esta_frenado
card.opciones[].etiqueta
card.opciones[].consecuencia
card.opciones[].razon_recomendacion
card.sin_recomendacion_porque
card.falta
card.costo_de_no_decidir
card.evidencia_minima[]
```

Sin excepción por «ya viene saneado» (H-6191-3). Se mantiene `innerHTML` fuera de
todo camino alimentado por la ficha.

### CA-UX-5 (agregado) · Accesibilidad mínima verificable

- El `<details>`/`<summary>` nativo aporta el foco de teclado y el estado
  expandido/colapsado sin ARIA extra: **no** reimplementar el colapsable con
  `div` + `onclick` (además es lo que hace la decisión 1 de la madre).
- Contraste AA sobre el fondo de tarjeta (`--in-bg-2 #161b22`). Ratios calculados
  en esta pasada (fórmula WCAG 2.1 de luminancia relativa):

  ```
  #e6edf3 (--in-fg)       14,64:1   AA / AAA
  #8b949e (--in-fg-dim)    5,62:1   AA  ← texto de consecuencia: OK
  #6e7681 (--in-fg-soft)   3,77:1   NO llega a AA para texto chico
  #d29922 (--in-warn)      6,85:1   AA
  #f85149 (--in-bad)       5,16:1   AA
  #2ee6c1 (--in-accent)   10,88:1   AA / AAA
  ```

  El texto de `consecuencia` y `evidencia_minima` usa `--in-fg-dim` como piso.
  **Prohibido** bajar a `--in-fg-soft` para texto de la ficha: no llega a AA.
  `--in-fg-soft` queda sólo para glifos decorativos y rótulos ≥18px.
- Cada tarjeta es un `article` con el encabezado como primer elemento: el orden
  de lectura del lector de pantalla arranca por la decisión, igual que el visual.

### Sin objeciones

CA-1, CA-2, CA-3, CA-4, CA-7 quedan **tal cual**. Las tres decisiones cerradas del
issue no se re-litigan: `<details>` inline, los 5 `MOTIVOS[*].decision` no migran
tal cual, y lo que no se entiende sin conocer el pipeline va al colapsado.

---

## Nota sobre los gaps del `guru` (no son míos, pero me tocan)

- **G-2** (`dashboard.js:1863-1878` no copia `evidence`/`precondition`): con
  `evidence` ausente, la ficha del dashboard pierde la cita del issue que sí
  tiene la de Telegram → **dos superficies con distinta evidencia para el mismo
  bloqueo**, que es lo que CA-4 quiere evitar. Desde UX: sumar `dashboard.js` a
  los archivos modificados del issue.
- **G-3** (sin `dep_age_hours`/`rebotes`/`labels` casi nunca hay recomendada):
  el panel A del mockup muestra la tarjeta **con** ese contexto, para que se vea
  qué se gana cuando llega. Sin él, la tarjeta degrada a la variante B (sin
  estrella + `sin_recomendacion_porque`), que también está mockeada y **es un
  render válido, no un bug**.

## Nota de commit

No se commitea desde este agente: el checkout está parado en
`bugfix/intake-maxbuffer-enobufs` (rama ajena) con el árbol sucio de estado
runtime del pipeline. Commitear ahí contaminaría trabajo de otro. Los assets
quedan en `.pipeline/assets/mockups/6191/` y este contrato viaja además como
comentario del issue, que es lo que verifica `validacion`.

## Recomendaciones pendientes de aprobación humana

Ninguna nueva. Las oportunidades detectadas ya tienen issue abierto: **#6184**
(acciones ejecutables para todas las opciones), **#6175** (componente colapsable
compartido), **#7044** (endurecer la interpolación en `onclick`), **#6189**
(unificar la redacción de antigüedad).
