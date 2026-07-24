# Estándar de contrato de API — Backend Ktor de Intrale

> CA-1 del issue [#4300](https://github.com/intrale/platform/issues/4300). Define el formato
> uniforme del contrato de cada endpoint (request / response / `statusCode`) alineado con el
> patrón `Response` del backend. La descripción concreta de cada endpoint **no se escribe a mano**
> en cada nota de implementación: se referencia la spec OpenAPI (`users/src/main/resources/openapi.yaml`)
> y su UI navegable en `/docs`.

## 1. Modelo de invocación

Todos los endpoints se exponen sobre una **única ruta dinámica catch-all**:

```
/{business}/{function...}
```

- `business` — identificador del tenant (multitenant). Se valida contra `Config.businesses()`.
- `function...` — clave lógica de la función (uno o dos segmentos), que resuelve el
  `bind<Function>(tag="...")` correspondiente en `users/.../Modules.kt` (fuente de verdad,
  45 endpoints).
- El **verbo HTTP real** lo resuelve el backend por el header `X-Http-Method`; el router registra
  los 4 verbos (POST/GET/PUT/DELETE) sobre el mismo path. Por eso los generadores de OpenAPI por
  introspección del árbol de rutas de Ktor **no aplican** (verían 1 endpoint genérico, no los 45).

## 2. Request

- El cuerpo llega a la función como `textBody: String` (sin tipar en el borde HTTP) —
  `Function.execute(business, function, headers, textBody)`.
- El **shape tipado** del request se declara **por endpoint en la spec OpenAPI** (`requestBody`),
  no en el borde HTTP. Cada operación documenta su `example`.
- Los headers relevantes (incluido `Authorization` para endpoints protegidos) se propagan a la
  función en el mapa `headers`.

## 3. Response — patrón `Response`

Toda función devuelve una subclase de `Response`, serializada con Gson:

```kotlin
open class Response(
    val statusCode: HttpStatusCode? = HttpStatusCode.OK,
    val responseHeaders: Map<String, String> = emptyMap()
)
```

- `statusCode` — código HTTP con que se responde (`200` por defecto).
- `responseHeaders` — headers adicionales que la función quiere emitir.
- Los errores se modelan como subclases de `Response` (p. ej. `ExceptionResponse`,
  `RequestValidationException`, `UnauthorizedException`) con su `statusCode` correspondiente.

### `statusCode` uniformes

| Código | Significado | Modelado |
|--------|-------------|----------|
| `200`  | Operación exitosa | subclase de `Response` |
| `400`  | Request inválido | `RequestValidationException` |
| `401`  | Token ausente/ inválido (endpoints `SecuredFunction`) | `UnauthorizedException` |
| `500`  | Error interno / función no encontrada / negocio inválido | `ExceptionResponse` |

## 4. Autenticación

- Los endpoints protegidos extienden `SecuredFunction`, que valida el JWT (`Authorization`)
  contra Cognito (`CognitoJwtValidator`) antes de ejecutar.
- En la spec se documentan con el esquema `bearerAuth` (`type: http`, `scheme: bearer`,
  `bearerFormat: JWT`). Los endpoints públicos no llevan `security`.

## 5. Documentación interactiva (`/docs`)

- La spec vive en `users/src/main/resources/openapi.yaml` (classpath del Lambda) y se sirve en
  `/openapi.yaml`. La UI navegable/autoprobable (Swagger UI) se sirve en `/docs`.
- **Gating (no-prod):** ambas rutas se registran sólo si el flag de entorno `API_DOCS_ENABLED`
  está activo (`1`/`true`/`yes`/`on`). En producción sin el flag, `/openapi.yaml` y `/docs`
  responden `404` a usuarios anónimos.
- **CORS:** el handler `OPTIONS` usa allowlist estricta (`CORS_ALLOWED_ORIGINS`, separada por
  comas). Nunca emite `Access-Control-Allow-Origin: *`.
- **Try It Out:** apunta por defecto al server no productivo declarado en la spec (`localhost`);
  los endpoints protegidos siguen exigiendo JWT. El token del campo *Authorize* queda sólo en
  memoria del navegador; no se persiste ni se registra en logs.
- **Swagger UI** está pinneado a una versión concreta con `Content-Security-Policy` propio.

## 6. Cómo mantener la spec sincronizada (anti-drift)

- La fuente de verdad de la **enumeración** de endpoints es `Modules.kt` (`bind<Function>(tag=...)`).
- Hay dos artefactos OpenAPI con roles distintos (ambos anclados a `Modules.kt`, no divergentes):
  - `users/src/main/resources/openapi.yaml` — **spec servida en runtime** (`/openapi.yaml` + `/docs`),
    tag-fiel a la ruta catch-all. Se **genera** con `node users/openapi/gen-openapi.js`.
  - `docs/api/openapi.yaml` — **spec de diseño/referencia** (vista REST idealizada con sub-rutas),
    consumida por los skills del pipeline (backend-dev, android-dev, po, qa, doc, review). No se sirve.
- La cobertura de la spec servida la verifica `users:OpenApiCoverageTest`: si se agrega un `tag` en
  `Modules.kt` sin reflejarlo en `resources/openapi.yaml`, el build **falla**.
- El campo `verbo` y el `requestType` por endpoint son declarativos en el generador (el borde HTTP
  no los conoce); mantenerlos ahí al agregar/cambiar endpoints.

## 7. Referencia desde la "Nota de implementación" (CA-4)

> ⚠️ CA-4 depende de la plantilla del entregable definida en el épico **#4255** (OPEN). Cuando esté
> disponible, la nota de implementación del backend-dev **referencia la spec OpenAPI** (este
> estándar + `/openapi.yaml`) en lugar de describir el contrato a mano. No se cierra en este PR.
