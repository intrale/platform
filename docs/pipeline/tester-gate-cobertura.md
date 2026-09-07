# Gate de cobertura del tester determinístico

> Origen: rebote de #6362 rev-1. Implementación en
> `.pipeline/skills-deterministicos/tester.js` (`coverageGateApplies`).
> Tests: `.pipeline/tests/tester-coverage-gate.test.js`.

## El problema

El tester determinístico corre la suite Gradle + Kover y compara la cobertura
de líneas **absoluta del repo** contra `--threshold` (default **80%**).

La baseline real del producto es **~36%** (el grueso de `app/composeApp` es
Compose/Android sin tests unitarios). Consecuencia: **cualquier** diff que no
sea `pipeline_only` y produzca reporte Kover se rechazaba siempre, con
independencia de su calidad.

El síntoma es un rebote con este texto y los tests en verde:

```
Tests: 6761 total · 0 failures · 0 errors
Cobertura de líneas 36.05% por debajo del umbral 80%
```

El propio reporte del tester lo delataba: imprime
`Delta vs baseline: baseline: no disponible`. Es decir, un **umbral
aspiracional** se estaba enforzando como si fuera un **gate de regresión**.

## Por qué no alcanzaba con `PIPELINE_ONLY_PATTERNS`

Históricamente esta clase de falso rebote (#2895, #3072, #3081, #3092, #2398,
#3409, #3576, #3929, #3943, #5065) se resolvió ensanchando la allowlist de
paths `pipeline_only`, que rutea el issue a `node --test` en vez de Gradle.

Eso no aplica cuando el diff toca un **build script**. La exclusión de
`build.gradle.kts` de esa allowlist es **correcta y deliberada**: un build
script sí puede cambiar qué compila Gradle y qué instrumenta Kover. Está
protegida por el test `PIPELINE_ONLY_PATTERNS sigue rechazando
build.gradle.kts`.

## El criterio actual

El fix no cambia el ruteo, cambia la pregunta:

> no *"¿es pipeline-only?"* sino **"¿este diff puede MOVER el número de cobertura?"**

La cobertura mide fuentes Kotlin/Java. Si el diff no toca ninguna fuente ni
recurso medido, y tampoco toca construcciones del build script que alteren
compilación o instrumentación, entonces numerador y denominador de Kover son
—por construcción— **idénticos a los de `origin/main`**. Comparar ese número
contra un umbral absoluto evalúa la historia del repo, no el cambio.

`coverageGateApplies(files, buildScriptLines)` devuelve:

| Caso | ¿Gatea? |
|---|---|
| Diff toca `src/**/*.{kt,java}` (producción o test) | **Sí** |
| Diff toca `src/**/{res,resources}/**` | **Sí** |
| Diff toca un build script con tokens de compilación/instrumentación | **Sí** |
| Diff toca un build script sin esos tokens | No |
| Diff sin fuentes ni build scripts (CI, docs, `.pipeline/`) | No |
| Diff desconocido (git falló) | **Sí** (fail-closed) |
| Build script presente pero líneas ilegibles | **Sí** (fail-closed) |

Build scripts = `*.gradle(.kts)`, `gradle.properties`, `*.versions.toml`.

Los tokens que fuerzan el gate están en `COVERAGE_AFFECTING_TOKENS`
(`sourceSets`, `srcDir`, `kover`, `jacoco`, `dependencies`, `implementation`,
`plugins`, `kotlinOptions`, `excludes?`, `reports?`, …), matcheados con
**word boundaries**.

> El boundary importa: sin él, `apiKey = it` disparaba el token `api` y el gate
> se aplicaba igual. Hay un test que fija exactamente ese caso.

## Invariantes de seguridad

1. **Fail-closed en toda rama dudosa.** Si no se puede determinar el diff, se
   gatea.
2. **Sobre-matchear un token es inofensivo**: preserva el comportamiento
   actual. El único riesgo sería sub-matchear; por eso la lista es generosa.
3. **El gate no se elimina, se vuelve informativo.** La cobertura se sigue
   midiendo y publicando. Cuando no gatea, el reporte lo dice explícitamente:

   > ℹ️ **Umbral informativo, no bloqueante en esta corrida.** […]

   Degradarse en silencio es exactamente lo que hizo que este defecto viviera
   ~10 rebotes sin diagnóstico.
4. **Agregar código Kotlin sin tests sigue rebotando.** El gate clásico al 80%
   se conserva intacto para cualquier diff que toque fuentes.

## Contrato YAML

El marker del tester expone:

```yaml
tester_coverage_line_percent: 36.05
tester_coverage_threshold: 80
tester_coverage_gated: false   # nuevo (#6362)
```

- `true` → el umbral gateó (comportamiento clásico).
- `false` → se midió pero no gateó (el diff no puede moverla).
- `null` → ruta `pipeline_only`, Kover no corrió.

## Pendiente

El fix correcto de fondo es un **gate de regresión con baseline persistida**
(rechazar si la cobertura *baja* respecto del merge-base), que es lo que la
sección "Baseline y gaps" del reporte ya anticipa pero nunca se implementó.
Este criterio es el paso intermedio: deja de emitir rebotes falsos sin relajar
el gate donde sí mide algo.
