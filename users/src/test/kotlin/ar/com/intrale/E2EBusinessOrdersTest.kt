package ar.com.intrale

import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class E2EBusinessOrdersTest : E2ETestBase() {

    @Test
    fun `listar pedidos vacíos del negocio`() {
        seedBusiness("pizzeria")
        val email = "admin@pizzeria.com"

        e2eTest { client ->
            val response = client.get("/pizzeria/business/orders") {
                header("Authorization", tokenFor(email))
            }
            assertEquals(HttpStatusCode.OK, response.status)
            val body = response.bodyAsText()
            assertTrue(body.contains("\"orders\""), "La respuesta debe contener la clave orders")
        }
    }

    @Test
    fun `listar pedidos del negocio con pedidos existentes`() {
        seedBusiness("pizzeria")
        val email = "admin@pizzeria.com"
        val repository = ClientOrderRepository()
        repository.createOrder("pizzeria", "cliente@test.com", ClientOrderPayload(
            status = "PENDING", total = 1500.0
        ))

        e2eTest { client ->
            val response = client.get("/pizzeria/business/orders") {
                header("Authorization", tokenFor(email))
            }
            assertEquals(HttpStatusCode.OK, response.status)
        }
    }

    @Test
    fun `sin autenticación retorna 401`() {
        seedBusiness("pizzeria")

        e2eTest { client ->
            val response = client.get("/pizzeria/business/orders")
            assertEquals(HttpStatusCode.Unauthorized, response.status)
        }
    }
}
