# Estrategia de Testing

## Frameworks y herramientas

| Módulo | Framework | Mocks | Entorno |
|--------|-----------|-------|---------|
| `backend` | kotlin-test + MockK | MockK 1.13.10 | JVM (runTest) |
| `users` | kotlin-test + MockK | MockK 1.13.10 | JVM (runTest) |
| `app/composeApp` | kotlin-test + Compose UI Test | Fakes manuales | commonTest → desktop JVM |

## Tipos de tests

### Unit tests
Validan lógica de negocio aislada: funciones, ViewModels, mappers, validadores.

- **Backend/Users**: se usa MockK para simular dependencias externas (Cognito, DynamoDB).
- **App**: se usan Fakes manuales (sin MockK) porque commonTest es multiplataforma.

### Integration tests
Validan la interacción entre componentes reales dentro de un módulo.

- En backend/users: tests que levantan el servidor Ktor con `testApplication` y DI real.

### E2E tests
Simulan flujos completos de usuario contra el servidor Ktor.

- Ubicados en `users/src/test/kotlin/.../E2E*.kt`.
- Usan `E2ETestBase` como clase base con tablas in-memory y JWT local.
- Ver [e2e-tests.md](e2e-tests.md) para detalle completo.

## Convenciones

### Nombres de tests
Usar backtick con descripción en español:

```kotlin
@Test
fun `loadProfile actualiza el estado con los datos del caso de uso`() = runTest { ... }
```

### Fakes
Prefijo `Fake[Interface]` para implementaciones de prueba:

```kotlin
class FakeGetProfile : ToDoGetProfile {
    var result: Result<DoGetProfileResult> = Result.success(...)
    override suspend fun execute(...) = result
}
```

### Estructura de tests
- Patrón AAA (Arrange-Act-Assert).
- `runTest` para coroutines.
- Un archivo de test por clase bajo prueba.

## Cobertura con Kover

[Kotlinx Kover](https://github.com/Kotlin/kotlinx-kover) v0.9.1 está integrado en los tres módulos principales.

### Umbrales por módulo

| Módulo | Umbral mínimo | Justificación |
|--------|---------------|---------------|
| `backend` | 80% | Lógica de negocio crítica |
| `users` | 80% | Funciones de autenticación y perfiles |
| `app/composeApp` | 5% | Baseline de visibilidad; la mayoría del código es UI |

### Configuración

Cada módulo incluye en su `build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.kover)
}

kover {
    reports {
        verify {
            rule {
                minBound(UMBRAL)
            }
        }
    }
}
```

> **Nota**: En `app/composeApp`, Kover se configura con la variante `jvm` (desktop) porque el módulo
> tiene Android product flavors que no son compatibles con la verificación genérica. Se usan los
> tasks `koverVerifyJvm` y `koverHtmlReportJvm` en lugar de los genéricos.

### Comandos

```bash
# Ejecutar tests de un módulo
./gradlew :backend:test
./gradlew :users:test
./gradlew :app:composeApp:desktopTest

# Verificar umbral de cobertura
./gradlew :backend:koverVerify
./gradlew :users:koverVerify
./gradlew :app:composeApp:koverVerifyJvm

# Generar reporte HTML (se abre en navegador)
./gradlew :backend:koverHtmlReport
./gradlew :users:koverHtmlReport
./gradlew :app:composeApp:koverHtmlReportJvm

# Verificar todo junto (backend + users)
./gradlew :backend:koverVerify :users:koverVerify :app:composeApp:koverVerifyJvm

# Test individual (ejemplo)
./gradlew :backend:test --tests "ar.com.intrale.SignInTest"
./gradlew :users:test --tests "ar.com.intrale.E2ESignUpSignInTest"
```

### Reportes

Los reportes HTML se generan en:
- `backend/build/reports/kover/html/`
- `users/build/reports/kover/html/`
- `app/composeApp/build/reports/kover/htmlJvm/`

## CI

En `pr-checks.yml`, el paso `./gradlew clean build` ejecuta automáticamente `koverVerify` como parte de `check`, lo que garantiza que los umbrales se cumplan en cada PR.
