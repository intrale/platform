# QA E2E — Tests de extremo a extremo

## Resumen

El modulo `qa/` contiene tests E2E que se ejecutan contra un entorno real (backend Ktor + DynamoDB local + Moto/Cognito). A diferencia de los tests unitarios (que mockean dependencias), estos tests validan flujos completos tal como los experimenta un usuario.

## Arquitectura

### Niveles de testing E2E

| Nivel | Plataforma | Herramienta | Estado |
|-------|-----------|-------------|--------|
| 1 | API | Playwright (HTTP client) | Implementado |
| 2 | Desktop/JVM | compose.uiTest | Futuro |
| 3 | Android | Maestro | Futuro |

### Por que Playwright como HTTP client?

Compose Multiplatform con target `wasmJs` renderiza dentro de un `<canvas>` HTML, no genera DOM accesible. Playwright no puede interactuar con selectores CSS/XPath contra la UI web. Por eso el nivel 1 usa Playwright como HTTP client nativo contra los endpoints del backend.

## Estructura del modulo

```
qa/
├── build.gradle.kts                    # JVM + Playwright + JUnit 5
├── scripts/
│   ├── qa-env-up.sh                    # Levantar entorno completo
│   └── qa-env-down.sh                  # Tirar abajo entorno
├── recordings/                         # Videos/traces (gitignored)
└── src/test/kotlin/ar/com/intrale/e2e/
    ├── QATestBase.kt                   # Base class con lifecycle Playwright
    └── api/
        ├── ApiHealthE2ETest.kt         # Health + routing basico
        ├── ApiSignInE2ETest.kt         # Login con credenciales seed
        └── ApiSignUpE2ETest.kt         # Registro de usuario nuevo
```

## Como correr los tests

### Requisitos previos

- Docker Desktop corriendo
- JDK 21 (Temurin)
- Playwright browsers instalados (`npx playwright install chromium`)

### Opcion 1: Con el agente /qa (recomendado)

```
/qa api
```

El agente se encarga de levantar el entorno, correr tests, analizar resultados y limpiar.

### Opcion 2: Manual

```bash
# 1. Levantar entorno
./qa/scripts/qa-env-up.sh

# 2. Correr tests
export JAVA_HOME="/c/Users/Administrator/.jdks/temurin-21.0.7"
export QA_BASE_URL="http://localhost:80"
./gradlew :qa:test

# 3. Ver resultados
# Reportes HTML: qa/build/reports/tests/test/index.html
# Recordings: qa/recordings/

# 4. Tirar abajo
./qa/scripts/qa-env-down.sh
```

### Opcion 3: En CI (automatico)

El job `e2e-qa` en `.github/workflows/pr-checks.yml` corre automaticamente cuando hay cambios en backend, users o archivos compartidos (gradle, buildSrc, etc.).

## Entorno de tests

Los tests usan los mismos servicios Docker que el desarrollo local:

- **DynamoDB Local** (puerto 8000) — tablas: business, users, userbusinessprofile
- **Moto** (puerto 5050) — mock de Cognito
- **Backend Ktor** (puerto 8080) — :users:run con variables de entorno locales

### Datos seed

| Entidad | Datos |
|---------|-------|
| Business | `intrale` (APPROVED) |
| Usuario | `admin@intrale.com` / `Admin1234!` (password temporal) |
| Perfil | `admin@intrale.com#intrale#DEFAULT` (APPROVED) |

## Variables de entorno

| Variable | Default | Descripcion |
|----------|---------|-------------|
| `QA_BASE_URL` | `http://localhost:80` | URL base del backend |
| `RECORDINGS_DIR` | `qa/recordings/` | Directorio para videos |

## Integración con delivery

El skill `/delivery` verifica si hay resultados QA recientes antes de crear un PR. Si no hay tests E2E ejecutados en las ultimas 2 horas, advierte al usuario.

## Agregar nuevos tests

1. Crear clase en `qa/src/test/kotlin/ar/com/intrale/e2e/api/`
2. Extender `QATestBase` para obtener `apiContext` y `logger`
3. Usar `apiContext.get()` / `apiContext.post()` para llamadas HTTP
4. Nombres de test: backtick descriptivo en espanol
5. Verificar que compila: `./gradlew :qa:compileTestKotlin`

## Limitaciones conocidas

- **No hay tests de UI web**: Compose Wasm renderiza en canvas, inaccesible para Playwright
- **iOS diferido**: requiere Xcode + macOS runner
- **Android diferido**: requiere emulador + Maestro
- Los tests corren **solo cuando se invoca explicitamente** (`:qa:test`), no con `./gradlew check`
