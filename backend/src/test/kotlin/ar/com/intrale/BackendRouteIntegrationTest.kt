package ar.com.intrale

import ar.com.intrale.delivery.deliveryAvailabilityRoutes
import com.auth0.jwt.interfaces.DecodedJWT
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.kodein.di.DI
import org.kodein.di.bind
import org.kodein.di.singleton
import org.kodein.di.ktor.di
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BackendRouteIntegrationTest {

    private val logger: Logger = LoggerFactory.getLogger("test")

    // --- Fakes reutilizables ---

    private fun testConfig(vararg businesses: String) = object : Config("us-east-1", "pool", "client") {
        override fun businesses() = businesses.toSet()
    }

    /** Función que captura los parámetros recibidos para verificación */
    private class CapturingFunction : Function {
        var capturedBusiness: String? = null
        var capturedFunction: String? = null
        var capturedHeaders: Map<String, String>? = null
        var capturedBody: String? = null

        override suspend fun execute(
            business: String,
            function: String,
            headers: Map<String, String>,
            textBody: String
        ): Response {
            capturedBusiness = business
            capturedFunction = function
            capturedHeaders = headers
            capturedBody = textBody
            return Response(HttpStatusCode.OK)
        }
    }

    /** Respuesta con campos personalizados para verificar serialización */
    private class DetailedResponse(
        val data: String,
        val count: Int,
        status: HttpStatusCode = HttpStatusCode.OK
    ) : Response(statusCode = status)

    /** Función que retorna una respuesta con campos personalizados */
    private class DetailedFunction : Function {
        override suspend fun execute(
            business: String,
            function: String,
            headers: Map<String, String>,
            textBody: String
        ): Response = DetailedResponse(data = "resultado", count = 42)
    }

    /** Función que retorna un status code personalizado */
    private class CreatedFunction : Function {
        override suspend fun execute(
            business: String,
            function: String,
            headers: Map<String, String>,
            textBody: String
        ): Response = Response(HttpStatusCode.Created)
    }

    /** Función que lanza una excepción no controlada */
    private class ThrowingFunction : Function {
        override suspend fun execute(
            business: String,
            function: String,
            headers: Map<String, String>,
            textBody: String
        ): Response {
            throw RuntimeException("Error simulado")
        }
    }

    /** JwtValidator fake que siempre acepta el token */
    private class AcceptAllJwtValidator : JwtValidator {
        override fun validate(token: String): DecodedJWT {
            return io.mockk.mockk<DecodedJWT>()
        }
    }

    /** JwtValidator fake que siempre rechaza el token */
    private class RejectAllJwtValidator : JwtValidator {
        override fun validate(token: String): DecodedJWT {
            throw IllegalArgumentException("Token inválido")
        }
    }

    /** SecuredFunction concreta para testing */
    private class FakeSecuredFunction(
        config: Config,
        logger: Logger,
        jwtValidator: JwtValidator
    ) : SecuredFunction(config, logger, jwtValidator) {
        var capturedBusiness: String? = null
        var capturedHeaders: Map<String, String>? = null

        override suspend fun securedExecute(
            business: String,
            function: String,
            headers: Map<String, String>,
            textBody: String
        ): Response {
            capturedBusiness = business
            capturedHeaders = headers
            return Response(HttpStatusCode.OK)
        }
    }

    // --- Módulos de DI ---

    private fun fullModule(
        vararg businesses: String,
        extraBindings: DI.Builder.() -> Unit = {}
    ) = DI.Module("integration-test") {
        bind<Logger>() with singleton { logger }
        bind<Config>() with singleton { testConfig(*businesses) }
        extraBindings()
    }

    // --- Tests de integración ---

    @Test
    fun `POST reenvía business, function, headers y body a la función`() = testApplication {
        val capturing = CapturingFunction()
        application {
            di {
                import(fullModule("miNegocio") {
                    bind<Function>(tag = "operar") with singleton { capturing }
                })
            }
            configureDynamicRouting()
        }

        val response = client.post("/miNegocio/operar") {
            contentType(ContentType.Application.Json)
            header("X-Custom", "valor-custom")
            setBody("""{"clave":"valor"}""")
        }

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("miNegocio", capturing.capturedBusiness)
        assertEquals("operar", capturing.capturedFunction)
        assertEquals("""{"clave":"valor"}""", capturing.capturedBody)
        assertEquals("POST", capturing.capturedHeaders?.get("X-Http-Method"))
        assertEquals("operar", capturing.capturedHeaders?.get("X-Function-Path"))
        assertEquals("valor-custom", capturing.capturedHeaders?.get("X-Custom"))
    }

    @Test
    fun `GET inyecta X-Http-Method GET en headers`() = testApplication {
        val capturing = CapturingFunction()
        application {
            di {
                import(fullModule("negocio") {
                    bind<Function>(tag = "consulta") with singleton { capturing }
                })
            }
            configureDynamicRouting()
        }

        client.get("/negocio/consulta")

        assertEquals("GET", capturing.capturedHeaders?.get("X-Http-Method"))
    }

    @Test
    fun `PUT inyecta X-Http-Method PUT en headers`() = testApplication {
        val capturing = CapturingFunction()
        application {
            di {
                import(fullModule("negocio") {
                    bind<Function>(tag = "actualizar") with singleton { capturing }
                })
            }
            configureDynamicRouting()
        }

        client.put("/negocio/actualizar") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }

        assertEquals("PUT", capturing.capturedHeaders?.get("X-Http-Method"))
    }

    @Test
    fun `DELETE inyecta X-Http-Method DELETE en headers`() = testApplication {
        val capturing = CapturingFunction()
        application {
            di {
                import(fullModule("negocio") {
                    bind<Function>(tag = "borrar") with singleton { capturing }
                })
            }
            configureDynamicRouting()
        }

        client.delete("/negocio/borrar")

        assertEquals("DELETE", capturing.capturedHeaders?.get("X-Http-Method"))
    }

    @Test
    fun `respuesta con campos personalizados se serializa correctamente`() = testApplication {
        application {
            di {
                import(fullModule("tienda") {
                    bind<Function>(tag = "detalle") with singleton { DetailedFunction() }
                })
            }
            configureDynamicRouting()
        }

        val response = client.post("/tienda/detalle") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }

        assertEquals(HttpStatusCode.OK, response.status)
        val json = Json.parseToJsonElement(response.bodyAsText()).jsonObject
        assertEquals("resultado", json["data"]?.jsonPrimitive?.content)
        assertEquals("42", json["count"]?.jsonPrimitive?.content)
    }

    @Test
    fun `función con status Created propaga el código 201`() = testApplication {
        application {
            di {
                import(fullModule("tienda") {
                    bind<Function>(tag = "crear") with singleton { CreatedFunction() }
                })
            }
            configureDynamicRouting()
        }

        val response = client.post("/tienda/crear") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }

        assertEquals(HttpStatusCode.Created, response.status)
    }

    @Test
    fun `POST sin body envía string vacío a la función`() = testApplication {
        val capturing = CapturingFunction()
        application {
            di {
                import(fullModule("negocio") {
                    bind<Function>(tag = "vacio") with singleton { capturing }
                })
            }
            configureDynamicRouting()
        }

        client.post("/negocio/vacio")

        assertEquals("", capturing.capturedBody)
    }

    @Test
    fun `business no registrado retorna 500 con mensaje descriptivo`() = testApplication {
        application {
            di {
                import(fullModule("registrado") {
                    bind<Function>(tag = "fn") with singleton { CapturingFunction() }
                })
            }
            configureDynamicRouting()
        }

        val response = client.post("/inexistente/fn") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }

        assertEquals(HttpStatusCode.InternalServerError, response.status)
        val body = response.bodyAsText()
        assertTrue(body.contains("Business not avaiable"))
        assertTrue(body.contains("inexistente"))
    }

    @Test
    fun `función no registrada retorna 500 con nombre de función`() = testApplication {
        application {
            di {
                import(fullModule("negocio") {
                    bind<Function>(tag = "existente") with singleton { CapturingFunction() }
                })
            }
            configureDynamicRouting()
        }

        val response = client.post("/negocio/desconocida") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }

        assertEquals(HttpStatusCode.InternalServerError, response.status)
        val body = response.bodyAsText()
        assertTrue(body.contains("No function with name desconocida found"))
    }

    @Test
    fun `múltiples businesses pueden coexistir y enrutar correctamente`() = testApplication {
        val capturingA = CapturingFunction()
        val capturingB = CapturingFunction()
        application {
            di {
                import(fullModule("negocioA", "negocioB") {
                    bind<Function>(tag = "accion") with singleton { capturingA }
                    bind<Function>(tag = "otra") with singleton { capturingB }
                })
            }
            configureDynamicRouting()
        }

        client.post("/negocioA/accion") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }
        assertEquals("negocioA", capturingA.capturedBusiness)

        client.post("/negocioB/otra") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }
        assertEquals("negocioB", capturingB.capturedBusiness)
    }

    @Test
    fun `ruta multi-segmento propaga functionPath completo en X-Function-Path`() = testApplication {
        val capturing = CapturingFunction()
        application {
            di {
                import(fullModule("negocio") {
                    bind<Function>(tag = "client/profile") with singleton { capturing }
                })
            }
            configureDynamicRouting()
        }

        client.post("/negocio/client/profile") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }

        assertEquals("client/profile", capturing.capturedFunction)
        assertEquals("client/profile", capturing.capturedHeaders?.get("X-Function-Path"))
    }

    @Test
    fun `SecuredFunction sin token Authorization retorna 401`() = testApplication {
        val config = testConfig("negocio")
        application {
            di {
                import(fullModule("negocio") {
                    bind<Function>(tag = "protegida") with singleton {
                        FakeSecuredFunction(config, logger, AcceptAllJwtValidator())
                    }
                })
            }
            configureDynamicRouting()
        }

        val response = client.post("/negocio/protegida") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }

        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun `SecuredFunction con token inválido retorna 401`() = testApplication {
        val config = testConfig("negocio")
        application {
            di {
                import(fullModule("negocio") {
                    bind<Function>(tag = "protegida") with singleton {
                        FakeSecuredFunction(config, logger, RejectAllJwtValidator())
                    }
                })
            }
            configureDynamicRouting()
        }

        val response = client.post("/negocio/protegida") {
            contentType(ContentType.Application.Json)
            header("Authorization", "Bearer token-invalido")
            setBody("{}")
        }

        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun `SecuredFunction con token válido ejecuta securedExecute`() = testApplication {
        val config = testConfig("negocio")
        val secured = FakeSecuredFunction(config, logger, AcceptAllJwtValidator())
        application {
            di {
                import(fullModule("negocio") {
                    bind<Function>(tag = "protegida") with singleton { secured }
                })
            }
            configureDynamicRouting()
        }

        val response = client.post("/negocio/protegida") {
            contentType(ContentType.Application.Json)
            header("Authorization", "Bearer token-valido")
            setBody("{}")
        }

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("negocio", secured.capturedBusiness)
    }

    @Test
    fun `OPTIONS retorna 200 con headers CORS completos`() = testApplication {
        application {
            di {
                import(fullModule("negocio") {
                    bind<Function>(tag = "fn") with singleton { CapturingFunction() }
                })
            }
            configureDynamicRouting()
        }

        val response = client.options("/")

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("*", response.headers["Access-Control-Allow-Origin"])
        assertTrue(response.headers["Access-Control-Allow-Methods"]?.contains("POST") == true)
        assertTrue(response.headers["Access-Control-Allow-Headers"]?.contains("Authorization") == true)
    }

    @Test
    fun `health, delivery y dynamic routing coexisten sin conflicto`() = testApplication {
        val capturing = CapturingFunction()
        application {
            di {
                import(fullModule("negocio") {
                    bind<Function>(tag = "fn") with singleton { capturing }
                })
            }
            healthRoute()
            deliveryAvailabilityRoutes()
            configureDynamicRouting()
        }

        // Health responde
        val healthResp = client.get("/health")
        assertEquals(HttpStatusCode.OK, healthResp.status)
        val healthJson = Json.parseToJsonElement(healthResp.bodyAsText()).jsonObject
        assertEquals("UP", healthJson["status"]?.jsonPrimitive?.content)

        // Delivery responde (sin token → 401)
        val deliveryResp = client.get("/delivery/profile/availability")
        assertEquals(HttpStatusCode.Unauthorized, deliveryResp.status)

        // Dynamic routing responde
        val dynamicResp = client.post("/negocio/fn") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }
        assertEquals(HttpStatusCode.OK, dynamicResp.status)
        assertEquals("negocio", capturing.capturedBusiness)
    }

    @Test
    fun `respuesta JSON incluye Content-Type application json`() = testApplication {
        application {
            di {
                import(fullModule("negocio") {
                    bind<Function>(tag = "fn") with singleton { CapturingFunction() }
                })
            }
            configureDynamicRouting()
        }

        val response = client.post("/negocio/fn") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }

        assertTrue(response.contentType()?.match(ContentType.Application.Json) == true)
    }
}
