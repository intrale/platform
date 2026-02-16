package ar.com.intrale

import com.google.gson.Gson
import io.ktor.client.request.*
import io.ktor.http.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class E2EAssignProfileTest : E2ETestBase() {

    @Test
    fun `asignacion de perfil por platform admin via HTTP`() {
        val adminEmail = "admin@intrale.com"
        seedBusiness("intrale")
        seedPlatformAdmin(adminEmail, "intrale")
        configureCognitoGetUser(adminEmail)

        e2eTest { client ->
            val response = client.post("/intrale/assignProfile") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(adminEmail))
                setBody(
                    Gson().toJson(
                        AssignProfileRequest(
                            email = "newuser@test.com",
                            profile = PROFILE_BUSINESS_ADMIN
                        )
                    )
                )
            }
            assertEquals(HttpStatusCode.OK, response.status)

            val assigned = tableProfiles.items.find {
                it.email == "newuser@test.com" && it.profile == PROFILE_BUSINESS_ADMIN
            }
            assertTrue(assigned != null, "El perfil debe haber sido asignado")
            assertEquals(BusinessState.APPROVED, assigned.state)
        }
    }

    @Test
    fun `asignacion sin perfil admin retorna no autorizado`() {
        val userEmail = "user@test.com"
        seedBusiness("intrale")
        // No seedeamos perfil de admin para este usuario
        configureCognitoGetUser(userEmail)

        e2eTest { client ->
            val response = client.post("/intrale/assignProfile") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(userEmail))
                setBody(
                    Gson().toJson(
                        AssignProfileRequest(
                            email = "otro@test.com",
                            profile = PROFILE_BUSINESS_ADMIN
                        )
                    )
                )
            }
            assertEquals(HttpStatusCode.Unauthorized, response.status)
        }
    }
}
