# UX · #6440 — El aviso de que un pedido se ejecutó y su respuesta se perdió

> Entregable de la fase `definicion/criterios`. Fija el contrato de copy y el
> sistema visual del aviso. Los criterios **UX-1 … UX-10 son vinculantes**: la
> fase de validación y la de aprobación los verifican contra el HEAD.
>
> - Fuente única del texto: `.pipeline/assets/copy/orphan-turn/copy.json`
> - Renderer de referencia: `.pipeline/assets/copy/orphan-turn/render.js`
> - Validador ejecutable: `.pipeline/assets/copy/orphan-turn/validate-copy.js`
> - Mockups: `01-telegram-aviso-huerfano.svg`, `02-dashboard-badge-huerfano.svg`
> - Tokens: `.pipeline/assets/design-tokens.css` → `--result-huerfano*`

---

## 0. El problema de UX que este issue resuelve — y el que puede crear

El issue nació de un mensaje que **no existió**. Pero el daño no fue el silencio
en sí: fue lo que el operador **hizo con** ese silencio. Estuvo 70 minutos
convencido de que su pedido no se había ejecutado, cuando ya se habían cerrado
dos issues, partido un tercero y reiniciado el pipeline. El siguiente paso
natural — y el más caro — era **volver a mandar el mismo pedido**.

> El silencio no es la ausencia de un mensaje. Es un mensaje equivocado.

De ahí sale la regla que ordena todos los criterios de abajo:

> **El aviso tiene que dejar al operador con el estado del mundo correcto y con
> una sola cosa clara: qué NO tiene que volver a hacer.**
> Un aviso que dice “se perdió la respuesta” y no dice “ya está hecho, no lo
> repitas” resuelve la mitad del problema y deja la mitad cara sin resolver.

Y el riesgo que este issue puede crear, si se implementa sin cuidado, es el
opuesto y es peor: **avisar de pérdidas que no ocurrieron**. Un canal que
grita “se perdió tu respuesta” mientras el Commander todavía está trabajando se
vuelve ruido en dos días, y el día que se pierda una de verdad nadie lo va a
leer. Ese riesgo es concreto y medible — está cuantificado en **UX-5**.

---

## 1. Criterios vinculantes

### UX-1 · Dos superficies, y no son intercambiables

| Superficie | Naturaleza | Qué muestra | Cuándo |
|---|---|---|---|
| **Dashboard** (pasivo) | El operador va a buscarlo | El resultado de **todos** los pedidos, incluido `huerfano` | Permanente |
| **Telegram** (activo) | Interrumpe | Sólo cuando una respuesta **se perdió** | Excepcional |

El badge del dashboard **no es opcional ni posterior**: es la superficie que
permite auditar después. El mensaje de Telegram es el que evita el daño en el
momento. Los dos, en el mismo cambio.

---

### UX-2 · El aviso sale por el camino conversacional, no por el de alertas

**Vinculante.** El aviso se encola como un dropfile de respuesta del Commander
(`servicios/telegram/pendiente`, `{ text, plain: true, chat_id }`), el mismo
camino de `sendTelegram`. **No** se emite con `notifyTelegram`.

Verificado en esta pasada, sobre `.pipeline/lib/notify-telegram.js`:

```
buildMessage (L179):  lines.push(`${emojiFor(level)} ${component}: ${summary}`)
buildMessage (L208):  ctxLines.push(`emisor: pid=${process.pid} host=${os.hostname()} ts=${ts}`)
resolvePrivateChatId (L211): candidate !== anchor  =>  { ok: false, reason: 'unauthorized_chat_id' }
```

Tres razones, todas bloqueantes:

1. **El encuadre miente sobre la naturaleza del mensaje.** `componente: texto`
   lee como una falla interna del sistema. El operador aprende a saltearlo. Pero
   esto **no** es una alerta de operación: es la respuesta a algo que él pidió.
