

===== COMENTARIO de leitolarreta (2026-08-24T15:41:03Z) (554 chars) =====
## Dependencias detectadas por el pipeline

- #6458

Esta sub-historia queda bloqueada hasta que cierre #6458. El motivo no es administrativo: el barrido de huérfanos lee el canal estructurado `commander-<reqId>.stages.jsonl` y correlaciona por `commander_req_id` / `boot_id`, y esos tres artefactos los crea #6458. Sin ellos el discriminante D-2 tendría que volver a leerse del `.log` de texto plano — que es exactamente el vector falsificable que SEC-1 rechazó.

El brazo de desbloqueo quita `blocked:dependencies` automáticamente cuando #6458 cierra.


===== COMENTARIO de leitolarreta (2026-08-24T15:49:47Z) (10085 chars) =====
## Análisis de seguridad — fase `analisis` (definición)

**Veredicto: aprobado con requisitos de seguridad vinculantes.** La historia no introduce por sí misma una vulnerabilidad: todavía no hay código. Pero abre **tres superficies nuevas** —un lector de filesystem que enumera `.pipeline/logs`, un **escritor nuevo** sobre el audit-log encadenado, y un **valor nuevo** que llega hasta el HTML del dashboard— y cada una tiene un requisito que conviene dejar escrito ahora, para que el dev no lo descubra recién en la fase de revisión.

### Verificación empírica del sustrato (HEAD `b21526863`)

```
$ grep -rn "boot_id\|PULPO_BOOT_ID\|stages.jsonl" .pipeline/*.js .pipeline/lib/**/*.js | grep -v __tests__
<sin resultados>
```

Confirmado: el canal estructurado de etapas y el `boot_id` **no existen aún** — los trae #6458. La dependencia declarada es real y **no es administrativa**: sin ella, el discriminante D-2 tendría que leerse del `.log` de texto plano, que es justamente el vector falsificable. De ahí sale SEC-0.

```
$ grep -n "function commanderOutboundStatus" .pipeline/pulpo.js
12257:function commanderOutboundStatus(rawContent, correlationId) {
```

La única fuente de verdad de entrega existe, es pura y ya está testeada.

---

### Requisitos de seguridad (vinculantes para la implementación)

#### SEC-0 · El veredicto de entrega nunca sale de una fuente falsificable
`[A08 · Software and Data Integrity Failures]`

