# UX · Addendum 2 #5708 — Estados que introduce la revisión 2 del contrato visual

> Entregable de UX en `definicion/criterios`, pasada de **routing #2**. Complementa
> `ux-criterios-5708.md` (mockup 48, UX-1..UX-8) y `ux-criterios-5708-addendum.md`
> (mockup 49, UX-9..UX-13). Mockup nuevo:
> `.pipeline/assets/mockups/50-visual-block-rev2-states.svg` (1240×1560),
> preview `.pipeline/assets/mockups/5708/preview-50.png`.

## 0. Por qué existe este addendum

La **revisión 2** de la receta del `architect` (D7–D15) cambia el contrato: imágenes por
referencia, `verdict` obligatorio, `rev` con consumidor, `regression` derivada por código,
topes con fallo declarado y un call-site único del guardrail. Esas nueve decisiones
introducen **cuatro situaciones nuevas** que las bandas E1–E5 del mockup 49 no describen
correctamente. Mapearlas a las bandas existentes —como hace hoy la tabla de D15— hace que
el reporte **afirme cosas que la pasada no verificó**, que es exactamente el defecto que
este issue ataca.

Verificado en esta pasada sobre `origin/agent/5708-pipeline-dev` @ `2ce72094d`:

```
$ git show origin/agent/5708-pipeline-dev:.pipeline/rejection-report.js | sed -n '1571p'
      : `<div class="visual-placeholder">⚠ ${label} no disponible</div>`;
      ⇒ el placeholder de imagen no declara motivo (UX-18)

$ git show origin/agent/5708-pipeline-dev:.pipeline/rejection-report.js | sed -n '1608p'
            ${d?.regression ? '<span class="badge badge-purple">REGRESIÓN</span>' : ''}
      ⇒ el chip sólo tiene dos estados: hay chip / no hay chip (UX-17)

$ git show origin/agent/5708-pipeline-dev:.pipeline/hooks/visual-report-shape-gate.js
   reason: 'coverage-incomplete' | 'coverage-missing' | 'report-malformed'
      ⇒ el bloqueo del guardrail NO es una falla de carga, pero D15 lo manda a la banda E4,
        cuyo título dice "el contrato no se pudo cargar" (UX-14)
```

**Regla rectora heredada** (SEC-4 llevada al operador): *ninguna razón por la que algo no
se muestre puede ser indistinguible de «no hubo desvíos»*. Este addendum la extiende: **ni
puede describirse con el motivo equivocado**. Una banda que dice "no se pudo cargar" cuando
el contrato se leyó perfecto manda al dev a diagnosticar el archivo en vez de re-ejecutar
el barrido.

## 1. Los cuatro estados nuevos

| Estado | Condición (`skip.reason` o caso) | Artefacto visible | Reemplaza al mapeo de |
|--------|----------------------------------|-------------------|-----------------------|
| **E6** | `shape-gate-block` | banda violeta *barrido no aceptado* | D15 → E4 (incorrecto) |
| **E3b** | `rev-unknown` | banda ámbar *pasada indeterminada*, copy propio | D15 → E3 (afirma algo falso) |
| **E2p** | `verdict-approved` | banda verde **con** la cobertura proyectada | D8 deja el contrato en `null` y E2 se queda sin datos |
| **REG** | `regression` derivada sin línea base | tercer estado del chip de regresión | D11 colapsa dos casos en uno |
| **IMG** | `safeImageSrc` no resuelve | placeholder **con motivo** | placeholder mudo actual (`:1571`) |

### E6 · Barrido no aceptado — banda propia, no E4

Fondo `#2B1D46`, borde `#8957E5`, acento `#BC8CFF`. **Símbolo propio**: círculo incompleto
(arco sólido + arco punteado) con puntos suspensivos — deliberadamente distinto de la `×`
de E4, porque no es la misma clase de falla.

- Título: `BARRIDO VISUAL NO ACEPTADO — la cobertura declarada está incompleta`.
- Cuerpo **obligatorio**: *"El contrato se leyó correctamente. Lo que no se aceptó es el
  barrido"* + *"Esto NO es una falla técnica de carga y NO significa «sin desvíos»"*.