2. **La línea `emisor: pid=… host=… ts=…` es jerga**, y CA-12 la prohíbe de
   forma explícita. No se puede desactivar: `buildMessage` la agrega siempre.
3. **El destino está anclado a un solo chat.** `resolvePrivateChatId` rechaza
   cualquier `chat_id` que no sea `TELEGRAM_LEO_OPERATOR_CHAT_ID`. Eso es
   incompatible con CA-13, que exige resolver el destino por conversación.

CA-14 se cumple igual: los dos caminos escriben en la **misma cola de
filesystem**, que es la que sobrevive al restart. Lo que cambia es el encuadre,
no la durabilidad.

`plain: true` va **explícito**, nunca por omisión: `servicio-telegram.js`
resuelve `data.parse_mode || 'Markdown'`, así que omitirlo reinyecta Markdown y
el identificador de la sesión rompería el envío.

---

### UX-3 · Anatomía del aviso: cuatro bloques, orden fijo, sin líneas en blanco

```
{marcador} qué pasó
qué significa para vos ahora
dónde mirar
de qué pedido hablamos
```

**El segundo bloque es obligatorio en todo aviso de pérdida.** Es el que dice
que el pedido ya está hecho y advierte que repetirlo lo vuelve a ejecutar. Sin
esa línea el aviso informa pero no protege, y el episodio se repite con mejor
prensa.

Texto normativo de H1 (salida literal de `render.js`, 371 chars):

```
⚠️ Tu pedido de las 09:26 se ejecutó, pero la respuesta se perdió antes de llegarte.
Lo que pediste ya está hecho. Antes de volver a mandarlo, fijate cómo quedó: si lo repetís, se hace de nuevo.
La conversación quedó guardada en el registro y la podés abrir desde el panel de conversaciones del dashboard.
Sesión: 6529617704-1787574376808 — 24/08 09:26 (hace 4 h 13 min).
```

Marcador `⚠️`. La sirena `🚨` queda reservada para lo que exige decidir en el
momento; acá el trabajo ya está hecho y lo único urgente es no duplicarlo.

Los tres avisos normativos (H1 pérdida confirmada, H2 entrega no verificable,
H3 consolidado) están en `copy.json → avisos`.

---

### UX-4 · Vocabulario cerrado — y la palabra `huérfano` **no** le llega al operador

`copy.json` es la fuente única. Ningún string visible se escribe en otro lado.

- **UX-4.1** — Nada de la lista de `reglas.vocabulario_prohibido`.
- **UX-4.2** — **La palabra “huérfano” no aparece nunca en el mensaje.** Es el
  valor del enum (`huerfano`) y el vocabulario del dashboard, no el del
  operador: no describe nada que él pueda entender ni accionar. Al operador se
  le dice *que la respuesta se perdió*. Este criterio está separado de UX-4.1 a
  propósito, porque es el error más fácil de cometer: el enum está a mano.
- **UX-4.3** — **Cero contenido del pedido en el aviso.** Ni un extracto de lo
  que se pidió, ni un resumen de lo que se respondió. Sólo el puntero.
  Reconstruir la respuesta perdida desde un texto que no se pudo confirmar como
  entregado es exactamente la inferencia que #3951 prohíbe.
- **UX-4.4** — Sin metacaracteres de Markdown.
- **UX-4.5** — Máximo 500 chars por mensaje, 170 por línea, sin líneas en blanco.
- **UX-4.6** — Todo aviso de pérdida dice que ya se ejecutó **y** advierte qué
  pasa si se repite.
- **UX-4.7** — Todo aviso lleva el identificador de la sesión y su marca de
  tiempo legible (`DD/MM HH:MM`), más el lapso (`hace 4 h 13 min`).

Los siete se verifican corriendo `node .pipeline/assets/copy/orphan-turn/validate-copy.js`
(exit 0 / exit 1 con el detalle del incumplimiento), incluida la regex literal
de CA-12.

---

