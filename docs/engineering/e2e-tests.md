# Tests E2E (End-to-End)

## Infraestructura

Los tests E2E validan flujos completos de usuario contra el servidor Ktor, usando componentes reales con dependencias externas mockeadas.

### Componentes clave

| Componente | Ubicación | Descripción |
|-----------|-----------|-------------|
| `JwtValidator` | `backend/.../JwtValidator.kt` | Interfaz para validación de JWT |
| `LocalJwtValidator` | `users/src/test/.../LocalJwtValidator.kt` | Implementación de test que genera/valida JWT localmente |
| `E2ETestBase` | `users/src/test/.../E2ETestBase.kt` | Clase base abstracta para todos los tests E2E |
| `InMemoryDynamoDbTable` | `users/src/test/...` | Tabla DynamoDB en memoria para tests |

### Arquitectura

```
E2ETestBase
├── LocalJwtValidator      → JWT sin Cognito real
├── InMemoryDynamoDbTable   → DynamoDB sin AWS real
├── MockK CognitoClient    → Cognito mockeado
└── DI Module (Kodein)      → Wiring completo de funciones
```

Cada test extiende `E2ETestBase` y usa `e2eTest { client -> ... }` para levantar el servidor con DI configurada.

## Funciones cubiertas

### Fase 1 — Flujos principales
- **SignUp + SignIn** (`E2ESignUpSignInTest`): registro de usuario y login.
- **ChangePassword** (`E2EChangePasswordTest`): cambio de contraseña autenticado.
- **2FA Setup + Verify** (`E2ETwoFactorTest`): configuración y verificación TOTP.
- **RegisterBusiness** (`E2EBusinessRegistrationTest`): registro de negocio.
- **ReviewBusinessRegistration** (`E2EReviewBusinessRegistrationTest`): aprobación/rechazo de negocios.

### Fase 2 — Funciones adicionales
- **AssignProfile** (`E2EAssignProfileTest`): asignación de perfiles a usuarios.
- **RegisterSaler** (`E2ERegisterSalerTest`): registro de vendedores.
- **RequestJoinBusiness + ReviewJoinBusiness** (`E2EJoinBusinessTest`): solicitud y revisión de unión a negocio.
- **ConfigAutoAcceptDeliveries** (`E2EConfigAutoAcceptTest`): configuración de auto-aceptación de repartos.
- **ClientProfile** (`E2EClientProfileTest`): perfil de cliente (lectura y actualización).

## Ejecución

```bash
# Todos los tests E2E
./gradlew :users:test --tests "ar.com.intrale.E2E*"

# Un test E2E específico
./gradlew :users:test --tests "ar.com.intrale.E2ESignUpSignInTest"

# Un método específico
./gradlew :users:test --tests "ar.com.intrale.E2ETwoFactorTest.setup y verificacion TOTP completa"
```

## Cómo agregar un nuevo test E2E

### 1. Crear la clase

```kotlin
class E2ENuevoFlujoTest : E2ETestBase() {

    @Test
    fun `descripcion del flujo en espanol`() = e2eTest { client ->
        // Arrange: seed de datos
        seedBusiness("miNegocio")
        val email = "user@test.com"
        configureCognitoGetUser(email)

        // Act: llamadas HTTP
        val response = client.post("/miNegocio/nuevaFuncion") {
            header("Authorization", "Bearer ${tokenFor(email)}")
            contentType(ContentType.Application.Json)
            setBody("""{"campo": "valor"}""")
        }

        // Assert
        assertEquals(HttpStatusCode.OK, response.status)
    }
}
```

### 2. Registrar la función en `e2eModule()`

Si la función no está registrada en `E2ETestBase.e2eModule()`, agregarla:

```kotlin
bind<Function>(tag = "nuevaFuncion") {
    singleton { NuevaFuncion(instance(), instance(), instance()) }
}
```

### 3. Helpers disponibles

| Helper | Descripción |
|--------|-------------|
| `seedBusiness(name, ...)` | Crear negocio en tabla in-memory |
| `seedPlatformAdmin(email, business)` | Crear perfil de admin de plataforma |
| `seedBusinessAdmin(email, business)` | Crear perfil de admin de negocio |
| `seedClientProfile(email, business, profile)` | Crear perfil de cliente |
| `tokenFor(email)` | Generar JWT válido para el email |
| `configureCognitoGetUser(email)` | Configurar mock de Cognito `getUser` |
| `resetTables()` | Limpiar todas las tablas in-memory |
