package ar.com.intrale

import com.google.gson.Gson
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class E2EConfigAutoAcceptTest : E2ETestBase() {

    @Test
    fun `activar auto aceptacion de deliveries`() {
        val adminEmail = "admin@biz.com"
        seedBusiness("intrale")
        seedBusiness("biz", emailAdmin = adminEmail, autoAcceptDeliveries = false)
        seedBusinessAdmin(adminEmail, "biz")
        configureCognitoGetUser(adminEmail)

        e2eTest { client ->
            val response = client.post("/biz/configAutoAcceptDeliveries") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(adminEmail))
                setBody(Gson().toJson(ConfigAutoAcceptDeliveriesRequest(true)))
            }
            assertEquals(HttpStatusCode.OK, response.status)

            val business = tableBusiness.items.find { it.publicId == "biz" }
            assertTrue(business != null, "El negocio debe existir")
            assertEquals(true, business.autoAcceptDeliveries, "autoAcceptDeliveries debe ser true")
        }
    }

    @Test
    fun `auto aceptacion aprueba automaticamente solicitud de delivery`() {
        val adminEmail = "admin@biz.com"
        val deliveryEmail = "delivery@test.com"
        seedBusiness("intrale")
        seedBusiness("biz", emailAdmin = adminEmail, autoAcceptDeliveries = true)
        seedBusinessAdmin(adminEmail, "biz")
        configureCognitoGetUser(deliveryEmail)

        e2eTest { client ->
            val response = client.post("/biz/requestJoinBusiness") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(deliveryEmail))
                setBody("{}")
            }
            assertEquals(HttpStatusCode.OK, response.status)
            val body = response.bodyAsText()
            assertTrue(body.contains("APPROVED"), "El estado debe ser APPROVED directamente")

            val profile = tableProfiles.items.find {
                it.email == deliveryEmail && it.profile == PROFILE_DELIVERY && it.business == "biz"
            }
            assertTrue(profile != null, "Debe existir el perfil de delivery")
            assertEquals(BusinessState.APPROVED, profile.state)
        }
    }
}
