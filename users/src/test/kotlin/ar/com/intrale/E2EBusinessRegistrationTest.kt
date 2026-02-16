package ar.com.intrale

import com.google.gson.Gson
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class E2EBusinessRegistrationTest : E2ETestBase() {

    @Test
    fun `registro de negocio crea negocio en estado pendiente`() {
        seedBusiness("intrale")

        e2eTest { client ->
            val response = client.post("/intrale/registerBusiness") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                setBody(
                    Gson().toJson(
                        RegisterBusinessRequest(
                            name = "Mi Nuevo Negocio",
                            emailAdmin = "admin@nuevonegocio.com",
                            description = "Descripcion del negocio"
                        )
                    )
                )
            }
            assertEquals(HttpStatusCode.OK, response.status)

            val created = tableBusiness.items.find { it.emailAdmin == "admin@nuevonegocio.com" }
            assertTrue(created != null, "El negocio debe existir en la tabla")
            assertEquals(BusinessState.PENDING, created.state)
            assertEquals("Descripcion del negocio", created.description)
        }
    }

    @Test
    fun `negocio pendiente duplicado retorna error`() {
        seedBusiness("intrale")
        tableBusiness.putItem(
            Business(
                name = "Negocio Existente",
                publicId = "negocio-existente",
                emailAdmin = "admin@existente.com",
                state = BusinessState.PENDING
            )
        )

        e2eTest { client ->
            val response = client.post("/intrale/registerBusiness") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                setBody(
                    Gson().toJson(
                        RegisterBusinessRequest(
                            name = "Negocio Existente",
                            emailAdmin = "admin@existente.com",
                            description = "Duplicado"
                        )
                    )
                )
            }
            assertEquals(HttpStatusCode.BadRequest, response.status)
        }
    }
}
