## Diseño de experiencia — `ux` (fase `criterios`)

**Veredicto: aprobado.** El contrato de copy de la madre #6173 sigue vigente y no se re-litiga. Lo que faltaba —y entrego en este ciclo— son las **4 superficies que #6190 toca y la madre no escribió**.

### Entregables (verificados en disco en este ciclo)

```
$ ls -la .pipeline/assets/mockups/6190/
6190-01-telegram-presupuesto-recordatorio-fallback.svg   13898 bytes
ux-criterios-6190.md                                     17980 bytes

$ validacion XML del SVG (parser de pila + chequeo de & crudo)
XML BIEN FORMADO | amp crudo: 0

$ render real (Chrome headless 1740x1274) -> inspeccionado visualmente
4 paneles, sin solapamientos, sin clipping. Cero color nuevo: solo design-tokens.css.
```

# Contrato de copy — #6190 (addendum del contrato madre de #6173)

> **Qué es esto.** El contrato madre (`.pipeline/assets/mockups/6173/ux-criterios-6173.md`
> + `issuecomment-5343233526`) ya fijó las **7 plantillas `tipo → ficha`**, el glosario de
> 22 entradas, la lista negra de jerga y la tabla de antigüedad. **Nada de eso se
> re-litiga acá y sigue siendo el contrato vigente.**
>
> Este addendum cubre **sólo las 4 superficies que #6190 toca y que la madre no
> escribió**, verificadas ausentes en este ciclo:
>
> ```
> $ for t in "quedaron afuera" "compacta" "presupuesto" "recordatorio"; do
>     grep -ic "$t" ux-criterios-6173.md; done
> 0    <- linea de excedente (CA-16)
> 0    <- linea compacta (CA-16)
> 0    <- presupuesto del mensaje (CA-16)
> 0    <- recordatorio en texto plano (CA-15 / CA-34)
> ```
>
> El mockup madre `6173-02-telegram-ficha-agrupada.svg` renderiza **las 3 fichas
> completas**, que es exactamente lo que CA-16 prohíbe. Ese mockup ilustra la
> **ficha**; no ilustra el **mensaje bajo presupuesto**. De ahí este entregable.

Mockup de esta hija: `6190-01-telegram-presupuesto-recordatorio-fallback.svg`.

---

## 0 · Medición empírica del presupuesto (hecha en este ciclo)

Los caps de la madre son **por campo** (220 / evidencia 120). No hay ninguno **por
mensaje**, y CA-13 exige un único mensaje agrupado. Medido contra el copy real del
mockup madre:

```
$ node .pipeline/_tmp_budget.js
ficha completa (dependencia) : 970 chars
compacta prom / max          : 138 / 150 chars
linea de excedente           : 117 chars
TOTAL del mensaje propuesto  : 1548 chars
HANDLER_TEXT_BUDGET          : 3500   TELEGRAM_TEXT_LIMIT: 4000
holgura contra 3500          : 1952 chars
4 fichas completas           : 3880  -> EXCEDE 3500
```

**Conclusión:** con **4 trabajos frenados el mensaje de fichas completas ya cruza el
presupuesto** y lo arbitra `safeTruncate`, cortando en silencio las fichas del final.
La forma que fija CA-16 (1 completa + N compactas + línea de excedente) entra con
casi 2 KB de holgura y admite **15 compactas** antes de necesitar recorte.

---

## 1 · Superficie A — Mensaje agrupado bajo presupuesto (CA-16, CA-17)

### 1.1 Estructura

```
🚦 {n} trabajos esperan una decisión tuya          ← sólo si n > 1

{FICHA COMPLETA DEL DESTACADO}                     ← plantillas §4 del contrato madre

{i} · #{issue} «{titulo}» — {edad}. {que_se_decide_corto} → /unblock {issue} {ejemplo}
{i} · #{issue} «{titulo}» — {edad}. {que_se_decide_corto} → /unblock {issue} {ejemplo}

{LINEA DE EXCEDENTE}                               ← sólo si quedó alguno afuera
```

### 1.2 Quién es el destacado (regla de UX que cierro yo)

1. Si el emisor trae `highlight` (el trabajo que disparó el aviso) → **ese** lleva la
   ficha completa. Es el que el operador está esperando ver.