- Pie monoespaciado: `reason` del guardrail + `missing[]` textual + acción
  `re-ejecutar QA visual con barrido completo antes de rebotar`.

Es el estado más importante del issue: es la primera vez que el pipeline **le dice al
operador que el barrido fue incompleto** en vez de pasarlo como veredicto.

### E3b · Pasada indeterminada — variante de E3 con copy propio

Mismos tokens que E3 (`#3A2D0B` / `#7D5E10` / `#D29922`) pero **símbolo `?`** en vez de `!`
y copy distinto:

- Título: `EVIDENCIA VISUAL NO ATRIBUIBLE A ESTA PASADA`.
- Cuerpo: *"No se pudo determinar a qué pasada corresponde la evidencia. No se afirma que
  sea vieja: se afirma que no se sabe."*
- **Prohibido** el copy de E3 (*"corresponde a una pasada anterior"*): con `rev-unknown` el
  contrato puede ser perfectamente el de esta misma pasada, y afirmar lo contrario es
  inventar un hecho.
- Pie: `contrato.rev=N · pasada actual=(no informada)` + acción dirigida **al emisor**, no
  al dev (`el emisor debe pasar la pasada actual al reporte`).

### E2p · Veredicto aprobado — la cobertura viaja en el skip

D8 hace que `loadVisualComparison` devuelva `contract: null` con `verdict: "approved"`.
Pero el §3 de *Cambios requeridos* del issue exige que **el aprobado también declare
cobertura**, y el render se quedaría sin datos para hacerlo. Resolución de UX:

> Junto al `skip` de `verdict-approved` viaja una **proyección mínima de cobertura**
> (`skip.coverage`): `secciones_declaradas`, `verificadas`, `no_verificadas[{section,
> motivo}]`. **Sin `diffs`, sin imágenes, sin `suggestedAction`.**

Así el contrato sigue sin entregarse al camino de rechazo (D8 intacto) y la línea base para
tipificar regresiones de la pasada siguiente queda visible y auditable. La banda muestra los
chips por sección y el conteo `N de M secciones verificadas`. Nunca el badge
`VISUAL MISMATCH`.

### REG · Tipificación de regresión — tres estados, no dos

`d.regression` derivada (D11) tiene tres significados y hoy sólo dos apariencias:

| Caso | Chip | Cuándo |
|------|------|--------|
| Regresión | `REGRESIÓN · verificada sin hallazgos en rev N` (violeta, sólido) | la pasada previa declaró la sección verificada y sin hallazgos |
| No es regresión | `NO ES REGRESIÓN · sección no verificada en rev N` (gris, sólido) | hay línea base y la sección no estaba verificada ⇒ hallazgo tardío por barrido incompleto |
| Sin línea base | `SIN LÍNEA BASE · no hay pasada previa registrada` (gris, **con textura**) | `deriveRegressions` no encontró store previo |

El caso 3 es el sesgo que D11 acepta a propósito (*"el falso negativo es aceptable"*) —
pero **el operador tiene que saber que está frente a un falso negativo estructural**, no
frente a una verificación. Mostrarlo igual que el caso 2 es afirmar algo que no se verificó.
La distinción se codifica con **textura + texto**, nunca sólo con color (UX-4).

### IMG · Placeholder de imagen con motivo

Con D7 las imágenes viajan por path relativo, así que el camino "no resoluble" pasa de
excepcional a probable (archivo ausente, extensión fuera del allowlist, symlink, tope de
bytes). El placeholder actual (`:1571`) dice `⚠ MOCKUP ESPERADO no disponible` y nada más.

- Debe declarar el **motivo** en pie monoespaciado (ausente / extensión no permitida /
  symlink rechazado / supera el tope).
- Debe incluir la desambiguación: *"Esto NO significa que la entrega coincida con el
  mockup: la imagen no se pudo leer"*.
