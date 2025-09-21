# Arquitectura Técnica - Módulo `backend`

El proyecto se organiza como un conjunto de módulos Gradle. El módulo `backend` provee la infraestructura común para exponer funciones HTTP o serverless y es utilizado por los módulos de negocio.

## 1. Propósito del módulo

`backend` constituye el núcleo funcional y arquitectónico del sistema. Sirve como base para los demás módulos (por ejemplo, `users`) y está construido en Kotlin con Ktor. Soporta ejecución embebida y en AWS Lambda.

## 2. Tecnologías y frameworks

- **Ktor**: construcción del servidor HTTP y APIs.
- **Kodein DI**: inyección de dependencias para registrar funciones de negocio.
- **Gson**: serialización y deserialización JSON.
- **AWS Cognito**: validación de tokens JWT.
- **AWS Lambda**: ejecución serverless.

## 3. Flujo de arranque

`Application.kt` expone un `embeddedServer(Netty)` que importa el módulo de dependencias recibido, expone `/health` y registra las rutas de negocio. La aplicación también declara un `options { ... }` global para habilitar CORS con los encabezados utilizados por los clientes móviles y web.

```kotlin
fun start(appModule: DI.Module) {
    embeddedServer(Netty) {
        di { import(appModule) }
        healthRoute()
        routing { ... }
    }.start(wait = true)
}
```

Cuando se despliega en AWS, `LambdaRequestHandler` reutiliza exactamente la misma configuración para manejar eventos API Gateway.

## 4. Ruta dinámica `/{business}/{function}`

Toda llamada de negocio se canaliza a través de `post("/{business}/{function}")`:

1. Obtiene `business` y `function` desde la URL y valida que no sean nulos.
2. Recupera la implementación de `Config` desde DI para validar que el negocio exista. `UsersConfig` arma el conjunto desde DynamoDB y siempre incluye `intrale`, por lo que sólo se aceptan rutas activas (`/{business}/...`).
3. Construye un `Map<String, String>` con todos los headers y captura el cuerpo como texto.
4. Resuelve la implementación de `Function` registrada con la misma etiqueta que llegó en `function` (por ejemplo, `changePassword`, `recovery`, `2fasetup`).
5. Ejecuta la función y serializa la respuesta con Gson, respetando el `HttpStatusCode` que expone cada instancia de `Response`.

Si el nombre de función no está registrado o el negocio no es válido, el servidor responde con `ExceptionResponse` y un status acorde (`400` o `404`).

## 5. Contratos de ejecución

```kotlin
interface Function {
    suspend fun execute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response
}
```

Las operaciones que requieren autenticación extienden `SecuredFunction`. Esta clase se encarga de:

- Leer el header `Authorization`.
- Descargar y cachear el JWKS de Cognito.
- Validar firma, `token_use == "access"` y `client_id`.
- Retornar `UnauthorizedException` cuando el token es inválido.

Sólo cuando el token pasa las verificaciones se invoca `securedExecute`, donde cada caso de uso implementa su lógica.

## 6. Serialización de respuestas

`Response` encapsula el `HttpStatusCode` que se envía al cliente. Las clases concretas agregan datos cuando es necesario:

- `Response()` → 200 OK sin cuerpo adicional.
- `RequestValidationException` → 400 con mensaje descriptivo.
- `UnauthorizedException` → 401 cuando Cognito rechaza el token.
- `ExceptionResponse` → 5xx con detalle del error.

El cliente (por ejemplo la app Compose) recibe un JSON con la estructura `{"statusCode":{"value":200,"description":"OK"}}` y aplica su propio modelado (`StatusCodeDTO`).

## 7. Registro de funciones

Los módulos de negocio aportan implementaciones vía Kodein. `users/Modules.kt` asocia etiquetas como `changePassword`, `recovery`, `2fasetup` o `searchBusinesses` a sus clases concretas. Gracias a esto el backend puede enrutar dinámicamente nuevas capacidades sin tocar `Application.kt`.

## 8. Ejecución en ambientes

- **Modo local**: `./gradlew :backend:run` inicia el servidor Netty para pruebas locales.
- **Modo AWS Lambda**: `LambdaRequestHandler` adapta las mismas funciones a eventos de API Gateway sin duplicar lógica.

De esta forma el módulo `backend` queda enfocado en la orquestación, seguridad y serialización mientras las funciones de negocio permanecen aisladas en sus propios módulos.
