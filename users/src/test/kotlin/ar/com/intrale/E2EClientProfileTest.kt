package ar.com.intrale

import com.google.gson.Gson
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class E2EClientProfileTest : E2ETestBase() {

    @Test
    fun `obtener perfil de cliente por defecto`() {
        seedBusiness("intrale")
        val email = "client@test.com"

        e2eTest { client ->
            val response = client.get("/intrale/client/profile") {
                header("Authorization", tokenFor(email))
            }
            assertEquals(HttpStatusCode.OK, response.status)
            val body = response.bodyAsText()
            assertTrue(body.contains(email), "La respuesta debe contener el email del cliente")
        }
    }

    @Test
    fun `actualizar perfil de cliente`() {
        seedBusiness("intrale")
        val email = "client@test.com"

        e2eTest { client ->
            val updateRequest = ClientProfileUpdateRequest(
                profile = ClientProfilePayload(fullName = "Juan Perez", email = email, phone = "+5411999999"),
                preferences = ClientPreferencesPayload(language = "es")
            )
            val response = client.put("/intrale/client/profile") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(email))
                setBody(Gson().toJson(updateRequest))
            }
            assertEquals(HttpStatusCode.OK, response.status)
            val body = response.bodyAsText()
            assertTrue(body.contains("Juan Perez"), "Debe contener el nombre actualizado")
            assertTrue(body.contains("+5411999999"), "Debe contener el telefono actualizado")
        }
    }

    @Test
    fun `crear y listar direcciones`() {
        seedBusiness("intrale")
        val email = "client@test.com"

        e2eTest { client ->
            // Crear una direccion
            val address = ClientAddressPayload(
                label = "Casa",
                street = "Av. Corrientes",
                number = "1234",
                city = "Buenos Aires",
                country = "AR"
            )
            val createResponse = client.post("/intrale/client/addresses") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(email))
                setBody(Gson().toJson(address))
            }
            assertEquals(HttpStatusCode.Created, createResponse.status)
            val createBody = createResponse.bodyAsText()
            assertTrue(createBody.contains("Casa"), "Debe contener el label de la direccion")
            assertTrue(createBody.contains("Av. Corrientes"), "Debe contener la calle")

            // Listar direcciones
            val listResponse = client.get("/intrale/client/addresses") {
                header("Authorization", tokenFor(email))
            }
            assertEquals(HttpStatusCode.OK, listResponse.status)
            val listBody = listResponse.bodyAsText()
            assertTrue(listBody.contains("Casa"), "La lista debe contener la direccion creada")
        }
    }

    @Test
    fun `marcar direccion como predeterminada`() {
        seedBusiness("intrale")
        val email = "client@test.com"

        e2eTest { client ->
            // Crear primera direccion
            val addr1 = ClientAddressPayload(
                id = "addr-1",
                label = "Casa",
                street = "Calle 1",
                number = "100",
                city = "Buenos Aires"
            )
            val create1 = client.post("/intrale/client/addresses") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(email))
                setBody(Gson().toJson(addr1))
            }
            assertEquals(HttpStatusCode.Created, create1.status)

            // Crear segunda direccion
            val addr2 = ClientAddressPayload(
                id = "addr-2",
                label = "Oficina",
                street = "Calle 2",
                number = "200",
                city = "Buenos Aires"
            )
            val create2 = client.post("/intrale/client/addresses") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(email))
                setBody(Gson().toJson(addr2))
            }
            assertEquals(HttpStatusCode.Created, create2.status)

            // Marcar la segunda como predeterminada
            val defaultResponse = client.put("/intrale/client/addresses/addr-2/default") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(email))
                setBody("{}")
            }
            assertEquals(HttpStatusCode.OK, defaultResponse.status)

            // Listar y verificar que addr-2 es default
            val listResponse = client.get("/intrale/client/addresses") {
                header("Authorization", tokenFor(email))
            }
            assertEquals(HttpStatusCode.OK, listResponse.status)
            val listBody = listResponse.bodyAsText()
            assertTrue(listBody.contains("\"isDefault\":true"), "Debe haber una direccion predeterminada")
            assertTrue(listBody.contains("addr-2"), "La segunda direccion debe estar en la lista")
        }
    }
}