2. Si **no hay** `highlight` (caso del recordatorio, que es un barrido sin disparador)
   → lleva la ficha completa **el más antiguo**. Es el que más caro sale seguir
   ignorando, y es el criterio que ya usa el recordatorio para ordenar.
3. Nunca hay dos fichas completas. Dos fichas completas es la forma más rápida de
   volver a cruzar el presupuesto sin darse cuenta.

### 1.3 Orden de las compactas

Por **antigüedad descendente** (el más viejo primero), igual que el recordatorio de
hoy. El destacado va siempre primero, aunque no sea el más viejo: es el que motivó
el mensaje y romper esa expectativa desorienta.

### 1.4 La línea compacta — literal

```
{i} · #{issue} «{titulo}» — {edad}. {que_se_decide} → /unblock {issue} {ejemplo}
```

Reglas:

- **≤ 200 caracteres en total.** Si el título no entra, se recorta **el título** (nunca
  la pregunta ni el comando) con `…` **dentro** de las comillas angulares:
  `«Reordenar la ventana de bloqueados por urgencia de la…»`. Recortar la pregunta
  deja una compacta que no dice qué se decide, que es el defecto que este issue viene
  a cerrar.
- `{que_se_decide}` es el **mismo campo de la ficha**, no una versión propia. Si supera
  lo que queda de presupuesto de línea, se usa la **forma corta por tipo** de §1.5.
  Nunca se reescribe ad hoc.
- La compacta **no lleva** opciones, ni consecuencia, ni evidencia, ni costo de no
  decidir. Una compacta con media opción es peor que una compacta sin ninguna: sugiere
  que ésa es la única.
- **Cada compacta lleva su propio comando con el número real.** Es el núcleo de H-UX-3:
  con N trabajos en un mensaje, un pie único es ambiguo.
- El separador `→` es un carácter, no markup. No usar `->` (dos caracteres, se lee como
  código) ni `|`.

### 1.5 Forma corta de `que_se_decide` por tipo (para la compacta)

| tipo | forma corta |
|---|---|
| `dependencia` | `¿Esperamos o avanzamos igual?` |
| `circuit` | `¿Se reintenta o se replantea el alcance?` |
| `firma` | `¿Aprobás el alcance?` |
| `infra` | `¿Esperamos que vuelva o paramos por hoy?` |
| `rebote` | `¿Se corrige o se acepta como está?` |
| `pregunta` | `Un agente te hizo una pregunta.` |
| `indeterminado` | `No sé qué hay que decidir.` |

En `pregunta` e `indeterminado` la forma corta **no es una pregunta al operador**, y
está bien: en `pregunta` la pregunta real es del agente y no se parafrasea (regla 8 de
la madre); en `indeterminado` no hay decisión que formular todavía. La regla "termina
en `?`" es de `que_se_decide` **en la ficha completa**, no de la forma corta.

### 1.6 La línea de excedente — literal

```
Otros {k} trabajos esperan decisión y no entraron en este mensaje. Están todos en el
tablero, ordenados por antigüedad.
```

Variante singular:

```
Hay 1 trabajo más esperando decisión que no entró en este mensaje. Está en el tablero.
```

Reglas:

- **Sólo aparece si `k > 0`.** Un "otros 0 trabajos" es ruido y erosiona la confianza en
  el resto del mensaje.
- Dice el **número exacto**, nunca "algunos" ni "varios". El operador tiene que poder
  cerrar la cuenta: `1 destacado + N compactas + k afuera = n del encabezado`.
- Dice **dónde verlos**. "El tablero" es la única superficie donde hoy están todos, y
  sigue siendo cierto después de #6191.
- **Prohibido** cortar a mitad de ficha o a mitad de compacta. El recorte es siempre
  por **unidad entera**.
- **Prohibido** que un trabajo desaparezca sin estar contado en `k`.

### 1.7 Qué pasa si ni siquiera entra el destacado

Caso patológico (ficha de 220×6 + 4 opciones). Degradación, en este orden:

1. Se recorta `evidencia_minima` a 1 ítem (es el campo más prescindible: es contexto,
   no decisión).
2. Se recortan las opciones **no recomendadas** dejando **como mínimo 2**, y el mensaje
   declara: `Hay más opciones en el tablero.`
