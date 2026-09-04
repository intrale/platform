# UX · Addendum #5708 — Estados degradados del bloque visual

> Entregable de UX en `desarrollo/validacion`, pasada de rebote (rechazo de `review` →
> R1/R2). Complementa `ux-criterios-5708.md` (mockup 48). Mockup nuevo:
> `.pipeline/assets/mockups/49-visual-block-degraded-states.svg` (1240×1180),
> preview `.pipeline/assets/mockups/5708/preview-49.png`.

## 0. Por qué existe este addendum

Mi spec de `criterios` (V1–V5) definió cómo se ve el bloque visual **cuando hay un
contrato válido**. No definió qué ve el operador cuando el contrato **no corresponde a
esta pasada**, declara un aprobado, o no se pudo cargar. Ese hueco es la cara UX de R1:

```
$ node -e "generateNarration({issue:5708, primaryCause:{summary:'tests del modulo users fallan: 3 rojos en DoLoginTest'}, visualComparison:vc})"
Issue 5708: rechazo visual. 4 desvíos detectados; los 3 de mayor impacto son: Cobertura
visual declarada — impacto alto. Inventario agrupado por seccion — impacto alto. ...

$ node -e "generateNarration({issue:5708, primaryCause:{...}})"   # control, sin el json
Issue 5708: rechazado. Causa: tests del modulo users fallan: 3 rojos en DoLoginTest.
```

El operador escucha *"rechazo visual, 4 desvíos"* para un rechazo por tests rojos, y la
causa real nunca aparece. CA-8/CA-9/CA-10/CA-13 resuelven la **lógica** de la supresión.
Este addendum define el **artefacto visible** de cada supresión, para que "no renderizar"
no se convierta en otra forma de silencio.

**Regla rectora** (SEC-4 llevada a la experiencia del operador):

> Toda supresión del bloque visual que el operador podría leer como *"no hubo desvíos"*
> se declara en el PDF y en el audio. Un log en `stdout` no es evidencia para el operador.

## 1. Los cinco estados

| Estado | Condición | Artefacto visible | CA que lo cubre |
|--------|-----------|-------------------|-----------------|
| **E1** | El skill que rechaza no es el de QA visual | **ninguno** — sin bloque y sin banda | CA-10 |
| **E2** | `verdict: "approved"` | banda verde informativa + bloque de cobertura | CA-8 |
| **E3** | `contrato.rev ≠ pasada actual` | banda ámbar de descarte | CA-9 |
| **E4** | Tope de bytes superado / JSON inválido / no legible | banda roja de falla declarada | CA-13 |
| **E5** | — | orden de narración del audio | CA-10 |

### E1 · Rechazo no visual — sin banda

No se adjunta `--visual-json`, no se renderiza bloque y **no se agrega banda**. La pasada
no hizo ninguna afirmación visual, así que no hay nada que declarar: agregar una banda
"sin evidencia visual" en el rechazo de `tester` sería ruido. El reporte muestra la causa
real del rechazo, intacta.

### E2 · Veredicto visual aprobado — banda informativa

Fondo `#0F3D26`, borde `#196C2E`, acento `#3FB950`, ícono check en círculo.
Título: `COBERTURA VISUAL DECLARADA · sin desvíos`. Se renderiza la cobertura (V1) porque
es la línea base para tipificar regresiones en la próxima pasada; **no** se renderiza
inventario porque no hay desvíos. Nunca se usa el badge `VISUAL MISMATCH`.

### E3 · Contrato de otra pasada — banda de descarte

Fondo `#3A2D0B`, borde `#7D5E10`, acento `#D29922`, ícono `!` en círculo.
Título: `EVIDENCIA VISUAL DESCARTADA — corresponde a una pasada anterior`.
Cuerpo obligatorio: los dos `rev` (el del contrato y el actual) y por qué se descarta
(*"para no reportar como vigentes desvíos que pueden estar corregidos"*).
Pie monoespaciado con el path del archivo y la acción: `re-ejecutar QA visual en esta pasada`.

### E4 · Contrato no cargable — banda de falla declarada

Fondo `#3B1F1B`, borde `#8B1A14`, acento `#F85149`, ícono `×` en círculo.
Título: `EVIDENCIA VISUAL NO EVALUADA — el contrato no se pudo cargar`.
El cuerpo **debe** desambiguar explícitamente: *"esto NO significa «sin desvíos»:
significa que el inventario no se leyó"*. Pie monoespaciado con el motivo medido
(`size N B > MAX_VISUAL_JSON_BYTES M`) y la acción sugerida.

Hoy este caso es un `return null` mudo:

```
$ sed -n '126p' .pipeline/rejection-report.js
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_VISUAL_JSON_BYTES) return null;
$ wc -c qa/evidence/5708/visual-comparison.json   →  815663   (77,8 % del tope, 99,8 % base64)
```

### E5 · Orden de narración

La rama visual se evalúa **después** de `inconclusive` y de `primaryCause`, y sólo con
`verdict: "rejected"` de la pasada actual. Los estados degradados narran como **sufijo**,
nunca como titular:

- E2 → «…además, la validación visual quedó aprobada con 4 de 4 secciones verificadas.»
- E3 → «La evidencia visual disponible es de una pasada anterior y no se tuvo en cuenta.»
- E4 → «La evidencia visual no se pudo evaluar en esta pasada.» — **nunca se omite**: es
  exactamente la falla que SEC-4 prohíbe callar.

## 2. Criterios de aceptación UX (verificables sobre el PDF y el audio generados)

- **UX-9** · Un rechazo cuyo `primaryCause` no es visual narra y titula **la causa real**,
  aunque exista `visual-comparison.json` en disco. Verificable: `generateNarration` con
  `primaryCause` no-visual + contrato presente ⇒ la primera oración nombra la causa real.
- **UX-10** · Ninguna supresión de E2/E3/E4 es silenciosa en el PDF: cada una renderiza su
  banda con símbolo, etiqueta textual y motivo objetivable. Verificable en escala de
  grises: la banda sigue siendo distinguible y legible sin color.
- **UX-11** · E4 nunca puede confundirse con «sin desvíos»: la banda contiene la frase de
  desambiguación explícita y el motivo medido en bytes.
- **UX-12** · Los estados degradados aparecen también en el audio, como sufijo. Verificable:
  el `.mp3` de un rechazo con contrato `stale` menciona el descarte sin titularlo.
- **UX-13** · Ninguna banda degradada usa el badge `VISUAL MISMATCH`, que queda reservado
  al caso con inventario real de desvíos de la pasada actual.

## 3. Nota de diseño para `dev` (no bloqueante, alta prioridad)

El contrato es 99,8 % base64 inline. Aun implementando E4, el próximo caso choca la pared
y el operador recibe una banda roja en vez del inventario. La imagen debería viajar **por
referencia** (path bajo `qa/evidence/<issue>/`, que `safeImageSrc` ya resuelve). Coincide
con la nota de diseño que PO dejó en el cuerpo del issue.

## 4. Trazabilidad

- Mockup base: `48-rejection-visual-inventory.svg` (#5708, fase `criterios`).
- Mockup de este addendum: `49-visual-block-degraded-states.svg` (#5708, rebote `validacion`).
- Render afectado: `.pipeline/rejection-report.js` → `renderVisualComparisonBlock`,
  `loadVisualComparison`, `generateNarration`.
- Emisor afectado: `.pipeline/pulpo.js` → bloque `if (data.resultado === 'rechazado')`.
- Doc a actualizar por dev: `docs/pipeline/visual-validation.md` (§ estados degradados, nueva).
