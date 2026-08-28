## Code review — rev-2 · APROBADO ✅

Segunda pasada. En rev-1 rechacé por **CA-3 / `Cambios requeridos` #4**: el barrido emitía el evento terminal en un solo desenlace. Verifiqué el fix empíricamente por el camino real de `runOrphanSweep`, no llamando al appender.

### Verificación del rechazo rev-1 (CA-3)

Escenario reproducido idéntico al del rechazo: turno de un **boot anterior**, con `transcripción` + `envío` (correlation_id real), **sin** `resultado`, `outboundStatus ⇒ 'enviado'`. Más un segundo turno con `outboundStatus ⇒ 'fallido'` para ver los dos desenlaces conviviendo.

```
resumen    = {"evaluados":2,"huerfanos":1,"sanos":1,"no_evaluables":0,"no_verificables":0}
veredictos = [{"v":"sano","r":"entrega_confirmada"},{"v":"huerfano","r":"entrega_no_confirmada"}]
emitidos   = 2
emitidosOk = ["150aae61cb00-..."]   emitidosFallidos = ["f24702f28174-..."]

PAYLOADS reales que llegan al appender:
  { success:false, delivery_state:"delivery_failed",   error_code:"delivered=false" }   ← CA-2
  { success:true,  delivery_state:"delivery_observed", error_code:null }                ← CA-3
```

En rev-1 este mismo probe daba `EVENTOS EMITIDOS = 0`. **Cerrado.**

Los literales usados son `delivery_observed` / `delivery_failed`, no los `'delivered'` / `'not_delivered'` que dice el texto de `Cambios requeridos` #4 — correcto: la corrección **R-1** del arquitecto ya había marcado que `_normalizeDeliveryState` colapsa a `null` cualquier valor fuera del enum, o sea que copiar los literales del issue habría hecho fallar CA-2/CA-3 **sin ruido**.

**CA-11 (un evento por `commander_req_id`, no uno por tick)** — vale para los dos desenlaces por construcción: comparten el mismo `yaResueltos`/`readResolvedRefs`. Segunda corrida del barrido sobre el mismo estado ⇒ `emitidos = 0`.

**CA-4 (no se reescribe nada y la cadena verifica)** — con las dos entradas nuevas asentadas:

```
verifyChain = {"ok":true,"entriesChecked":2}
```

`cerro_solo` (B-09) correctamente **fuera** de `entregados`: ese turno cerró in-process y su desenlace lo asentó su propio `finally` (CA-6). `correlacion_directa` (B-11) y `correlacion_sin_rastro` (B-14) tampoco emiten — afirmar cualquier desenlace ahí sería afirmar un hecho no observado (SEC-0/B5). La decisión está documentada en el bloque «Los DOS desenlaces terminales» de la cabecera del módulo, que es donde tenía que estar.

### Verificación del rebote de QA (CA-9/CA-13) — `28e091f6f`

La causa raíz que encontró el dev es la correcta y la reparación es la buena: el listado de peticiones **nunca existió en la superficie V3**; vivía dentro de `generateHTML()`, que el dispatch sirve sólo para `/legacy`. El fix no parchea el síntoma — extrae la lectura a **una fuente única** (`lib/commander/recent-requests.js`) y el CSS a **una sola constante** (`RESULT_BADGE_CSS`), consumidas por las dos superficies. Es lo que impide que vuelvan a divergir, que era el escape real.

Render verificado ejecutando el módulo contra un fixture de 3 filas (huérfana / sana / sin sidecar):

```html
<a class="cmd-act-row cmd-act-row-huerfano" ...>
  <span class="cmd-act-id">-1001234567890-…</span>
  <span class="cmd-act-when">25/08 19:03</span>
  <span class="cmd-result cmd-result-huerfano" title="Se ejecutó, pero su respuesta nunca se confirmó como entregada">∅ huérfano</span>
<a class="cmd-act-row" ...> … <span class="cmd-result cmd-result-ok">✓ ok</span>
<a class="cmd-act-row" ...> … <span class="cmd-act-nobadge">(sin badge)</span>
```

Glifo + etiqueta + barra de acento sólo en la fila huérfana (señal redundante, no sólo color) y la fila sin sidecar **lo dice** en vez de quedar muda. El panel se monta en el flujo principal, no dentro del sink oculto — un badge dentro de `hidden` habría sido el mismo no-render.

### Wiring y arquitectura

- `pulpo.js`: boot hook + tick **gateado** (`ORPHAN_SWEEP_EVERY_TICKS = 10`, ~5 min), los dos `try/catch` best-effort. `orphanSweepGate` es puro y exportado, así que el test ejercita el código real del loop y no una copia.
- Sin ciclo contra `pulpo.js`: `outboundStatus` y `noteFallbackDeliveryResolved` entran **inyectados** por `deps`. Núcleo puro / capa de I/O bien separados.
- Requires defensivos consistentes con el resto de las vistas; el panel degrada sin tumbar el home.

### Tests

```
node --test  (7 archivos del alcance) ......... 186 pass / 0 fail
node --test  .pipeline/views/dashboard/ ....... 610 pass / 0 fail
node --test  .pipeline/lib/commander/ ......... 437 pass / 0 fail
```

Los 5 tests nuevos de CA-3 van **por `runOrphanSweep`**, no llamando al appender directo — que fue exactamente el modo de falla que dejó pasar el escape en rev-1. Nombres en español y describiendo el caso de uso.

### Nit no bloqueante

`home.js:renderCommanderActivityPanel()` — el comentario promete que «si el módulo no cargó **o** el render tira, el panel cae a un fallback inerte VISIBLE con la causa», pero el código hace `if (!_commanderActivity) return '';`: en la rama módulo-no-cargado el panel **desaparece en silencio**, que es justo la lectura falsa que el comentario dice evitar. Es inherente (el fallback vive en el módulo que no cargó), así que no bloquea — pero el comentario promete de más. Vale ajustar el texto, o mover un literal inerte mínimo al caller.

### Recomendaciones abiertas en rev-1 (siguen pendientes de triaje humano, no bloquean)

- #6572 — eliminar el render path muerto `doraMinHTML` de `dashboard.js`.
- #6573 — consolidar el parseo del `reqId` del Commander (`buildAuditReqRef` vs `parseReqIdParts`).

No creo recomendaciones nuevas en esta pasada (tope de 3 por PR).

---

**Veredicto: aprobado.** El bloqueante de rev-1 está cerrado por el camino real, el rebote de QA está cerrado en la superficie que abre el operador, y no encontré nada que exija cambios antes de mergear.
