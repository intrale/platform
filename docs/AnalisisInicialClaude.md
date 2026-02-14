# Analisis Inicial del Proyecto — Claude Code

Fecha: 2026-02-14
Puntaje general: **7/10**

Buena base arquitectonica, tooling destacado (KSP processor, icon automation), con gaps operacionales que deben resolverse antes de escalar como marca blanca.

---

## Resumen ejecutivo

| Area | Puntaje | Estado |
|------|---------|--------|
| Arquitectura App | 8/10 | Capas limpias, algo de sobre-ingenieria |
| Arquitectura Backend | 7/10 | Patron funcional solido, falta abstraccion |
| KSP Forbidden Strings | 10/10 | Herramienta de clase mundial |
| Automatizacion de iconos | 9/10 | Base64 a 3 plataformas automatico |
| Resource validation | 9/10 | Previene crashes en produccion |
| Multiplataforma | 9/10 | Excelente uso de expect/actual |
| Clean architecture (app) | 8/10 | Separacion asdo/ext/ui clara |
| Product flavors | 8/10 | client/business/delivery con slugs |
| fb() resilience | 9/10 | Fallbacks ASCII-safe |
| init.sh onboarding | 9/10 | Automatizado con validacion |
| Testeabilidad | 4/10 | Buena estructura, poca cobertura |
| CI/CD | 2/10 | Solo deploy, sin validacion de PRs |
| .gitignore | 1/10 | Criticamente incompleto |
| White-label theming | 3/10 | No implementado |

---

## CRITICO — Resolver inmediatamente

### 1. `.gitignore` incompleto

**Estado: RESUELTO en PR inicial**

El `.gitignore` original tenia solo 7 lineas (solo iconos de branding). Faltaban patrones para `build/`, `.gradle/`, `.idea/`, `local.properties`, `*.log`, `node_modules/`, etc. El `git status` mostraba 15+ carpetas untracked que podrian commitearse accidentalmente.

### 2. No hay CI para PRs

**Estado: RESUELTO en PR inicial**

Solo existia `.github/workflows/main.yml` que hace deploy a Lambda en push a `main`. No habia validacion de PRs — se podian mergear cambios rotos sin correr tests ni `verifyNoLegacyStrings`. Se creo `pr-checks.yml` que valida en cada PR a `main` y `develop`.

### 3. DynamoDB full table scans (12+ ocurrencias)

**Estado: PENDIENTE**

Cada request al backend escanea tablas completas (`scan()` en vez de `query()`). Sin GSIs (Global Secondary Indexes), esto es O(n) por request. Con 10k+ registros el sistema se degrada severamente.

**Archivos afectados:**
- `users/src/main/kotlin/ar/com/intrale/UsersConfig.kt:18`
- `users/src/main/kotlin/ar/com/intrale/SignIn.kt:130`
- `users/src/main/kotlin/ar/com/intrale/ReviewBusinessRegistration.kt:77-90`
- `users/src/main/kotlin/ar/com/intrale/AssignProfile.kt`
- `users/src/main/kotlin/ar/com/intrale/RegisterSaler.kt`
- `users/src/main/kotlin/ar/com/intrale/ReviewJoinBusiness.kt`
- Y 6+ mas

**Solucion:**
- Agregar GSI en `email` para tabla `UserBusinessProfile`
- Agregar GSI en `publicId` para tabla `Business`
- Reemplazar todos los `.scan()` con `.query()`
- Implementar patron repository
- Cachear lista de businesses al inicio del Lambda

### 4. `println()` en codigo de seguridad

**Estado: RESUELTO en PR inicial**

`SecuredFunction.kt` usaba `println()` en lineas 47, 54, 60 — potencialmente exponiendo informacion de tokens en logs de produccion. Reemplazado por `logger.warn()`.

### 5. Codigo inalcanzable eliminado

**Estado: RESUELTO en PR inicial**

`SecuredFunction.kt` tenia un bloque `//TODO: Returning nothing` (lineas 64-66) que nunca se ejecutaba porque todos los paths retornan antes. Eliminado.

### 6. Secrets en `application.conf`

**Estado: PENDIENTE**

Credenciales como placeholders en archivos de configuracion. El CI usa `sed` para inyectar secrets, lo cual es fragil. Deberian migrarse a AWS Secrets Manager.

**Archivos:** `users/src/main/resources/application.conf`, `users/src/main/kotlin/ar/com/intrale/Modules.kt`

---

## ALTA PRIORIDAD — Proximo sprint

### 7. `DIManager.kt` es un monolito

**Archivo:** `app/composeApp/src/commonMain/kotlin/DIManager.kt`
**Tamano:** 438 lineas, 95+ bindings

Todo el DI del app esta en un solo archivo. Deberia dividirse en modulos de Kodein por feature:

```kotlin
val authModule = DI.Module("auth") {
    bindSingleton<CommLoginService> { ClientLoginService(instance()) }
    bindSingleton<ToDoLogin> { DoLogin(instance(), instance()) }
    // ...
}

val businessModule = DI.Module("business") {
    // bindings de negocio
}

var di = DI {
    import(authModule)
    import(businessModule)
    import(clientModule)
    import(deliveryModule)
    import(screensModule)
}
```

