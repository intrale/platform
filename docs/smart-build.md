# Build Inteligente

> Compilar solo los módulos afectados por los cambios del branch.

## Problema anterior

El CI ejecutaba `./gradlew clean build` completo en cada push y PR, recompilando **todos los módulos** sin importar qué archivos cambiaron. Un cambio en `backend/` recompilaba todo `composeApp`. El `clean` eliminaba el caché y forzaba recompilación total.

## Qué cambió

### 1. Gradle Build Cache habilitado

En `gradle.properties`:
```properties
org.gradle.caching=true
org.gradle.parallel=true
org.gradle.configuration-cache=true
```

- **Build cache**: reutiliza outputs de tasks cuyo input no cambió
- **Parallel**: ejecuta tasks independientes en paralelo
- **Configuration cache**: cachea la fase de configuración de Gradle

### 2. CI ya no ejecuta `clean`

El workflow de `main` cambió de `clean build` a solo `build`. Gradle detecta automáticamente qué tasks necesitan re-ejecutarse (up-to-date checking).

### 3. Gradle cache en GitHub Actions

Se agregó `actions/cache@v4` para persistir `~/.gradle/caches` y `~/.gradle/wrapper` entre ejecuciones. La clave se basa en el hash de los archivos de configuración Gradle.

### 4. PR workflow con path filtering

El workflow `pr-checks.yml` ahora usa `dorny/paths-filter@v3` para detectar qué archivos cambiaron y ejecutar solo los jobs relevantes:

| Job | Se ejecuta si cambia... |
|-----|------------------------|
| `verify-strings` | `app/**` o archivos compartidos |
| `check-backend` | `backend/**` o archivos compartidos |
| `check-users` | `users/**`, `backend/**` o archivos compartidos |
| `check-app` | `app/**` o archivos compartidos |
| `check-tools` | `tools/**` o archivos compartidos |

**Archivos compartidos** (disparan build completo):
- `build.gradle.kts`, `settings.gradle.kts`, `gradle.properties`
- `gradle/**`, `buildSrc/**`

**Transitividad**: `:users` depende de `:backend`, por lo que cambios en backend disparan también check de users.

**Gate final**: el job `pr-status` verifica que todos los checks hayan pasado o sido correctamente skipped. Es el único check requerido para merge.

### 5. Build de main sigue compilando todo

El workflow de `main` mantiene build completo porque el deploy a Lambda necesita el JAR `users-all.jar` que incluye backend + users.

## Script local: smart-build.sh

Para desarrollo local, `scripts/smart-build.sh` detecta módulos afectados y compila solo lo necesario.

### Uso

```bash
# Detecta cambios vs main (default)
./scripts/smart-build.sh

# Detecta cambios vs otra rama
./scripts/smart-build.sh --base develop

# Forzar build completo
./scripts/smart-build.sh --all
```

### Comportamiento

1. Compara archivos cambiados entre tu branch y la rama base
2. Determina qué módulos se ven afectados
3. Si cambió `build.gradle.kts`, `buildSrc/`, etc. → build completo
4. Si cambió `backend/` → compila `:backend:check` + `:users:check` (transitividad)
5. Si no hay cambios compilables → sale sin hacer nada

## Dependencias entre módulos

```
:users ──→ depende de ──→ :backend
:app:composeApp             (independiente)
:tools:forbidden-strings-processor  (independiente)
```

## Impacto esperado

| Escenario | Antes | Ahora |
|-----------|-------|-------|
| PR solo backend | ~8 min (todo) | ~2 min |
| PR solo app | ~8 min (todo) | ~5 min |
| PR solo docs/scripts | ~8 min (todo) | ~0 min (skip) |
| Desarrollo local | recompilación total | incremental |
