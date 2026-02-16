package ar.com.intrale

import com.google.gson.Gson
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class E2EJoinBusinessTest : E2ETestBase() {

    @Test
    fun `solicitud de union y aprobacion por business admin`() {
        val deliveryEmail = "delivery@test.com"
        val adminEmail = "admin@biz.com"
        seedBusiness("intrale")
        seedBusiness("biz", emailAdmin = adminEmail)
        seedBusinessAdmin(adminEmail, "biz")
        configureCognitoGetUser(deliveryEmail)

        e2eTest { client ->
            // 1. Delivery solicita unirse al negocio
            val joinResponse = client.post("/biz/requestJoinBusiness") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(deliveryEmail))
                setBody("{}")
            }
            assertEquals(HttpStatusCode.OK, joinResponse.status)
            val body = joinResponse.bodyAsText()
            assertTrue(body.contains("PENDING"), "El estado inicial debe ser PENDING")

            val pendingProfile = tableProfiles.items.find {
                it.email == deliveryEmail && it.profile == PROFILE_DELIVERY && it.business == "biz"
            }
            assertTrue(pendingProfile != null, "Debe existir el perfil de delivery pendiente")
            assertEquals(BusinessState.PENDING, pendingProfile.state)

            // 2. Business admin aprueba la solicitud
            configureCognitoGetUser(adminEmail)
            val reviewResponse = client.post("/biz/reviewJoinBusiness") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(adminEmail))
                setBody(
                    Gson().toJson(
                        ReviewJoinBusinessRequest(
                            email = deliveryEmail,
                            decision = "APPROVED"
                        )
                    )
                )
            }
            assertEquals(HttpStatusCode.OK, reviewResponse.status)

            val approvedProfile = tableProfiles.items.find {
                it.email == deliveryEmail && it.profile == PROFILE_DELIVERY && it.business == "biz"
            }
            assertTrue(approvedProfile != null, "El perfil debe existir")
            assertEquals(BusinessState.APPROVED, approvedProfile.state)
        }
    }
}