### 8. Duplicacion de codigo en backend (40-50% reducible)

| Patron duplicado | Ocurrencias | Archivos |
|---|---|---|
| Logica de validacion de request | 12 | SignIn, ChangePassword, RegisterBusiness, etc. |
| Chequeo de admin autorizacion | 5 | AssignProfile, ReviewJoinBusiness, ConfigAutoAcceptDeliveries, etc. |
| Creacion de usuario Cognito | 4 | SignUp, SignUpDelivery, RegisterSaler, ReviewBusinessRegistration |
| Validacion de email (regex) | 8 | Multiples funciones de signup/registro |
| Chequeo body vacio | 15+ | Casi todas las funciones |
| Extraccion de token | 10+ | Todas las funciones secured |

**Solucion propuesta:**

```kotlin
// Base class con validacion
abstract class ValidatedFunction<Req : Any>(
    open val config: Config,
    open val logger: Logger
) : Function {
    abstract fun validationRules(): Validation<Req>
    abstract suspend fun executeValidated(
        business: String, function: String,
        headers: Map<String, String>, body: Req
    ): Response
}

// Servicio de autorizacion centralizado
class AuthorizationService(cognito, tableProfiles) {
    suspend fun getCurrentEmail(headers: Map<String, String>): Result<String>
    suspend fun requireProfile(email: String, business: String, profile: String): Result<Unit>
    suspend fun requireBusinessAdmin(email: String, business: String): Result<Unit>
}

// Servicio de Cognito centralizado
class CognitoUserService(cognito, config) {
    suspend fun createUserIfNotExists(email: String): Result<Unit>
    suspend fun signIn(email: String, password: String): Result<AuthTokens>
}

// Validaciones compartidas
object ValidationPatterns {
    val EMAIL = pattern(".+@.+\\..+") hint "Email format"
    val DECISION = pattern(Regex("^(APPROVED|REJECTED)$", RegexOption.IGNORE_CASE))
}
```

### 9. Tests deshabilitados (5 tests comentados)

Tests de integracion criticos estan comentados con TODOs:
- `users/src/test/.../SignInIntegrationTest.kt:37` — login exitoso
- `users/src/test/.../AssignProfileIntegrationTest.kt:32` — asignacion de perfil
- `users/src/test/.../ModulesTest.kt:39`
- `users/src/test/.../ReviewBusinessRegistrationIntegrationTest.kt:90`
- `users/src/test/.../ReviewJoinBusinessTest.kt:35`

### 10. Cobertura de tests del App baja (~7.5%)

17 tests para 224 archivos fuente. Distribucion actual:

| Capa | Tests | Archivos fuente | Cobertura |
|------|-------|-----------------|-----------|
| ViewModels (ui/sc) | 8 | 70 | ~11% |
| Acciones (asdo) | 1 | 58 | ~2% |
| Servicios (ext) | 1 | 60 | ~2% |
| UI/Compose | 1 instrumented | 9 cp + 6 th | ~7% |
| Utils | 3 | N/A | Buena |
| Integracion | 1 | N/A | Minima |

**Prioridad de tests:**
1. Servicios (ext) — mockear HTTP con ktor-client-mock
2. Acciones (asdo) — usar Fakes existentes
3. ViewModels restantes
4. Tests de Router/navegacion

---

## MEDIA PRIORIDAD — Proximo mes

### 11. Theming no es dinamico para white-label

**Archivo:** `app/composeApp/src/commonMain/kotlin/ui/th/Color.kt`

Los colores estan hardcodeados (primary `#415F91`). El `brandId` existe como gradle property pero no se usa para theming.

**Solucion:**
- Inyectar colores via BuildKonfig por brand
- O crear `BrandTheme` con paletas por brandId
- Usar `CompositionLocal` para proveer colores dinamicos

### 12. String Catalog sub-utilizado

La arquitectura del `StringCatalog` (con soporte para brand overrides + lang) es excelente, pero solo tiene 4 keys definidas. Necesita 50+ para ser funcional como marca blanca.

**Archivos:**
- `app/composeApp/src/commonMain/kotlin/.../strings/StringCatalog.kt`
- `app/composeApp/src/commonMain/kotlin/.../strings/StringProvider.kt`
- `app/composeApp/src/commonMain/kotlin/.../strings/StringKey.kt`

### 13. Sin rate limiting en backend

Todos los endpoints estan abiertos sin limites de requests por usuario. Critico para endpoints de autenticacion (SignIn, SignUp, PasswordRecovery).

### 14. Logging en produccion con nivel TRACE

**Archivo:** `users/src/main/resources/logback.xml`

Root level TRACE es demasiado verboso y costoso en produccion. Deberia ser INFO o WARN.

### 15. `ClientProfileRepository` usa almacenamiento in-memory

**Archivo:** `users/src/main/kotlin/ar/com/intrale/ClientProfiles.kt`

Los perfiles de cliente se pierden con cada cold start de Lambda. Deberia usar DynamoDB.

### 16. Componentes UI limitados

