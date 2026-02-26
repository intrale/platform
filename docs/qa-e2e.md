# QA E2E — Tests de extremo a extremo

## Resumen

El modulo `qa/` contiene tests E2E que se ejecutan contra un entorno real (backend Ktor + DynamoDB local + Moto/Cognito). A diferencia de los tests unitarios (que mockean dependencias), estos tests validan flujos completos tal como los experimenta un usuario.

## Arquitectura

### Niveles de testing E2E

| Nivel | Plataforma | Herramienta | Estado | Comando |
|-------|-----------|-------------|--------|---------|
| 1 | API | Playwright (HTTP client) | Implementado | `/qa api` |
| 2 | Desktop/JVM | compose.uiTest | Implementado | `/qa desktop` |
| 3 | Android | Maestro | Implementado | `/qa android` |

### Por que Playwright como HTTP client?

Compose Multiplatform con target `wasmJs` renderiza dentro de un `<canvas>` HTML, no genera DOM accesible. Playwright no puede interactuar con selectores CSS/XPath contra la UI web. Por eso el nivel 1 usa Playwright como HTTP client nativo contra los endpoints del backend.

### testTags para UI testing

Los componentes Compose tienen `testTag` configurados para que compose.uiTest y Maestro puedan encontrar los elementos:

| Componente | testTag | Descripcion |
|-----------|---------|-------------|
| `TextField` | `field_{labelText}` | Tag dinamico basado en el label |
| `IntralePrimaryButton` | `btn_primary` | Tag fijo para boton primario |
| `Login` screen | `login_screen` | Tag fijo para pantalla de login |
| `SignUpScreen` | `signup_screen` | Tag fijo para pantalla de registro |

- **compose.uiTest** usa `onNodeWithTag("field_Username")` para encontrar nodos
- **Maestro** usa `id: "field_Username"` en selectores YAML

## Estructura del modulo

```
qa/
├── build.gradle.kts                    # JVM + Playwright + JUnit 5
├── scripts/
│   ├── qa-env-up.sh                    # Levantar entorno completo
│   ├── qa-env-down.sh                  # Tirar abajo entorno
│   └── qa-android.sh                   # Build APK + Maestro tests
├── recordings/                         # Videos/traces (gitignored)
└── src/test/kotlin/ar/com/intrale/e2e/
    ├── QATestBase.kt                   # Base class con lifecycle Playwright
    └── api/
        ├── ApiHealthE2ETest.kt         # Health + routing basico
        ├── ApiSignInE2ETest.kt         # Login con credenciales seed
        ├── ApiSignUpE2ETest.kt         # Registro de usuario nuevo
        ├── ApiProfilesE2ETest.kt       # Profiles (SecuredFunction, JWT)
        ├── ApiPasswordRecoveryE2ETest.kt # Recovery + confirm password
        └── ApiBusinessE2ETest.kt       # SearchBusinesses + RegisterBusiness

.maestro/
├── config.yaml                         # Config global Maestro (appId)
└── flows/
    ├── login.yaml                      # Flujo: login con credenciales
    ├── signup.yaml                     # Flujo: registro basico
    └── navigation.yaml                 # Flujo: navegacion entre pantallas

app/composeApp/src/desktopTest/kotlin/ui/sc/
├── auth/
│   └── LoginScreenUiTest.kt           # Tests UI: campos login, testTags
└── signup/
    └── SignUpScreenUiTest.kt           # Tests UI: campo email, boton
```

## Como correr los tests

### Requisitos previos

- Docker Desktop corriendo (solo para nivel 1)
- JDK 21 (Temurin)
- Playwright browsers instalados (`npx playwright install chromium`) — solo nivel 1
- Emulador Android + Maestro — solo nivel 3

### Opcion 1: Con el agente /qa (recomendado)

```
/qa api        # Nivel 1: tests HTTP contra backend real
/qa desktop    # Nivel 2: tests UI con compose.uiTest
/qa android    # Nivel 3: tests con Maestro en emulador
/qa all        # Los 3 niveles en secuencia
```

El agente se encarga de levantar el entorno, correr tests, analizar resultados y limpiar.

### Opcion 2: Manual

```bash
# Nivel 1: API
./qa/scripts/qa-env-up.sh
export JAVA_HOME="/c/Users/Administrator/.jdks/temurin-21.0.7"
export QA_BASE_URL="http://localhost:80"
./gradlew :qa:test
./qa/scripts/qa-env-down.sh

# Nivel 2: Desktop UI
./gradlew :app:composeApp:desktopTest

# Nivel 3: Android (requiere emulador + Maestro)
bash qa/scripts/qa-android.sh
```

### Opcion 3: En CI (automatico)

El job `e2e-qa` en `.github/workflows/pr-checks.yml` corre automaticamente para el nivel 1 (API) cuando hay cambios en backend, users o archivos compartidos.

Los niveles 2 y 3 no corren en CI actualmente:
- Desktop: podria agregarse, pero requiere headless display
- Android: requiere emulador, lento y fragil en CI

## Entorno de tests

Los tests de nivel 1 usan los mismos servicios Docker que el desarrollo local:

- **DynamoDB Local** (puerto 8000) — tablas: business, users, userbusinessprofile
- **Moto** (puerto 5050) — mock de Cognito
- **Backend Ktor** (puerto 8080) — :users:run con variables de entorno locales

