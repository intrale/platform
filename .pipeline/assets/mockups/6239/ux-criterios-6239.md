# UX · #6239 — Aviso anticipado de vencimiento de la sesión de Claude Code

> Entregable de la fase `definicion/criterios`. Fija el contrato de copy y el
> sistema visual del aviso. Los criterios UX-1..UX-12 son **vinculantes**: la
> fase de validación y la de aprobación los verifican contra el HEAD.
>
> Fuente única del texto: `.pipeline/assets/copy/oauth-session-expiry/copy.json`.
> Mockups: `01-telegram-avisos-sesion.svg`, `02-dashboard-linea-sesion.svg`.

---

## 0. El problema de UX que este issue tiene que resolver — y el que puede crear

El issue nació de un aviso que **no existió**: la sesión se venció y el operador
se enteró por el ruido de los rebotes. Pero el análisis de `guru` verificó un
dato que cambia el problema:

- `expiresAt` es el vencimiento del **access token**, con TTL de 8 horas.
- La cadena de refresh lo renueva sola, varias veces por día, sin intervención.
- Lo que obliga a reautenticar a mano es `refreshTokenExpiresAt`, a 27 días.

Con los CA escritos como están, el aviso saldría **dos veces cada 8 horas** —
seis mensajes de "reautenticá" por día — por algo que se resuelve solo. En una
semana el operador aprende a ignorar el aviso, y la próxima vez que la sesión
se caiga de verdad el mensaje va a estar ahí, correcto, y nadie lo va a leer.

**Ese es exactamente el modo de falla que originó el issue.** Un aviso que
cansa no es un aviso: es ruido con buena intención. Por eso la posición de UX
no es una preferencia de redacción, es la condición para que el issue cumpla su
objetivo.

### La regla que ordena todas las decisiones de abajo

> **Se interrumpe al operador sólo cuando hay algo que él puede y debe hacer.**
> Si la respuesta a "¿y yo qué hago con esto?" es "nada, se arregla solo",
> entonces no es un aviso: es, como mucho, un dato de dashboard.

De ahí salen las dos superficies, que no son intercambiables:

| Superficie | Naturaleza | Qué muestra | Cuándo |
|---|---|---|---|
| **Dashboard** (pasivo) | El operador va a buscarlo | La vigencia **siempre**, en todos sus estados | Permanente |
| **Telegram** (activo) | Interrumpe | Sólo cuando la renovación automática **no** está ocurriendo | Excepcional |

---

## 1. Criterios vinculantes

### UX-1 · El aviso se condiciona a la no-renovación (cierra la decisión (d))

El disparo de los avisos por vencimiento **no** se hace por el mero paso del
tiempo. Se emite sólo si el vencimiento leído **no saltó hacia adelante**
respecto de la lectura anterior persistida.

Cuando el vencimiento sí saltó hacia adelante, la respuesta correcta es
**silencio total** — ni Telegram, ni cambio de color en el dashboard.

> Esta es la **variante recomendada por guru** y la que el Arquitecto dejó
> abierta como decisión de producto. UX la cierra a favor de la condicionada.
> Si PO decidiera lo contrario, la consecuencia a asumir por escrito es seis
> avisos diarios de una acción que el operador no tiene que hacer.

**Consecuencia obligatoria: CA-1 y CA-2 del issue deben reescribirse.** Redacción
propuesta:

- CA-1: *Con la sesión a menos de 30 minutos de vencer **y sin haberse renovado
  desde la verificación anterior**, el operador recibe un aviso por Telegram.*
- CA-2: *Con menos de 10 minutos **y en la misma condición**, recibe el segundo aviso.*
- CA nuevo: *Si la sesión se renueva sola, no se emite ningún aviso de
  vencimiento — ni el de 30 ni el de 10 minutos.*

