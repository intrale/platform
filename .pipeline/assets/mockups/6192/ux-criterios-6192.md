# Contrato de experiencia — #6192 · Gate de firma

> Entregable de `ux` en `definicion/criterios`. Extiende el contrato madre
> `.pipeline/assets/mockups/6173/ux-criterios-6173.md` (§4.3 `firma`) al caso
> concreto de GATE 1. **No redefine copy**: todo el texto sale de
> `.pipeline/lib/decision-card.js`. Lo que este documento fija es **qué ficha
> corresponde a cada motivo del gate**, **cuál de los tres avisos lleva botones**
> y **qué cuenta como "cambió" para el dedupe**.
>
> Verificado empíricamente sobre HEAD `177ab2bf6`.

---

## 0. El hallazgo que ordena todo el resto

`decision-card.js` clasifica el tipo de ficha **por el texto del motivo**
(`decision-card.js:770`, `RE_FIRMA`). Los motivos que realmente emite el gate
(`operator-signoff-gate.js:318-395`) **no fueron escritos para ese clasificador**.
Resultado medido:

```
motivo         firmantes    tipo             opciones  recomendadas
sin firma          3        indeterminado       0            0
sin firma          0        indeterminado       0            0
sin allowlist      3        firma               3            0
sin allowlist      0        indeterminado       0            0
stale              3        indeterminado       0            0
stale              0        indeterminado       0            0
verdict inválido   3        indeterminado       0            0
re-definition      3        indeterminado       0            0
rechazado          3        rebote              3            1
```

Se lee así, y es exactamente al revés de lo que pide el issue:

- **El motivo más frecuente del gate — "sin firma del operador para la
  definición", el caso base cuando nunca hubo firma — sale `indeterminado`, con
  CERO opciones.** Si el desarrollo deja que el clasificador infiera el tipo,
  CA-1 y CA-2 quedan incumplidos: no hay ficha de firma y no hay tres botones.
- **El único motivo que hoy sale `firma` con tres botones es justo el que CA-6
  prohíbe**: "firmante no verificable (sin authorizedSigners configurado)". Sólo
  cae en `indeterminado` si el llamador pasa `firmantes_autorizados: 0`; si no lo
  pasa (queda `null`), el operador recibe tres botones de firma en el único
  escenario donde ninguna firma sería válida.
- **"operador rechazó la definición" sale `rebote`, y `rebote` trae una opción
  recomendada.** El tipo `firma` tiene prohibida la recomendada (CA-5); si ese
  motivo se cuela por el clasificador, la prohibición se viola por la puerta de
  atrás y además el texto le habla al operador de un rechazo de un control
  automático cuando el que rechazó fue él.

**Regla:** el tipo de ficha lo resuelve el llamador en `pulpo.js` a partir del
resultado estructurado del gate, **nunca el clasificador por texto**. El motivo
crudo (`opGateResult.reason`) sigue viajando como dato, pero no decide nada.

---

## 1. Tabla de ruteo `motivo del gate → ficha` (normativa)

| # | Motivo del gate (`operator-signoff-gate.js`) | Ficha que corresponde | Campos que el llamador debe pasar | Botones |
|---|---|---|---|---|
| A | `sin firma del operador para la definición` | `firma` | `tipo:'firma'`, `firmantes_autorizados:<n>` | **Sí (3)** |
| B | `firma stale (anti-TOCTOU A08)…` | `firma` variante vencida | `tipo:'firma'`, `firma_vencida:true`, `firmantes_autorizados:<n>` | **Sí (3)** |
| C | `firmante no verificable (sin authorizedSigners configurado…)` | `indeterminado` | `firmantes_autorizados:0` y **sin** `tipo` forzado | **No** |
| D | `firmante '<x>' no autorizado (A01…)` | `indeterminado` | `firmantes_autorizados:<n>`, sin `tipo` forzado | **No** |
| E | `verdict inválido '<x>'` | `indeterminado` | sin `tipo` forzado | **No** |
| F | `operador marcó re-definición…` / `operador rechazó la definición…` | **ninguna ficha** | — | **No** |

Notas de cada fila:

- **A** es el caso del 19/08 que reportó el operador y el que domina el volumen.
  `que_se_decide` sale *"¿Aprobás el alcance de #N para que arranque el
  desarrollo?"*.