3. Si aún no entra, el destacado **pasa a compacta** y el mensaje pasa a ser todo
   compactas + excedente. Nunca se emite una ficha mutilada.

Nunca se llega a "no emitir el aviso": la visibilidad no se degrada, sólo el detalle.

---

## 2 · Superficie B — Recordatorio en texto plano (CA-15, CA-34)

### 2.1 Lo que sale hoy (verificado en este ciclo)

```
$ node -e "require('./lib/human-block-reminder.js').buildReminderMessage([...3 due...])"

🔁 *Recordatorio: 3 bloqueos esperando tu respuesta*

• *#6150* — guru en analisis _(hace 27h · aviso #3)_
• *#6144* — po en criterios _(hace 6h)_
   ↳ Confirmar alcance?
• *#6173* — ux en criterios _(hace 3h · aviso #2)_
   ↳ dependency_block: espera #6110

_Siguen bloqueados: nada se aprueba solo por dejar pasar el tiempo._
_Usá_ `/unblock <issue> <orientación>` _para destrabar._

--- metacaracteres Markdown: 23
```

Seis defectos, todos ya condenados por los criterios: **23 metacaracteres vivos**
(CA-15 / CA-27) · vocabulario de máquina `guru en analisis` (CA-12) · dato crudo
`dependency_block: espera #6110` (CA-12) · `#6150` llega **sin ninguna razón** (CA-6) ·
`bloqueos` es jerga de estado, no lenguaje de decisión · pie con `<issue>` de molde
(CA-17). Y ninguna línea dice qué se decide.

### 2.2 Lo que debe salir — literal

```
🔁 Segundo aviso: 3 trabajos siguen esperando tu decisión

{FICHA COMPLETA DEL MÁS ANTIGUO}

{i} · #{issue} «{titulo}» — {edad}, {n}º aviso. {que_se_decide} → /unblock {issue} {ejemplo}
{i} · #{issue} «{titulo}» — {edad}. {que_se_decide} → /unblock {issue} {ejemplo}

Nada se destraba solo por dejar pasar el tiempo.
```

Reglas propias del recordatorio:

- **Es el mismo cuerpo que la superficie A**, con el mismo presupuesto, el mismo
  destacado-por-antigüedad y la misma línea de excedente. El recordatorio **no tiene
  copy propio**: eso es exactamente CA-1. Lo único suyo son el encabezado y el cierre.
- **Encabezado por número de aviso**: `Segundo aviso:` / `Tercer aviso:` / a partir del
  cuarto, `{n}º aviso:`. Decir "recordatorio" cada vez, sin decir cuántas veces ya se
  avisó, entrena al operador a ignorarlo. El número es la información.
- **El contador de avisos va en la compacta, no en el encabezado de cada línea**, y sólo
  si es `> 1`. Es contexto de urgencia, no un contador crudo de máquina: por eso se dice
  `2º aviso`, no `reminder_number=2`.
- **Cierre**: `Nada se destraba solo por dejar pasar el tiempo.` — una línea, sin
  cursivas. Es la única frase del recordatorio que no está en la ficha y se gana el
  lugar: es la razón de existir del recordatorio.
- **Cero markup.** Sin `*`, `_`, `` ` ``, `[`, `]`. El recordatorio es el **único camino
  que hoy sale con Markdown vivo y sin `plain`**; es el 7º camino que cierra #5421.

---

## 3 · Superficie C — El aviso de fallback (CA-20, CA-21)

Cuando la construcción de la ficha lanza, el operador **igual tiene que enterarse**. Lo
que no puede pasar es que el aviso degradado sea peor que el de hoy ni que filtre lo
que la ficha redactaba.

### 3.1 Literal

```
⚠️ Hay {n} trabajos esperando tu decisión y no pude armar el detalle.

{i} · #{issue} «{titulo}» — {edad}.
{i} · #{issue} «{titulo}» — {edad}.

