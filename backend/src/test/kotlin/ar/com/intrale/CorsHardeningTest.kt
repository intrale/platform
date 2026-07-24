package ar.com.intrale

import io.ktor.client.request.*
import io.ktor.http.*
import io.ktor.server.testing.*
import org.kodein.di.DI
import org.kodein.di.bind
import org.kodein.di.singleton
import org.kodein.di.ktor.di
import org.slf4j.LoggerFactory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Verifica el endurecimiento de CORS del handler OPTIONS (#4300, CA-S6):
 * nunca `Access-Control-Allow-Origin: *`; sólo se refleja un Origin de la allowlist.
 */
class CorsHardeningTest {

    private fun testConfig() = object : Config("us-east-1", "pool", "client") {
        override fun businesses() = setOf("biz")
    }

    private fun module() = DI.Module("test") {
        bind<org.slf4j.Logger>() with singleton { LoggerFactory.getLogger("test") }
        bind<Config>() with singleton { testConfig() }
    }

    @Test
    fun `OPTIONS nunca emite Access-Control-Allow-Origin wildcard`() = testApplication {
        application {
            di { import(module()) }
            configureDynamicRouting(corsAllowedOrigins = emptySet())
        }

        val response = client.options("/") {
            header(HttpHeaders.Origin, "https://evil.example.com")
        }
        assertEquals(HttpStatusCode.OK, response.status)
        val acao = response.headers["Access-Control-Allow-Origin"]
        assertTrue(acao != "*", "CORS no debe emitir wildcard '*'")
        assertNull(acao, "un Origin fuera de la allowlist no debe recibir ACAO")
    }

    @Test
    fun `OPTIONS refleja solo un Origin de la allowlist`() = testApplication {
        application {
            di { import(module()) }
            configureDynamicRouting(corsAllowedOrigins = setOf("https://app.intrale.com"))
        }

        val allowed = client.options("/") {
            header(HttpHeaders.Origin, "https://app.intrale.com")
        }
        assertEquals("https://app.intrale.com", allowed.headers["Access-Control-Allow-Origin"])

        val rejected = client.options("/") {
            header(HttpHeaders.Origin, "https://evil.example.com")
        }
        assertNull(rejected.headers["Access-Control-Allow-Origin"], "Origin no permitido no recibe ACAO")
    }

    @Test
    fun `allowedCorsOrigins sin env es vacio`() {
        // En el entorno de test no se define CORS_ALLOWED_ORIGINS -> allowlist vacía (mismo origen).
        assertTrue(allowedCorsOrigins().isEmpty())
    }
}
