package ar.com.intrale

import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class E2EClientOrdersTest : E2ETestBase() {

    @Test
    fun `listar pedidos vacíos del cliente`() {
        seedBusiness("intrale")
        val email = "client@test.com"

        e2eTest { client ->
            val response = client.get("/intrale/client/orders") {
                header("Authorization", tokenFor(email))
            }
            assertEquals(HttpStatusCode.OK, response.status)
            val body = response.bodyAsText()
            assertTrue(body.contains("\"orders\""), "La respuesta debe contener la clave orders")
        }
    }

    @Test
    fun `sin autenticación retorna 401`() {
        seedBusiness("intrale")

        e2eTest { client ->
            val response = client.get("/intrale/client/orders")
            assertEquals(HttpStatusCode.Unauthorized, response.status)
        }
    }

    @Test
    fun `detalle de pedido sin orderId retorna 400`() {
        seedBusiness("intrale")
        val email = "client@test.com"

        e2eTest { client ->
            val response = client.get("/intrale/client/order-detail") {
                header("Authorization", tokenFor(email))
            }
            assertEquals(HttpStatusCode.BadRequest, response.status)
        }
    }

    @Test
    fun `detalle de pedido inexistente retorna 404`() {
        seedBusiness("intrale")
        val email = "client@test.com"

        e2eTest { client ->
            val response = client.get("/intrale/client/order-detail/nonexistent") {
                header("Authorization", tokenFor(email))
            }
            assertEquals(HttpStatusCode.NotFound, response.status)
        }
    }
}
