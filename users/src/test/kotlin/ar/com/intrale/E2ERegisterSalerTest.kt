package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminCreateUserRequest
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminCreateUserResponse
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.UserType
import com.google.gson.Gson
import io.ktor.client.request.*
import io.ktor.http.*
import io.mockk.coEvery
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class E2ERegisterSalerTest : E2ETestBase() {

    @Test
    fun `registro de vendedor por business admin`() {
        val adminEmail = "admin@biz.com"
        val salerEmail = "saler@test.com"
        seedBusiness("intrale")
        seedBusiness("biz", emailAdmin = adminEmail)
        seedBusinessAdmin(adminEmail, "biz")
        configureCognitoGetUser(adminEmail)

        coEvery { cognito.adminCreateUser(any<AdminCreateUserRequest>()) } returns AdminCreateUserResponse {
            user = UserType {
                username = salerEmail
                attributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = salerEmail })
            }
        }

        e2eTest { client ->
            val response = client.post("/biz/registerSaler") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(adminEmail))
                setBody(Gson().toJson(RegisterSalerRequest(salerEmail)))
            }
            assertEquals(HttpStatusCode.OK, response.status)

            val salerProfile = tableProfiles.items.find {
                it.email == salerEmail && it.profile == PROFILE_SALER && it.business == "biz"
            }
            assertTrue(salerProfile != null, "Debe existir el perfil de vendedor")
            assertEquals(BusinessState.APPROVED, salerProfile.state)
        }
    }

    @Test
    fun `registro de vendedor duplicado retorna conflicto`() {
        val adminEmail = "admin@biz.com"
        val salerEmail = "saler@test.com"
        seedBusiness("intrale")
        seedBusiness("biz", emailAdmin = adminEmail)
        seedBusinessAdmin(adminEmail, "biz")
        configureCognitoGetUser(adminEmail)

        // Seedear perfil de saler ya aprobado
        seedClientProfile(salerEmail, "biz", PROFILE_SALER, BusinessState.APPROVED)

        e2eTest { client ->
            val response = client.post("/biz/registerSaler") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(adminEmail))
                setBody(Gson().toJson(RegisterSalerRequest(salerEmail)))
            }
            assertEquals(HttpStatusCode.Conflict, response.status)
        }
    }
}