### UX-5 · No se avisa de una pérdida que todavía puede resolverse sola

**Este es el criterio que más puede romper el issue, y sale de datos medidos en
esta pasada.**

CA-8 pide que el barrido corra “anclado al boot del pulpo **y de forma
periódica**”. El barrido periódico corre **con pedidos vivos en vuelo**. Si el
discriminante mira sólo las etapas y una antigüedad corta, marca como perdido un
pedido que todavía está trabajando y **le manda al operador un aviso falso** —
justo el que le dice “ya está hecho, no lo repitas”, sobre algo que todavía no
terminó.

Duración real de los pedidos del Commander (639 logs, desde el `reqId` hasta la
última escritura de su log, medido hoy):

| p50 | p90 | p95 | p99 | máx |
|---|---|---|---|---|
| 6,1 min | 17,0 min | 22,7 min | 36,9 min | 57,3 min |

```
>10 min: 179 de 639 (28 %)      >15 min: 78 de 639 (12 %)
```

> Una guarda de 10 minutos produciría avisos falsos sobre hasta el **28 %** de
> los pedidos vivos; una de 15 minutos, sobre el **12 %**. El pedido del propio
> episodio corrió **9 m 35 s**: con esas guardas, el aviso le habría llegado al
> operador **mientras el Commander seguía trabajando**.

**Criterio:**

1. **La guarda primaria es de vida, no de reloj.** Un pedido cuyo proceso puede
   seguir escribiendo **no se evalúa**. El barrido de boot lo tiene gratis: todo
   pedido anterior al arranque actual pertenece a un proceso que ya no existe.
2. **La guarda de reloj es el respaldo, y no baja de 45 minutos** (p99 = 36,9
   min más margen). Sólo aplica cuando la vida del proceso no se puede
   determinar.
3. **Ante la duda, silencio.** Un aviso demorado 45 minutos sigue siendo útil
   —el operador todavía no rehízo el trabajo—; un aviso falso quema el canal.

Este criterio **no contradice** a CA-8: el barrido sigue siendo el mecanismo
principal. Acota **cuándo** un pedido es evaluable.

---

### UX-6 · Un aviso por pasada y por conversación

Si una misma pasada encuentra 2 o más respuestas perdidas para la misma
conversación, sale **un solo** mensaje consolidado (H3), que lista hasta **3**
sesiones y resume el resto (`y N más`). Nunca N mensajes.

CA-9 ya evita la estampida de reintentos; esto evita la estampida de **lectura**,
que es la que hace que el operador silencie el chat. Cinco avisos seguidos no se
leen.

Con 2 o 3 pedidos se listan todos y no aparece el resumen.

---

### UX-7 · El badge del dashboard, completo y en el mismo cambio

| Campo | Valor |
|---|---|
| enum | `huerfano` (sin tilde — el enum de `request-classify.js` es cerrado) |
| glifo | `∅` |
| etiqueta | `huérfano` |
| tooltip | `Se ejecutó, pero su respuesta nunca se confirmó como entregada` |
| clase | `cmd-result-huerfano` |
| tokens | `--result-huerfano` / `--result-huerfano-bg` / `--result-huerfano-dim` |