- **B** es la única variante donde la pregunta cambia (*"¿Confirmás el alcance
  nuevo de #N, o lo mandás a replantear?"*) y donde el motivo importa: el
  operador ya firmó y necesita saber **que los criterios cambiaron después de su
  firma**. Se activa con `firma_vencida: true`, jamás por el texto del motivo.
- **C y D** son el corazón de CA-6: pedir firmar cuando ninguna firma valdría es
  ofrecer una opción inejecutable. La ficha `indeterminado` ya dice qué falta —
  *"No hay ningún firmante autorizado configurado: sin eso ninguna firma vale."* —
  y **no ofrece opciones**, que es la respuesta honesta.
- **F**: el operador **ya decidió**. Volver a preguntarle *"¿Aprobás el
  alcance?"* es un bucle. Acá el aviso queda como está hoy (línea informativa),
  con `{ plain: true }` y dedupe, **sin ficha y sin botones**. Darle ficha propia
  a la confirmación de la decisión propia está fuera de alcance y queda anotado
  como oportunidad.

**`firmantes_autorizados` se pasa SIEMPRE**, en las seis filas, incluso donde el
tipo va forzado. Es el dato que impide que C y D degraden a `firma` si alguien
toca el ruteo más adelante.

---

## 2. Los tres avisos de GATE 1 no son la misma cosa

El issue dice *"los tres avisos pasan a ficha de tipo `firma`"*. Medido contra el
código, eso es incorrecto para dos de los tres:

| Aviso | Línea | Qué pasó realmente | Ficha | Botones |
|---|---|---|---|---|
| Bloqueo por evaluación del gate | `pulpo.js:6946` | El gate corrió y retuvo | según §1 (A–F) | Sí en A y B |
| Error cargando el issue | `pulpo.js:6927` | El gate **no llegó a evaluar** | `indeterminado` | **No** |
| Error inesperado del gate | `pulpo.js:6960` | El gate **reventó** | `indeterminado` | **No** |

Razón: un botón "Aprobar el alcance" sobre un issue cuyo alcance el sistema **no
pudo leer** promete una firma que el sistema no puede fundamentar. Los dos avisos
de error informan una retención, no piden una decisión de firma. Siguen siendo
fail-closed: el issue permanece retenido en los tres casos.

---

## 3. Contrato de los botones

`operator-gate.js:684 buildInlineKeyboard` ya produce
`✅ Aprobar · ❌ Rechazar · ✏️ Ajustar`. Reglas de correspondencia:

1. **Botón N ↔ opción N de la ficha**, en el mismo orden. La ficha `firma`
   numera `1. Aprobar el alcance · 2. Rechazar · 3. Ajustar los criterios`; los
   botones son su forma corta. Un orden distinto entre lista y botonera hace que
   el operador toque el botón equivocado.
2. **Prohibido un cuarto botón** y prohibido esconder uno de los tres. Si un
   caso no admite las tres acciones, no es tipo `firma`.
3. **Ficha sin opciones ⇒ mensaje sin `reply_markup`.** Una botonera sobre una
   ficha `indeterminado` contradice el texto *"No te propongo opciones porque no
   las puedo justificar"* que el mismo mensaje acaba de decir.
4. **Los botones no reemplazan el pie `/unblock`.** El pie queda: es el camino
   del operador que lee el aviso donde el teclado no se renderiza, y es el único
   que admite una indicación escrita.
5. **Ningún botón lleva marca de recomendado**, ni por emoji, ni por orden, ni
   por texto. La ficha declara *"No hay recomendación: la decisión es tuya."* y
   la botonera no puede desmentirla.
6. Los avisos de rechazo al tocar un botón salen de `rejectionToast`
   (`operator-gate.js:373`) tal cual: `🔒 No autorizado para firmar este issue`,
   `⏱️ Acción expirada; no se aplicó ningún cambio`, `Ya firmaste esta acción`.
   **No se redacta copy nuevo para los toasts.** El no autorizado no recibe
   detalle del issue: el toast no confirma ni desmiente qué hay del otro lado.

---

## 4. Qué cuenta como "cambió" para el dedupe

CA-3 dice *"no se repite si nada cambió; si cambian los criterios firmables,
vuelve a avisar"*. Desde la experiencia, el criterio es:

- **El hash se calcula sobre el texto ya renderizado de la ficha**, no sobre
  `opGateResult.reason` crudo. Es lo que el operador ve: si el mensaje que le
  llegaría es idéntico al que ya leyó, mandarlo de nuevo es ruido; si el mensaje
  cambió en algo que él puede leer, es información nueva.
- **La edad queda fuera del hash.** `hace 20 h` cambia sola en cada barrido: si
  entra al hash, el dedupe no dedupea nada y el defecto original vuelve intacto.
  Es el único campo de la ficha que hay que excluir explícitamente.
- **Cambiar de fila de la tabla §1 siempre re-avisa** (A→B, A→C…). Pasar de
  "esperando tu firma" a "no hay firmante configurado" es justamente lo que el
  operador necesita saber.
- **Un aviso silenciado no relaja la retención.** El issue sigue frenado aunque
  no se vuelva a avisar; eso ya lo dice el copy del tipo `firma`: *"no se te
  vuelve a avisar hasta que cambie lo que hay que firmar"*. Esa frase es la
  promesa que el dedupe tiene que cumplir literalmente — y es también la razón
  por la que el silencio no deja al operador a ciegas: el estado sigue visible en
  el tablero.

---

## 5. Fallback fail-closed

Si armar la ficha falla, el aviso degradado ya existe:
`decision-card-render.js:359 renderFallbackAviso`, verificado:

```
⚠️ Hay 1 trabajo esperando tu decisión y no pude armar el detalle.

#6192 «…» — hace 20 h.

No te muestro opciones porque no pude prepararlas. Siguen frenados: esto no
destrabó nada. Mirá el tablero para decidir, o respondé /unblock 6192 seguido de
qué querés que se haga.
```

Tres condiciones de experiencia sobre el degradado:

1. **Sale sin botonera.** Los ids de firma se registran a partir de las opciones
   de la ficha; si la ficha no existe, no hay opción que ejecutar.
2. **Dice que no destrabó nada.** El texto ya lo dice; no se recorta.
3. **El degradado también dedupea**, con su propio hash. Un fallo persistente que
   se repite en cada barrido reproduce el defecto que esta historia elimina.

---

## 6. Criterios de aceptación de experiencia (verificables)

- **CA-UX-1** · El motivo *"sin firma del operador para la definición"* produce
  una ficha `tipo: 'firma'` con **3 opciones**. Test: llamar al camino real de
  notificación con ese motivo y afirmar `tipo === 'firma'` y
  `opciones.length === 3`. (Hoy, sin `tipo` explícito, sale `indeterminado`: el
  test falla y debe fallar.)
- **CA-UX-2** · Con `firmantes_autorizados: 0`, **ningún** motivo produce
  `tipo: 'firma'`, ni siquiera con `tipo:'firma'` pasado explícitamente. El
  llamador decide `indeterminado` antes de construir la ficha.
- **CA-UX-3** · La ficha de firma cumple
  `opciones.filter(o => o.es_recomendada).length === 0` y
  `sin_recomendacion_porque` no vacío.
- **CA-UX-4** · La botonera tiene exactamente `opciones.length` botones, en el
  mismo orden; con `opciones: []` el mensaje va **sin** `reply_markup`.
- **CA-UX-5** · Dos barridos consecutivos sin cambios ⇒ **un** envío. Cambiar
  sólo la edad del bloqueo ⇒ sigue siendo **un** envío. Cambiar el cuerpo del
  issue ⇒ segundo envío.
- **CA-UX-6** · El mensaje enviado no contiene ninguna palabra de la lista negra
  del contrato madre §3 fuera del título citado: `GATE 1`, `enforce`,
  `dry-run`, `hash`, `dedupe`, `fail-closed`, `A01`, `A08`, `TOCTOU`,
  `authorizedSigners`, `criteria_hash`, `pulpo.js`, `.pipeline/…`. Los motivos
  crudos del gate contienen **cinco** de esos términos: por eso el motivo no se
  interpola en el texto visible.
- **CA-UX-7** · Los avisos de `pulpo.js:6927` y `:6960` (errores) viajan **sin
  botonera**.
- **CA-UX-8** · Todos los envíos usan `{ plain: true }` explícito y ningún campo
  visible supera 220 caracteres (contrato madre §1.6).

---

## 7. Mockups

| Archivo | Qué muestra |
|---|---|
| `6192-01-telegram-gate1-antes-despues.svg` | El aviso de hoy (salida real de `pulpo.js:6946`) contra la ficha con los tres botones |
| `6192-02-ruteo-motivo-a-ficha.svg` | La tabla §1 como árbol de decisión, con el estado medido de cada rama |

Sistema visual: `.pipeline/assets/design-tokens.css`. **Cero color nuevo, cero
ícono nuevo.**
