## 🎨 UX — validación de #6565 · Panel de saldo y ritmo de cuota por proveedor

**Veredicto: aprobado.** Nada impide arrancar `dev`. El issue entró directo con `Ready`
(no pasó por `definicion/criterios`), así que **esta fase entrega los assets** que el dev
necesita como entrada — no sólo opinión. Scope: `area:dashboard` + `area:infra`, sin `app:*`
⇒ QA structural + evidencia visual render-vs-mockup (hay mockup versionado ⇒ aplica #4568).

---

### 1. Assets entregados (rama `agent/6565-ux-assets`, se mergea dentro de la rama del dev)

| Archivo (`.pipeline/assets/mockups/6565/`) | Qué es |
|---|---|
| `dashboard-actual-cuota.png` | Estado ACTUAL del home (1440×900 fullPage, dashboard vivo en `localhost:3200`, 21/09 15:27). |
| `panel-actual-cuota.png` | Zoom 2× del panel "Estado + Cuota por proveedor" tal como está hoy (#4533): 3 columnas, ventana corta/larga con % del proveedor. |
| `panel-esperado-cuota.html` | Fuente del mockup (HTML/CSS self-contained, sólo tokens `--in-*` del `theme.css` real, sin scripts ni fetch). |
| `panel-esperado-cuota.png` | **Mockup ESPERADO** (2×): ① el panel con los 3 proveedores en 3 escenarios reales; ② catálogo de los 6 estados del enum `ESTADOS`. **Es la referencia de aceptación.** |
| `render-mockup.js` | Cómo se renderizó (Puppeteer, flujo `docs/pipeline/ux-visual-flow.md`). Re-ejecutable. |
| `ux-validacion-6565.md` | Este contrato. |

---

### 2. Decisión de diseño — una sola sección (CA-4)

El home ya tiene la sección **🔌 CUOTA POR PROVEEDOR** (`renderSystemQuotaPanel`, #4533):
`Proveedor | Ventana corta | Ventana larga`, cada celda con mini-barra + % leído del proveedor
+ countdown de reset. Ese panel **es** la sección de cuota; no se crea otra.

Lo que cambia:

| Columna | Hoy (#4533) | Esperado (#6565) |
|---|---|---|
| Proveedor | dot + nombre + fuente | **igual** |
| Ventana corta | `5H ▬▬ 83% ↻21m` desde `/api/dash/quota` | **igual, intacta** (la ventana corta no tiene techo declarado; queda fuera del libro contable) |
| Ventana larga | `SEM ▬▬ 23% ↻6d5h` desde `/api/dash/quota` | pasa a **Período · saldo**: `SEM ▬▬▬|▬ 77 pts` desde `/api/dash/quota-balance` |
| — | — | nueva **Ritmo · proyección**: `0,62 pts/h · agota en 5d 4h` |
| — | — | nueva **línea 2** bajo las dos columnas nuevas: chip de veredicto (ícono + texto) a la izquierda; `techo · consumido · ↻ cierre` a la derecha |

Cada proveedor ocupa **dos líneas** (la primera versión en una sola línea no entraba en los
~715 px útiles de la matriz sin recortar el chip — verificado en render). La nota del header
pasa a: *"corta: % leído del proveedor · período: saldo y ritmo del libro contable (#6560) ·
muestra hace Xm"*.

**Fuente única por celda (CA-3/CA-4):** la celda larga deja de hidratarse desde
`/api/dash/quota`. Todo lo del período (barra, saldo, ritmo, proyección, chip, cierre) sale de
`/api/dash/quota-balance` → `balance.providers[<id>]`. Dos endpoints escribiendo la misma celda
era exactamente el "dos secciones con datos distintos" que prohíbe el CA-4.

---

### 3. Mapeo campo → elemento (la vista NO recalcula nada)

| Elemento | Campo de `balance.providers[id]` | Formato |
|---|---|---|
| tag del período | `periodo` | `semanal→SEM`, `diario→DÍA`, `horario→HORA` |
| barra: relleno | `consumo` / `techo` | `min(100, consumo/techo·100)` % de ancho — sólo escala visual, no umbral |
| barra: tramo rayado | `excedente_pts` / `techo` | ancho `excedente/techo·100` % a partir del borde derecho; sólo si `> 0` |
| barra: marca vertical | `al_cierre_pts` | posición `(techo − al_cierre_pts)/techo`; se dibuja sólo si `al_cierre_pts != null`; clamp a 100 % |
| saldo | `saldo_pts` + `unidad` | `77 pts` (0 decimales). Con `unidad: tokens` → `1,2 M tok`; `mensajes`/`creditos` → entero + unidad. **Nunca negativo** (ya viene ≥ 0) |
| ritmo | `ritmo_pts_por_hora` | `0,62 pts/h` (2 decimales, coma decimal `es-AR`); `null → —` |
| "agota en" | `agota_en_ms` | `fmtETA(ms)` existente (`5d 4h`); `null` → `sin proyección`; excedido → `agotado` |
| chip de veredicto | `estado` (+ `agota_en_ms`, `cierre_en_ms`, `al_cierre_pts`, `excedente_pts`, `muestras`, `min_muestras`, `muestra_at`) | tabla §4 |
| lectura derecha | `techo`, `consumo`, `cierre_en_ms`, `ultimo_reset` | `techo 100 · consumido 23 ↻ cierra en 6d 5h` · si `ultimo_reset` en el período: `repuesto hace 12m` |
| color de saldo/barra/ritmo | `estado` | `alcanza→ok · se_agota_antes→warn · excedido→bad · desactualizado→warn · sin_datos→dim · sin_proyeccion→(color normal, ok)` |
| `title` de cada celda | todos los anteriores + `plan`, `reposicion`, `cierre_periodo_at`, `agota_at`, `muestra_at`, `confidence`, `ventana_movil_min` | texto plano, con fechas locales `dd/mm hh:mm` |
| nota del header "muestra hace Xm" | `computed_at` / `muestra_at` más reciente | `relativeTime` |

**Prohibido en la vista:** comparar `consumo` contra umbrales, derivar `estado` a partir del
%, calcular `agota` con regla de tres, o pintar `warn/bad` por porcentaje. El color lo dicta
`estado` y sólo `estado`. Si un día cambia la fórmula, cambia en `quota-balance.js` y el panel
lo refleja sin tocar CSS.

---

### 4. Copy del chip por estado (contrato — un estado = un render)

| `estado` | Ícono | Texto del chip | Tono | "agota en" |
|---|---|---|---|---|
| `alcanza` | ✓ | `Alcanza · +{al_cierre_pts} pts al cierre` | ok (verde) | `agota en {fmtETA(agota_en_ms)}` o `no se agota` si `ritmo = 0` |
| `se_agota_antes` | ⚠ | `Se agota {fmtETA(cierre_en_ms − agota_en_ms)} antes del cierre · {al_cierre_pts} pts` (con signo) | warn (ámbar) | `agota en {fmtETA(agota_en_ms)}` — si `cierre_periodo_at = null` (rolling sin reset): `Se agota en {…} · cierre desconocido` |
| `excedido` | ✕ | `Excedido +{excedente_pts} pts sobre el techo` | bad (rojo) | `agotado` |
| `sin_datos` | ○ | `Sin datos del período` | dim (gris, **no verde**) | `sin proyección` |
| `desactualizado` | ⏱ | `Dato viejo · muestra de hace {relativeTime(muestra_at)}` | warn | `sin proyección` |
| `sin_proyeccion` | ◌ | `Ritmo en cálculo · {muestras}/{min_muestras} muestras` | dim (el saldo conserva su color normal) | `sin proyección` |

Reglas de copy: sentence case (no MAYÚSCULAS en el chip: a 9 px las versales pierden legibilidad y
ensanchan 20 %), signo tipográfico `−` para negativos, `·` como separador, sin punto final.

---

### 5. Criterios UX vinculantes (los verifico en `aprobacion`)

- **UX-1 — Una sola sección. BLOQUEANTE.** `renderSystemQuotaPanel` se extiende; no aparece un
  segundo panel/sección de cuota en home ni en `/providers`. "Ventana corta" queda byte-a-byte
  como hoy (ids `mz-qm-<key>-short-*`, hidratación de `/api/dash/quota` intacta).
- **UX-2 — El período se hidrata SOLO desde `/api/dash/quota-balance`. BLOQUEANTE.**
  `_mzHydrateWinCell(key,'long')` deja de escribir (o se elimina); `home.test.js:267` se ajusta
  (`mz-qm-anthropic-long-bar` ya no existe; ids nuevos sugeridos `mz-qb-<key>-{bar,over,mark,saldo}`,
  `mz-qr-<key>-{rate,eta}`, `mz-qv-<key>`, `mz-ql2-<key>-rd`). Ningún número del período se calcula
  en el cliente (§3, "Prohibido").
- **UX-3 — Estado nunca sólo por color. BLOQUEANTE.** Cada fila muestra el chip con ícono + texto
  de §4. `aria-label` del chip = mismo texto + nombre del proveedor. Design system §3 lo exige.
- **UX-4 — `sin_datos` = saldo completo en gris, nunca error, nunca verde.** `100 pts` en
  `--in-fg-dim`, chip `○ Sin datos del período`. (Gherkin "proveedor recién repuesto": saldo
  completo + consumo 0 se muestra con `ok` sólo si hay muestra fresca; con `confidence: missing`
  va gris.)
- **UX-5 — `excedido` muestra excedente explícito.** Saldo `0 pts`, chip `✕ Excedido +N pts`,
  barra llena + tramo rayado (`repeating-linear-gradient` con `--in-bad`), lectura
  `techo 100 · consumido 112`. Nunca un saldo negativo ni un % > 100 sin el tramo rayado.
- **UX-6 — Sin proyección sobre dato viejo o insuficiente.** `desactualizado` y
  `sin_proyeccion` renderizan ritmo `—` y `sin proyección`; no se dibuja la marca de cierre.
- **UX-7 — Fail-closed del slice.** `ok: false` ⇒ las dos columnas nuevas quedan en `sin dato`
  (`mz-qm-nodata`, gris) con `title = motivo`; header con `⚠ balance no disponible`. Nunca `0 pts`
  ni `100 pts` verde por defecto. Mientras no llega el primer tick: `…` atenuado (misma convención
  CA-UX2 de #4249).
- **UX-8 — Sólo tokens `--in-*`.** `--in-ok/--in-warn/--in-bad` + `-soft`, `--in-fg/-dim/-soft`,
  `--in-border`. Cero hex nuevos en `home.js` (el mockup no introduce ninguno). Contraste ya
  validado por el design system: `#3fb950`/`#d29922`/`#f85149` sobre `#161b22` ≥ 5,6:1.
- **UX-9 — Countdowns vivos.** `cierre_en_ms` / `agota_en_ms` se descuentan localmente con
  `fmtETA` (tick de 1 s como el resto de la matriz) y se re-piden al slice cada 60 s
  (`tickProviderQuota`-like). Un countdown vencido muestra `renovando…`, no negativo.
- **UX-10 — `title` completo en las tres celdas del período** (§3): plan, techo, consumo, saldo,
  excedente, ritmo, `agota_at`, `cierre_periodo_at`, `al_cierre_pts`, `muestra_at`, confidence,
  ventana móvil. Es el "ver más" sin ensuciar la grilla.
- **UX-11 — Layout.** `grid-template-columns: 0.8fr 0.95fr 1.35fr 1.2fr`, `column-gap 12px`,
  fila = 2 líneas (`grid-template-rows: auto auto`; proveedor y ventana corta `span 2`).
  Nada recortado a 1440 px (verificado con `scrollWidth > clientWidth` en el render: 0 elementos
  recortados salvo rounding del chip ámbar). A < 1200 px la línea 2 puede envolver; no se oculta.

---

### 6. Checklist render-vs-mockup para `aprobacion` (PO/UX/QA)

- [ ] Paleta: saldo/barra/chip usan `--in-ok/warn/bad/fg-dim` según `estado` (no según %).
- [ ] Jerarquía: proveedor 12 px 800 · saldo 11 px 800 · chip 9 px 800 · lectura 9 px 700 dim.
- [ ] Espaciados: fila 2 líneas, `min-height 26px` por línea, `column-gap 12px` (±4 px).
- [ ] Ventana corta idéntica al `panel-actual-cuota.png`.
- [ ] Los 6 estados renderizan como el bloque ② (forzar con fixtures del slice o `now` sintético).
- [ ] `ok:false` del slice ⇒ `sin dato` gris + motivo en `title`.
- [ ] Un solo panel de cuota en home; `/providers` no duplica saldo/ritmo (si el dev quiere
  mostrarlo ahí, va como link "ver saldo en home", no como segunda fuente).

---

### 7. Verificación empírica de esta pasada

    $ gh issue view 6565 --json labels,state
    labels: enhancement, Ready, area:dashboard, area:infra, priority:high, size:medium · OPEN
    (sin app:* ⇒ sin video; con mockup versionado ⇒ QA visual #4568)

    $ git fetch origin main && git log --oneline -1 origin/main
    d9c79cf24 Calcular saldo, ritmo y proyeccion de agotamiento de cuota por proveedor (#7557)

    $ git archive origin/main .pipeline/lib/multi-provider/quota-balance.js … | tar -x
    ESTADOS = [alcanza, se_agota_antes, excedido, sin_datos, desactualizado, sin_proyeccion]
    balanceForProvider → { provider, plan, periodo, unidad, techo, reposicion, rolling,
      periodo_inicio_at, cierre_periodo_at, cierre_en_ms, cierre_fuente, consumo, consumo_pct,
      saldo_pts, excedente_pts, balance_pts, ritmo_pts_por_hora, agota_at, agota_en_ms,
      al_cierre_pts, estado, confidence, muestra_at, muestras, ventana_movil_min, min_muestras,
      ultimo_reset, fuente }
    quotaBalanceSlice → { ok, motivo, computed_at, horas, balance:{providers}, series }
    (dashboard-slices.js:4464; ruta GET /api/dash/quota-balance, dashboard-routes.js)

    $ curl -s localhost:3200/api/dash/quota-balance | head -c 60
    <!DOCTYPE html>…   ← el dashboard vivo corre el repo principal (1ad62022e), anterior a
                          #7557: la ruta todavía no está desplegada. Esperable; el dev parte de
                          origin/main.

    $ curl -s localhost:3200/api/dash/quota | jq '.providers.anthropic'
    session {pct:82, win:"5h", kind:"short"} · weekly {pct:23, win:"Sem", kind:"long"}  ← la
    celda larga de hoy muestra este 23 %; con #6565 ese 23 pasa a ser `consumo` del balance y
    la celda muestra `77 pts` de saldo (misma muestra, otra lectura — no dos fuentes).

    $ node render-mockup.js
    {"panelW":1036,"panelH":245,"clipped":["⚠Se agota 1d 1h antes del cierre · −16 p"]}
    (el único "recorte" es 1 px de rounding del inline-flex del chip; en el PNG se lee entero)

    $ grep -c "#[0-9a-fA-F]\{6\}" panel-esperado-cuota.html   → sólo el bloque :root que
    replica theme.css (8 tokens); ninguna regla de las celdas nuevas usa hex.

    $ grep -n "mz-qm-anthropic-long-bar" views/dashboard/__tests__/home.test.js
    267: assert.ok(html.includes('id="mz-qm-anthropic-long-bar"') …   ← el dev lo ajusta (UX-2)

Comentario publicado en el issue con el mockup y este contrato.

Sin recomendaciones como issues independientes: la serie histórica de saldo por proveedor ya la
cubren #4948/#4543/#5018 (notado por UX en #6560), y la alerta anticipada por Telegram es #4282.
