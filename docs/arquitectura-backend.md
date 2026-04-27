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

## 9. Zonas de delivery configurables (issue #2415)

El módulo `users` expone una API completa para gestionar zonas de cobertura por negocio (POLYGON o CIRCLE) con verificación point-in-polygon server-side. Coexiste con el modelo legacy `Business.deliveryZoneJson` (RADIUS / POSTAL_CODES); la migración del modelo viejo queda fuera de alcance.

### 9.1 Modelo de datos

Tabla DynamoDB `deliveryzones` con clave compuesta:

- **PK**: `businessId`
- **SK**: `zoneId` (primer uso de sort key compuesto en el proyecto)

Entidad `DeliveryZoneEntity` (`users/src/main/kotlin/ar/com/intrale/DeliveryZoneEntity.kt`):

- `type ∈ {POLYGON, CIRCLE}`
- `coordsJson` — lista `[{lat,lng}]` para POLYGON
- `boundingBoxJson` — AABB precomputado para optimizar el check
- `centerLat`, `centerLng`, `radiusMeters` — para CIRCLE
- `shippingCost`, `estimatedTimeMinutes`
- `currency` (default `ARS`)
- `name` opcional (sin tildes ni caracteres especiales)
- `createdAt`, `updatedAt` ISO-8601 UTC

Las coordenadas se truncan a **6 decimales** (~11 cm de precisión) antes de persistir, como mitigación parcial de PII y para consistencia entre clientes.

### 9.2 Endpoints

Todos bajo el ruteo dinámico `/{business}/{function...}` registrado vía Kodein:

| Endpoint | Método | Auth | Tag Kodein |
|----------|--------|------|------------|
| `/{business}/zones` | GET | Pública | `zones` |
| `/{business}/zones` | POST | JWT + `BUSINESS_ADMIN` | `zones` |
| `/{business}/zones` | DELETE | JWT + `BUSINESS_ADMIN` | `zones` |
| `/{business}/zones/check` | POST | Pública (rate-limited) | `zones/check` |

> **Nota sobre el ruteo**: el dispatcher de `Application.kt` usa hasta 2 segmentos del path como `functionKey`. Por eso el `zoneId` para DELETE viaja por el header `X-Zone-Id` en lugar de en la URL (`DELETE /{business}/zones` + `X-Zone-Id: zn_xxx`).

### 9.3 Contratos

#### POST `/{business}/zones`

Request body:

```json
{
  "type": "POLYGON",
  "shippingCost": 450.0,
  "estimatedTimeMinutes": 35,
  "name": "Centro",
  "currency": "ARS",
  "polygon": [
    { "lat": -34.605, "lng": -58.382 },
    { "lat": -34.605, "lng": -58.380 },
    { "lat": -34.603, "lng": -58.380 },
    { "lat": -34.603, "lng": -58.382 }
  ]
}
```

Para CIRCLE:

```json
{
  "type": "CIRCLE",
  "shippingCost": 200.0,
  "estimatedTimeMinutes": 20,
  "centerLat": -34.6037,
  "centerLng": -58.3816,
  "radiusMeters": 1500.0
}
```

Response 200:

```json
{
  "zoneId": "zn_a9k2m3p7x4bq",
  "zone": { ... }
}
```

#### POST `/{business}/zones/check`

Request body: `{"lat": -34.605, "lng": -58.381}`

Response cuando el punto está dentro:

```json
{
  "inZone": true,
  "shippingCost": 450.0,
  "estimatedTimeMinutes": 35,
  "zoneId": "zn_a9k2m3p7x4bq",
  "currency": "ARS"
}
```

Response cuando está fuera:

```json
{ "inZone": false, "reason": "OUT_OF_COVERAGE" }
```

Response cuando el negocio no configuró zonas:

```json
{ "inZone": false, "reason": "NO_ZONES_DEFINED" }
```

### 9.4 Validaciones server-side