- La columna afectada lleva badge `sin captura`, **no** `no matchea` — que afirma una
  comparación que no se hizo.

## 2. Criterios de aceptación UX (verificables sobre el PDF y el audio)

- **UX-14** · `shape-gate-block` renderiza la banda **E6**, con símbolo propio distinto del
  de E4 y con el texto *"el contrato se leyó correctamente"*. Verificable: el HTML generado
  con `VISUAL_REPORT_SHAPE_GATE_ENABLED=1` y cobertura incompleta contiene la etiqueta de
  barrido no aceptado y **no** contiene la frase de falla de carga de E4.
- **UX-15** · `rev-unknown` renderiza **E3b** con copy propio. Verificable: el HTML de un
  reporte sin `--rev` **no** contiene la frase *"corresponde a una pasada anterior"*.
- **UX-16** · Con `verdict: "approved"` el PDF muestra la cobertura declarada (chips por
  sección y conteo), alimentada por `skip.coverage`. Verificable: HTML con las N secciones
  y sin bloque de inventario; `contract` sigue siendo `null` para el camino de rechazo.
- **UX-17** · Cada hallazgo del inventario declara **uno de los tres** estados de regresión,
  y `SIN LÍNEA BASE` es visualmente distinguible de `NO ES REGRESIÓN` en escala de grises.
  Verificable: contrato sin store previo ⇒ ningún hallazgo muestra `NO ES REGRESIÓN`.
- **UX-18** · El placeholder de imagen declara motivo y desambiguación, y la columna sin
  imagen no lleva el badge `no matchea`. Verificable: HTML con `delivery.src` inexistente.
- **UX-19** · Ninguna banda nueva (E6, E3b, E2p) emite el badge `VISUAL MISMATCH` —extiende
  UX-13— y todas narran **como sufijo**, nunca como titular —extiende UX-12—. Verificable:
  `generateNarration` con cada `skip.reason` ⇒ la primera oración nunca empieza por el
  motivo visual.

## 3. Impacto sobre la receta del `architect` (revisión 2)

La tabla de D15 mapea `skip.reason → banda` así: `verdict-approved → E2`,
`stale-rev`/`rev-unknown → E3`, `oversize`/`unreadable`/`shape-gate-block`/
`contract-embeds-base64 → E4`. Este addendum la corrige en tres celdas:

| `skip.reason` | D15 decía | Debe ser |
|---------------|-----------|----------|
| `shape-gate-block` | E4 | **E6** |
| `rev-unknown` | E3 | **E3b** |
| `verdict-approved` | E2 (sin datos de cobertura) | **E2p** (con `skip.coverage`) |

`stale-rev → E3`, `oversize`/`unreadable`/`contract-embeds-base64 → E4` quedan **como
están**: ahí el mapeo describe bien lo que pasó.

## 4. Trazabilidad

- Mockup base: `48-rejection-visual-inventory.svg` (criterios, UX-1..UX-8).
- Mockup de supresiones: `49-visual-block-degraded-states.svg` (validación, UX-9..UX-13).
- Mockup de este addendum: `50-visual-block-rev2-states.svg` (criterios rev-2, UX-14..UX-19).
- Render afectado: `.pipeline/rejection-report.js` → `loadVisualComparison`,
  `renderVisualComparisonBlock`, `safeImageSrc`, `generateNarration`.
- Store afectado: `.pipeline/lib/visual-coverage-store.js` (nuevo, D11) — `deriveRegressions`
  debe distinguir *«no es regresión»* de *«no hay línea base»* en su valor de retorno, no
  sólo devolver `false` en ambos casos.
- Doc a actualizar por dev: `docs/pipeline/visual-validation.md` (§ estados degradados).
- Verificación de render de este mockup: `node .pipeline/assets/mockups/5708/render-mockup.js
  .pipeline/assets/mockups/50-visual-block-rev2-states.svg
  .pipeline/assets/mockups/5708/preview-50.png 1240 1560`
  ⇒ `status 200 · 56 texts · 39 rects · 0 overflow · 0 pageerror`.
