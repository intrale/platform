# Narrativa UX — Multi-Provider Coverage Widget (#3681)

> Sistema visual del widget "Coverage" del tab Multi-Provider del dashboard
> interno V3 (`localhost:3200`). Acompaña al mockup
> [`24-multi-provider-coverage-widget.svg`](24-multi-provider-coverage-widget.svg)
> y soporta los criterios CA-B4..CA-B19 del comentario PO en
> [#3681](https://github.com/intrale/platform/issues/3681).

Este NO es un widget del producto cliente final — es **herramienta operativa
del equipo Intrale**. Vive en HTML/CSS/SVG porque está embebido en el dashboard
del pipeline. La identidad visual sigue los tokens existentes
(`.pipeline/assets/design-tokens.css`) y el sprite real
(`.pipeline/assets/icons/sprite.svg`).

> **Nota de numeración:** el body del issue #3681 referencia este mockup como
> número 23. Ese slot ya está tomado por `23-ghost-artifacts-widget.svg`
> (mockup preexistente de #3638). UX asignó el siguiente número libre — **24** —
> y lo documenta en `README.md`. El dev del hijo B debe leer el path desde el
> inventario, no desde el path embebido en el issue body.

---

## Filosofía del sistema visual

La matriz `skill × provider` es el **veredicto cuantificado** de la red multi-
provider. Cada celda responde una sola pregunta: *"¿este skill, contra este
provider, funciona o no?"*. El operador entra al panel cuando hay ruido en
Telegram o cuando quiere validar que la red sigue completa antes de un cambio
sensible (rotar una key, sumar un provider, mergear un PR que toca
`agent-models.json`).

Tiene que comunicar tres cosas a primera vista:

1. **¿Está toda verde la red?** — predominancia de PASS (verde) en la matriz.
2. **¿Dónde está el problema?** — celdas FAIL (rojo) con borde más grueso
   y panel lateral de issues auto-creados que las acompaña 1-a-1.
3. **¿Puedo disparar otro run ahora?** — banner de coordinación + estado del
   botón "Ejecutar harness" (habilitado o bloqueado con tooltip explicativo).

Y tiene que **negarse** a comunicar dos cosas (REQ-SEC-B3/B4/B7):

- API key prefixes, hostnames, latencias absolutas. Solo buckets discretos.
- Raw output de los providers. Solo `error_class` genérico + `evidence_hash`.

---

## Paleta y mapeo de estados

Todos los colores vienen de `design-tokens.css`. **Cero hardcoding fuera de
tokens** — si hay que sumar un color, primero se suma al token.

### Estados de celda (CA-B5)

Regla §3 del design system: nunca info por color solo. Cada estado lleva
color + glyph + texto. WCAG AA verificado contra `--surface-1`.

| Estado    | Token primario  | Token bg                            | Glyph             | Texto en celda                                |
|-----------|-----------------|-------------------------------------|-------------------|-----------------------------------------------|
| **PASS**    | `--success`     | `rgba(63,185,80,0.08)`              | `ic-cell-pass`    | `PASS` + bucket (`≤500ms`, `≤2s`, …)         |
| **WARN**    | `--warning`     | `rgba(210,153,34,0.10)`             | `ic-cell-warn`    | `WARN` + tipo de divergencia (`div · schema`) |
| **FAIL**    | `--danger`      | `rgba(248,81,73,0.10)`              | `ic-cell-fail`    | `FAIL` + error_class (`429 rate_limit`)       |
| **SKIPPED** | `--text-dim`    | `rgba(139,148,158,0.08)` punteado   | `ic-cell-skipped` | `SKIPPED` + razón (`sin key`)                 |
| **N/A**     | `--text-disabled` | `rgba(110,118,129,0.08)`          | `ic-cell-na`      | `N/A` + razón corta (`no aplica · TOS`)       |

#### Diferenciación crítica N/A · SKIPPED · FAIL (CA-B14)

Las tres son "no PASS" pero **comunican cosas distintas** y se confunden
fácil — por eso cada una tiene un glyph propio:

- **N/A** — combinación que NO aplica por diseño. Ejemplo canónico:
  `security × gemini`. Google AI Studio entrena con prompts del free tier
  (memoria `project_multi-provider-per-agent-order.md`), entonces ningún skill
  de seguridad puede usar Gemini. Está vetado en `agent-models.json`. El
  rayado diagonal del glyph codifica esa decisión arquitectónica. **NO es un
  fail ni un skip — es una celda que nunca debería invocarse.**
- **SKIPPED** — combinación que aplica pero **no se invocó en este run**.
  Razones típicas: falta la credencial del provider, está en mantenimiento,
  override deterministic activo. El círculo punteado vacío comunica "ausencia
  controlada".
- **FAIL** — se invocó y falló. Círculo cerrado con cruz. Es el único estado
  que dispara creación de issue auto.

> **Regla operativa:** un cambio de N/A → SKIPPED es siempre rojo (significa
> que alguien sacó un veto sin pensar). Un cambio de SKIPPED → PASS es
> celebración (significa que sumamos una nueva combinación a la red).

### Buckets de latencia (CA-B3)

Discretos, nunca absolutos (REQ-SEC-B3 — los timings absolutos son timing
oracles). Cada bucket pinta el chip con su token semántico:

| Bucket    | Token       | Color | Semántica del bucket                                |
|-----------|-------------|-------|----------------------------------------------------|
| `≤100ms`  | `--success` | verde | tiempo de eco del provider — saludable             |
| `≤500ms`  | `--teal`    | cyan  | prompt corto — saludable                           |
| `≤2s`     | `--info`    | azul  | prompt típico de smoke test                        |
| `≤10s`    | `--warning` | ámbar | prompt largo / cold start — tolerable              |
| `>10s`    | `--danger`  | rojo  | timeout / SLA breach — disparador de FAIL          |

Los buckets se muestran en pill redondeada con fondo `*-bg` y borde `*-dim`.
WCAG AA verificado para el texto monospace.

### Identidad cromática de providers

Cada provider tiene su token (familia 3.c/3.d del design system). Se usa en
el header de columna y como acento del logo del provider — **nunca en la
celda**. La celda solo usa tokens semánticos para mantener la legibilidad del
estado.

| Provider       | Token                       | Identidad        |
|----------------|----------------------------|------------------|
| anthropic      | `--provider-anthropic`     | copper cálido    |
| openai-codex   | `--provider-openai-codex`  | emerald profundo |
| groq           | `--provider-groq`          | coral energético |
| gemini         | `--provider-gemini`        | azul Google      |
| cerebras       | `--provider-cerebras`      | amarillo wafer   |

---

## Iconografía

Los 8 íconos nuevos se agregan a `.pipeline/assets/icons/sprite.svg` con
prefijo `ic-*` (el mockup los preview con prefijo `m-*` para visualización
standalone — el dev usa los `ic-*` con `<use href="#ic-..."/>`).

| Símbolo            | Uso                                                                          |
|--------------------|------------------------------------------------------------------------------|
| `ic-cell-pass`     | Círculo con check interno — celda PASS. Tinte `--success`.                   |
| `ic-cell-warn`     | Triángulo con exclamación — celda WARN. Tinte `--warning`.                   |
| `ic-cell-fail`     | Círculo con cruz interna — celda FAIL. Tinte `--danger`.                     |
| `ic-cell-skipped`  | Círculo punteado vacío — celda SKIPPED. Tinte `--text-dim`.                  |
| `ic-cell-na`       | Rayado diagonal — celda N/A. Tinte `--text-disabled`. **Codifica semánticamente "no aplica por diseño".** |
| `ic-play`          | Play sólido — botón "Ejecutar harness" (habilitado). Tinte `--brand-cyan`.   |
| `ic-pause-lock`    | Pausa + candado — botón "Ejecutar harness" (bloqueado). Tinte `--text-dim` o `--rest-mode`. |
| `ic-link-out`      | Flecha saliendo de cuadrado — link al issue auto-creado. Tinte `--info`.     |

Íconos auxiliares reutilizados del sprite existente:

- `ic-rest-mode` — banner de coordinación en modo descanso.
- `ic-info` — placeholder en panel de issues cuando no hay FAILs.
- `ic-provider-*` — header de columnas con la identidad de cada provider.

---

## Microcopy — reglas de tono

**Persona del operador**: ingeniero del equipo Intrale, sesión de revisión a
las 23:14, necesita decidir en menos de un minuto si la red está sana o si
hay que parar el merge. No quiere prosa.

### Texto en celda

- ✅ `PASS · ≤500ms`
- ✅ `WARN · div · schema`
- ✅ `FAIL · 429 rate_limit`
- ✅ `SKIPPED · sin key`
- ✅ `N/A · no aplica · TOS`

No usar:

- ❌ `OK`, `Bien`, `Saludable` (zero información clínica).
- ❌ Emojis del SO (`✅`/`❌`) — el sistema usa SVG inline, no Unicode emoji.
- ❌ Latencias absolutas (`512ms`, `1.23s`) — siempre bucket discreto.
- ❌ `Excelente!`, `Genial`, `Listo` — el operador no busca elogios.

### Banner del último run (CA-B8)

```
[timestamp absoluto UTC] · hace [relativo]
DURACIÓN: [Nm Ns]
SPAWNS USADOS: [N / 60]
MODO: serializado · concurrency = 1
RUN ID: [8 chars]
EVIDENCE: [primeros 2 hashes truncados, "..."]
```

### Banner de coordinación (CA-B9)

Estados explícitos, sin ambigüedad:

| Estado del pipeline                              | Banner                                          | Botón harness |
|--------------------------------------------------|-------------------------------------------------|---------------|
| Modo descanso ACTIVO ahora                       | `Modo descanso · activo desde HH:MM (TZ)`       | habilitado    |
| Modo descanso programado (próximo)               | `Modo descanso · en Xh Ym (HH:MM TZ)`           | bloqueado     |
| `.partial-pause.json` con allowlist `multi-provider-smoke-test` exclusiva | `Pausa parcial · ventana exclusiva`             | habilitado    |
| `.partial-pause.json` con allowlist mixta        | `Pausa parcial · otros issues en allowlist`     | bloqueado     |
| Pipeline corriendo productivo                    | `Pipeline activo · sin ventana de coordinación` | bloqueado     |
| `.paused` total                                  | `Pipeline pausado completo`                     | bloqueado     |

### Microcopy del panel lateral de issues (CA-B10)

Cada row de FAIL:

```
[skill] × [provider]                 [error_class]  [latency_bucket]
latency bucket: >10s                                   ┌──────────┐
evidence: [hash 12 chars]                              │ #3692 ↗  │
                                                       └──────────┘
```

**Reglas inquebrantables del row:**

- `error_class` viene del schema del hijo A (`429`, `timeout`, `5xx`,
  `schema_invalid`). **NUNCA** texto libre del provider.
- `evidence` mostrado siempre truncado a 12 chars (REQ-SEC-B8 — convención
  git-style).
- Link al issue construido server-side como
  `https://github.com/intrale/platform/issues/${Number(issue)}` con
  `Number()` cast explícito (REQ-SEC-B7). `target="_blank"` +
  `rel="noopener noreferrer"`.
- Sin raw output del provider. Sin stack trace. Sin URL completa con query
  params.

### Tooltip popover de celda (CA-B13)

Sobre hover/focus, popover custom (NO `title=` nativo — rompe focus de teclado
y se llevan mal con WCAG):

```
[skill] × [provider]                         [estado · bucket]
─────────────────────────────────────────────────────────────
model        [model id, monospace]
latency      bucket [bucket]
divergence   [tipo de div en WARN | "— (PASS sin divergencia)"]
timestamp    [HH:MM:SS UTC, monospace]
evidence     [hash 12 chars, monospace]
```

**Reglas inquebrantables del tooltip:**

- Implementado como `<div role="tooltip">` posicionado por JS, NO `title=`.
- Estado del popover en JS state — **NUNCA** leer atributos `data-*` con
  `innerHTML` (REQ-SEC-B9).
- Todos los campos via `textContent` o template literals escapados (REQ-SEC-B4).
- NO incluye raw output, NO incluye stack trace, NO incluye API key prefix.
- Focus visible obligatorio cuando se navega con teclado.

---

## Layout y jerarquía visual

```
┌────────────────────────────────────────────────────────────────────────┐
│ Header dashboard (62px)                                                │
├────────────────────────────────────────────────────────────────────────┤
│ Breadcrumb + Título + descripción                                      │
├────────────────────────────────────────────────────────────────────────┤
│ Banner último run (1112×58)         │ Banner coordinación (260×58)     │ ← CA-B8 / CA-B9
│                                     │ Botón "Ejecutar harness" (260×46)│ ← CA-B11 / CA-B12
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│ ┌────────────── MATRIZ (894×600) ─────────┐ ┌── Panel issues (460×600)┐│
│ │ skill ↓ provider →                      │ │ Issues auto-creados ·   ││
│ │ ┌───┬───┬───┬───┬───┐                   │ │ FAIL                    ││
│ │ │ guru ── 5 celdas ────────────────     │ │ ───────────────         ││
│ │ │ po                                    │ │ planner × groq → #3690  ││
│ │ │ planner    ←──── FAIL aquí            │ │ architect × groq → #3691││
│ │ │ ux                                    │ │ review × cdx → #3692    ││
│ │ │ security  ←──── N/A en gemini         │ │                         ││
│ │ │ architect ←──── FAIL aquí             │ │ (estado vacío preview)  ││
│ │ │ review                                │ │                         ││
│ │ │ refinar   ←──── celda con FOCUS       │ │ Footer audit log        ││
│ │ └───────────────────────────────────────┘ │                         ││
│ │                                           └─────────────────────────┘│
├────────────────────────────────────────────────────────────────────────┤
│ Leyenda permanente (884×200)        │ Footer técnico (460×200)         │ ← CA-B7
│ 5 estados + 5 buckets               │ endpoints / locks / polling      │
└────────────────────────────────────────────────────────────────────────┘
```

### Reglas de grilla

- 8 filas de skills (`guru`, `po`, `planner`, `ux`, `security`, `architect`,
  `review`, `refinar`) × 5 columnas de providers (`anthropic`,
  `openai-codex`, `groq`, `gemini`, `cerebras`) = **40 celdas**.
- Celda: 142px × 60px, gap 6px.
- Header de columna: 36px de alto.
- Header de fila (skill): 130px de ancho.
- Tamaño total de la matriz: 894×600.
- Panel lateral: 460×600, mismo alto que la matriz.

> **Si entran más skills o más providers:** mantener gap y altura por celda;
> aumentar el ancho del bloque matriz; el panel lateral baja debajo en
> viewport < 1280px (responsive futuro, fuera del scope inmediato).

---

## Estados y transiciones

### Celdas — refresh entre runs

El dashboard hace polling al endpoint GET cada 30s. Cuando llega una nueva
matriz, el render aplica **DOM morphing por id de celda**
(`data-skill="..." data-provider="..."`) — NO se reemplaza el container
completo (patrón #2801 anti-flicker, CA-B19).

Transiciones específicas:

1. **PASS → WARN**: borde transiciona de `--success-dim` a `--warning` en
   `--motion-base` (200ms). Sin flash adicional.
2. **PASS/WARN → FAIL**: la celda no parpadea (no es alarma de incendio) —
   solo cambia color + glyph + texto. Aparece automáticamente un row en el
   panel lateral con el issue auto-creado.
3. **FAIL → PASS** (recuperación): borde transiciona, no se celebra
   visualmente, pero el row desaparece del panel lateral con
   `transition: opacity --motion-slow ease-out`.
4. **SKIPPED → PASS** (sumamos cobertura): celebración tenue (badge "+1
   nuevo" sobre la fila, dura 1 ciclo de polling, después desaparece).

### Botón "Ejecutar harness" — durante el run (CA-B12)

```
Estado IDLE (guard habilita):
  [ ▶ Ejecutar harness ]
  habilitado · ventana modo descanso

Click → dialog modal:
  ┌──────────────────────────────────────────────┐
  │ Disparar smoke test multi-provider           │
  │ ────────────────────────────────────────────  │
  │ Estimación: 4-6 min                          │
  │ Spawns: hasta 60 (1 por skill × provider)   │
  │ Modo: serializado · concurrency = 1          │
  │                                              │
  │            [Cancelar]  [Disparar]            │
  └──────────────────────────────────────────────┘

Estado RUNNING (POST devolvió 202 + runId):
  [ ▒▒▒▒░░░░░░ 42% ]
  corriendo · 17 / 40 celdas

Estado FINISHED:
  [ ▶ Ejecutar harness ]  ← vuelve a IDLE
  banner del último run se refresca
```

El barra de progreso usa `--brand-cyan` para el fill y `--surface-2` para el
track. El % es estimado server-side (celdas completadas / total).

### Banner de coordinación — sincronización con `partial-pause.json`

Si durante un run alguien cambia el estado del pipeline (cierra la ventana de
modo descanso, agrega un issue a `.partial-pause.json`), el banner se actualiza
en el próximo polling. El POST `/coverage/run` ya no se podrá disparar hasta
que vuelva el estado válido, pero el run en curso **no se cancela** (cleanup
del lockfile sólo en `finally` del proceso del harness).

---

## Accesibilidad (WCAG AA — CA-B15..B18)

### Estructura semántica

La matriz se rendea visualmente con CSS grid, **pero el DOM mantiene `<table>`
real** con `<thead>/<tbody>` para screen readers (CA-B15):

```html
<table role="grid" aria-label="Cobertura skill por provider">
  <thead>
    <tr>
      <th scope="col">skill</th>
      <th scope="col">anthropic</th>
      <th scope="col">openai-codex</th>
      ...
    </tr>
  </thead>
  <tbody>
    <tr>
      <th scope="row">guru</th>
      <td data-skill="guru" data-provider="anthropic"
          tabindex="0"
          aria-label="celda guru × anthropic: PASS, latencia menor a 500 milisegundos">
        <svg role="img" aria-hidden="true"><use href="#ic-cell-pass"/></svg>
        <span>PASS</span>
        <span class="bucket">≤500ms</span>
      </td>
      ...
    </tr>
  </tbody>
</table>
```

### `aria-label` por celda (CA-B16 / CA-B17)

Descriptivo del **estado**, no del dibujo. Patrón:

- PASS: `"celda [skill] × [provider]: PASS, latencia [bucket textual]"`
- WARN: `"celda [skill] × [provider]: WARN, divergencia [tipo], latencia [bucket]"`
- FAIL: `"celda [skill] × [provider]: FAIL, [error_class], latencia [bucket], ver issue [N]"`
- SKIPPED: `"celda [skill] × [provider]: SKIPPED, [razón]"`
- N/A: `"celda [skill] × [provider]: no aplica por diseño, [razón]"` —
  **NUNCA** "vacío" o aria-label vacío.

El `<svg>` interno lleva `role="img"` con `aria-hidden="true"` cuando el
`aria-label` de la celda ya describe el estado (evita doble lectura).

### Focus visible (CA-B18)

Outline `--brand-cyan` 2px con offset 2px, render fuera de la celda para no
recortar el glyph. Implementado con `:focus-visible` (NO `:focus`) para que
no interfiera con clicks de mouse.

```css
td:focus-visible {
  outline: 2px solid var(--brand-cyan);
  outline-offset: 2px;
  z-index: 1; /* para que el outline se vea sobre celdas adyacentes */
}
```

Tab order natural: header → banner → botón harness → celdas (fila por fila) →
issues del panel → leyenda → footer.

### Tamaños mínimos

- Texto del estado: 13px (`--fs-sm`).
- Texto del bucket: 11px (`--fs-xs`) — al borde de WCAG porque es información
  secundaria; el estado principal está en texto de 13px.
- Touch target del row del panel de issues: 56px de alto (>44px requerido).

### Contraste verificado (sobre `--surface-1` `#161B22`)

| Token             | Contraste | Uso                          |
|-------------------|-----------|------------------------------|
| `--text-primary`  | 14.8:1    | Estado en celda              |
| `--success`       | 5.9:1     | Glyph + texto PASS           |
| `--warning`       | 7.4:1     | Glyph + texto WARN           |
| `--danger`        | 6.3:1     | Glyph + texto FAIL           |
| `--text-dim`      | 5.3:1     | Bucket / SKIPPED             |
| `--text-disabled` | 3.9:1     | Texto secundario en N/A (solo apto para >18px, no usar para texto chico) |

---

## Reglas inquebrantables del widget (espejo de REQ-SEC-B1..B10)

1. **REQ-SEC-B1**: el botón "Ejecutar harness" tiene guard frontend pero
   **no es autoridad**. El POST hace re-validación server-side; un click
   manipulado por DevTools no dispara nada si el server no lo permite.
2. **REQ-SEC-B2**: el botón visualmente entra en estado RUNNING al disparar.
   Si el server devuelve 409 (lockfile presente), el botón vuelve a IDLE
   con tooltip `"otro run en curso · esperá a que termine"`.
3. **REQ-SEC-B3**: el dashboard NUNCA hace fetch desde el browser a los
   providers directamente — todo va por `/api/dash/multi-provider-coverage`.
4. **REQ-SEC-B4**: TODOS los campos dinámicos del JSON (`skill`, `provider`,
   `error_class`, `evidence_hash`, `timestamps`, `model`) se renderizan vía
   `textContent` o template literals escapados. **NUNCA** `innerHTML` /
   `insertAdjacentHTML`.
5. **REQ-SEC-B5**: los 8 íconos nuevos del sprite **no contienen** `<script>`,
   `<foreignObject>`, `on*`, `<use href="http...">` ni `<image href="data:...">`.
   Test estático del sprite cubre esto en el módulo `__tests__`.
6. **REQ-SEC-B6**: el endpoint GET responde con `Content-Type: application/
   json; charset=utf-8`, `X-Content-Type-Options: nosniff`,
   `Cache-Control: no-store`. **NO** `Access-Control-Allow-Origin: *`.
7. **REQ-SEC-B7**: link al issue construido server-side con `Number()` cast.
   `target="_blank"` siempre con `rel="noopener noreferrer"`.
8. **REQ-SEC-B8**: `evidence_hash` truncado a 12 chars siempre. El hash
   completo vive en el JSON persistido, no se renderiza.
9. **REQ-SEC-B9**: el popover de tooltip lee desde JS state, NO de atributos
   `data-*` con `innerHTML`. Focus visible obligatorio para teclado.
10. **REQ-SEC-B10**: cada click al POST queda en audit-log (`harness_run_requested`),
    con `allowed: true|false`. El badge "histórico de runs" del panel cita el
    path al JSONL.

---

## Anti-patrones (cosas que el dev NO debe hacer)

- ❌ Disparar fetch directo del browser a un endpoint del provider. Todo va
  por `/api/dash/multi-provider-coverage` para que la sanitización server-side
  proteja.
- ❌ Mostrar latencias absolutas en ms. **Solo buckets discretos.**
- ❌ Mostrar raw output del provider en el panel o el tooltip. **Solo
  `error_class`** del schema.
- ❌ Cell color sin glyph y sin texto. **Las tres cosas a la vez, siempre.**
- ❌ N/A indistinguible visualmente de SKIPPED. **Rayado diagonal vs círculo
  punteado — diferentes a primera vista.**
- ❌ `title="..."` como tooltip nativo. **Popover custom con `role="tooltip"`.**
- ❌ Re-renderizar el container completo de la matriz cada 30s. **DOM
  morphing por id de celda (#2801).**
- ❌ Hardcoded colors fuera de `design-tokens.css`.
- ❌ Inventar tokens nuevos. **Reusar los existentes** — la paleta del
  sistema ya cubre los 5 estados y los 5 buckets.

---

## Checklist de verificación visual (para QA structural)

Cuando el dev termine la implementación, el screenshot debería poder responder
"sí" a todas estas preguntas:

- [ ] ¿Los 5 estados de celda son visibles en la matriz simultáneamente?
- [ ] ¿Cada estado tiene color + glyph + texto (no solo color)?
- [ ] ¿N/A se distingue visualmente de SKIPPED al primer vistazo?
- [ ] ¿La leyenda está SIEMPRE visible (no escondida en hover/toggle)?
- [ ] ¿La leyenda cubre los 5 estados Y los 5 buckets?
- [ ] ¿El banner del último run muestra timestamp + duración + spawns + modo?
- [ ] ¿El banner de coordinación usa el token `--rest-mode` con su tinte
  indigo característico?
- [ ] ¿El botón "Ejecutar harness" cambia de IDLE a RUNNING durante un run?
- [ ] ¿El panel lateral tiene un row por cada FAIL de la matriz (1-a-1)?
- [ ] ¿El link al issue del row tiene `target="_blank"` y abre nueva pestaña?
- [ ] ¿El tooltip de celda NO muestra raw output ni latencias absolutas?
- [ ] ¿La matriz tiene `<table>` real con `<thead>/<tbody>` (verificar con
  DevTools)?
- [ ] ¿Cada celda tiene `aria-label` descriptivo no vacío (incluyendo N/A)?
- [ ] ¿Focus visible al navegar con Tab muestra outline brand-cyan 2px?
- [ ] ¿El bundle generado NO contiene `innerHTML` ni `insertAdjacentHTML`
  (grep)?
- [ ] ¿El `curl` al endpoint NO devuelve `api_key_prefix`, `hostname`,
  `latency_ms`, `raw_output`?

---

## Referencias

- Padre: [#3669](https://github.com/intrale/platform/issues/3669) — épico
  multi-provider smoke test.
- Hermano (dependencia): [#3680](https://github.com/intrale/platform/issues/3680) —
  schema + harness + matriz JSON.
- Este issue: [#3681](https://github.com/intrale/platform/issues/3681) —
  widget + endpoint API.
- Mockup: [`24-multi-provider-coverage-widget.svg`](24-multi-provider-coverage-widget.svg).
- Patrón anti-flicker DOM morphing: #2801.
- Patrón modo descanso `--rest-mode`: #2882.
- Patrón provider colors: #3086 / U1.
- Design system completo: `docs/pipeline/design-system.md`.

> Narrativa UX del Hijo B del épico #3669 — Multi-Provider Coverage widget.
> Sistema visual elaborado en la fase `criterios` del pipeline de definición.
> Audio narrado del MP3 se generará en fase `dev` con `edge-tts` (voz
> `es-AR-ElenaNeural`) sobre este texto.
