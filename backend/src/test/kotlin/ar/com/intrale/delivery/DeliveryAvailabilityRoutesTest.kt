package ar.com.intrale.delivery

import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DeliveryAvailabilityRoutesTest {

    @Test
    fun `GET sin Authorization retorna 401`() = testApplication {
        application { deliveryAvailabilityRoutes() }

        val response = client.get("/delivery/profile/availability")
        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun `GET con token retorna payload por defecto`() = testApplication {
        application { deliveryAvailabilityRoutes() }

        val response = client.get("/delivery/profile/availability") {
            header(HttpHeaders.Authorization, "Bearer test-token-get-default")
        }
        assertEquals(HttpStatusCode.OK, response.status)
        val json = Json.parseToJsonElement(response.bodyAsText()).jsonObject
        assertEquals("UTC", json["timezone"]?.jsonPrimitive?.content)
        assertTrue(json["slots"]?.jsonArray?.isEmpty() == true)
    }

    @Test
    fun `PUT sin Authorization retorna 401`() = testApplication {
        application { deliveryAvailabilityRoutes() }

        val response = client.put("/delivery/profile/availability") {
            setBody("{}")
        }
        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun `PUT con payload invalido retorna 400`() = testApplication {
        application { deliveryAvailabilityRoutes() }

        val response = client.put("/delivery/profile/availability") {
            header(HttpHeaders.Authorization, "Bearer test-token-put-invalid")
            contentType(ContentType.Application.Json)
            setBody("esto no es json valido")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun `PUT con timezone vacio retorna error de validacion`() = testApplication {
        application { deliveryAvailabilityRoutes() }

        val response = client.put("/delivery/profile/availability") {
            header(HttpHeaders.Authorization, "Bearer test-token-put-tz")
            contentType(ContentType.Application.Json)
            setBody("""{"timezone":"","slots":[]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        val body = response.bodyAsText()
        assertTrue(body.contains("timezone requerido"))
        assertTrue(body.contains("al menos un día debe estar activo"))
    }

    @Test
    fun `PUT con dia invalido retorna error de validacion`() = testApplication {
        application { deliveryAvailabilityRoutes() }

        val response = client.put("/delivery/profile/availability") {
            header(HttpHeaders.Authorization, "Bearer test-token-put-day")
            contentType(ContentType.Application.Json)
            setBody("""{"timezone":"UTC","slots":[{"dayOfWeek":"fooDay","mode":"BLOCK","block":"MORNING"}]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertTrue(response.bodyAsText().contains("día inválido"))
    }

    @Test
    fun `PUT con modo invalido retorna error de validacion`() = testApplication {
        application { deliveryAvailabilityRoutes() }

        val response = client.put("/delivery/profile/availability") {
            header(HttpHeaders.Authorization, "Bearer test-token-put-mode")
            contentType(ContentType.Application.Json)
            setBody("""{"timezone":"UTC","slots":[{"dayOfWeek":"monday","mode":"INVALID"}]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertTrue(response.bodyAsText().contains("modo inválido"))
    }

    @Test
    fun `PUT con bloque invalido retorna error de validacion`() = testApplication {
        application { deliveryAvailabilityRoutes() }

        val response = client.put("/delivery/profile/availability") {
            header(HttpHeaders.Authorization, "Bearer test-token-put-block")
            contentType(ContentType.Application.Json)
            setBody("""{"timezone":"UTC","slots":[{"dayOfWeek":"monday","mode":"BLOCK","block":"INVALID"}]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertTrue(response.bodyAsText().contains("bloque inválido"))
    }

    @Test
    fun `PUT custom con rangos incompletos retorna error`() = testApplication {
        application { deliveryAvailabilityRoutes() }

        val response = client.put("/delivery/profile/availability") {
            header(HttpHeaders.Authorization, "Bearer test-token-put-custom-inc")
            contentType(ContentType.Application.Json)
            setBody("""{"timezone":"UTC","slots":[{"dayOfWeek":"monday","mode":"CUSTOM"}]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertTrue(response.bodyAsText().contains("rangos incompletos"))
    }

    @Test
    fun `PUT custom con fin menor al inicio retorna error`() = testApplication {
        application { deliveryAvailabilityRoutes() }

        val response = client.put("/delivery/profile/availability") {
            header(HttpHeaders.Authorization, "Bearer test-token-put-custom-end")
            contentType(ContentType.Application.Json)
            setBody("""{"timezone":"UTC","slots":[{"dayOfWeek":"monday","mode":"CUSTOM","start":"14:00","end":"08:00"}]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertTrue(response.bodyAsText().contains("fin debe ser mayor al inicio"))
    }

    @Test
    fun `PUT valido con modo BLOCK guarda y retorna normalizado`() = testApplication {
        application { deliveryAvailabilityRoutes() }

        val putResponse = client.put("/delivery/profile/availability") {
            header(HttpHeaders.Authorization, "Bearer test-token-put-block-ok")
            contentType(ContentType.Application.Json)
            setBody("""{"timezone":" America/Buenos_Aires ","slots":[{"dayOfWeek":"Monday","mode":"block","block":"morning"}]}""")
        }
        assertEquals(HttpStatusCode.OK, putResponse.status)
        val json = Json.parseToJsonElement(putResponse.bodyAsText()).jsonObject
        assertEquals("America/Buenos_Aires", json["timezone"]?.jsonPrimitive?.content)
        val slot = json["slots"]?.jsonArray?.first()?.jsonObject
        assertEquals("monday", slot?.get("dayOfWeek")?.jsonPrimitive?.content)
        assertEquals("BLOCK", slot?.get("mode")?.jsonPrimitive?.content)
        assertEquals("MORNING", slot?.get("block")?.jsonPrimitive?.content)
    }

    @Test
    fun `PUT valido con modo CUSTOM guarda y retorna`() = testApplication {
        application { deliveryAvailabilityRoutes() }

        val putResponse = client.put("/delivery/profile/availability") {
            header(HttpHeaders.Authorization, "Bearer test-token-put-custom-ok")
            contentType(ContentType.Application.Json)
            setBody("""{"timezone":"UTC","slots":[{"dayOfWeek":"tuesday","mode":"CUSTOM","start":"09:00","end":"17:00"}]}""")
        }
        assertEquals(HttpStatusCode.OK, putResponse.status)

        // Verify GET returns the stored data
        val getResponse = client.get("/delivery/profile/availability") {
            header(HttpHeaders.Authorization, "Bearer test-token-put-custom-ok")
        }
        assertEquals(HttpStatusCode.OK, getResponse.status)
        val json = Json.parseToJsonElement(getResponse.bodyAsText()).jsonObject
        assertEquals("UTC", json["timezone"]?.jsonPrimitive?.content)
        val slot = json["slots"]?.jsonArray?.first()?.jsonObject
        assertEquals("tuesday", slot?.get("dayOfWeek")?.jsonPrimitive?.content)
        assertEquals("CUSTOM", slot?.get("mode")?.jsonPrimitive?.content)
        assertEquals("09:00", slot?.get("start")?.jsonPrimitive?.content)
        assertEquals("17:00", slot?.get("end")?.jsonPrimitive?.content)
    }

    @Test
    fun `PUT con bloques AFTERNOON y NIGHT son validos`() = testApplication {
        application { deliveryAvailabilityRoutes() }

        val response = client.put("/delivery/profile/availability") {
            header(HttpHeaders.Authorization, "Bearer test-token-put-blocks")
            contentType(ContentType.Application.Json)
            setBody("""{"timezone":"UTC","slots":[
                {"dayOfWeek":"wednesday","mode":"BLOCK","block":"AFTERNOON"},
                {"dayOfWeek":"thursday","mode":"BLOCK","block":"NIGHT"}
            ]}""")
        }
        assertEquals(HttpStatusCode.OK, response.status)
    }
}