Solo 9 archivos en `ui/cp/` (buttons, icons, inputs, menu). Para escalar como marca blanca se necesitan:
- Card, Dialog, List components
- Loading states
- Empty states
- Error states

---

## BAJA PRIORIDAD — Mejoras a largo plazo

### 17. Navegacion sin type-safety

Las rutas son strings. Considerar Compose Destinations o navigation type-safe de Compose 2.8+.

### 18. Capa de acciones (asdo) demasiado fina

Muchas acciones son pass-throughs simples (ej: `DoCreateProduct` es solo 14 lineas). Las interfaces `ToDo*` agregan overhead de mantenimiento con beneficio limitado.

### 19. No hay soporte offline

No hay base de datos local (SQLDelight/Room). Todas las operaciones requieren conectividad.

### 20. OpenAPI spec incompleta

**Archivo:** `users/src/main/resources/openapi.yaml`

Solo documenta el endpoint de health. Los 20 endpoints de negocio no estan documentados.

### 21. Sin audit logging

No se registran cambios de estado de negocio (aprobaciones, rechazos, asignaciones de perfil). Importante para compliance.

### 22. Consolidar serialization

El backend usa Gson mientras el app usa kotlinx-serialization. Consolidar en kotlinx-serialization para consistencia.

---

## Fortalezas destacadas

### KSP Forbidden Strings Processor (10/10)

Herramienta de analisis estatico en compile-time que bloquea APIs legacy de strings. Incluye:
- Scanner de 415 lineas con resolucion de imports
- Codemod automatico de migracion (392 lineas)
- Tests comprensivos
- Configuracion flexible (excluir tests)

### Sistema de iconos automatizado (9/10)

Icons almacenados como Base64 en `docs/branding/icon-pack/`. Task `syncBrandingIcons` genera automaticamente:
- Android: 5 niveles de DPI (hdpi, mdpi, xhdpi, xxhdpi, xxxhdpi)
- iOS: Assets.xcassets
- Web/Wasm: recursos estaticos

### Resource Pack Validator (9/10)

Valida bundles `.cvr` de Compose Resources contra:
- Encoding Base64 valido
- Contenido UTF-8 decodificable
- Sin caracteres de control invalidos
- Deteccion de Base64 doblemente encodado

### Sistema de resiliencia fb() (9/10)

Helper `fb()` convierte texto a ASCII-safe para fallbacks. Task `scanNonAsciiFallbacks` valida que todos los fallbacks sean ASCII puros. `resString()` captura excepciones de decode y retorna fallback con prefijo `RES_ERROR_PREFIX`.

### Multiplataforma excelente (9/10)

Codigo platform-specific minimo:
- Android: 6 archivos (MainActivity, Platform, Icon, ResStrings, Preview)
- iOS: 6 archivos (MainViewController, Platform, Icon, ResStrings)
- Desktop: 6 archivos (main, Platform, Icon, ResStrings)
- Wasm: 5 archivos (main, Platform, Icon, ResStrings)

---

## Roadmap sugerido

```
SEMANA 1:  .gitignore + CI para PRs + fix println + codigo inalcanzable  [HECHO]
SEMANA 2:  Modularizar DIManager + fix DynamoDB scans (GSIs)
SEMANA 3:  Sistema de colores por brand + expandir StringCatalog
SEMANA 4:  Documentacion white-label + script scaffolding nueva marca
MES 2:     Rate limiting + audit logging + subir cobertura tests a 40%+
MES 3:     CI multiplataforma (Android/iOS/Web) + gestion de artifacts
MES 4:     Repository pattern backend + Secrets Manager + logback prod
MES 5:     Soporte offline + componentes UI adicionales
MES 6:     OpenAPI completa + navegacion type-safe + consolidar serialization
```

---

## Metricas del proyecto

### App Module
| Metrica | Valor |
|---------|-------|
| Archivos Kotlin (commonMain) | 224 |
| Pantallas | 31 |
| ViewModels | 24 |
| Servicios (ext) | 60 |
| Acciones (asdo) | 58 |
| Componentes (cp) | 9 |
| Tests | 17 + 1 instrumented |

### Backend + Users Modules
| Metrica | Valor |
|---------|-------|
| Archivos fuente (backend) | 13 |
| Archivos fuente (users) | 52 |
| Funciones de negocio | 20 |
| Request/Response models | 19 |
| Tests (backend) | 12 |
| Tests (users) | 58 |
| Tests comentados | 5 |
| DynamoDB scans | 12+ |
| println en seguridad | 3 (resuelto) |
| Codigo inalcanzable | 4 (1 resuelto) |

### Build & Tooling
| Metrica | Valor |
|---------|-------|
| Kotlin | 2.2.21 |
| Java | 21 |
| Gradle | 8.13 |
| Compose Multiplatform | 1.8.2 |
| Ktor | 2.3.9 / 3.0.0-wasm2 |
| Product flavors | 3 (client, business, delivery) |
| Plataformas target | 4 (Android, iOS, Desktop, Web) |
| Custom Gradle tasks | 4 |
| CI workflows | 2 (deploy + pr-checks) |