### Datos seed

| Entidad | Datos |
|---------|-------|
| Business | `intrale` (APPROVED) |
| Usuario | `admin@intrale.com` / `Admin1234!` (password temporal) |
| Perfil | `admin@intrale.com#intrale#DEFAULT` (APPROVED) |

## Tests API (Nivel 1) — Endpoints cubiertos

| Test Class | Endpoints | Tests |
|-----------|----------|-------|
| ApiHealthE2ETest | signin, rutas inexistentes, raiz | 3 |
| ApiSignInE2ETest | signin (OK, sin body, password incorrecto, email inexistente) | 4 |
| ApiSignUpE2ETest | signup (OK, duplicado, sin body, email invalido) | 4 |
| ApiProfilesE2ETest | profiles (sin token, token invalido, business inexistente) | 3 |
| ApiPasswordRecoveryE2ETest | recovery, confirm (OK, sin body, codigo invalido) | 4 |
| ApiBusinessE2ETest | searchBusinesses, registerBusiness (OK, filtro, sin body) | 5 |

**Total: 23 tests API**

## Variables de entorno

| Variable | Default | Descripcion |
|----------|---------|-------------|
| `QA_BASE_URL` | `http://localhost:80` | URL base del backend |
| `RECORDINGS_DIR` | `qa/recordings/` | Directorio para videos |

## Integracion con delivery

El skill `/delivery` verifica si hay resultados QA recientes antes de crear un PR. Si no hay tests E2E ejecutados en las ultimas 2 horas, **bloquea** la creacion del PR hasta que el usuario confirme explicitamente que quiere saltear QA.

## Agregar nuevos tests

### Nivel 1 (API)
1. Crear clase en `qa/src/test/kotlin/ar/com/intrale/e2e/api/`
2. Extender `QATestBase` para obtener `apiContext` y `logger`
3. Usar `apiContext.get()` / `apiContext.post()` para llamadas HTTP
4. Nombres de test: backtick descriptivo en espanol
5. Verificar que compila: `./gradlew :qa:compileTestKotlin`

### Nivel 2 (Desktop UI)
1. Crear clase en `app/composeApp/src/desktopTest/kotlin/ui/sc/`
2. Usar `runComposeUiTest { setContent { ... } }` para montar componentes
3. Buscar nodos con `onNodeWithTag()` usando los testTags definidos
4. Verificar que compila: `./gradlew :app:composeApp:desktopTest`

### Nivel 3 (Android)
1. Crear flow YAML en `.maestro/flows/`
2. Usar `id: "tag_name"` para encontrar elementos por testTag
3. Probar localmente: `maestro test .maestro/flows/nuevo-flow.yaml`

## Evidencias historicas

Las evidencias de cada ejecucion QA se persisten en `qa/evidence/` para consulta permanente, evitando depender de artifacts de CI que expiran a los 14 dias.

### Estructura

```
qa/evidence/
├── 2026-02-25_14-30/          # Run con timestamp
│   ├── summary.md             # Tabla de resultados (tests/passed/failed/skipped)
│   ├── api/
│   │   ├── html/              # Reporte HTML de Gradle (index.html)
│   │   ├── junit/             # Archivos JUnit XML
│   │   ├── traces/            # Traces Playwright (.zip)
│   │   └── screenshots/       # Screenshots (.png)
│   ├── desktop/
│   │   └── html/              # Reporte desktopTest (si existe)
│   └── android/
│       ├── maestro-results.xml
│       └── maestro-output.log
├── latest/                    # Copia del ultimo run (sin symlinks, compatible Windows)
└── .gitkeep
```

### Navegar el reporte

Abrir `qa/evidence/latest/api/html/index.html` en un navegador para ver el reporte HTML con el detalle de cada test (passed/failed, duracion, stack traces).

### Uso local

Despues de correr tests (ej: `/qa api`), ejecutar:

```bash
bash qa/scripts/collect-evidence.sh
```

Opciones:
- `--dry-run` — muestra que archivos copiaria sin ejecutar nada

El script detecta automaticamente que niveles tienen resultados (API, Desktop, Android) y solo recolecta lo que exista.

### En CI

El job `e2e-qa` en `pr-checks.yml` ejecuta `collect-evidence.sh` automaticamente despues de los tests y commitea las evidencias a la rama del PR. Esto permite:

- Ver el historial de evidencias directamente en el repo
- Comparar resultados entre distintas ejecuciones
- Consultar reportes sin depender de artifacts temporales

### Artifacts de CI

Los artifacts de CI (`qa-e2e-reports`, `qa-e2e-recordings`) siguen disponibles durante 14 dias para archivos grandes como videos. Las evidencias versionadas en `qa/evidence/` son complementarias.

## Limitaciones conocidas

- **No hay tests de UI web**: Compose Wasm renderiza en canvas, inaccesible para Playwright
- **iOS diferido**: requiere Xcode + macOS runner
- **Android requiere setup local**: emulador + Maestro, no corre en CI
- Los tests API corren **solo cuando se invoca explicitamente** (`:qa:test`), no con `./gradlew check`
- Los tests desktop UI corren con `:app:composeApp:desktopTest` (incluido en `check`)
