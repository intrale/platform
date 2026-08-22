package ar.com.intrale

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

/**
 * Documentación interactiva de la API (OpenAPI + Swagger UI). Ver issue #4300.
 *
 * Seguridad:
 * - CA-S1: las rutas sólo se registran si [enabled] es true. Por defecto se gatea por el flag
 *   de entorno [ENV_API_DOCS_ENABLED] (no-prod). En producción sin el flag, `/openapi.yaml` y
 *   `/docs` NO existen (404) para usuarios anónimos.
 * - CA-S2: el `Try It Out` apunta por defecto al server no productivo declarado en la spec
 *   (localhost); los endpoints protegidos siguen exigiendo JWT vía SecuredFunction.
 * - CA-S3: Swagger UI se sirve pinneado a [SWAGGER_UI_VERSION] con `Content-Security-Policy`.
 * - CA-S5: el token JWT del campo Authorize queda sólo en memoria del navegador (Swagger UI no
 *   lo persiste); esta ruta no lo registra en ningún log.
 */

/** Flag de entorno que habilita la doc interactiva. Valores verdaderos: 1/true/yes/on. */
const val ENV_API_DOCS_ENABLED = "API_DOCS_ENABLED"

/** Versión pinneada de swagger-ui-dist servida desde un CDN inmutable (CA-S3). */
const val SWAGGER_UI_VERSION = "5.17.14"

private const val SWAGGER_UI_BASE = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@$SWAGGER_UI_VERSION"

/**
 * CSP de la página `/docs`. Sólo permite cargar swagger-ui desde el CDN pinneado y hacer
 * requests al mismo origen (connect-src 'self') para el "Try It Out". Sin `unsafe-eval`.
 */
private val SWAGGER_UI_CSP: String = listOf(
    "default-src 'none'",
    "base-uri 'self'",
    "script-src 'unsafe-inline' $SWAGGER_UI_BASE",
    "style-src 'unsafe-inline' $SWAGGER_UI_BASE",
    "img-src 'self' data: $SWAGGER_UI_BASE",
    "font-src data: $SWAGGER_UI_BASE",
    "connect-src 'self'"
).joinToString("; ")

/** Resuelve el flag de entorno [ENV_API_DOCS_ENABLED]. */
fun apiDocsEnabled(): Boolean =
    System.getenv(ENV_API_DOCS_ENABLED)?.trim()?.lowercase() in setOf("1", "true", "yes", "on")

/**
 * Registra las rutas de documentación: la spec OpenAPI en `/openapi.yaml` (leída del classpath,
 * fuente de verdad `users/src/main/resources/openapi.yaml`) y la UI navegable en `/docs`.
 * No hace nada si [enabled] es false (CA-S1).
 */
fun Application.swaggerRoute(enabled: Boolean = apiDocsEnabled()) {
    if (!enabled) return
    routing {
        get("/openapi.yaml") {
            val resource = this::class.java.classLoader.getResource("openapi.yaml")
            if (resource != null) {
                call.response.headers.append(HttpHeaders.CacheControl, "no-store")
                call.respondText(resource.readText(), ContentType.parse("text/yaml"))
            } else {
                call.respond(HttpStatusCode.NotFound)
            }
        }
        get("/docs") {
            call.response.headers.append("Content-Security-Policy", SWAGGER_UI_CSP)
            call.response.headers.append("X-Content-Type-Options", "nosniff")
            call.respondText(swaggerUiHtml(), ContentType.Text.Html)
        }
    }
}

/** HTML de la UI. Referencia swagger-ui pinneado; no incluye tokens ni datos reales (CA-S4/S5). */
internal fun swaggerUiHtml(): String = """
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Intrale API — Documentación</title>
  <link rel="stylesheet" href="$SWAGGER_UI_BASE/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="$SWAGGER_UI_BASE/swagger-ui-bundle.js"></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: '/openapi.yaml',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
        layout: 'BaseLayout'
      });
    };
  </script>
</body>
</html>
""".trimIndent()