**El color no reusa `--danger`, y no es una preferencia estética.** Un pedido con
respuesta perdida **no falló**: se ejecutó entero. Pintarlo del mismo rojo que
`error` le haría leer al operador *“falló”* donde dice *“se hizo y no te
enteraste”* — el malentendido exactamente opuesto al que el issue viene a
cerrar. Se usa `--alert-anomaly` (#FF6B8A), ya declarado en la paleta como
distinguible del danger puro.

Contraste **medido** (no estimado), sobre el fondo compuesto real:

```
#FF6B8A sobre surface-0 (#0D1117)            = 6,96:1   AA
#FF6B8A sobre el fondo del badge (#341F29)   = 5,62:1   AA
referencia: #F85149 (error vigente) sobre surface-0 = 5,65:1
```

El estado nuevo **no baja el piso de contraste existente**.

Los tres tokens ya están commiteados en `design-tokens.css`. El glifo `∅` no
colisiona con `✓ ✎ ↪ ✗` y se lee a 9,4 px, que es el tamaño real del badge
(verificado renderizando el mockup 02, no por inspección del código).

---

### UX-8 · El identificador es un puntero, y sólo va a la conversación del propio pedido

El identificador de la sesión viaja **crudo y completo**: es lo único que
permite encontrar el registro. Lo que sí se traduce es la marca de tiempo — el
operador no lee epochs.

**Guarda de destino (complementa a CA-13):** el destino sale del historial de
correlación, nunca del nombre del archivo. Pero además, si el destino resuelto
**no** corresponde a la conversación del propio pedido, **no se envía**: se
registra y se descarta. Es una guarda *negativa* y fail-closed — no convierte al
filename en fuente del destino, sólo impide que el aviso le cuente a un operador
el pedido de otro.

El renderer valida la forma del identificador (`/^[A-Za-z0-9_-]{1,64}$/`) y
**tira** si no matchea: un identificador adulterado manda al operador a buscar un
registro que no existe.

---

### UX-9 · Fail-closed no termina en la cola: el aviso que no se pudo entregar tiene que verse

CA-14 exige reintento con tope y dead-letter registrada. **Falta el último
tramo:** si el aviso muere en dead-letter, el operador vuelve a quedar en
silencio — exactamente el estado que el issue viene a cerrar, ahora con un
registro interno que lo prueba y nadie lee.

**Criterio:** un aviso en dead-letter tiene que ser **visible en el dashboard**,
en la misma fila del pedido (el badge `huerfano` alcanza como ancla) o en el
panel de conversaciones. La regla es: *ninguna pérdida termina siendo un dato
que sólo existe en un archivo de log*.

---

### UX-10 · Cero ruido en el camino feliz — verificable

Los seis silencios normativos están en `copy.json → silencios` y son parte del
contrato, no una nota. Verificado hoy sobre el estado real del repo:

```
$ ventana de 48 h sobre .pipeline/logs/commander-*.log
{ enVentana: 8, conTrans: 7, sinEnvio: 1, sinResultado: 1, candidatoHuerfano: 1 }
candidato: commander-6529617704-1787574376808.log
```

Es decir: **6 de cada 7 pedidos de la ventana no producen absolutamente nada**, y
el único candidato es el log del propio episodio. El silencio es la regla; el
aviso, la excepción.

---

## 2. Cómo se verifica esto en las fases siguientes

| Criterio | Comando / evidencia |
|---|---|
| UX-3, UX-4 (todos) | `node .pipeline/assets/copy/orphan-turn/validate-copy.js` ⇒ exit 0 |
| UX-2 | el dropfile emitido tiene `plain: true` y `chat_id`, y **no** contiene `emisor:` ni `<componente>:` |
| UX-5 | test del barrido con un pedido vivo / reciente ⇒ **no** emite |
| UX-6 | test con 5 pérdidas de la misma conversación ⇒ **1** mensaje |
| UX-7 | el dashboard renderiza el badge; enum y badge en el mismo commit |
| UX-8 | test con destino que no corresponde a la conversación ⇒ no se envía |
| UX-9 | un aviso en dead-letter se ve en el dashboard |
| UX-10 | barrido sobre la ventana actual ⇒ 1 aviso, y el segundo barrido ⇒ 0 |

## 3. Qué NO es responsabilidad de este contrato

- El discriminante de huérfano (D-2 del PO), el canal estructurado (CA-1) y las
  claves de correlación (CA-2) son decisiones ya cerradas y no se tocan acá.
- La métrica/alerta de tasa de huérfanos es la recomendación #6446, fuera de
  alcance.

> Criterios del agente `ux` — fase `criterios`, pipeline `definicion`.
