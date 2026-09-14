# [ux] Validación de desarrollo — #6191

> Pasada del **09/09** sobre `HEAD = 03bb57eec` (`main`). Re-ejecutada por un **rebote de
> tipo `infra`** (`[guru] Agente terminó con código 1`, que disparó `fast-fail-rebote` y
> canceló a `po` y a `ux`), **no** por un rechazo de contenido. No había defecto que
> corregir. Como el `HEAD` cambió respecto de la pasada anterior (`0c1875873`), **todo se
> volvió a medir desde cero**: ningún número de abajo se cita de una corrida previa.

## CA-UX-5 · Contraste re-medido (encargo explícito del criterio)

Tokens leídos de `.pipeline/views/dashboard/theme.css` (`:10-14` oscuro, `:50-54` claro),
fórmula de luminancia relativa WCAG 2.1:

```
OSCURO  bg --in-bg-2 #161b22
  --in-fg-dim  #8b949e = 5,62:1   AA PASA
  --in-fg-soft #6e7681 = 3,77:1   AA NO PASA
CLARO   bg --in-bg-2 #ffffff
  --in-fg-dim  #57606a = 6,39:1   AA PASA
  --in-fg-soft #8c959f = 3,04:1   AA NO PASA
```

Las 4 cifras coinciden **exactamente** con las declaradas en el CA. Regla confirmada en
**ambos temas**: piso `--in-fg-dim`, **prohibido `--in-fg-soft`** para texto de la ficha.

## CA-7 · Baseline de no-regresión

```
$ node --test .pipeline/views/dashboard/__tests__/bloqueados.test.js \
              .pipeline/views/dashboard/__tests__/bloqueados-stats.test.js
tests 63 | pass 63 | fail 0
```

Confirma **63 pass / 0 fail**. La cifra `56` que circulaba sigue siendo incorrecta.

## CA-4 · Gap G-2 sigue vivo, y son DOS puntos

`.pipeline/lib/human-block.js` **sí** produce `precondition` (`:563/:580/:626/:633`) y
`evidence` (`:584/:628`). Los dos `map` de `.pipeline/dashboard.js` copian **12 campos**
cada uno y **ninguno los propaga**:

- `:1863-1878` — `map` principal.
- `:1885+` — `map` del bloque `catch` (fallback).

```
$ grep -n "precondition\|evidence" .pipeline/dashboard.js
249: (única línea: require de qa-evidence-seal, no relacionado)
```

Cero hits en ambos `map`. Arreglar sólo el principal deja el bug vivo en el fallback y
produce **dos fichas distintas** para el mismo bloqueo — justo lo que CA-4 prohíbe.

## CA-5 / CA-6 · Nombres reales de campo

```
keys ficha: tipo, issue, que_esta_frenado, por_que_esta_frenado, que_se_decide,
  que_se_decide_corto, opciones, evidencia_minima, costo_de_no_decidir,
  sugerencia_del_pipeline, sin_recomendacion_porque, indeterminado, falta,
  ejemplo_de_valor, pie_destrabe
opcion[0] keys: etiqueta, consecuencia, es_recomendada, razon_recomendacion
```

Los 11 campos que CA-5 manda escapar existen con **ese** nombre. Ninguna clave de
`opciones[]` es `id`/`kind`/`accion` → la decisión D-1 (**las opciones son información,
no botones**) se sostiene empíricamente.

## CA-UX-2 · Estado "cero opciones"

```
$ buildDecisionCard({ issue: 6191, reason: 'zzz-motivo-no-reconocible' })
indeterminado: true
opciones.length: 0
falta: "El motivo del bloqueo. Quien lo frenó no dejó texto; el dato está en la
        actividad reciente del issue."
```

La degradación diseñada funciona: la ficha **explica** qué falta en lugar de dejar hueco.
Renderizar `card.falta` en el lugar de las opciones es suficiente; **prohibido** redactar
un "sin opciones disponibles" local.

## CA-8 · Los mockups NO están en `main` — sigue bloqueante

```
$ git ls-tree -r origin/main --name-only -- .pipeline/assets/mockups/6191/
(vacío)

$ git ls-tree -r origin/agent/6191-ux --name-only -- .pipeline/assets/mockups/6191/
.pipeline/assets/mockups/6191/6191-00-actual-ventana-bloqueados.png
.pipeline/assets/mockups/6191/6191-01-esperado-tarjeta-decision.png
.pipeline/assets/mockups/6191/ux-criterios-6191.md
```

El worktree de `dev` nace de `origin/main` → **no los ve**. El dev tiene que traerlos a la
rama del PR. Assets verificados como entregables reales, no placeholders:

```
6191-00-actual-ventana-bloqueados.png : PNG 1240x1400 RGB · 187.137 bytes
6191-01-esperado-tarjeta-decision.png : PNG 1044x2267 RGB · 248.691 bytes
md5 36adb6b4… / 30d8874a…  (distintos entre sí)
```

## Veredicto

**Aprobado.** Los criterios UX (CA-UX-1 a CA-UX-5) están completos, numerados, sin
contradicciones y **todos verificables por test o por inspección del HTML renderizado**.
Los assets de `criterios` existen y son válidos. Nada que regenerar en este ciclo.

> **Para `aprobacion`:** este issue tiene mockup de UI versionado
> (`6191-01-esperado-tarjeta-decision.png`), así que por #4568 exige **QA visual**
> (screenshot del render real contra el mockup). Un QA estructural **no** alcanza.
