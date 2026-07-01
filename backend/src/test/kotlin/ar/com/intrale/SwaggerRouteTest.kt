package ar.com.intrale

import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Verifica el gating y el contenido de la doc interactiva (#4300, CA-3 + CA-S1/S3).
 */
class SwaggerRouteTest {

    @Test
    fun `con flag ON openapi punto yaml responde 200 y text yaml`() = testApplication {
        application { swaggerRoute(enabled = true) }

        val response = client.get("/openapi.yaml")
        assertEquals(HttpStatusCode.OK, response.status)
        assertTrue(
            response.contentType()?.match(ContentType.parse("text/yaml")) == true,
            "content-type esperado text/yaml, fue ${response.contentType()}"
        )
        assertTrue(response.bodyAsText().contains("openapi:"), "el cuerpo debe ser la spec OpenAPI")
    }

    @Test
    fun `con flag ON docs responde 200 con Content-Security-Policy`() = testApplication {
        application { swaggerRoute(enabled = true) }

        val response = client.get("/docs")
        assertEquals(HttpStatusCode.OK, response.status)
        val csp = response.headers["Content-Security-Policy"]
        assertNotNull(csp, "la página /docs debe emitir Content-Security-Policy (CA-S3)")
        assertTrue(csp.contains("default-src 'none'"), "el CSP debe ser restrictivo")
    }

    @Test
    fun `con flag OFF las rutas de doc no son accesibles anonimamente`() = testApplication {
        application { swaggerRoute(enabled = false) }

        assertEquals(HttpStatusCode.NotFound, client.get("/openapi.yaml").status)
        assertEquals(HttpStatusCode.NotFound, client.get("/docs").status)
    }

    @Test
    fun `swagger UI esta pinneado a una version concreta`() {
        assertTrue(swaggerUiHtml().contains("swagger-ui-dist@$SWAGGER_UI_VERSION"))
    }
}