`esHuerfano` sólo puede leer dos cosas: el canal estructurado de etapas (#6458) y `commanderOutboundStatus(historyRaw, correlationId)`. **Prohibido** derivarlo del cuerpo del `.log`, del texto de la respuesta del modelo (#3951), de `clearFlag`, o de la presencia de la etapa `envío`.

El motivo concreto: el `.log` del Commander contiene texto que **entra desde Telegram**, o sea desde un canal de entrada. Cualquiera con acceso al chat puede mandar un mensaje cuyo cuerpo imite una cabecera de etapa (`--- etapa:resultado req:... ---`), y ese texto queda escrito en el `.log`. Si el barrido parsea el `.log` para decidir, el usuario del chat puede fabricar o suprimir un veredicto de huérfano.

El `.log` legacy sigue siendo fuente de **baja confianza**: puede escalar a `entrega no verificable`, **nunca** suprimir una detección. Test obligatorio: un log legacy con una cabecera de etapa falsificada dentro del cuerpo de un mensaje **no** cambia el veredicto.

#### SEC-1 · Revalidar el `reqId` con `ID_SAFE_RE` antes de cualquier `path.join`
`[A01 · Broken Access Control — path traversal]`

Hay una asimetría real en `request-log.js` que este issue es el primero en pisar:

```js
// request-log.js:165 — metaFileName SÍ sanitiza
function metaFileName(reqId) {
  const safeId = String(reqId == null ? '' : reqId).replace(ID_SAFE_RE, '');
  return `commander-${safeId}.meta.json`;
}

// request-log.js:69 — logFileName NO sanitiza
function logFileName(reqId) {
  return `commander-${reqId}.log`;
}
```

Hoy es inocuo porque el único productor de `reqId` en runtime es `buildRequestId`, que ya sanitiza. Pero el barrido **invierte el flujo de datos**: deriva el `reqId` de un nombre de archivo leído del disco. Un archivo `commander-..%2f..%2fx.log` (o un `reqId` con `../` tras un parseo ingenuo) sale del `readdir` y, si el barrido se lo pasa a `logFileName` o a `writeRequestMeta`, escribe fuera de `LOG_DIR`.

Requisito:
- Aplicar `ID_SAFE_RE` al `reqId` extraído **antes** de usarlo, y **descartar** —no corregir— el archivo cuyo id no matchee `^[a-zA-Z0-9-]+$`. Corregir silenciosamente puede colapsar dos ids distintos en el mismo.
- Tras resolver el path, verificar confinamiento explícito: `path.resolve(p).startsWith(path.resolve(LOG_DIR) + path.sep)`. `path.basename` solo no alcanza como control único.

#### SEC-2 · Symlinks: `withFileTypes` en el `readdir`, no `lstat` suelto
`[A01]`

La nota técnica del issue pide `lstat` para saltear symlinks. `lstat`-y-después-`open` es un TOCTOU: entre la comprobación y la apertura, la entrada puede cambiar.

Requisito: enumerar con `fs.readdirSync(dir, { withFileTypes: true })` y aceptar sólo `dirent.isFile() === true`. Descarta symlink, directorio y FIFO en un solo syscall, sin ventana de carrera. Si igual se usa `lstat`, que sea contra el mismo descriptor que después se lee.

#### SEC-3 · El barrido escribe en el audit-log **sólo** vía `appendChained`
`[A08 · integridad de la cadena]`

El barrido es un **escritor nuevo y concurrente** sobre el mismo `.jsonl` que ya escribe el loop principal. `appendChained` (`audit-log.js:255`) serializa el read-then-append con un file-lock y es **fail-closed**: si no consigue el lock, tira. La CA "el hash-chain de `appendChained` sigue verificando" depende enteramente de pasar por ahí.

- **Prohibido** `appendFileSync` directo al audit-log desde el barrido. Saltear el lock rompe la cadena de forma silenciosa y no reparable.
- El wiring es best-effort (`try/catch`), así que una excepción de lock **no puede matar el tick** — pero tampoco puede tragarse en silencio: hay que loguearla. Un barrido que falla siempre por contención es un barrido que no existe, y el síntoma sería indistinguible de "no hay huérfanos", que es exactamente la clase de ceguera que este issue viene a eliminar.

#### SEC-4 · El evento terminal lleva identificadores, nunca contenido
`[A02/A09 · exposición de datos sensibles]`

`historyRaw` es `.pipeline/commander-history.jsonl` (125 KB hoy) y contiene **el texto de las conversaciones de Telegram y los `chat_id`**.

El evento `fallback_delivery_resolved` que emite el barrido debe llevar únicamente: `commander_req_id`, `correlation_id`, `boot_id`, `delivery_state`, `error_code` y timestamps. **Cero** texto de mensajes, cero excerpts del `.log`, cero `chat_id` que no sea imprescindible para correlacionar.

Es el mismo criterio que ya aplican `requestLog.stage(...)` en `pulpo.js:16135` ("SEC-3: SOLO strings/booleans") y el shape acotado de `writeRequestMeta`. El punto: el barrido no puede ser la puerta por la que el contenido conversacional entra al audit-log, que tiene una política de retención distinta a la de los logs de turno.

#### SEC-5 · `notified` corrupto ⇒ se detecta igual (fail-open en la supresión)
`[A09 · fallo del monitoreo]`

El parámetro `notified` es un **supresor**: lo que está adentro, no se avisa. Lo llena #6460, o sea que es estado en disco, y el estado en disco se corrompe, se trunca y se borra.

Requisito: si el store de `notified` no se puede leer o parsear, `detectOrphans` lo trata como **conjunto vacío** y detecta igual. Nunca "no pude leer los notificados ⇒ no marco nada": eso convierte un archivo corrupto en un apagón silencioso de la detección.

Ojo con la aparente contradicción: fail-**closed** va en la escritura del audit-log (SEC-3), fail-**open** va en la supresión del aviso. No son la misma decisión — una protege integridad, la otra protege visibilidad — y conviene que un test lo fije para que nadie las "unifique" después.

#### SEC-6 · La guarda de vida compara `boot_id` exacto, y el reloj no sale del contenido
`[A08]`

- Comparación `String(bootIdDelTurno) === String(PULPO_BOOT_ID)`: exacta, sin prefijos ni `startsWith`. Un `boot_id` ausente, vacío o no-string **no** es "igual al actual": cae a la guarda de reloj, no al camino "vivo, no evaluar". Si cayera al camino "vivo", bastaría con un `boot_id` vacío para que un huérfano quede invisible para siempre.
- Para el camino legacy (≥ 45 min), el timestamp debe salir del **`epochms` del nombre del archivo** o del `mtime` — **nunca** de un timestamp dentro del contenido del log. El contenido es la parte falsificable; el nombre lo genera `buildRequestId` y ya está sanitizado. Esto además es lo que hace cumplible la CA de "decidir la ventana de 48 h por el nombre antes de abrir nada".

#### SEC-7 · `huerfano` entra al enum cerrado, y el enum es la **única** defensa del HTML
`[A03 · Injection / XSS]`

Verificado ejecutando el módulo actual:

```
$ node -e "const {buildResultBadges} = require('./.pipeline/lib/commander/result-badge'); ..."
"ok"          => <span class="cmd-result cmd-result-ok" title="El turno cerró sin ajustes ni fallback">✓ ok</span>
"huerfano"    => ""
"__proto__"   => <span class="cmd-result cmd-result-__proto__" title=""> </span>
"constructor" => <span class="cmd-result cmd-result-constructor" title=""> </span>
```

Dos lecturas:

1. `huerfano` hoy renderiza cadena vacía. Confirma empíricamente por qué enum + badge + CSS tienen que ir en el **mismo commit**: separarlos deja el huérfano sin badge, que es el síntoma que el issue elimina.
2. `result-badge.js:57` hace `cmd-result-${esc(meta.resultado)}` — o sea, **interpola el valor del sidecar dentro de un atributo `class`**. Está gateado por el lookup en `RESULT_BADGES` y pasa por `esc()`, así que **no hay XSS**. Pero el gate resuelve por cadena de prototipos y deja pasar `__proto__`, `constructor`, `toString`. Va como hardening aparte (#6462), no bloquea a este issue.

Requisito para #6459: el badge de `huerfano` se agrega como **literal estático** en `RESULT_BADGES` — glyph, label y title hardcodeados, jamás derivados del log ni del sidecar — y la clase CSS se sigue construyendo desde el valor ya validado contra el enum. No agregar un camino "resultado libre" ni un `title` dinámico.

---

### Nota no bloqueante

`commander-history.jsonl` no rota (125 KB hoy) y el barrido lo leería **entero** cada ~5 min. No es un riesgo de seguridad hoy, pero conviene que `runOrphanSweep` acote la lectura (tamaño máximo, o lectura por chunks) para que el crecimiento del archivo no se traduzca en presión de memoria en el tick.

### Recomendaciones de hardening (issues aparte)

- #6461 — `logFileName` sin `ID_SAFE_RE`, asimétrico con `metaFileName`.
- #6462 — `RESULT_BADGES` resuelve por cadena de prototipos y renderiza un badge fantasma.

Las dos son **recomendaciones pendientes de triaje humano**: no entran al pipeline automático hasta que un humano las apruebe. Ninguna depende de #6459 ni lo bloquea.

> Auditoría del agente `security` — fase `analisis` del pipeline de definición, issue #6459.


===== COMENTARIO de leitolarreta (2026-08-24T19:57:36Z) (125 chars) =====
## Dependencias resueltas 🟢

Las siguientes dependencias cerraron: #6458.

El pipeline reentra a este issue automáticamente.

===== COMENTARIO de leitolarreta (2026-08-24T20:14:43Z) (10383 chars) =====
## Análisis técnico — fase `analisis` (definición)

**Veredicto: viable. Aprobado.** La dependencia que bloqueaba esta sub-historia (#6458) cerró y mergeó, y verifiqué **en `origin/main`** que todos los puntos de anclaje que el issue nombra existen de verdad. No hay blocker técnico. Dejo abajo la verificación empírica, tres riesgos de implementación y dos correcciones de coordenadas para que el dev no pierda tiempo buscando símbolos donde ya no están.

### 1 · La dependencia #6458 está resuelta (era el único blocker declarado)

```
$ gh issue view 6458 --json state,closedAt,stateReason
{"closedAt":"2026-08-24T19:33:51Z","state":"CLOSED","stateReason":"COMPLETED"}

$ gh pr list --search "6458 in:title,body" --state all --json number,state,mergedAt
[{"mergedAt":"2026-08-24T19:33:50Z","number":6509,"state":"MERGED", ...}]

$ git log --oneline -1 origin/main
687dea0ec [Split de #6440] Canal estructurado de etapas y estado de entrega honesto en el audit del Commander (#6509)
```

Esto invalida la foto que tenía el análisis de seguridad, que corrió sobre `b21526863` (pre-merge) y por eso vio el sustrato ausente. El label `blocked:dependencies` ya no corresponde y el barrido tiene de dónde leer.

### 2 · El sustrato que consume el barrido existe y está exportado

**Canal estructurado + guarda de vida (`boot_id`):**

```
$ git grep -n "PULPO_BOOT_ID\|stages.jsonl\|boot_id" origin/main -- .pipeline/pulpo.js .pipeline/lib | grep -v __tests__
origin/main:.pipeline/lib/commander/request-log.js:89:  return `commander-${safeId}.stages.jsonl`;
origin/main:.pipeline/pulpo.js:610:const PULPO_BOOT_ID = `${process.pid}-${Date.now()}`;
origin/main:.pipeline/pulpo.js:16271:      boot_id: PULPO_BOOT_ID,
```

`PULPO_BOOT_ID` se calcula **a nivel de módulo**, así que la guarda B1 ("boot_id del turno ≠ boot actual ⇒ muerto") es comparación de string pura, sin I/O ni reloj. Es exactamente el discriminante que pide el issue.

**API pública de `request-log.js` — el barrido no necesita reimplementar nada:**

```
$ git show origin/main:.pipeline/lib/commander/request-log.js | grep -n "ID_SAFE_RE\|stagesFileName\|readStages\|hasStage\|module.exports"
49:const ID_SAFE_RE = /[^a-zA-Z0-9-]/g;
87:function stagesFileName(reqId) {
88:  const safeId = String(reqId == null ? '' : reqId).replace(ID_SAFE_RE, '');
295:function readStages(logDir, reqId) {
296:  const file = path.join(logDir, stagesFileName(reqId));
323:function hasStage(stages, nombre) {
361:module.exports = {
367:  ID_SAFE_RE,
369:  stagesFileName,
370:  readStages,
371:  hasStage,
```

Punto importante para el dev: **`stagesFileName` ya sanitiza con `ID_SAFE_RE` internamente** (línea 88), y `readStages` arma el path sólo a través de ella (línea 296). O sea que la asimetría que SEC-1 marcó sobre `logFileName` **no existe en el camino que usa este issue**. El requisito SEC-1 se cumple usando `readStages(logDir, reqId)` y no concatenando paths a mano; no hace falta re-sanitizar por afuera, y conviene no hacerlo para no tener dos verdades.

**Fuente única de verdad de entrega y evento terminal:**

```
$ git grep -n "function commanderOutboundStatus" origin/main -- .pipeline/pulpo.js
origin/main:.pipeline/pulpo.js:12273:function commanderOutboundStatus(rawContent, correlationId) {

$ git grep -n "noteFallbackDeliveryResolved" origin/main -- .pipeline | grep -v __tests__
origin/main:.pipeline/lib/commander/inflight-fallback.js:720:function noteFallbackDeliveryResolved(opts = {}) {
origin/main:.pipeline/lib/commander/inflight-fallback.js:824:    noteFallbackDeliveryResolved,
```

`noteFallbackDeliveryResolved` **ya está exportado** por `inflight-fallback.js` y ya emite `inflight_fallback_delivery_resolved` como evento nuevo. El requisito A3 ("evento terminal, nunca reescritura") queda satisfecho por construcción del módulo — el dev no tiene que inventar el mecanismo, sólo llamarlo.

**Enum, badge y CSS — los tres puntos a tocar en el mismo commit:**

```
$ git show origin/main:.pipeline/lib/commander/request-classify.js | grep -n RESULTADOS
const RESULTADOS = Object.freeze(['ok', 'ajustada', 'fallback', 'error']);   # falta 'huerfano'

$ git show origin/main:.pipeline/lib/commander/result-badge.js | grep -n RESULT_BADGES -A6
const RESULT_BADGES = Object.freeze({ ok / ajustada / fallback / error });   # falta 'huerfano'

$ git grep -n "cmd-result-" origin/main -- .pipeline/dashboard.js
5476-5479: .cmd-result-ok / -ajustada / -fallback / -error                    # falta -huerfano
```

Los tres están donde el issue dice y con la forma que el issue asume. La advertencia del issue ("separarlos deja el huérfano sin badge") es correcta: `result-badge.js` documenta explícitamente que un `resultado` fuera del mapa cae a `undefined` y **no renderiza badge** — o sea que agregar el enum sin el badge produce silenciosamente el mismo síntoma que el issue viene a eliminar.

### 3 · Riesgos de implementación (no bloquean, pero conviene tenerlos escritos)

**R-1 · Los tokens `--result-huerfano` NO están en `main`; viven en una rama sin mergear.**

```
$ git show origin/main:.pipeline/assets/design-tokens.css | grep -n huerfano
<sin resultados>

$ git show origin/agent/6440-ux-assets:.pipeline/assets/design-tokens.css | grep -n huerfano
308:  --result-huerfano:      var(--alert-anomaly);
309:  --result-huerfano-dim:  var(--alert-anomaly-dim);
310:  --result-huerfano-bg:   var(--alert-anomaly-bg);
```

La buena noticia es que los tokens base que esos alias referencian **sí están en `main`**:

```
$ git show origin/main:.pipeline/assets/design-tokens.css | grep -n alert-anomaly
93:  --alert-anomaly:      #FF6B8A;
94:  --alert-anomaly-dim:  #B8254A;
95:  --alert-anomaly-bg:   rgba(255, 107, 138, 0.16);
```

O sea que el CSS del badge no se queda sin color: los alias resuelven apenas se traigan. La nota técnica del issue ya prevé el `git checkout origin/agent/6440-ux-assets -- .pipeline/assets/`. **Sugerencia**: traer el archivo puntual (`-- .pipeline/assets/design-tokens.css`) en vez del directorio entero, y revisar el diff antes de commitear. La rama está anclada a `b21526863`, o sea a un `main` de antes de #6509 y #6374; copiar el directorio completo desde una base vieja es la clase de operación que revierte trabajo ajeno sin que nadie lo note. Hoy no pisa nada, pero la verificación cuesta un `git diff` y evita una regresión silenciosa. Registré la deuda de fondo como recomendación independiente (#6511).

**R-2 · Colisión previsible con hermanos del épico.** #6460 (aviso al operador) depende de éste, así que va secuencial y no preocupa. El que sí puede chocar es **#6469** (*"Mostrar el estado de entrega del turno del Commander como badge en el dashboard"*), que por título toca los mismos dos archivos: `result-badge.js` y la zona `.cmd-result-*` de `dashboard.js`. Si los dos se despachan en paralelo, el conflicto es casi seguro. Vale la pena que se ordenen, o que #6469 se apoye sobre lo que deje éste.

**R-3 · El criterio "100 % de las ramas de decisión" no es medible hoy.** No hay `c8` ni `nyc` en el repo y `test:pipeline` es `node --test` pelado, así que ese criterio se termina aprobando por lectura del test y no por medición. Node v24.13.1 trae cobertura nativa, así que se arregla tocando sólo el script de npm. Lo registré como recomendación independiente (#6510). Para **este** issue alcanza con que el dev enumere en el PR las ramas de decisión de `orphan-sweep.js` y el test que cubre cada una.

### 4 · Correcciones de coordenadas (el merge de #6458 corrió las líneas)

Los números del issue se escribieron contra `b21526863`. Después del merge de #6509 quedaron desfasados. Anclar por símbolo, no por línea:

| El issue dice | En `origin/main` (687dea0ec) | Nota |
|---|---|---|
| `commanderOutboundStatus` en `pulpo.js:12257` | **`pulpo.js:12273`** | mismo símbolo, +16 líneas |
| `persistCommanderResult` en `pulpo.js:16123-16155` | **`pulpo.js:~16196`** | ojo: **no es una función top-level**, es un *closure* dentro del turno del Commander (cierra sobre `commanderDispatch`, `requestLog`, etc.). Un `grep "function persistCommanderResult"` da vacío — por eso no aparece en un barrido ingenuo. La etapa `resultado` se emite en **`pulpo.js:16205`** y el sidecar justo abajo con `writeRequestMeta`. |
| tick junto a `reconcileTelegramReceipts()` en `pulpo.js:22623` | **`pulpo.js:22732`** | |
| boot de `mainLoop` en `pulpo.js:21417+` | **`async function mainLoop()` en `pulpo.js:21522`** | |

Que `persistCommanderResult` sea un closure tiene una consecuencia de diseño que conviene ver antes de codear: el **camino rápido in-process** (punto 5 del issue, marcar `resultado: huerfano` al cierre del turno) sólo puede decidirse con lo que ese closure tiene en scope, y hoy la clasificación sale de `classifyCommanderResult(...)` con un enum cerrado. Meter `huerfano` ahí es agregar un caso al clasificador, no un `if` suelto en el closure — si no, el enum y el valor persistido se desincronizan.

### 5 · Sobre la calidad de la definición

La historia está bien acotada para implementarse: separa núcleo puro (`detectOrphans`) de capa de I/O (`runOrphanSweep`), lo cual hace testeable el 100 % de las ramas sin tocar filesystem; el discriminante D-2 está escrito como código y no como prosa; y los criterios de aceptación son verificables uno por uno. El parámetro `notified` reservado desde el arranque para #6460 evita un refactor de firma en el hijo siguiente. No tengo objeciones de alcance.

### Otras oportunidades observadas

Durante el análisis crucé dos cosas más que no ameritan issue nuevo: la rotación de logs del Commander ya está cubierta por **#6442**, y la neutralización de delimitadores de sección en los logs de etapas por **#6445**. Este último es complementario, no bloqueante: como el discriminante D-2 lee el canal estructurado y `commanderOutboundStatus` —nunca el cuerpo del `.log`—, la superficie de log-forging queda fuera del camino de decisión de este issue.

### Recomendaciones creadas (pendientes de triaje humano)

- **#6510** — Medir cobertura de ramas en `test:pipeline` con el coverage nativo de `node --test`.
- **#6511** — Integrar a `main` los assets de UX que hoy viven sueltos en ramas `agent/*`.

Ninguna de las dos bloquea ni depende de este issue.

---

*Análisis del agente `guru` — fase `analisis` del pipeline de definición. Verificado empíricamente contra `origin/main` en `687dea0ec`.*


===== COMENTARIO de leitolarreta (2026-08-24T20:26:58Z) (6175 chars) =====
## Criterios de aceptación — fase `criterios` (definición)

**Veredicto: aprobado.** La historia entrega valor propio y verificable: hoy un turno que se ejecutó y nunca confirmó entrega es indistinguible de uno que nunca arrancó; después de esta parte se lee como huérfano en la etapa `resultado` y en la fila del dashboard. No necesita a #6460 para valer: detección y visibilidad ya sirven solas al operador. Es una sola entrega, no se subdivide.

Los **CA-1..CA-10** del body quedan vigentes tal cual — están bien formulados y son verificables. Agrego cinco (CA-11..CA-15) que cierran huecos que verifiqué empíricamente sobre `origin/main` (`687dea0ec`), y corrijo una nota técnica del body que llevaba a aceptar esto sin QA visual.

### 1 · Corrección bloqueante: este issue **NO** es `qa:skipped`

El body cerraba con *"`area:pipeline` sin `app:*` ⇒ corresponde `qa:skipped` con justificación escrita"*. Es incorrecto acá, y lo confirma el propio gate del repo ejecutado contra este issue:

```
$ node -e "g.scopeReason({labels, body}); g.evaluate({labels, body}, {flag:'1'})"
scopeReason = pipeline-dashboard
evaluate    = { gate: 'block', scope: 'pipeline-dashboard',
                reason: 'missing-section', missing: [ '## Screenshots & Mockups header' ] }
```

O sea: el issue **ya estaba en scope** del gate de QA visual (por mencionar `.pipeline/dashboard.js`) y le faltaba la sección. Y además hay **mockup acordado versionado**:

```
$ ls .pipeline/assets/mockups/6440/
01-telegram-aviso-huerfano.svg
02-dashboard-badge-huerfano.svg
ux-criterios-6440.md
```

Con diseño acordado, la exención "tooling interno ⇒ sólo QA estructural" no aplica sin importar el `area:*` (#4568, escape #4531). Un badge se acepta **viéndolo renderizado**, no leyendo que el CSS está.

Agregué al body la sección `## Screenshots & Mockups` con el mockup esperado y el hueco del render real. Revalidado:

```
scopeReason = versioned-mockup      # escaló al trigger fuerte de #4568
evaluate    = { gate: 'ok', scope: 'versioned-mockup' }
```

Nota aparte: el gate corre con flag de rollout **apagado** (`SCREENSHOTS_MOCKUPS_GATE_ENABLED` vacío), así que hoy no habría bloqueado a nadie — este issue se habría colado a QA estructural en silencio. Lo registré como recomendación independiente, no bloquea.

### 2 · CA-11 — un mismo huérfano tiene que producir **un** evento, no uno por tick

Es el hueco más concreto. `noteFallbackDeliveryResolved` es un *appender* puro, sin deduplicación:

```
$ git show origin/main:.pipeline/lib/commander/inflight-fallback.js | sed -n '720,753p'
function noteFallbackDeliveryResolved(opts = {}) {
    ...
    return _appendAudit({ ... entry: { event: 'inflight_fallback_delivery_resolved', ... } });
}
```

Cada llamada asienta una entrada nueva en el audit encadenado — que es justo lo correcto para A3 ("evento terminal, nunca reescritura"), pero significa que **la deduplicación tiene que ponerla el llamador**. Y el llamador es este issue.

El detalle que lo vuelve real: el issue dice que `notified` "existe desde el arranque (lo llena #6460); acá se respeta aunque venga vacío". Pero **#6460 todavía no existe**, así que en producción `notified` llega vacío. El barrido corre en bucle sobre una ventana de 48 h y vuelve a detectar al mismo huérfano en cada pasada. Medido recién:

```
$ node -e "logs commander en ventana 48h"
total logs commander: 644 | en ventana 48h: 13
```

Con 13 turnos en ventana y un huérfano dentro (el del episodio), sin marca propia de "ya resuelto" ese huérfano emite un evento cada tick durante dos días. El audit-log encadenado se llena de cientos de copias del mismo hecho, y el CA-4 ("el hash-chain sigue verificando") pasaría igual — la cadena estaría íntegra, sólo que llena de ruido. Por eso va como criterio propio y no como detalle de implementación.

### 3 · CA-12 — el punto de wiring corre cada ~30 s, no cada 5 min

El issue pide el tick "cada ~5 min" al lado de `reconcileTelegramReceipts()`. Pero ese punto se ejecuta en **cada** iteración del `mainLoop`:

```
$ sed -n '22713,22732p' pulpo.js
desyncEvalTick = (desyncEvalTick + 1) % DESYNC_EVAL_EVERY_TICKS;
if (desyncEvalTick === 0) { ... }                 # <-- así se consiguen los ~5 min
...
try { reconcileTelegramReceipts(); } catch (e) { ... }   # <-- sin gateo: cada iteración

$ grep -n "DESYNC_EVAL_EVERY_TICKS\s*=" pulpo.js
18413:const DESYNC_EVAL_EVERY_TICKS = 10;
```

Poner el barrido ahí sin gatear por ticks lo hace correr ~10× más seguido que lo declarado, releyendo `commander-history.jsonl` entero cada vez (la nota no bloqueante de seguridad sobre los 125 KB sin rotar se vuelve 10× peor). El criterio pide el contador explícito, como ya lo hace `desyncEvalTick`.

### 4 · CA-14 y CA-15 — que el silencio no se confunda con salud, y una cobertura que se pueda medir

CA-14 sale de SEC-3: el barrido es best-effort y no puede romper el tick, de acuerdo — pero un barrido que falla **siempre** produce exactamente la misma salida que "no hay huérfanos". Eso es el bug original del episodio otra vez, un nivel más arriba. Tiene que dejar rastro con la causa.

CA-15 recoge el riesgo R-3 del análisis técnico: "100 % de las ramas" no es medible hoy (no hay `c8`/`nyc`, `test:pipeline` es `node --test` pelado), así que se aprobaría por lectura, que es igual a no tener criterio. Lo aterrizo: el PR enumera las ramas de decisión de `detectOrphans` y nombra el test que cubre cada una. La deuda de fondo ya está en #6510.

### 5 · Lo que NO reabro

D-1 (ventana 48 h), D-2 (el discriminante no es "falta la etapa `envío`"), B1 (guarda por `boot_id`) y UX-5 (guarda de reloj de respaldo nunca menor a 45 min, ante la duda silencio) están cerrados en la definición del padre y sostenidos con datos. Los CA-11..CA-15 no los tocan.

### Definición de terminado

- Los quince criterios (CA-1..CA-15) verificados.
- Enum + badge + CSS en el **mismo** commit — separarlos deja el huérfano sin badge, que es el síntoma que el issue viene a eliminar.
- Screenshot del badge renderizado, comparado contra `02-dashboard-badge-huerfano.svg`, adjunto al PR.
- `npm run test:pipeline` en verde.

Recomendación pendiente de aprobación humana: #6513


===== COMENTARIO de leitolarreta (2026-08-24T20:38:10Z) (10582 chars) =====
## Criterios UX — fase `criterios` (definición)

**Veredicto: aprobado.** Los assets visuales de esta historia **ya están producidos** y cubren el alcance de esta sub-historia (el badge del dashboard; el aviso de Telegram es #6460). Verifiqué uno por uno los números que el body afirma —contraste, composición del fondo, puntos de anclaje— y **todos dan exacto**. No re-diseño nada.

Lo que sí agrego son **cinco criterios UX** que salen de verificar el sustrato real contra `origin/main` (`687dea0ec`). El primero es el importante: tal como está escrito hoy, el CA-6 lleva a un badge que **se ve incoloro** en el escenario degradado — que es justo el síntoma que el issue viene a eliminar.

---

### 1 · Los assets existen, pero **NO están en `origin/main`**

El CA-6 dice *"los tokens `--result-huerfano` / `-bg` / `-dim` que UX ya commiteó en `.pipeline/assets/design-tokens.css`"*. Eso se lee como "ya están en main". **No lo están:**

```
$ git diff origin/main -- .pipeline/assets/design-tokens.css | grep "^+.*result-huerfano"
+  --result-huerfano:           var(--alert-anomaly);         /* glifo + label del badge */
+  --result-huerfano-dim:       var(--alert-anomaly-dim);     /* borde del badge */
+  --result-huerfano-bg:        var(--alert-anomaly-bg);      /* fondo del badge */

$ git ls-tree -r --name-only origin/main -- .pipeline/assets/mockups/ | grep 6440
(sin resultados)
```

Viven **sólo** en la rama de assets, que sigue viva y sin mergear:

```
$ git log --oneline -1 a571b8c2b626e74d214acc28deffaa07ff76a87f
a571b8c2b feat(ux): copy y sistema visual del aviso de respuesta perdida (#6440)

$ git ls-tree -r --name-only a571b8c2b -- .pipeline/assets/design-tokens.css .pipeline/assets/mockups/6440/
.pipeline/assets/design-tokens.css
.pipeline/assets/mockups/6440/01-telegram-aviso-huerfano.svg
.pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg
.pipeline/assets/mockups/6440/ux-criterios-6440.md
```

**Buena noticia: el `git checkout` que propone el body es seguro.** Verifiqué que `main` no tocó `design-tokens.css` desde la base de esa rama, así que traerlo no pisa trabajo de nadie:

```
$ BASE=$(git merge-base a571b8c2b origin/main)   # b21526863
$ git diff --stat $BASE origin/main -- .pipeline/assets/
 .../6173/6173-01-tarjeta-decision-dashboard.svg    | 169 +++
 .../6173/6173-02-telegram-ficha-agrupada.svg       | 135 +++
 .pipeline/assets/mockups/6173/ux-criterios-6173.md | 128 +++
 ...-telegram-presupuesto-recordatorio-fallback.svg | 101 +++
 .../assets/mockups/6190/ux-contrato-copy-6190.md   | 413 +++
 5 files changed, 946 insertions(+)
```

Sólo mockups nuevos de #6173/#6190; `design-tokens.css` **no** aparece ⇒ el checkout agrega el bloque `huerfano` y no revierte nada. (Y `git checkout <ref> -- <dir>` no borra archivos que el ref no tiene, así que esos mockups de #6173/#6190 sobreviven.)

- [ ] **UX-1 · Los tokens `--result-huerfano*` entran a `main` en el MISMO commit que la regla CSS.** El SHA inmutable es `a571b8c2b626e74d214acc28deffaa07ff76a87f` (usalo en vez del nombre de rama, que es podable). Un `.cmd-result-huerfano` que referencia tokens inexistentes es indistinguible de no tener badge.

---

### 2 · UX-2 es el criterio bloqueante: **el fallback literal**

Este es el hueco real. Las cuatro reglas vigentes **todas** llevan fallback legacy, a propósito:

```
$ sed -n '5473,5479p' .pipeline/dashboard.js
 *    sólo del color). Tokens con fallback legacy por si design-tokens.css no
.cmd-result-ok       {color:var(--success,var(--gn));  ...border-color:var(--success-dim,var(--gn2))}
.cmd-result-ajustada {color:var(--warning,var(--yl));  ...border-color:var(--warning-dim,var(--yl2))}
.cmd-result-fallback {color:var(--info,var(--ac));     ...border-color:var(--info-dim,var(--ac2))}
.cmd-result-error    {color:var(--danger,var(--rd));   ...border-color:var(--danger-dim,var(--rd2))}
```

El fallback no es decorativo: `loadDesignTokens()` **degrada en silencio a cadena vacía**.

```
$ sed -n '176,179p' .pipeline/dashboard.js
    _designTokensCache = fs.readFileSync(path.join(ASSETS_DIR, 'design-tokens.css'), 'utf8');
  } catch {
    _designTokensCache = ''; // degradacion silenciosa: dashboard sigue con paleta legacy inline
```

Y acá está el problema específico de `huerfano`: **la paleta legacy inline no tiene ningún rosa.**

```
$ sed -n '4655,4665p' .pipeline/dashboard.js
  --ac:#58a6ff;--ac2:#1f6feb;
  --gn:#3fb950;--gn2:#196c2e;
  --yl:#d29922;--yl2:#9e6a03;
  --rd:#f85149;--rd2:#8b1a14;
  --or:#db6d28;--or2:#7d3410;
  --pu:#bc8cff;
```

O sea: `ok/ajustada/fallback/error` tienen a dónde caer (`--gn/--yl/--ac/--rd`); `huerfano` **no**. Copiar el patrón `var(--result-huerfano, var(--algo-legacy))` no funciona porque ese `--algo-legacy` no existe. Sin design-tokens el badge renderiza con `color` sin resolver ⇒ hereda el color de la fila, sin fondo y sin borde ⇒ **vuelve a ser una fila muda**, que es exactamente el escape #4531.

- [ ] **UX-2 · `.cmd-result-huerfano` usa fallback con el hex literal, no con una variable legacy.** Concretamente `var(--result-huerfano,#FF6B8A)`, `var(--result-huerfano-bg,rgba(255,107,138,0.16))`, `var(--result-huerfano-dim,#B8254A)`. Verificable: renderizar el dashboard con `design-tokens.css` inaccesible y comprobar que el badge **sigue teniendo** glifo, color rosa, fondo y borde. Es la única de las cinco reglas que necesita este tratamiento, precisamente porque es la única cuyo color no está en la paleta legacy.

---

### 3 · Contraste: verificado, no estimado — los números del body dan exacto

Recalculé sobre el fondo **compuesto real** (no sobre el color plano), con luminancia relativa WCAG 2.x:

```
$ node -e "<luminancia relativa WCAG 2.x + composicion alpha sobre surface-0>"
badge-bg compuesto real   = #341f29
huerfano  sobre surface-0 = 6.96
huerfano  sobre badge-bg  = 5.62
error(ref) sobre surface-0= 5.65
ok(ref)    sobre surface-0= 7.45
```

Los dos valores que afirma el body (**6.96:1** y **5.62:1**) son correctos al centésimo, ambos **AA normal** (>= 4.5:1), y el estado nuevo **no baja el piso existente**: rinde mejor que el `error` vigente (5.65:1). La elección de no reusar `--danger` está bien fundada y es una decisión de significado, no estética: el pedido **no falló** —se ejecutó entero—, lo que se perdió fue la respuesta. Pintarlo del rojo de `error` le diría al operador "falló" donde el dato real es "se hizo y no te enteraste": el malentendido exactamente opuesto al que el issue cierra.

- [ ] **UX-3 · El badge `huerfano` no reusa `--danger` / `--result-error`.** Si en implementación aparece rojo, es un defecto de significado, no un detalle de color.

---

### 4 · Precisiones de vocabulario y alcance (para que nadie las "arregle")

Verifiqué cómo se deriva la clase CSS:

```
$ grep -n "cmd-result-" .pipeline/lib/commander/result-badge.js
      html += `<span class="cmd-result cmd-result-${esc(meta.resultado)}" ...
```

La clase sale **del valor del enum**, así que `huerfano` (sin tilde) ⇒ `.cmd-result-huerfano`. La **etiqueta visible** sí lleva tilde: `huérfano`. No es una inconsistencia: es enum vs. copy.

- [ ] **UX-4 · `huerfano` sin tilde en el enum y en la clase CSS; `huérfano` con tilde en la etiqueta visible y en el tooltip.** Tildar el enum rompe el selector CSS; sacarle la tilde a la etiqueta es un error de ortografía a la vista del operador.

Sobre el alcance del checkout: el comando del body trae también `.pipeline/assets/copy/orphan-turn/` (4 archivos), que es el copy del **aviso de Telegram de #6460** y no se usa acá. No es un defecto —son assets inertes— pero conviene que el PR de este issue traiga sólo lo suyo (`design-tokens.css` + `mockups/6440/`) para que el diff se lea honesto. No lo pongo como CA.

También verifiqué que **no hay leyenda ni filtro** que haya que actualizar además de los tres puntos que ya nombra el CA-6:

```
$ grep -rn "RESULTADOS|'ajustada'" .pipeline/lib .pipeline/*.js | grep -v __tests__
.pipeline/lib/commander/request-classify.js:28:const RESULTADOS = Object.freeze(['ok','ajustada','fallback','error']);
.pipeline/lib/commander/request-classify.js:127: *   resultado: 'ok'|'ajustada'|'fallback'|'error',
.pipeline/lib/commander/result-badge.js:26:  ajustada: { glyph: '...', ...
```

Enum + mapa de badges + CSS. Los tres, mismo commit, como pide el CA-6. Confirmado que no falta un cuarto lugar.

---

### 5 · UX-5 · Lo que tiene que mostrar la captura del CA-13

El CA-13 del PO ya exige comparar screenshot contra `02-dashboard-badge-huerfano.svg`, y estoy de acuerdo. Preciso **qué** tiene que probar la captura, porque el mockup plantea la comparación como *dos filas juntas*, no como un badge suelto:

- [ ] **UX-5 · La captura del CA-13 muestra una fila `huerfano` y, en la misma imagen, una fila sin badge.** El mockup dedica su panel central a esto (`HOY · las dos filas se ven igual` vs `CON EL BADGE · se separan de un vistazo`): el valor entregado no es "existe un badge rosa", es **"la fila con respuesta perdida ya no se confunde con un log viejo sin metadata"**. Una captura de un badge aislado no evidencia eso. Se debe ver el glifo del conjunto vacío, la etiqueta `huérfano`, y el rosa resuelto desde `--result-huerfano*` — no gris, no el rojo de `error`.

Nota de accesibilidad, ya resuelta por el diseño: el glifo discrimina por **forma** además de por color (el set completo es `ok / ajustada / fallback / error / huerfano` con cinco glifos distintos), así que el estado se lee sin depender del rosa. Eso importa porque el rosa `#FF6B8A` y el rojo `#F85149` de `error` conviven en la misma columna y en protanopia/deuteranopia se acercan. No hace falta ningún cambio: el set de glifos ya lo cubre. Lo dejo escrito para que la forma no se descarte como "detalle" en una refactorización futura.

---

### Assets — no se re-diseñan

| Asset | Estado | Alcance |
|---|---|---|
| `.pipeline/assets/design-tokens.css` (bloque `--result-huerfano*`) | producido — `a571b8c2b` | **#6459** |
| `.pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg` | producido — `a571b8c2b` | **#6459** |
| `.pipeline/assets/mockups/6440/ux-criterios-6440.md` | producido — `a571b8c2b` | contexto |
| `.pipeline/assets/mockups/6440/01-telegram-aviso-huerfano.svg` | producido | #6460 |
| `.pipeline/assets/copy/orphan-turn/*` | producido | #6460 |

Los dos SVG verificados: XML bien formado, sin `script`, sin manejadores de evento, sin recursos externos.

```
$ node -e "...02-dashboard-badge-huerfano.svg..."
bytes 12217 script? false href externo? false
```

---

Recomendaciones pendientes de aprobación humana: #6516.


===== COMENTARIO de leitolarreta (2026-08-24T20:50:56Z) (1151 chars) =====
<!-- architect-signoff issue=6459 -->
## ✅ Arquitecto — firma de pre-admisión

**Receta técnica:** ver sección "Detalles Técnicos" del body

Verificada empíricamente contra `origin/main` (`687dea0ec`) en esta pasada. Tres hallazgos que no estaban en la definición y que, sin la receta, se descubrían recién en review:

1. **`noteFallbackDeliveryResolved` no acepta `success` ni `error_code`, y `'delivered'`/`'not_delivered'` no existen en `DELIVERY_STATES`.** `_normalizeDeliveryState` colapsa a `null` en silencio ⇒ CA-2 y CA-3 fallarían sin ruido si se copian los literales del body. Mapeo correcto y extensión aditiva del entry en R-1.
2. **El `correlationId` vive únicamente en la etapa `envío`**, que es precisamente la que un huérfano no tiene ⇒ D-2 no es invocable tal como está escrito. Resolución explícita (y por qué no viola CA-7) en el punto 2 del patrón.
3. **Tensión aparente CA-1 vs CA-6**, resuelta separando el camino in-process del barrido a posteriori (R-3). Es la ambigüedad con más chance de generar rebote.

**Modelo:** Sonnet 4.7 (fallback: ninguno)
**Tokens:** 0 in / 0 out — $0.00

Issue habilitado para promoción a `Ready`.


===== COMENTARIO de leitolarreta (2026-08-24T21:17:34Z) (8579 chars) =====
## Análisis técnico — `guru` · fase `validacion` (pipeline `desarrollo`)

**Veredicto: viable, sin blockers. `resultado: aprobado`.**

Todo lo que sigue se verificó ejecutando comandos contra `origin/main`
(`687dea0ec`) en esta misma pasada — no cito de memoria ni del body del issue.

### 1 · La dependencia declarada está cerrada

```
$ gh issue view 6458 --json state  => CLOSED   ("Canal estructurado de etapas…")
$ gh issue view 6509 --json state  => MERGED   (el PR que la cerró)
$ git log --oneline -1 origin/main => 687dea0ec [Split de #6440] … (#6509)
```

No corresponde `dependency_block`: el sustrato que este issue consume ya está
en `main`.

### 2 · Las coordenadas de la receta existen, una por una

```
$ git grep -n "…" origin/main -- .pipeline/pulpo.js
:610    const PULPO_BOOT_ID = ...process.pid...Date.now()...
:12273  function commanderOutboundStatus(rawContent, correlationId) {
:16195  const persistCommanderResult = (hadError) => {      <- closure, tal cual advierte la receta
:16271  boot_id: PULPO_BOOT_ID,                             <- la etapa `transcripción` sí lo lleva
:18413  const DESYNC_EVAL_EVERY_TICKS = 10;
:22714  desyncEvalTick = (desyncEvalTick + 1) % DESYNC_EVAL_EVERY_TICKS;
:22732  try { reconcileTelegramReceipts(); } catch (e) { … }
```

```
$ git show origin/main:.pipeline/lib/commander/request-log.js | sed -n '361,373p'
module.exports = { buildRequestId, logFileName, openRequestLog, metaFileName,
  writeRequestMeta, ID_SAFE_RE,
  stagesFileName, readStages, hasStage, buildAuditReqRef };   <- #6458, los 4 helpers están
```

`request-classify.js:28` => `RESULTADOS = Object.freeze(['ok','ajustada','fallback','error'])`
(enum cerrado, 4 valores). `result-badge.js` => `RESULT_BADGES` con esos mismos 4.
`dashboard.js:5476-5479` => las 4 reglas `.cmd-result-*`. La quinta entrada hay
que agregarla en los tres lugares, como dice el issue.

### 3 · R-1 confirmado — es un riesgo real, no defensivo

```
$ git show origin/main:.pipeline/lib/commander/inflight-fallback.js | sed -n '181p'
const DELIVERY_STATES = new Set(['delivery_pending','delivery_observed','delivery_failed']);

$ … | sed -n '183,185p'
function _normalizeDeliveryState(v) {
    return (typeof v === 'string' && DELIVERY_STATES.has(v)) ? v : null;   <- colapsa a null EN SILENCIO
}
```

Y el `entry` de `noteFallbackDeliveryResolved` (`:720-748`) lleva exactamente
`event, skill, primary_provider, secondary_provider, request_id, chat_id_hash,
resolved_by, commander_req_id, delivery_state`. **No hay `success` ni
`error_code`.** Si el dev copia literal el punto 4 de "Cambios requeridos"
(`delivery_state: 'delivered' / 'not_delivered'`, `success`, `error_code`),
CA-2 y CA-3 fallan sin ruido: el estado queda `null` y los dos campos se
descartan. La mitigación de la receta (mapear a `delivery_observed` /
`delivery_failed` + extender el entry con los dos campos **aditivos al final**)
es la correcta y es **obligatoria**, no opcional.

### 4 · R-5 verificado: el checkout de los tokens es seguro

Ésta era la operación con más olor a "revierte trabajo ajeno". No lo hace:

```
$ git diff a571b8c2b^ origin/main -- .pipeline/assets/design-tokens.css
(vacío)
```

El `design-tokens.css` de `main` es **idéntico** al padre de `a571b8c2b`, así
que `git checkout a571b8c2b… -- .pipeline/assets/design-tokens.css` sólo
**agrega** el bloque `--result-huerfano*` (3 tokens + comentario) y no pisa
nada. Los tokens resuelven a `--alert-anomaly` (`:93-97`, `#FF6B8A` /
`#B8254A` / `rgba(255,107,138,0.16)`), que sí está declarado en ese archivo.
El mockup de CA-13 también vive en ese commit
(`.pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg`, 172 líneas).

**Ojo (aporte de esta fase):** el mockup **tampoco está en `main`**, y la
pre-checklist sólo trae el `design-tokens.css`. Para comparar el render contra
él en CA-13 no hace falta commitearlo — alcanza con
`git show a571b8c2b626e74d214acc28deffaa07ff76a87f:.pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg > /tmp/mockup.svg`.
Que quede escrito para que QA visual no se frene buscando un archivo que no
existe en el working tree.

### 5 · UX-2 confirmado: sin fallback hex el badge sale sin color

```
$ git show origin/main:.pipeline/dashboard.js | sed -n '176,179p'
  } catch {
    _designTokensCache = '';   // degradacion silenciosa: dashboard sigue con paleta legacy inline
  }
```

Y las 4 reglas `.cmd-result-*` vigentes usan el patrón
`var(--success, var(--gn))` — o sea, apoyadas en la paleta legacy inline, que
efectivamente **no tiene ningún rosa**. Copiar ese patrón para `huerfano` deja
el badge sin color cuando el archivo de tokens no se puede leer. El fallback
hex literal de la receta es la solución correcta.

### 6 · Observaciones nuevas de esta fase (no bloquean, sí importan al implementar)

**O-1 · El estado `'unknown'` de `commanderOutboundStatus` no está en la tabla de tests.**
La función devuelve cuatro valores, no tres:

```
$ git show origin/main:.pipeline/pulpo.js | sed -n '12273,12287p'
  if (!rawContent || typeof rawContent !== 'string' || !correlationId) return 'unknown';
  let status = 'unknown';
  …  reconcile+enviado|fallido => status = e.status;  else out => 'encolado'
  return status;
```

La tabla de "Tests obligatorios" cubre `'fallido'` y `'encolado'` => huérfano,
pero **no** `'unknown'`. Con el discriminante propuesto (`entrega !== 'enviado'
&& entrega !== 'no_verificable'`), `'unknown'` **cuenta como huérfano**. Eso
pasa cuando hay `correlation_id` en la etapa `envío` pero el
`commander-history.jsonl` no tiene ninguna entry para él — p. ej. si el
historial se rotó o truncó dentro de la ventana de 48 h. Es un falso positivo
plausible. Pido que el dev **decida el caso explícitamente** (mi lectura: es el
mismo caso que `'directo'` => `NO_VERIFICABLE`, porque "no encuentro rastro" no
es "no se entregó" — SEC-0/B5) y agregue la fila a la tabla de ramas de CA-15.
No es blocker: es una rama de decisión más, del mismo tipo que las ya listadas.

**O-2 · `readStages` no acepta `fsImpl` — la inyección tiene que ser del lector entero.**

```
$ git show origin/main:.pipeline/lib/commander/request-log.js | sed -n '295,298p'
function readStages(logDir, reqId) {
  const file = path.join(logDir, stagesFileName(reqId));
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
```

Usa `fs` del módulo, sin hook de test. El test de CA-8 ("archivo viejo => **no
se abre**, espiar el lector inyectado") sólo funciona si `readStages` entra por
`deps` en `runOrphanSweep`, no si el módulo lo requiere directo. La receta ya
prevé `deps`; queda anotado que **ese** helper específico tiene que ir ahí sí o
sí, o CA-8 es inverificable.

**O-3 · La inyección de `outboundStatus` está confirmada como viable.**
`commanderOutboundStatus` **sí** se exporta desde `pulpo.js`: la suite vigente
lo importa con `process.env.PULPO_NO_AUTOSTART='1'; require('../../pulpo')`
(`commander-outbound-reconcile.test.js:12-27`). O sea, el wiring en `pulpo.js`
puede pasarlo por `deps` sin ningún trabajo previo. Confirmado, no supuesto.

**O-4 · El sustrato todavía está vacío en este host.**

```
$ ls .pipeline/logs/*.stages.jsonl | wc -l
0
```

Cero archivos de etapas, porque el proceso vivo acá corre `b21526863`
(pre-#6509). No es un problema del issue — es la consecuencia esperada de que
#6458 recién se mergeó — pero sí quiere decir que **el fixture del test tiene
que ser sintético** y que la verificación E2E contra logs reales sólo va a ser
posible cuando corra un Pulpo con `main` post-`687dea0ec`. Que nadie lo lea
como "el barrido no encuentra nada, luego funciona".

**O-5 · R-6 sigue vivo.** #6469 está **OPEN** y toca `result-badge.js` y la
misma zona `.cmd-result-*` de `dashboard.js`. El conflicto es real si van en
paralelo.

### 7 · Cobertura de la definición

El issue trae objetivo, contexto con episodio verificado, 15 CA verificables,
3 escenarios Gherkin, tabla archivo→acción anclada por símbolo, 8 riesgos con
mitigación, tabla rama→test y pre-checklist. **Contexto técnico: suficiente y
por encima del estándar.** No hay ambigüedad que justifique rebote a
definición.

### Recomendaciones creadas

- #6525 — `[guru] Extraer las funciones puras de reconciliación de salientes de
  pulpo.js a lib/commander/outbound-status.js`. **Pendiente de triaje humano**
  (`tipo:recomendacion` sin `recommendation:approved`); **no depende ni bloquea
  a #6459**.

Sin otras oportunidades por encima del umbral: la cobertura de ramas ya está
registrada en #6510 y el resto del alcance es específico de este issue.


===== COMENTARIO de leitolarreta (2026-08-24T21:32:48Z) (5816 chars) =====
## UX · fase `validacion` — APROBADO

Verificación empírica de los assets entregados en `criterios`, ejecutada en esta
pasada contra `origin/main` = `687dea0ec`. Todo output pegado abajo es real.

### 1 · Los assets existen y son alcanzables (no se re-diseñan)

```
$ git ls-remote --heads origin | grep 6440
a571b8c2b626e74d214acc28deffaa07ff76a87f    refs/heads/agent/6440-ux-assets

$ git cat-file -t a571b8c2b626e74d214acc28deffaa07ff76a87f
commit

$ git ls-tree -r --name-only a571b8c2b -- .pipeline/assets/mockups/6440/
.pipeline/assets/mockups/6440/01-telegram-aviso-huerfano.svg
.pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg
.pipeline/assets/mockups/6440/ux-criterios-6440.md
```

La rama **está pusheada en `origin`**, así que el SHA no corre riesgo de GC. Sigue
siendo cierto —y sigue siendo responsabilidad del dev— que **no están en `main`**:

```
$ git show origin/main:.pipeline/assets/design-tokens.css | grep result-huerfano
(sin resultados)
$ git ls-tree -r --name-only origin/main -- .pipeline/assets/mockups/ | grep 6440
(sin resultados)
```

### 2 · CORRECCIÓN BLOQUEANTE aplicada al body: el checkout del directorio entero borra trabajo ajeno

El body decía, en "Notas técnicas":
`git checkout origin/agent/6440-ux-assets -- .pipeline/assets/` — **el directorio completo**.
Eso contradice a R-5 (que pide el archivo puntual) y es destructivo. Medido:

```
$ git diff origin/main a571b8c2b --stat -- .pipeline/assets/
 .pipeline/assets/copy/orphan-turn/README.md          |  65 ++++
 .pipeline/assets/copy/orphan-turn/copy.json          | 108 ++++++
 .pipeline/assets/copy/orphan-turn/render.js          | 215 +++++++++++
 .pipeline/assets/copy/orphan-turn/validate-copy.js   | 272 ++++++++++++++
 .pipeline/assets/design-tokens.css                   |  16 +
 .../6173/6173-01-tarjeta-decision-dashboard.svg      | 169 ---------
 .../6173/6173-02-telegram-ficha-agrupada.svg         | 135 ---------
 .pipeline/assets/mockups/6173/ux-criterios-6173.md   | 128 ---------
 ...telegram-presupuesto-recordatorio-fallback.svg    | 101 ---------
 .../assets/mockups/6190/ux-contrato-copy-6190.md     | 413 ---------------
 .../mockups/6440/01-telegram-aviso-huerfano.svg      | 168 +++++++++
 .../mockups/6440/02-dashboard-badge-huerfano.svg     | 172 +++++++++
 .pipeline/assets/mockups/6440/ux-criterios-6440.md   | 310 ++++++++++++++
 13 files changed, 1326 insertions(+), 946 deletions(-)
```

**946 borrados**: los 3 mockups de #6173 y los 2 de #6190. La rama de assets está
anclada a un `main` previo, así que checkoutear el dir entero **revierte** trabajo de
otras historias, en silencio y sin conflicto. Ya corregí la línea del body por los dos
comandos aditivos correctos (`design-tokens.css` + `mockups/6440/`, `+16` y `+650`).

### 3 · Contraste: recalculado de cero, coincide y no baja el piso vigente

```
badge-bg compuesto real (#FF6B8A @0.16 sobre #0D1117) = #341F29
huerfano #FF6B8A sobre surface-0 = 6.96:1   <- AA normal
huerfano #FF6B8A sobre badge-bg  = 5.62:1   <- AA normal
error    #F85149 sobre surface-0 = 5.65:1   <- referencia vigente
```

Los números del body son exactos. El estado nuevo **no baja** el piso del `error`.
Del borde: `--result-huerfano-dim` rinde 2.48:1 contra el fondo del badge, mejor que
el 1.76:1 del `error` vigente. Ninguno llega a 3:1 (SC 1.4.11) pero el borde no porta
significado (glifo + etiqueta + relleno sí) — observación sistémica, **no** blocker
de este issue: queda en #6526.

### 4 · Mockup acordado (CA-13) — íntegro y seguro

```
$ md5sum .pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg
ad394d3f3191eedc0e4e08c87ba37def
XML bien formado (root=svg), 12341 bytes
glifo "∅": 3 ocurrencias | etiqueta "huérfano": 3 | tokens result-huerfano: 5
FF6B8A: 9 | B8254A: 4
script / onload / onclick / <image> / href externo: ninguno
```

Es la baseline contra la que se compara el screenshot de CA-13. Sin esa captura
comparada, la fase de aprobación rechaza.

### 5 · UX-2 sigue vivo y sigue siendo bloqueante en `main`

```
$ git show origin/main:.pipeline/dashboard.js | sed -n '173,180p'
    _designTokensCache = fs.readFileSync(... 'design-tokens.css'), 'utf8');
  } catch {
    _designTokensCache = ''; // degradacion silenciosa: dashboard sigue con paleta legacy inline
  }
$ ... paleta legacy :root (4655) | grep -i "ff6b|pink|rosa"
NINGUN ROSA
```

Las 4 reglas `.cmd-result-*` vigentes (`dashboard.js:5476-5479`) caen a
`--gn/--yl/--ac/--rd`. Para `huerfano` **no hay legacy donde caer** ⇒ el fallback
hex literal del punto 4 de la receta es obligatorio, no una preferencia.

### 6 · Anclajes visuales confirmados en `origin/main` (los 3, ninguno más)

```
request-classify.js:28   const RESULTADOS = Object.freeze(['ok','ajustada','fallback','error']);
result-badge.js:24-31    RESULT_BADGES = { ok, ajustada, fallback, error }
dashboard.js:5475        .cmd-result{...}   (clase base, no se toca)
dashboard.js:5476-5479   .cmd-result-ok/-ajustada/-fallback/-error
```

No hay leyenda ni filtro extra que actualizar. **Sí** hay un comentario a sincronizar
que la receta no nombra: `dashboard.js:5471` dice literalmente
`Mapea el enum cerrado (ok/ajustada/fallback/error) a los 4 tokens` — pasa a cinco.
Junto con el JSDoc de `request-classify.js:127` que la receta sí lista.

Recordatorio de `result-badge.js:59`: la clase sale del valor del enum
(`cmd-result-${esc(meta.resultado)}`) ⇒ `huerfano` **sin tilde** en enum y CSS,
`huérfano` **con tilde** sólo en la etiqueta visible y el tooltip (R-7).

### Veredicto

`aprobado`. Los assets están, son correctos, alcanzables y accesibles; el mockup
acordado sirve de baseline para CA-13; y la única trampa de UX que quedaba en el
body (el checkout destructivo) quedó corregida antes de que el dev la pise.

Recomendaciones pendientes de aprobación humana: #6526.


===== COMENTARIO de leitolarreta (2026-08-24T21:54:53Z) (4630 chars) =====
## ✅ Validación PO — fase `validacion` (pipeline `desarrollo`)

Gate de PO: **criterios de aceptación completos** + **labels correctos**. Todo el output de abajo es real de esta pasada.

### 1) Labels — correctos y completos

```
$ gh issue view 6459 --json labels --jq '.labels[].name'
bug
Ready
priority:high
area:pipeline
size:grande
```

- **tipo**: `bug` ✔ (el issue nace del episodio verificado del 2026-08-24)
- **área**: `area:pipeline` ✔ (sin `app:*`, correcto: el alcance es Pulpo + dashboard)
- **prioridad**: `priority:high` ✔ (heredada del padre #6440)
- **estado**: `Ready` ✔
- **sizing**: `size:grande`, `dividido: false` — correcto por el freno de cascada de #5837 (es hijo del split de #6440, no se re-parte). El defecto de corte ya quedó reportado sobre el padre.
- **NO** lleva `qa:skipped` ✔ — es lo que corregí en `criterios` y sigue firme (ver punto 3).

### 2) Criterios de aceptación — completos y verificables

```
$ grep -n "^## " body.md
## Objetivo / ## Contexto / ## Cambios requeridos
## Criterios de aceptación
## Escenarios Gherkin
## Tests obligatorios
## Notas técnicas
## Criterios de aceptación adicionales (PO · fase criterios)
## Screenshots & Mockups
## Detalles Técnicos
```

15 CA (CA-1..CA-10 originales + CA-11..CA-15 agregados en `criterios`), 3 escenarios Gherkin, tabla de tests obligatorios con archivo por caso, y receta anclada por símbolo. Cada CA es falsable con un comando o un test concreto — ninguno es ambiguo.

### 3) QA visual sigue siendo obligatorio (CA-13) — gate re-ejecutado

```
$ node -e "g=require('./.pipeline/hooks/screenshots-mockup-gate.js'); ..."
scopeReason      = versioned-mockup
evaluate(flag=1) = {"gate":"ok","scope":"versioned-mockup"}
```

El issue está en scope por **mockup versionado** (trigger fuerte de #4568), no por el label de área. La sección `## Screenshots & Mockups` está presente y el gate pasa. **No** se acepta por QA estructural: en `aprobacion` voy a exigir el screenshot del dashboard renderizado comparado contra `02-dashboard-badge-huerfano.svg` (glifo `∅`, etiqueta `huérfano`, color resuelto desde `--result-huerfano*`). Ese es el modo de falla del escape #4531.

### 4) Baseline de CA-13 alcanzable — verificado, no citado

```
$ git cat-file -t a571b8c2b626e74d214acc28deffaa07ff76a87f
commit
$ git ls-tree -r --name-only a571b8c2b -- .pipeline/assets/mockups/6440/
.pipeline/assets/mockups/6440/01-telegram-aviso-huerfano.svg
.pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg
.pipeline/assets/mockups/6440/ux-criterios-6440.md
$ git show a571b8c2b:.pipeline/assets/design-tokens.css | grep -n result-huerfano
308:  --result-huerfano:     var(--alert-anomaly);
309:  --result-huerfano-dim: var(--alert-anomaly-dim);
310:  --result-huerfano-bg:  var(--alert-anomaly-bg);
```

Y confirmo la corrección bloqueante que UX aplicó al body en esta misma fase:

```
$ git diff --stat origin/main a571b8c2b -- .pipeline/assets/design-tokens.css
 1 file changed, 16 insertions(+)              <- los dos comandos del body: ADITIVOS
$ git diff --stat origin/main a571b8c2b -- .pipeline/assets/
 14 files changed, 1326 insertions(+), 1157 deletions(-)   <- el dir entero: DESTRUCTIVO
```

Los 1157 borrados serían mockups de #6173 y #6190. El body ya trae los dos comandos aditivos; **no** checkoutear `.pipeline/assets/` entero.

### 5) Dependencias — despejadas

```
$ gh issue view 6458 --json state  => CLOSED  (canal estructurado de etapas, ya en main)
$ gh issue view 6460 --json state  => OPEN    (esperado: llena `notified`; por eso CA-11)
$ gh issue view 6469 --json labels => tipo:recomendacion + needs:triage-backlog, sin recommendation:approved
```

#6469 toca la misma zona (`result-badge.js`, `.cmd-result-*`) pero es una recomendación **pendiente de triaje humano**: no entra al pipeline automático, así que el riesgo R-6/O-5 de colisión no se materializa mientras siga sin `recommendation:approved`.

### 6) Observación para el dev (no bloquea)

`commanderOutboundStatus` devuelve cuatro valores (`unknown|enviado|fallido|encolado`). Con el discriminante del body, `unknown` cae del lado de "huérfano" — plausible falso positivo si `commander-history.jsonl` se corrompe o rota. Eso **no** abre un CA nuevo: ya está cubierto por **CA-10** (turnos sanos ⇒ cero marcas) y **CA-15** exige enumerar la rama y nombrar su test. Decidilo explícito en el PR, no por omisión.

---

**Resultado: aprobado.** La historia entrega valor propio (un huérfano se lee como huérfano en el log y en el dashboard, sin depender de #6460), tiene criterios completos y verificables, labels correctos y assets alcanzables. Pasa a `dev`.
