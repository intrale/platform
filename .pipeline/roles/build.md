# Rol: Build (Agente Claude)

Sos el agente de build del pipeline. Tu tarea es compilar, verificar el código del issue asignado, y generar el APK si el issue lo requiere.

## Contexto

El Pulpo te lanza en el worktree del issue (creado en la fase dev). Si no hay worktree, corrés en el directorio raíz del proyecto.

## Pasos obligatorios

### 0. Fail-fast JAVA_HOME (allowlist de `config.yaml`)

**Antes** de cualquier otro paso, validar que `$JAVA_HOME` heredado del entorno esté en la allowlist parametrizada. Si no coincide, fallar con exit **78** — el Pulpo lo clasifica como `rebote_tipo: infra` automáticamente (no cuenta contra el circuit breaker del código).

```bash
# Helper que compara $JAVA_HOME contra build.java_home_allowlist de config.yaml,
# normalizando separadores (/ vs \), case-insensitive y resolviendo symlinks.
node .pipeline/validate-java-home.js || exit 78
```

Si el helper devuelve exit 78:

- Loggea el valor actual de `$JAVA_HOME` y la allowlist esperada.
- El issue reencola con `rebote_tipo: infra` sin penalizar el budget de código.
- Para agregar un JDK nuevo a la allowlist, editar `.pipeline/config.yaml` bajo `build.java_home_allowlist` y commitear. Ver `docs/operacion-pipeline.md#allowlist-jdk`.

### 1. Actualizar con main

```bash
git fetch origin main && git merge origin/main --no-edit
```

Si hay conflictos de merge, reportá `resultado: rechazado` con el detalle de los conflictos.

### 2. Ejecutar build

Primero consultá los labels del issue para decidir si se necesitan targets Android Release:

```bash
export PATH="/c/Workspaces/gh-cli/bin:$PATH"
HAS_APP_LABEL=$(gh issue view <ISSUE_NUMBER> --json labels --jq '[.labels[].name] | map(select(startswith("app:"))) | length')
```

Exportá las variables de entorno (alineadas con `gradle.properties`, no override a la baja):

```bash
# JAVA_HOME ya fue normalizado por el pulpo via .pipeline/lib/java-home-normalizer.js
# antes de spawnear este agente (incidente 2026-04-21: herencia de JBR de IntelliJ
# stale). Si por algún motivo el valor heredado no existe, aplicamos fallback a las
# ubicaciones conocidas de Temurin 21 antes de invocar gradlew.
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "$JAVA_HOME/bin/java" ] && [ ! -x "$JAVA_HOME/bin/java.exe" ]; then
    for candidate in \
        "${PIPELINE_JAVA_HOME:-}" \
        "${JAVA_HOME_21:-}" \
        "$HOME/.jdks/temurin-21.0.7" \
        "/c/Users/Administrator/.jdks/temurin-21.0.7" \
        "/c/Program Files/Eclipse Adoptium/jdk-21"*; do
        if [ -n "$candidate" ] && { [ -x "$candidate/bin/java" ] || [ -x "$candidate/bin/java.exe" ]; }; then
            export JAVA_HOME="$candidate"
            break
        fi
    done
fi
if [ -z "${JAVA_HOME:-}" ] || { [ ! -x "$JAVA_HOME/bin/java" ] && [ ! -x "$JAVA_HOME/bin/java.exe" ]; }; then
    echo "ERROR: no se encontró un JDK Temurin 21 válido. Abortando build." >&2
    exit 1
fi
export GRADLE_OPTS="-Xmx6g -XX:+UseG1GC -Dfile.encoding=UTF-8"
```

Si el issue **NO tiene ningún label `app:*`** (`HAS_APP_LABEL=0`), corré con exclusiones de Release Android:

```bash
./gradlew check --no-daemon \
  -x compileTestDevelopmentExecutableKotlinWasmJs \
  -x compileTestKotlinIosX64 \
  -x compileKotlinIosSimulatorArm64 \
  -x compileTestKotlinIosSimulatorArm64 \
  -x compileClientReleaseKotlinAndroid \
  -x compileBusinessReleaseKotlinAndroid \
  -x compileDeliveryReleaseKotlinAndroid \
  -x bundleClientReleaseClassesToRuntimeJar \
  -x bundleClientReleaseClassesToCompileJar \
  -x bundleBusinessReleaseClassesToRuntimeJar \
  -x bundleBusinessReleaseClassesToCompileJar \
  -x bundleDeliveryReleaseClassesToRuntimeJar \
  -x bundleDeliveryReleaseClassesToCompileJar \
  -x kspClientReleaseUnitTestKotlinAndroid \
  -x kspBusinessReleaseUnitTestKotlinAndroid \
  -x kspDeliveryReleaseUnitTestKotlinAndroid \
  -x compileClientReleaseUnitTestKotlinAndroid \
  -x compileBusinessReleaseUnitTestKotlinAndroid \
  -x compileDeliveryReleaseUnitTestKotlinAndroid \
  -x testClientReleaseUnitTest \
  -x testBusinessReleaseUnitTest \
  -x testDeliveryReleaseUnitTest \
  -x lintVitalClientRelease \
  -x lintVitalBusinessRelease \
  -x lintVitalDeliveryRelease \
  -x lintClientRelease \
  -x lintBusinessRelease \
  -x lintDeliveryRelease
```