> ⚠️ **ESTADO 2026-08-20 (fase Validación) — UX-1 quedó SUPERSEDIDO en su mecanismo,
> no en su principio.** PO cerró la decisión (d) en el body del issue: la evidencia
> empírica muestra que la renovación ocurre en **T-0**, no antes de los umbrales, así que
> la guarda `renewed` de UX-1 **no** suprime el ruido que se propone suprimir (en T-30 y
> T-10 la vigencia todavía no saltó, y el aviso saldría igual).
>
> - **Se mantiene** el principio de UX-1: se interrumpe sólo si hay algo que el operador
>   puede y debe hacer.
> - **Se reemplaza** el mecanismo por la **condición de emisión CE-1 / CE-2** del body
>   (CA-1..CA-13). La guarda `renewed` sigue siendo válida **sólo** para el reset de
>   umbrales (CA-4) y para el cierre del episodio (CA-9 / aviso A5).
> - La redacción propuesta acá para CA-1/CA-2 quedó **obsoleta**: la vigente es la del
>   body del issue. Fuente de verdad para el dev: **body del issue**, no este párrafo.
>
> El copy de `copy.json` ya está alineado con CE-1/CE-2 (campos `cuando`, `silencios` y
> `dashboard.titles`). Los textos visibles no cambiaron: siguen siendo válidos porque en
> ambas condiciones la renovación automática efectivamente no va a salvar la sesión.

---

### UX-2 · Nunca se afirma "no se está renovando" con una sola muestra

Si no hay lectura previa persistida — arranque del Pulpo, marker borrado,
primer despliegue — **no se emite nada**: se persiste la lectura y se decide en
la evaluación siguiente.

Sin este criterio, cada reinicio del Pulpo dentro de la media hora previa a un
vencimiento normal produce un aviso falso de "no se está renovando". El Pulpo
reinicia seguido (watchdog), así que no es un caso de borde: es una fuente
estable de falsos positivos, y el falso positivo es lo que destruye la
credibilidad del canal.

Costo: hasta una evaluación de demora (5 minutos). Beneficio: se elimina una
clase entera de aviso equivocado.

### UX-3 · Todo aviso que abre, cierra

Si se emitió A1 o A2 y después el vencimiento saltó hacia adelante, sale el
cierre **A5**. Si se emitió A3 (el chequeo no lee) y el chequeo vuelve a leer,
sale el cierre **A4**.

El operador que reautenticó necesita saber que lo que hizo sirvió. Sin cierre,
va a ir igual a verificarlo a mano, y el aviso le habrá ahorrado nada.

El cierre **sólo sale si hubo apertura**. Un "todo bien" espontáneo es ruido.

### UX-4 · El aviso de salud del chequeo es otro mensaje, no una variante

El caso de RS-7 (`available:false` persistente) usa el mensaje **A3**, que dice
explícitamente *"no es que esté por vencerse: es el chequeo el que no está
leyendo el dato"*.

Prohibido reusar el texto de vencimiento con otro número. Un operador que lee
"la sesión vence en …" cuando en realidad el chequeo está ciego, va a
reautenticar sin necesidad y a desconfiar del aviso cuando sea real.

A3 se emite **una vez por episodio**, no cada tres evaluaciones. Si el operador
trabaja sin sesión de Claude Code (por ejemplo, sólo con API keys), un aviso
repetido cada 15 minutos convierte el chequeo en spam permanente.

### UX-5 · El copy sale de `copy.json`, ninguna superficie inventa el suyo

`.pipeline/assets/copy/oauth-session-expiry/copy.json` es la fuente única del
texto de Telegram **y** del dashboard. Ni el Pulpo, ni el módulo, ni la vista
redactan copy propio.

### UX-6 · Reglas de redacción (verificables por `validate-copy.js`)

1. **Sin Markdown.** `notifyTelegram` escapa el texto entero antes de encolar
   (`notify-telegram.js:284-294`): un asterisco o un backtick se ven literales.
2. **Sin emoji propio en el texto.** El emoji lo pone `notifyTelegram` según
   `level` (⚠️ / 🚨 / ℹ️). Repetirlo da dos emojis en la misma línea.
3. **Un solo slot interpolado**, y siempre salida de `formatDurationEs`. Nunca
   un valor leído del archivo de credenciales (RS-3).
4. **Sin `payload.context`.** El render lo imprime como `clave: valor` crudo
   bajo el titular; `umbral: t30` es jerga interna. La línea `emisor:` la
   agrega `notifyTelegram` sola.
5. **`message` = qué pasa. `action` = qué hacer.** Son campos distintos del
   canal y el resto del pipeline los usa así. Meter la acción dentro del
   `message` rompe la lectura en diagonal, que es como se lee Telegram.
