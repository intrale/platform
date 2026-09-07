> **Sub-historia del split de #6440** — "El fallback del Commander se anota la entrega como exitosa aunque el operador nunca reciba la respuesta".
> Corresponde al **Bloque B, mitad de detección** de la receta del arquitecto (sección "Detalles Técnicos" del body de #6440).
> **Depende de #6458**: sin el canal estructurado de etapas ni las claves de correlación en el audit, el barrido no tiene de dónde leer ni con qué correlacionar.

## Objetivo

Que un turno del Commander que se ejecutó y nunca confirmó entrega quede **explícitamente marcado como huérfano** y se **vea** como tal en el dashboard, en vez de ser indistinguible de un turno que nunca arrancó. Esta parte no le manda nada al operador por Telegram (eso es #6460): entrega detección y visibilidad.

Valor propio y verificable: hoy la ausencia de etapas es indistinguible de "el turno nunca arrancó"; después de esta parte, un huérfano se lee como huérfano tanto en el log del turno como en la fila del dashboard.

## Contexto

Episodio verificado (2026-08-24): el `.log` del turno termina en la etapa `transcripción` — **sin** `dispatch`, `envío` ni `resultado` — mientras el turno hizo 19 acciones reales sobre el repo. Ver #6440 para la traza completa.

Decisiones ya cerradas en la definición del padre, **no se reabren**:

- **D-1 · Ventana del barrido: 48 h.** Verificado sobre los 638 logs reales: en 48 h hay 7 turnos, 1 huérfano ⇒ el primer boot encola 1 aviso, no los 18 históricos. Los huérfanos viejos quedan fuera a propósito.
- **D-2 · El discriminante NO es "no tiene etapa `envío`".**
- **B1 · La guarda de vida es por `boot_id`**, no por PID ni por reloj.

## Cambios requeridos

1. **Módulo nuevo** — `.pipeline/lib/commander/orphan-sweep.js`: núcleo **puro** `detectOrphans({ stagesByReq, historyRaw, nowMs, currentBootId, windowMs, notified })` + capa de I/O `runOrphanSweep({ logDir, pipelineDir, ... })`. El parámetro `notified` existe desde el arranque (lo llena #6460); acá se respeta aunque venga vacío.
2. **Discriminante D-2**, leído del canal estructurado:
   ```js
   esHuerfano =
        hasStage(stages, 'transcripción')
     && !hasStage(stages, 'resultado')                       // no cerro solo
     && commanderOutboundStatus(historyRaw, correlationId) !== 'enviado';
   ```
   `commanderOutboundStatus` (`pulpo.js:12257`, ya testeado en `lib/__tests__/commander-outbound-reconcile.test.js`) es la **única** fuente de verdad de entrega — este issue es su primer consumidor en runtime.
3. **Guarda de vida (B1)** — `boot_id` del turno ≠ `PULPO_BOOT_ID` actual ⇒ muerto, evaluable. Igual ⇒ vivo, **no se evalúa nunca** (lo cierra el `finally` in-process). Sin `boot_id` (log legacy) ⇒ guarda de reloj ≥ 45 min. Cualquier otra duda ⇒ silencio.
4. **Evento terminal, nunca reescritura (A3)** — el barrido emite `fallback_delivery_resolved` vía `noteFallbackDeliveryResolved(...)`: `{ success: true, delivery_state: 'delivered' }` con entrega confirmada, o `{ success: false, delivery_state: 'not_delivered', error_code: 'delivered=false' }` sin ella. Nunca se reescribe el `inflight_fallback_completed` ya asentado.
5. **Etapa `resultado: huerfano`** — `pulpo.js:16123-16155` (`persistCommanderResult`) contempla el valor `huerfano` en la etapa `resultado` + sidecar (camino rápido in-process para los turnos que sí alcanzan a cerrar).
6. **Enum + badge + CSS, en el MISMO commit** — `.pipeline/lib/commander/request-classify.js:28` (`RESULTADOS`, enum **cerrado**) ⇒ agregar `'huerfano'`; `.pipeline/lib/commander/result-badge.js:22-30` ⇒ entrada `huerfano: { glyph: '∅', label: 'huérfano', title: 'Se ejecutó, pero su respuesta nunca se confirmó como entregada' }`; `.pipeline/dashboard.js:5476-5479` ⇒ `.cmd-result-huerfano` con los tokens `--result-huerfano` / `-bg` / `-dim` que UX ya commiteó en `.pipeline/assets/design-tokens.css`. Separarlos deja el huérfano sin badge — indistinguible de un log viejo, que es justo el síntoma que el issue elimina.
7. **Wiring del barrido** — `pulpo.js:21417+` (boot de `mainLoop`, junto a los otros boot hooks) y `pulpo.js:22623` (tick periódico, al lado de `reconcileTelegramReceipts()`), ambos en `try/catch` best-effort, cada ~5 min.

## Criterios de aceptación

- [ ] Un turno que ejecuta acciones y cierra sin entrega confirmada queda marcado explícitamente como **huérfano** en la etapa `resultado`.
- [ ] Un fallback cuya entrega **no** se confirma cierra con `fallback_delivery_resolved` fallido y `error_code: 'delivered=false'`, distinguible de `empty_output`.
- [ ] Un fallback cuya entrega **sí** se confirma cierra con `fallback_delivery_resolved` exitoso, sin regresión respecto de #4309.
- [ ] Ningún evento ya asentado se reescribe: el hash-chain de `audit-log.appendChained` sigue verificando.
- [ ] Un turno del boot **actual** nunca se evalúa como huérfano.
- [ ] Un early-return con etapa `resultado` y sin etapa `envío` **no** es huérfano.
- [ ] El veredicto de entrega sale de `commanderOutboundStatus`, nunca de la etapa `envío`, del texto del modelo (#3951) ni de `clearFlag`.
- [ ] El barrido sólo abre archivos dentro de la ventana de 48 h, decidida por el `epochms` del **nombre** antes de abrir nada.
- [ ] El badge `huerfano` se ve **renderizando** el dashboard, no leyendo el código.
- [ ] Los turnos sanos (cuatro etapas, entrega confirmada) producen **cero** marcas de huérfano.

## Escenarios Gherkin

```gherkin
Escenario: Turno huerfano detectado a posteriori
  Dado un turno de un boot anterior con etapa de transcripcion
  Y sin etapa de resultado
  Y sin entrega confirmada en el registro de reconciliacion
  Cuando corre el barrido de rescate
  Entonces el turno queda marcado como huerfano
  Y se asienta un evento terminal de entrega no realizada
```

```gherkin
Escenario: Turno sano, cero ruido
  Dado un turno que responde por el proveedor primario sin incidentes
  Cuando el turno cierra con etapa de envio y entrega confirmada
  Entonces el barrido no lo marca como huerfano
```

```gherkin
Escenario: Turno en vuelo no se toca
  Dado un turno del boot actual todavia corriendo
  Cuando corre el barrido de rescate
  Entonces el turno no se evalua
```

## Tests obligatorios

Runner: `node --test`. Suite completa: `npm run test:pipeline`.

- `.pipeline/lib/commander/__tests__/orphan-sweep.test.js` **(nuevo)** — huérfano real; turno sano con 4 etapas y entrega confirmada ⇒ 0 detecciones; early-return con `resultado` y sin `envío` ⇒ no huérfano; guarda de vida (`boot_id` actual ⇒ no evaluable); ventana de 48 h; log legacy sin canal estructurado ⇒ escala a no-verificable, **nunca suprime**.
- `.pipeline/lib/commander/__tests__/request-classify.test.js` (extender) — `huerfano` es valor válido del enum.
- `.pipeline/lib/commander/__tests__/result-badge.test.js` (extender) — `huerfano` renderiza badge propio (no cadena vacía).
- `.pipeline/lib/__tests__/commander-inflight-fallback.test.js` (extender) — `fallback_delivery_resolved` cierra a éxito con entrega confirmada y a `error_code: 'delivered=false'` sin ella.
- Cobertura mínima: **100 % de las ramas de decisión de `orphan-sweep.js`**.

## Notas técnicas

- **Precedencia de fuentes (B5):** el canal estructurado manda. Para los `.log` legacy sin canal, el `.log` es fuente de **baja confianza**: puede escalar a `entrega no verificable`, **nunca** suprimir. A las 48 h del deploy el sustrato legacy sale solo de la ventana.
- Seguridad de rutas: `path.basename` + `ID_SAFE_RE` (`request-log.js:37`) + resolución confinada a `LOG_DIR` + `lstat` para saltear symlinks.
- Assets de UX ya entregados (no se re-diseñan). **Traer sólo lo que hace falta, NUNCA el directorio completo** (corrección de UX en fase `validacion`, coincide con R-5):
  ```bash
  git checkout a571b8c2b626e74d214acc28deffaa07ff76a87f -- .pipeline/assets/design-tokens.css
  git checkout a571b8c2b626e74d214acc28deffaa07ff76a87f -- .pipeline/assets/mockups/6440/
  ```
  Verificado empíricamente en `validacion`: `git diff origin/main a571b8c2b --stat -- .pipeline/assets/` reporta **946 borrados**, porque la rama de assets está anclada a un `main` previo y checkoutear `.pipeline/assets/` entero **elimina** los mockups de #6173 (3 archivos) y #6190 (2 archivos). Los dos comandos de arriba son puramente aditivos: `+16` líneas en `design-tokens.css` (los 3 tokens `--result-huerfano*`) y los 3 archivos nuevos bajo `mockups/6440/`.
- **Corrección del PO (fase `criterios`):** la regla "`area:pipeline` sin `app:*` ⇒ `qa:skipped`" **NO aplica a este issue**. El cambio entrega un **badge visible en el dashboard** y existe un **mockup versionado acordado** (`.pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg`), así que corresponde **QA visual** (regla #4568). Verificado ejecutando el propio gate del repo contra este issue: `scopeReason` ⇒ `pipeline-dashboard`, `evaluate` ⇒ `block / missing-section`. El resto del alcance (barrido, evento de auditoría) sí se valida por QA estructural.


## Criterios de aceptación adicionales (PO · fase `criterios`)

Los CA-1..CA-10 de arriba quedan **vigentes tal cual**. El PO agrega cinco que
cierran huecos verificados empíricamente sobre `origin/main` (`687dea0ec`):

- [ ] **CA-11 · Un mismo huérfano produce exactamente UN evento terminal.** El
  barrido corre en bucle sobre una ventana de 48 h, y
  `noteFallbackDeliveryResolved` (`inflight-fallback.js:720`) es un *appender*
  puro sin deduplicación: cada llamada asienta una entrada nueva en el audit
  encadenado. El parámetro `notified` lo llena **#6460, que todavía no existe**,
  así que en este issue llega vacío. Sin una marca propia de "ya resuelto"
  persistida por el barrido, el huérfano del episodio emite un evento por tick
  durante 48 h. Verificable: correr el barrido N veces seguidas sobre el mismo
  sustrato ⇒ 1 sola entrada `inflight_fallback_delivery_resolved` por
  `commander_req_id`, con N ≥ 3, en un test del módulo.
- [ ] **CA-12 · El barrido corre a la cadencia declarada (~5 min), no en cada
  iteración.** El punto de wiring que nombra el issue (junto a
  `reconcileTelegramReceipts()`, `pulpo.js:22732`) se ejecuta en **cada**
  iteración del `mainLoop`, no cada 5 min: la cadencia de ~5 min del loop se
  obtiene gateando por ticks, como hace `desyncEvalTick`
  (`DESYNC_EVAL_EVERY_TICKS = 10`, `pulpo.js:18413`). Sin ese gateo el barrido
  corre ~10× más seguido que lo previsto y relee `commander-history.jsonl`
  entero cada vez. Verificable: el contador de gateo es explícito y hay un test
  que prueba que M ticks del loop disparan ⌊M/10⌋ barridos.
- [ ] **CA-13 · QA visual del badge contra el mockup acordado (BLOQUEANTE).** El
  badge `huerfano` se acepta comparando un **screenshot del dashboard
  renderizado** contra
  `.pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg`, adjuntando
  ambas imágenes al PR/issue. **No** alcanza con "el CSS está", "el enum tiene
  el valor" ni "el dashboard levanta sin error": ese es exactamente el modo de
  falla del escape #4531. Debe verse el glifo `∅`, la etiqueta `huérfano` y el
  color resuelto desde `--result-huerfano*` (no gris, no el color de `error`).
- [ ] **CA-14 · Un barrido que falla siempre NO se lee como "no hay
  huérfanos".** El barrido es best-effort y nunca rompe el tick (SEC-3), pero
  una excepción recurrente (lock del audit, `logDir` ilegible) tiene que dejar
  rastro observable — log propio con la causa — en vez de degradar en silencio
  al mismo estado que "todo sano". Verificable: forzar el fallo y comprobar que
  el rastro aparece y que el tick sigue vivo.
- [ ] **CA-15 · Cobertura de ramas, medida de forma verificable.** El CA
  original pide "100 % de las ramas de decisión de `orphan-sweep.js`", pero hoy
  no hay `c8` ni `nyc` y `test:pipeline` es `node --test` pelado, así que ese
  número no es medible (riesgo R-3 del análisis técnico; deuda registrada en
  #6510). Para **este** issue el criterio se cumple así: el PR **enumera** las
  ramas de decisión de `detectOrphans` y nombra, por cada una, el test que la
  cubre. Si `npm run test:pipeline` ya expone cobertura nativa al momento de
  implementar, se adjunta el reporte y manda el número.

## Screenshots & Mockups

- **Esperado (mockup acordado, versionado):**
  `.pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg` — badge
  `huerfano` con glifo `∅`, etiqueta `huérfano` y tokens `--result-huerfano` /
  `-dim` / `-bg` sobre `--alert-anomaly` (contraste medido 6.96:1 sobre
  `surface-0` y 5.62:1 sobre el fondo del badge, AA). A propósito **no** reusa
  `--danger`: el pedido no falló, se perdió la respuesta.
- **Actual (render real):** _pendiente_ — sin baseline previa (primera
  implementación del badge). Lo completa quien implementa, capturando el
  dashboard renderizado con una fila de resultado `huerfano` y adjuntando la
  imagen acá. Sin esa captura comparada contra el mockup, el PO **rechaza** en
  la fase de aprobación (CA-13).


---

## Detalles Técnicos

> Receta del arquitecto — fase `criterios`. Verificada empíricamente contra `origin/main` (`687dea0ec`, post-merge de #6509/#6458). **Anclar por símbolo, no por número de línea**: los números de "Cambios requeridos" se escribieron contra `b21526863` y quedaron desfasados. Las coordenadas de abajo son las buenas.

### Archivos a tocar

| Archivo | Qué hacer |
|---|---|
| `.pipeline/lib/commander/orphan-sweep.js` **(nuevo)** | Núcleo puro `detectOrphans(...)` + capa de I/O `runOrphanSweep(...)`. Sin `require` de `pulpo.js` (ciclo). |
| `.pipeline/lib/commander/request-classify.js:28` | `RESULTADOS` ⇒ agregar `'huerfano'`. Y en `classifyCommanderResult` (`:141`) agregar el **input** que lo produce (ver "Patrón", punto 3). No un `if` suelto en el closure. |
| `.pipeline/lib/commander/request-classify.js:127` | Actualizar el JSDoc del union `'ok'\|'ajustada'\|'fallback'\|'error'`. |
| `.pipeline/lib/commander/result-badge.js:24-31` | Entrada `huerfano: { glyph: '∅', label: 'huérfano', title: 'Se ejecutó, pero su respuesta nunca se confirmó como entregada' }`. |
| `.pipeline/dashboard.js:5476-5479` | Regla `.cmd-result-huerfano` **con fallback hex literal** (UX-2). Va inmediatamente después de `.cmd-result-error`. |
| `.pipeline/assets/design-tokens.css` | Traer el bloque `--result-huerfano*` desde el SHA inmutable `a571b8c2b626e74d214acc28deffaa07ff76a87f` (UX-1). |
| `.pipeline/lib/commander/inflight-fallback.js:720-748` | **Extender el entry** de `noteFallbackDeliveryResolved` con `success` y `error_code` **aditivos al final** (ver R-1 — sin esto CA-2 es inverificable). |
| `.pipeline/pulpo.js:21522` (`async function mainLoop`) | Boot hook del barrido, `try/catch` best-effort. |
| `.pipeline/pulpo.js:22732` (junto a `reconcileTelegramReceipts()`) | Tick del barrido **gateado por contador de ticks** (CA-12), no en cada iteración. |
| `.pipeline/pulpo.js:~16196` (closure `persistCommanderResult`) | Camino rápido in-process: pasar el nuevo input al clasificador. **Ojo: es un closure, no una función top-level** — `grep "function persistCommanderResult"` da vacío. |

**Coordenadas verificadas en `origin/main`** (`git grep -n`, ejecutado en esta pasada):

```
.pipeline/pulpo.js:610    const PULPO_BOOT_ID = `${process.pid}-${Date.now()}`;
.pipeline/pulpo.js:600    const LOG_DIR = path.join(PIPELINE, 'logs');
.pipeline/pulpo.js:12273  function commanderOutboundStatus(rawContent, correlationId)
.pipeline/pulpo.js:16205  requestLog.stage('resultado', {...})
.pipeline/pulpo.js:16267  requestLog.stage('transcripción', { audios, mensajes, chat_id, boot_id })
.pipeline/pulpo.js:17367  requestLog.stage('envío', { canal, correlation_id, voz_ok, chars, disclaimer })
.pipeline/pulpo.js:18412  let desyncEvalTick = 0;   /  :18413  DESYNC_EVAL_EVERY_TICKS = 10
.pipeline/lib/commander/request-log.js:361  module.exports = { ..., stagesFileName, readStages, hasStage, buildAuditReqRef }
.pipeline/lib/commander/inflight-fallback.js:181  DELIVERY_STATES = new Set(['delivery_pending','delivery_observed','delivery_failed'])
```

### Patrón técnico recomendado

**1 · Forma del módulo — núcleo puro, I/O afuera.** Es lo que hace testeable el 100 % de las ramas sin tocar filesystem:

```js
// .pipeline/lib/commander/orphan-sweep.js
'use strict';
const OrphanVerdict = Object.freeze({
  HUERFANO: 'huerfano',
  SANO: 'sano',
  NO_EVALUABLE: 'no_evaluable',      // boot vivo / fuera de ventana / ya resuelto
  NO_VERIFICABLE: 'no_verificable',  // legacy sin canal / correlación imposible
});

// PURA. No lee disco, no mira el reloj del sistema, no requiere pulpo.js.
function detectOrphans({ stagesByReq, historyRaw, nowMs, currentBootId, windowMs, notified }) { /* ... */ }

// I/O: enumera, filtra por ventana, lee, delega en detectOrphans, emite.
function runOrphanSweep({ logDir, pipelineDir, nowMs, currentBootId, windowMs, notified, deps }) { /* ... */ }

module.exports = { detectOrphans, runOrphanSweep, OrphanVerdict, ORPHAN_WINDOW_MS };
```

`outboundStatus` entra por `deps` (inyección), **no** por `require('../../pulpo.js')`: `pulpo.js` es el proceso, no una librería, y requerirlo desde `lib/` crea un ciclo y arranca el mundo dentro de un test.

**2 · Resolución del `correlationId` — el punto no obvio de todo el issue.**

`commanderOutboundStatus(historyRaw, correlationId)` **necesita un `correlationId`**, y ese id vive **únicamente en la etapa `envío`** (`pulpo.js:17367`). Un huérfano real es, por definición, un turno **sin** etapa `envío` ⇒ **no hay `correlationId` que consultar**. Esto no rompe D-2, lo completa:

```js
// La etapa `envío` es PORTADORA del identificador, nunca del veredicto (CA-7).
function correlationIdFromStages(stages) {
  const env = stages.find(e => e && e.etapa === 'envío');
  if (!env) return null;                                  // sin saliente encolado
  const cid = env.correlation_id;
  if (!cid || cid === 'directo') return 'DIRECTO';        // sin reconciliación posible
  return String(cid);
}

const cid = correlationIdFromStages(stages);
const entrega =
    cid === null      ? 'sin_saliente'                     // ⇒ !== 'enviado' ⇒ cuenta
  : cid === 'DIRECTO' ? 'no_verificable'                   // ⇒ NO se marca huérfano
  :                     deps.outboundStatus(historyRaw, cid);

const esHuerfano =
     hasStage(stages, 'transcripción')
  && !hasStage(stages, 'resultado')
  && entrega !== 'enviado'
  && entrega !== 'no_verificable';
```

> **Esto NO viola CA-7.** CA-7 prohíbe *derivar el veredicto de entrega* de la etapa `envío`. Acá la etapa `envío` sólo aporta el **identificador de correlación**; el veredicto lo sigue emitiendo `commanderOutboundStatus`. Queda escrito para que review no lo lea como incumplimiento.

> **`correlation_id: 'directo'` ⇒ `no_verificable`, no huérfano.** Hubo envío observable en el canal no falsificable, pero sin recibo posible. Afirmar "no se entregó" sería afirmar un hecho no observado — justo lo que SEC-0/B5 prohíben. Se cuenta y se loguea, no emite evento terminal. Alineado con CA-10 (turnos sanos ⇒ cero marcas) y con el mismo tercer estado que ya prevé el test de log legacy.

**3 · `huerfano` en el clasificador, no en el closure** (`request-classify.js:141`). Input nuevo con default `false` (back-compat total) y **precedencia por debajo de `error`**:

```js
const { deliveryUnconfirmed = false } = args;   // nuevo, default false
// ...
let resultado;
if (deliveryUnconfirmed === true && hadError !== true) resultado = 'huerfano';
else if (hadError === true || emptyResponse === true || isErrorDisclaimer) resultado = 'error';
// ... resto igual
```

Un turno que falló **y** no entregó es `error` (el operador necesita saber que falló). `huerfano` describe "se ejecutó entero y la respuesta se perdió", que es semánticamente distinto — es la misma razón por la que UX-3 prohíbe reusar `--danger`.

**4 · CSS con fallback hex literal (UX-2 — bloqueante).** `loadDesignTokens()` degrada a cadena vacía (`dashboard.js:176-179`) y la paleta legacy inline (`dashboard.js:4655+`) **no tiene ningún rosa**: `--gn/--yl/--ac/--rd/--or/--pu`, ningún alias servible. Copiar el patrón `var(--x, var(--legacy))` deja el badge sin color:

```css
.cmd-result-huerfano {color:var(--result-huerfano,#FF6B8A);background:var(--result-huerfano-bg,rgba(255,107,138,0.16));border-color:var(--result-huerfano-dim,#B8254A)}
```

**5 · Enumeración segura + ventana de 48 h (CA-8, SEC-1, SEC-2).**

```js
const ENTRY_RE = /^commander-(.+)-(\d{10,})(?:-([a-zA-Z0-9]+))?\.stages\.jsonl$/;

for (const d of fs.readdirSync(logDir, { withFileTypes: true })) {  // SEC-2: un solo syscall
  if (!d.isFile()) continue;                                        // descarta symlink/dir/FIFO
  const m = ENTRY_RE.exec(d.name);
  if (!m) continue;
  const epochms = Number(m[2]);
  if (!Number.isFinite(epochms) || nowMs - epochms > windowMs) continue;  // CA-8: ANTES de abrir
  const reqId = `${m[1]}-${m[2]}${m[3] ? `-${m[3]}` : ''}`;
  if (!/^[a-zA-Z0-9-]+$/.test(reqId)) continue;                     // SEC-1: descartar, no corregir
  const stages = readStages(logDir, reqId);                         // path SIEMPRE vía stagesFileName
  // ...
}
```

- Enumerar los `.stages.jsonl`, **no** los `.log`: el barrido decide sobre el canal no falsificable (SEC-0). El `.log` no se abre nunca en el camino de decisión.
- `readStages(logDir, reqId)` arma el path vía `stagesFileName`, que ya sanitiza con `ID_SAFE_RE` (`request-log.js:88`). **No re-sanitizar por afuera** — dos verdades es peor que una. La asimetría de `logFileName` que marcó SEC-1 **no está en este camino**, porque el `.log` no se abre.
- **Trampa del regex:** el `chatId` de grupos es negativo ⇒ el nombre real es `commander--1001234-1756....stages.jsonl`. Por eso `(.+)` greedy en el primer grupo y `\d{10,}` anclado. Un `suffix` compuesto sólo por dígitos rompe la desambiguación ⇒ test obligatorio con nombre de grupo negativo + suffix hex.

**6 · Guarda de vida (B1).** Comparación de string pura contra `PULPO_BOOT_ID` (`pulpo.js:610`, nivel de módulo), leído de la etapa `transcripción` (que ya lo lleva, `pulpo.js:16271`):

```js
const bootId = (stages.find(e => e.etapa === 'transcripción') || {}).boot_id;
if (bootId && String(bootId) === String(currentBootId)) return OrphanVerdict.NO_EVALUABLE; // vivo
if (!bootId && (nowMs - epochms) < 45 * 60 * 1000)      return OrphanVerdict.NO_EVALUABLE; // legacy
```

**7 · Emisión del evento terminal — mapeo obligatorio de `delivery_state`.** Ver R-1: los literales del issue **no existen en el enum**.

```js
deps.noteFallbackDeliveryResolved({
  pipelineDir,
  commanderReqId: buildAuditReqRef(reqId),   // SEUDONIMIZADO (SEC-4). NUNCA el reqId crudo.
  chatId,                                     // hashFor() internamente ⇒ no filtra
  deliveryState: entregado ? 'delivery_observed' : 'delivery_failed',
  success: entregado,                              // requiere R-1
  errorCode: entregado ? null : 'delivered=false', // requiere R-1
  resolvedBy: 'orphan_sweep',
});
```

**8 · Wiring gateado (CA-12).** Copiar el patrón de `desyncEvalTick` (`pulpo.js:18412-18413`, `:22714`), no llamarlo pelado:

```js
let orphanSweepTick = 0;
const ORPHAN_SWEEP_EVERY_TICKS = 10;   // ~5 min con el tick actual del mainLoop
// ...
orphanSweepTick = (orphanSweepTick + 1) % ORPHAN_SWEEP_EVERY_TICKS;
if (orphanSweepTick === 0) {
  try { runOrphanSweep({ logDir: LOG_DIR, pipelineDir: PIPELINE, currentBootId: PULPO_BOOT_ID /* ... */ }); }
  catch (e) { log('commander', `[orphan-sweep] tick error: ${e.message}`); }  // CA-14: rastro, no silencio
}
```

### Riesgos identificados

- **R-1 · `noteFallbackDeliveryResolved` NO acepta `success` ni `error_code`, y `'delivered'` / `'not_delivered'` NO existen en el enum.** Verificado en `inflight-fallback.js:181` y `:720-748`: `DELIVERY_STATES = {delivery_pending, delivery_observed, delivery_failed}` y `_normalizeDeliveryState` **colapsa a `null`** cualquier otro valor, en silencio. El entry sólo lleva `event, skill, primary_provider, secondary_provider, request_id, chat_id_hash, resolved_by, commander_req_id, delivery_state` — no hay `success` ni `error_code` en ningún lado del archivo. Si el dev copia los literales del punto 4 de "Cambios requeridos", **CA-2 y CA-3 fallan sin ruido**. **Mitigación:** mapear a `delivery_observed` / `delivery_failed` y extender el entry con `success` y `error_code` **aditivos estrictamente al final** (mismo patrón #4413/#4438/#6458, para no romper la hash-chain de las entradas que no los traen), con test de regresión sobre entradas viejas.
- **R-2 · El `correlationId` sólo existe en la etapa `envío`, que el huérfano no tiene.** Sin resolverlo explícito, el dev implementa D-2 con `correlationId === undefined`, `commanderOutboundStatus` devuelve `'unknown'` por su guard de entrada y se llega al veredicto correcto **por accidente**, sin cubrir el caso `'directo'`. **Mitigación:** `correlationIdFromStages` + el tri-estado del punto 2, con test por rama.
- **R-3 · Tensión aparente CA-1 vs CA-6.** CA-1 pide que un turno que cierra sin entrega confirmada quede marcado huérfano; CA-6 pide que un early-return **con** etapa `resultado` y sin `envío` **no** lo sea. No se contradicen: CA-1 lo cubre el **camino rápido in-process** (el propio turno observa que el envío falló y clasifica `huerfano` al cerrar); CA-6 acota **al barrido**, que nunca toca un turno que ya asentó `resultado`. **Mitigación:** un test por cada uno, con nombre que diga cuál camino ejercita. Es la ambigüedad con más chance de generar rebote en review.
- **R-4 · `noteFallbackDeliveryResolved` es un appender puro sin dedup (CA-11).** `notified` llega vacío hasta #6460. Sin marca propia, el huérfano del episodio emite un evento por barrido durante 48 h. **Mitigación:** precheck sobre el audit encadenado de la ventana — `commander-dispatch-YYYY-MM-DD.jsonl` rota por día UTC (`inflight-fallback.js:192-198`), así que 48 h ⇒ leer los **3** archivos de día que la cubren y armar el set de `commander_req_id` que ya tienen `inflight_fallback_delivery_resolved`. Es la fuente de verdad, no agrega estado nuevo, y es exactamente el set que #6460 va a poblar. Con el gateo de 10 ticks el costo es despreciable.
- **R-5 · Los tokens `--result-huerfano*` no están en `main`.** `git checkout a571b8c2b626e74d214acc28deffaa07ff76a87f -- .pipeline/assets/design-tokens.css`. **Traer el archivo puntual, no el directorio** — la rama está anclada a un `main` pre-#6509/#6374 y copiar el dir completo es la clase de operación que revierte trabajo ajeno sin que nadie lo note. Revisar el diff antes de commitear.
- **R-6 · Colisión con #6469** (badge de estado de entrega): toca `result-badge.js` y la misma zona `.cmd-result-*` de `dashboard.js`. Si van en paralelo el conflicto es casi seguro; que #6469 se apoye sobre lo que deje éste.
- **R-7 · `huerfano` sin tilde en enum y clase CSS; `huérfano` con tilde en label y tooltip** (UX-4). La clase sale del valor del enum (`result-badge.js:59`): tildar el enum rompe el selector.
- **R-8 · La cobertura de ramas no es medible hoy** (no hay `c8`/`nyc`; `test:pipeline` es `node --test` pelado). Se cumple por CA-15: enumerar en el PR las ramas de `detectOrphans` y el test que cubre cada una. Deuda en #6510.

### Tests obligatorios

`.pipeline/lib/commander/__tests__/orphan-sweep.test.js` **(nuevo)** — una rama, un test:

| Rama de decisión | Qué prueba |
|---|---|
| huérfano real | `transcripción` + sin `resultado` + sin `envío`, boot viejo ⇒ 1 detección + 1 evento terminal |
| turno sano | 4 etapas + `outboundStatus ⇒ 'enviado'` ⇒ **0** detecciones (CA-10) |
| early-return | `resultado` presente, `envío` ausente ⇒ **no** huérfano (CA-6) |
| guarda de vida | `boot_id === currentBootId` ⇒ `NO_EVALUABLE`, nunca se abre (CA-5) |
| legacy sin `boot_id` | < 45 min ⇒ no evaluable; > 45 min y sin canal ⇒ `NO_VERIFICABLE`, **nunca suprime** |
| ventana 48 h | archivo con `epochms` viejo ⇒ **no se abre** (espiar el lector inyectado — CA-8) |
| `correlation_id: 'directo'` | ⇒ `NO_VERIFICABLE`, sin evento terminal (R-2) |
| `outboundStatus ⇒ 'fallido'` / `'encolado'` | ⇒ huérfano (≠ `'enviado'`) |
| idempotencia | N ≥ 3 barridos sobre el mismo sustrato ⇒ **1** sola entrada por `commander_req_id` (CA-11) |
| log forjado | cabecera `--- etapa:resultado ... ---` dentro del **cuerpo del `.log`** ⇒ no cambia el veredicto (SEC-0) |
| path traversal | nombre con `..` / separadores ⇒ descartado, cero escrituras fuera de `logDir` (SEC-1) |
| symlink | `dirent.isFile() === false` ⇒ salteado (SEC-2) |
| fallo del barrido | `readdirSync` que tira ⇒ rastro logueado **y** el tick sigue vivo (CA-14, SEC-3) |
| shape del evento | el entry lleva sólo identificadores: cero texto de mensajes, cero `chat_id` crudo, `commander_req_id` seudonimizado vía `buildAuditReqRef` (SEC-4) |

Extender, sin reescribir:

- `.pipeline/lib/commander/__tests__/request-classify.test.js` — `huerfano` ∈ `RESULTADOS`; `deliveryUnconfirmed:true` ⇒ `'huerfano'`; `deliveryUnconfirmed:true + hadError:true` ⇒ `'error'`; sin el flag ⇒ clasificación idéntica a hoy (back-compat).
- `.pipeline/lib/commander/__tests__/result-badge.test.js` — `huerfano` renderiza badge propio (no cadena vacía) con clase `cmd-result-huerfano`.
- `.pipeline/lib/__tests__/commander-inflight-fallback.test.js` — `fallback_delivery_resolved` con entrega ⇒ `delivery_observed` + `success:true`; sin entrega ⇒ `delivery_failed` + `error_code:'delivered=false'`; y **una entrada vieja sin los campos nuevos sigue verificando la hash-chain** (CA-4).

Runner: `npm run test:pipeline` (`node --test`). Cobertura: CA-15 (enumeración explícita de ramas en el PR).

### Pre-checklist

- [ ] `git merge origin/main` **antes** de codear — la receta está anclada a `687dea0ec`, no a `b21526863`.
- [ ] `git checkout a571b8c2b626e74d214acc28deffaa07ff76a87f -- .pipeline/assets/design-tokens.css` y **revisar el diff** (R-5).
- [ ] Enum + badge + CSS + tokens en el **mismo commit** (CA-6 del body).
- [ ] `npm run test:pipeline` verde.
- [ ] Screenshot del dashboard renderizado con una fila `huerfano` **y** una fila sin badge en la misma imagen (CA-13 + UX-5), comparado contra `.pipeline/assets/mockups/6440/02-dashboard-badge-huerfano.svg`.
- [ ] Renderizar con `design-tokens.css` inaccesible y verificar que el badge conserva glifo, rosa, fondo y borde (UX-2).
- [ ] `git diff origin/main --stat` sin archivos espurios (el checkout de assets trae sólo lo suyo).



