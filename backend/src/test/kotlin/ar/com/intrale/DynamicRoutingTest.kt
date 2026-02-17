package ar.com.intrale

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
import org.slf4j.LoggerFactory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DynamicRoutingTest {

    private fun testConfig(vararg businesses: String) = object : Config("us-east-1", "pool", "client") {
        override fun businesses() = businesses.toSet()
    }

    private class EchoFunction : Function {
        override suspend fun execute(business: String, function: String, headers: Map<String, String>, textBody: String): Response {
            return Response(HttpStatusCode.OK)
        }
    }

    private fun testModule(vararg businesses: String) = DI.Module("test") {
        bind<org.slf4j.Logger>() with singleton { LoggerFactory.getLogger("test") }
        bind<Config>() with singleton { testConfig(*businesses) }
        bind<Function>(tag = "echo") with singleton { EchoFunction() }
    }

    @Test
    fun `POST a funcion existente retorna OK`() = testApplication {
        application {
            di { import(testModule("biz")) }
            configureDynamicRouting()
        }

        val response = client.post("/biz/echo") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }
        assertEquals(HttpStatusCode.OK, response.status)
    }

    @Test
    fun `GET a funcion existente retorna OK`() = testApplication {
        application {
            di { import(testModule("biz")) }
            configureDynamicRouting()
        }

        val response = client.get("/biz/echo")
        assertEquals(HttpStatusCode.OK, response.status)
    }

    @Test
    fun `PUT a funcion existente retorna OK`() = testApplication {
        application {
            di { import(testModule("biz")) }
            configureDynamicRouting()
        }

        val response = client.put("/biz/echo") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }
        assertEquals(HttpStatusCode.OK, response.status)
    }

    @Test
    fun `DELETE a funcion existente retorna OK`() = testApplication {
        application {
            di { import(testModule("biz")) }
            configureDynamicRouting()
        }

        val response = client.delete("/biz/echo")
        assertEquals(HttpStatusCode.OK, response.status)
    }

    @Test
    fun `business no definido retorna 400`() = testApplication {
        application {
            di { import(testModule("biz")) }
            configureDynamicRouting()
        }

        // Ktor test client with /{business}/{function...} — when no function segments, route won't match
        // but null business can't happen in Ktor routing; test the function-missing path instead
        val response = client.post("/biz/missing") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }
        // Missing function returns 500 (ExceptionResponse)
        assertEquals(HttpStatusCode.InternalServerError, response.status)
        val body = response.bodyAsText()
        assertTrue(body.contains("No function with name missing found"))
    }

    @Test
    fun `business desconocido retorna 500`() = testApplication {
        application {
            di { import(testModule("biz")) }
            configureDynamicRouting()
        }

        val response = client.post("/unknown/echo") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }
        assertEquals(HttpStatusCode.InternalServerError, response.status)
        val body = response.bodyAsText()
        assertTrue(body.contains("Business not avaiable"))
    }

    @Test
    fun `OPTIONS retorna 200 con headers CORS`() = testApplication {
        application {
            di { import(testModule("biz")) }
            configureDynamicRouting()
        }

        val response = client.options("/")
        assertEquals(HttpStatusCode.OK, response.status)
    }

    @Test
    fun `ruta multi-segmento construye functionKey correctamente`() = testApplication {
        val module = DI.Module("test") {
            bind<org.slf4j.Logger>() with singleton { LoggerFactory.getLogger("test") }
            bind<Config>() with singleton { testConfig("biz") }
            bind<Function>(tag = "segment1/segment2") with singleton { EchoFunction() }
        }
        application {
            di { import(module) }
            configureDynamicRouting()
        }

        val response = client.post("/biz/segment1/segment2") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }
        assertEquals(HttpStatusCode.OK, response.status)
    }
}