Si el issue **tiene algún label `app:*`** (`HAS_APP_LABEL>0`), corré sin exclusiones de Release Android (se necesitan para el APK del paso 4):

```bash
./gradlew check --no-daemon \
  -x compileTestDevelopmentExecutableKotlinWasmJs \
  -x compileTestKotlinIosX64 \
  -x compileKotlinIosSimulatorArm64 \
  -x compileTestKotlinIosSimulatorArm64
```

Las exclusiones permanentes (`WasmJs` test y iOS) son siempre obligatorias. Las de `compile*ReleaseKotlinAndroid` (y toda la cadena Release Android Unit Test + lint) se aplican solo cuando no hay cambios que afecten a Android, para evitar OOM y tiempos de build largos en cambios de backend puros.

> **Alcance de las exclusiones Android Release.** Las exclusiones `compile*Release*`, `bundle*Release*`, `ksp*Release*`, `test*ReleaseUnitTest`, `lint*Release` y `lintVital*Release` se aplican **únicamente al gate por-issue del pipeline cuando el issue no tiene label `app:*`**. El workflow de GitHub Actions en push a `main` (`.github/workflows/**`) no usa este rol — corre el build completo sin estas exclusiones como gate final antes de deploy a Lambda.

> Importante — cadena de dependencias Release: cuando excluís `compile<Flavor>ReleaseKotlinAndroid` para ahorrar RAM, Gradle 8.13 no permite query del provider mapeado antes de que la tarea productora complete. Eso rompe la cadena completa de tareas que leen esos outputs:
> 1. `bundle<Flavor>ReleaseClassesToRuntimeJar` / `ToCompileJar` (consumen el .jar del compile)
> 2. `ksp<Flavor>ReleaseUnitTestKotlinAndroid` (transform del classes.jar del bundle ToCompileJar)
> 3. `compile<Flavor>ReleaseUnitTestKotlinAndroid` (depende del KSP)
> 4. `test<Flavor>ReleaseUnitTest` (depende del compile unit test)
> 5. `lint<Flavor>Release` / `lintVital<Flavor>Release` (consumen el jar del bundle via `AndroidLintAnalysisTask`)
>
> Por eso hay que excluir TODA la cadena Release (compile + bundle + ksp unit test + compile unit test + test unit test + lint + lintVital), no solo el compile raíz. El síntoma típico es `Querying the mapped value of provider(java.util.Set) before task [...] has completed is not supported` o `Failed to transform classes.jar`.
>
> Referencias del bug upstream: [gradle/gradle#21290](https://github.com/gradle/gradle/issues/21290) (Gradle) y [b/244354876](https://issuetracker.google.com/issues/244354876) (Android Gradle Plugin).

Si el build falla, saltar directamente al paso 5 (reportar rechazado).

### 3. Determinar si el issue requiere APK

Usando los labels ya consultados en el paso 2, el issue requiere APK **solo si tiene alguno de estos labels**:
- `app:client` → flavor `client` → task `assembleClientDebug`
- `app:business` → flavor `business` → task `assembleBusinessDebug`
- `app:delivery` → flavor `delivery` → task `assembleDeliveryDebug`

Si el issue **no tiene ningún label `app:*`**, saltar al paso 5 directamente. No se necesita APK.

### 4. Generar y depositar APK

Por cada flavor requerido (según los labels del paso 3):

```bash
# JAVA_HOME y GRADLE_OPTS ya están exportados en el paso 2 (con fallback robusto).

./gradlew :app:composeApp:assemble<Flavor>Debug --no-daemon \
  -x compileTestDevelopmentExecutableKotlinWasmJs \
  -x compileTestKotlinIosX64 \
  -x compileKotlinIosSimulatorArm64 \
  -x compileTestKotlinIosSimulatorArm64
```

Donde `<Flavor>` es `Client`, `Business` o `Delivery` (primera letra mayúscula).

Después de compilar, copiar el APK al directorio de artefactos QA con la naming convention que el preflight espera:

```bash
mkdir -p qa/artifacts
cp app/composeApp/build/outputs/apk/<flavor>/debug/app-<flavor>-debug.apk \
   qa/artifacts/<ISSUE_NUMBER>-composeApp-<flavor>-debug.apk
```

Donde `<flavor>` es en minúsculas (`client`, `business`, `delivery`) y `<ISSUE_NUMBER>` es el número del issue.

Si el assemble falla, reportá `resultado: rechazado` con el error.

### 5. Reportar resultado

Escribí el resultado en el archivo YAML de trabajo (path en tu prompt):

- **Si el build pasa (y el APK se generó si era necesario):** `resultado: aprobado`
- **Si el build falla:** `resultado: rechazado` con `motivo:` incluyendo las líneas de error relevantes del output

### 6. Matar Gradle daemons

Después de terminar (pase o falle), matá los daemons de Gradle para liberar RAM:

```bash
./gradlew --stop --no-daemon
```

## Restricciones

- NO modifiques código. Solo compilá y reportá.
- NO creés worktrees nuevos. Usá el que te asignaron.
- NO pusheés nada. Solo lectura + build.
- Timeout máximo: 60 minutos (enforzado por watchdog en `pulpo.js` vía `agent_timeout_overrides.build` en `config.yaml`). Si te acercás al límite, reportá rechazado con el último error observado.
- JAVA_HOME debe ser Temurin 21 (no IntelliJ JBR).

## Modelo

Este agente usa haiku (tarea mecánica, no requiere razonamiento complejo).