No te muestro opciones porque no pude prepararlas. Siguen frenados: esto no destrabó
nada. Mirá el tablero para decidir, o respondé /unblock {issue_del_primero} seguido de
qué querés que se haga.
```

Reglas:

- **Declara el fallo, no lo esconde.** "No pude armar el detalle" es honesto y le dice
  al operador por qué este aviso se ve distinto. Un aviso degradado sin explicación se
  lee como un bug y se ignora.
- **Dice explícitamente que nada se destrabó.** Es el corazón de fail-closed visto desde
  el operador: el peor desenlace es que interprete el aviso raro como "ya está resuelto".
- **No inventa opciones.** Es el mismo principio que `indeterminado`: sin base para
  justificar, cero opciones.
- **Pasa por la misma redacción que la ficha** (CA-21). El fallback se activa justo
  cuando el motivo tiene más chances de traer un stack o un volcado de config, y hoy es
  el camino que **no redacta nada**.
- **No vuelca el motivo crudo.** El fallback muestra **título + antigüedad y nada más**:
  son los dos campos que no dependen del módulo que acaba de fallar. Volcar `reason`
  crudo "porque total es el fallback" es la forma exacta en que este camino filtra.

---

## 4 · Superficie D — Guion de audio desde la ficha (CA-18)

Hoy `buildNeedHumanAudioText` narra `motivo → decisión → sugerencia` desde campos
crudos. Con la ficha, los campos son otros. Orden narrativo fijo:

```
Atención: {n} trabajos esperan una decisión tuya.
El más urgente es el {issue}: {que_se_decide}
Está frenado porque {por_que_esta_frenado}
Te recomiendo {etiqueta_recomendada}, porque {razon_recomendacion}
Si no decidís, {costo_de_no_decidir}
```

Reglas:

- **Tope 600 caracteres**, y el recorte es **por línea entera desde el final**, en este
  orden inverso de prioridad: recomendación → costo → por qué. **Nunca** se recorta
  `que_se_decide`: si el audio no dice qué se decide, no cumple ninguna función.
- **Se narra sólo el destacado.** Un audio con 12 trabajos es inescuchable. El resto va
  en un cierre único: `Hay 11 trabajos más esperando; están en el tablero.`
- **Sin recomendada** (`firma`, `pregunta`, `indeterminado`) la línea de recomendación se
  reemplaza por `No te propongo ninguna opción: la decisión es tuya.` No se omite en
  silencio — el silencio se oye como que el audio se cortó.
- **Nada de números de opción, comandos ni `#`**. El audio se escucha sin pantalla:
  `/unblock 6173 esperar` narrado es ruido. El audio orienta; el texto ejecuta.
- **En `indeterminado`**: `No pude inferir qué hay que decidir. Me falta
  {falta}.` — y nada más.

---

## 5 · Saneamiento del título, visto desde el operador (CA-22)

La regla de seguridad ya está cerrada. Lo que agrega UX es **cómo se ve el resultado**,
que es lo que decide si el operador confía en el mensaje:

- El título va **siempre entre `«…»`**, en **una sola línea**. Saltos, tabs y caracteres
  de control se reemplazan por **un espacio simple**, no se eliminan: eliminarlos pega
  palabras (`arreglarel`) y hace ilegible el identificador que el operador reconoce.
- Espacios múltiples resultantes colapsan a uno.
- Si se recorta, la `…` va **dentro** de las comillas: `«Reordenar la ventana de…»`.
  Afuera (`«Reordenar la ventana de»…`) se lee como si el título terminara ahí.
- **El título nunca abre línea.** Siempre va precedido de `#{issue} ` y de su rótulo
  (`Qué está frenado:` en la ficha, `{i} · ` en la compacta). Un título al principio de
  línea es exactamente lo que necesita para disfrazarse de estructura del mensaje.
- Si el título queda **vacío** después de sanear: `#{issue} (sin título)`. Nunca `«»`.

---

## 6 · Hallazgos de este ciclo (endurecen los criterios)

### H-UX-6 — El pie de `indeterminado` de la madre usa un molde y un metacarácter HTML

El contrato madre cierra la ficha `indeterminado` con
`Para decidir, respondé: /unblock 6150 <qué hacer>`. Dos problemas:

