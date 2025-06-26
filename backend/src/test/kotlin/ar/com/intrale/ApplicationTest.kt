package ar.com.intrale

import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals

class ApplicationTest {

    @Test
    fun healthEndpointReturnsUp() = testApplication {
        application {
            healthRoute()
        }

        val response = client.get("/health")
        assertEquals(HttpStatusCode.OK, response.status)

        val body = response.bodyAsText()
        val json = Json.parseToJsonElement(body).jsonObject

        assertEquals("UP", json["status"]?.toString()?.replace("\"", ""))
    }
}