- `latitude ∈ [-90, 90]`, `longitude ∈ [-180, 180]`
- `shippingCost ∈ [0, 100000]`
- `polygon.size ∈ [3, 1000]` vértices
- Polígono **simple** (sin auto-intersección) — algoritmo O(n²) par-a-par de segmentos
- Polígono **no degenerado** (área de Shoelace > 1e-9 grad²)
- `type ∈ {POLYGON, CIRCLE}`
- Para CIRCLE: `radiusMeters ∈ (0, 200000]`
- Máx **50 zonas** por negocio (consultadas vía `query` antes del insert)

Mensajes de error en español ASCII-safe (sin tildes ni ñ) — alineado con `verifyNoLegacyStrings`.

### 9.5 Algoritmos geográficos (`ar.com.intrale.geo`)

- **`PointInPolygon.contains`**: ray casting con epsilon + filtro AABB previo. Convención: punto sobre vértice/arista se considera DENTRO.
- **`PointInPolygon.isSelfIntersecting`**: comparación par-a-par de segmentos, ignorando segmentos adyacentes que comparten vértice (O(n²)).
- **`PointInPolygon.absoluteShoelaceArea`**: área absoluta usando la fórmula del shoelace.
- **`haversineMeters`**: distancia en metros entre dos puntos en grados decimales.
- **`BoundingBox.ofPolygon`** y **`ofCircle`**: AABB axis-aligned para early-exit O(1).

Implementación en Kotlin puro, **sin dependencias** (no jts, no geotools, no spatial4j).

### 9.6 Seguridad (OWASP A01, A04, A08)

- **Cross-tenant (A01)**: el `businessId` se deriva siempre del path; el JWT debe coincidir con un perfil `BUSINESS_ADMIN` aprobado para ese negocio (`requireApprovedProfile`). Los intentos cross-tenant se loguean como WARN con email + ambos businessIds.
- **DELETE seguro**: antes de borrar verifica con `getItem(Key)` que la zona pertenezca al business del path. Devuelve `404 NOT_FOUND` (sin distinguir de "no existe") si no matchea.
- **Rate limit `/zones/check` (A04)**: token bucket in-memory `ConcurrentHashMap<String, Bucket>` con capacidad **10 req/s por IP**. Las requests excedentes responden `429 TOO_MANY_REQUESTS`. **Mitigación parcial**: en AWS Lambda cada cold start resetea el estado; en producción se debe complementar con **API Gateway throttling** (historia de infra separada).
- **IP real (A04)**: se toma el **último valor** de `X-Forwarded-For` (no el primero, que es spoofeable por el cliente). El último salto lo agrega el gateway.
- **Recálculo autoritativo del costo (A08, CA-8)**: `/zones/check` es la **única fuente válida** de `shippingCost`. El flujo de checkout (historia separada) DEBE recalcular contra este endpoint y **no aceptar** el costo del cliente.
- **Sin PII de ubicación**: los logs **nunca** incluyen lat/lng del usuario final; solo `{businessId, inZone, zoneId?}`.
- **Anti-enumeration**: la respuesta `inZone:false` no revela distancia a zonas cercanas ni `zoneId` de zonas próximas. El `reason: NO_ZONES_DEFINED` es deliberado y consistente con `GET /zones` público.

### 9.7 Tests obligatorios

Cobertura ≥ 80% en los nuevos archivos, incluye:

**Funcionales**: ray casting (cuadrado, cóncavo, borde, vértice), Haversine (centro, radio exacto, fuera), CRUD completo de `ZonesFunction` con stubs de `DynamoDbTable`, `ZonesCheckFunction` con matching y no-matching.

**De seguridad**: cross-tenant POST, cross-tenant DELETE (zona NO se elimina), rate limit (10/15 → 5 rechazos), polígono bowtie auto-intersectante → 400, límite 50 zonas → 400, ray casting determinístico en borde, IP spoofing en X-Forwarded-For (rate limit usa último salto).