1. Es **un molde** — exactamente lo que H-UX-3 condenó y CA-17 prohíbe ("ningún
   `<issue>` literal en la salida"). `<qué hacer>` es el mismo defecto en otro campo.
2. `<` y `>` son **metacaracteres de HTML**. Verificado que el predicado que CA-27 manda
   reusar **no los cubre**:
   ```
   $ grep -n "const MARKUP_CHARS" .pipeline/lib/__tests__/human-block.test.js
   403:const MARKUP_CHARS = /[*_`]/;
   ```
   Con `plain: true` no rompe hoy, pero el CA dice "ni HTML" y el test que lo verifica no
   lo vería. Un copy que sólo es seguro porque el test es más flojo que el criterio es un
   riesgo latente, no un cumplimiento.

**Reemplazo (aplica a ficha, compacta y fallback):**

```
Para decidir, respondé: /unblock 6150 seguido de qué querés que se haga
```

Sin ángulos, sin molde, y le dice al operador qué escribir.

### H-UX-7 — El mockup madre muestra 3 fichas completas: contradice CA-16

`6173-02-telegram-ficha-agrupada.svg`, panel derecho, renderiza las 3 fichas enteras
(2297 chars medidos). CA-16 fija "ficha completa para el destacado, una línea para el
resto". Tomado como referencia visual de aceptación, ese mockup **valida lo que CA-16
prohíbe**.

No es un error de la madre: ese mockup ilustra **la ficha** y cumple su función. Pero
CA-37 pide "mockup acordado para exactamente esta salida", y la salida de #6190 bajo
presupuesto **no estaba dibujada**. Por eso este ciclo entrega
`6190-01-telegram-presupuesto-recordatorio-fallback.svg`.

**Ajuste pedido a CA-37:** la referencia visual de aceptación de #6190 es el mockup de
esta hija. El de la madre sigue siendo la referencia de **la ficha individual**.

### H-UX-8 — El recordatorio se identifica por su mecanismo, no por su urgencia

Verificado arriba: hoy dice `🔁 Recordatorio: 3 bloqueos esperando tu respuesta` y el
número de aviso va escondido en un paréntesis en cursiva por línea
(`_(hace 27h · aviso #3)_`). El operador que ya vio dos de estos lee "recordatorio" y
archiva sin abrir. **La información que cambia el comportamiento es cuántas veces ya se
avisó**, y hoy está en el lugar de menor jerarquía del mensaje. Por eso §2.2 la sube al
encabezado (`Segundo aviso:`).

---

## 7 · Ajustes pedidos sobre los criterios (sin cambiar la intención)

1. **CA-17** — extender explícitamente la prohibición de moldes a los **valores de
   ejemplo**, no sólo al número: ni `<issue>` ni `<qué hacer>` ni `<orientación>` en
   ninguna salida (H-UX-6).
2. **CA-27** — el test debe reusar `MARKUP_CHARS` como manda el CA, **y sumar `[<>]`
   como predicado aparte**, porque el CA dice "ni HTML" y `MARKUP_CHARS` no lo cubre
   (`:403`, verificado). Sin esto el criterio y su test no dicen lo mismo.
3. **CA-37** — la referencia visual de aceptación de esta hija es
   `.pipeline/assets/mockups/6190/6190-01-telegram-presupuesto-recordatorio-fallback.svg`
   (H-UX-7).
4. **CA-16** — dejar explícito que la cuenta tiene que cerrar para el operador:
   `1 destacado + N compactas + k afuera = n del encabezado`. Es lo que hace verificable
   "ningún issue desaparece sin que el mensaje lo declare" desde el lado del operador y
   no sólo desde el test.
5. **CA-18** — el guion de audio narra **sólo el destacado** más un cierre con el
   resto. Sin esto, "los mismos campos de la ficha" con 12 fichas produce un audio
   inescuchable que igual respeta el tope de 600 por truncado.

Sin objeciones a CA-1..CA-15, CA-19..CA-36, CA-38, CA-39 ni a las 10 decisiones de
producto del PO.

---

## 8 · Nota de commit

Los assets quedan en `.pipeline/assets/mockups/6190/`. **No se commitea desde este
ciclo**: el checkout está parado en `agent/5863-destrabe-labels-y-fallback-commander`
—rama de otro agente— con el árbol sucio de estado runtime del pipeline. Commitear ahí
contaminaría trabajo ajeno. El copy literal viaja además como comentario del issue, que
es el contrato que `validacion` verifica (mismo criterio que aplicó la madre #6173).

---
*Diseño producido por el agente `ux` en la fase `criterios` del pipeline de definición.*