6. **Vocabulario cerrado.** Al operador se le habla de *"la sesión de Claude
   Code"*. Prohibido: OAuth, token, `expiresAt`, `claudeAiOauth`, epoch, T-30,
   T-10, umbral, tick, fail-open, rutas de archivo.
7. **"Reautenticar", nunca "rotar".** *Rotar* es el vocabulario del cron de API
   keys — otro horizonte (días) y otra acción. Mezclarlos hace que el operador
   aplique el runbook equivocado.
8. **Nunca pedir credenciales por el chat.** La acción ocurre siempre *"desde
   una terminal"*.
9. **`message` ≤ 200 chars, `action` ≤ 320 chars.** Y una sola palabra de más
   de 40 caracteres sin espacios puede ser tachada entera por la heurística de
   entropía de `redactFreeText` (`redact.js:275-277`): el copy no las usa.

### UX-7 · Escalada de nivel entre A1 y A2

A1 va con `level: warn` (⚠️) y A2 con `level: error` (🚨). Dos mensajes con el
mismo tratamiento visual se leen como el mismo mensaje repetido, y el segundo
—que es el urgente— pierde justamente la urgencia que lo justifica.

### UX-8 · El dashboard muestra la vigencia siempre, en los cinco estados

La línea de sesión **nunca se oculta** para la fila de Claude. La ausencia de
dato es dato: una línea que aparece y desaparece hace dudar de la lectura.

Los cinco estados (textos literales en `copy.json → dashboard.estados`):

| Estado | Texto | Cuándo |
|---|---|---|
| vigente | `sesión vigente · quedan 5 h 20 min` | más de 30 min |
| por vencer | `la sesión vence en 27 min` | 30 min o menos |
| urgente | `⚠ la sesión vence en 8 min` | 10 min o menos |
| **vencida** | `⚠ sesión vencida` | 0 min o menos |
| sin datos | `vigencia de la sesión no verificable` | no se pudo leer |

> El estado **vencida** no está en el issue y sin él la vista tiene un bug
> garantizado: `minutesLeft` es negativo y el render literal muestra
> *"vence en -37 min"*. RS-8 sólo cubre la **emisión** del aviso, no la vista.

### UX-9 · Clase propia, no reuso de `prov-vigencia`

La línea va en `.prov-col-health` con clase **`prov-session`**. Prohibido reusar
`prov-vigencia` / `renderVigenciaLine` (`providers.js:478-513`), que ya
significan *"vigencia del cruce contra el catálogo de modelos"* y viven en
`.prov-col-models`.

**Regla de vocabulario anti-colisión:** todo texto de la línea nueva contiene la
palabra **"sesión"**; todo texto de la de catálogo contiene **"modelo"** o
**"catálogo"**. Es lo que las hace distinguibles cuando conviven en la misma fila.

Nótese que hoy ya existe el `REASON_LABEL` *"vigencia no verificable"* para el
catálogo: por eso el estado sin datos de la sesión dice *"vigencia **de la
sesión** no verificable"*, no la frase pelada.

### UX-10 · Jerarquía: es metadato, no alerta

La línea se lee **por debajo** del badge de salud y del chip de cuota, con el
mismo peso visual que `.prov-health-reason` (11px / `--in-fg-dim`).

- **Nunca** cambia el badge de salud del provider. Ese badge lo escribe el
  health-cron y afirmar "CAÍDO" por una sesión que vence sería mentir sobre la
  cadena.
- **Nunca** dispara el kill-switch ni cambia el acento de la fila.
- Sólo sube de jerarquía —peso 700 y `⚠` textual— en los estados urgente y
  vencida.

### UX-11 · Accesibilidad — contraste verificado sobre el fondo real de la fila

El fondo de `.prov-row` es `--in-bg-3` **#1f2937** (no `#161b22`). Contrastes
medidos sobre ese fondo:

| Token | Hex | Ratio sobre #1f2937 | WCAG AA (4.5:1 texto chico) |
|---|---|---|---|
| `--in-fg-dim` | `#8b949e` | **4.77:1** | ✅ |
| `--in-warn` | `#d29922` | **5.82:1** | ✅ |
| `--in-info` | `#58a6ff` | **5.81:1** | ✅ |
| `--in-bad` | `#f85149` | **4.38:1** | ❌ |
| `--in-fg-soft` | `#6e7681` | **3.20:1** | ❌ |

**Por eso el estado urgente y el vencido usan `--in-warn`, no `--in-bad`.** La
jerarquía entre "por vencer" y "urgente" se construye con **copy y peso
tipográfico**, no subiendo la saturación a un tono que no pasa AA en 11px.

Si en el futuro hiciera falta rojo en esta línea, las salidas válidas son subir
el texto a ≥14px en negrita (AA large, 3:1) o llevarlo a `--in-fg` (#e6edf3,
12.42:1) con el rojo sólo en un indicador no textual. Nunca `--in-bad` como
texto de 11px.

**Sin información sólo por color** (WCAG 1.4.1): cada estado cambia de palabra
—"vigente" / "vence en" / "vencida" / "no verificable"—, así que el color es
refuerzo, nunca el único portador. Los estados urgente y vencida suman además
un glifo `⚠` textual.

**Lector de pantalla:** la línea es `role="status"` (polite). Es contexto, no
interrumpe. El único `role="alert"` de la vista sigue siendo el que ya existe.

### UX-12 · Formato de tiempo reusado, no reinventado

Se usa **`formatDurationEs(ms)`** (`lib/wave-stall-watchdog.js:137`), que ya
produce `8 min` / `27 min` / `3 h` / `5 h 20 min` y es la redacción que el
operador viene leyendo en el resto de los avisos del pipeline. Un formateador
nuevo daría dos redacciones distintas para la misma magnitud en la misma
pantalla.

---

## 2. Sistema visual

**Cero tonos nuevos, cero íconos nuevos, cero componentes nuevos.** 100% reuso
de `design-tokens.css` / `theme.css` y del sprite existente, que se queda en sus
123 símbolos.

- Fila: `.prov-row` — `--in-bg-3` #1f2937, borde `--in-border` #30363d, acento
  izquierdo `--provider-anthropic` #E5946B.
- Línea nueva `.prov-session`: `font-size: 11px`, tercera línea de
  `.prov-col-health` (después de `.prov-health-badges` y `.prov-health-reason`),
  hereda el `gap: 6px` de la columna.
- Tonos: `--in-fg-dim` (vigente) · `--in-warn` (por vencer, urgente, vencida) ·
  `--in-info` (sin datos). Peso 600 normal, **700** en urgente y vencida.
- Sin sprite: la línea no lleva ícono, igual que `.prov-health-reason` y
  `.prov-vigencia`. El único glifo es el `⚠` textual de los dos estados fuertes.

---

## 3. Qué verifica la fase de validación

1. Los cuatro archivos de `.pipeline/assets/copy/oauth-session-expiry/` están en
   HEAD y `copy.json` parsea.
2. El código de producción **consume** `copy.json` — no tiene los textos
   duplicados en línea (UX-5).
3. `node .pipeline/assets/copy/oauth-session-expiry/validate-copy.js` termina en 0.
4. La línea del dashboard usa la clase `prov-session` y **no** `prov-vigencia`
   (UX-9), y cubre los cinco estados incluida **vencida** (UX-8).
5. El aviso no se emite cuando la sesión se renovó (UX-1) ni en la primera
   lectura sin estado previo (UX-2) — cubierto por tests.
6. Ningún texto visible contiene una palabra del vocabulario prohibido (UX-6.6).

---

## 4. Oportunidades detectadas, fuera del alcance de este issue

Se registran como recomendaciones independientes, con triaje humano pendiente.
No bloquean ni dependen de #6239.

1. **Deuda de contraste en los pills del panel de Proveedores.** Los chips
   `is-ok` / `is-warn` / `is-bad` / `is-info` pintan el texto con el tono pleno
   sobre su propio `*-soft` al 18% compuesto sobre `--in-bg-3`, y ninguno llega
   a AA: ok 4.25:1 · warn 4.32:1 · info 4.20:1 · **bad 3.59:1**. Es
   preexistente y transversal a todo el dashboard.
2. **Vigilar `refreshTokenExpiresAt`**, que es lo que realmente obliga a
   reautenticar a mano y hoy no lo mira nadie. Ya registrada por `guru` como
   #6248 — no se duplica.
