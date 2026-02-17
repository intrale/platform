package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.model.NotAuthorizedException
import com.google.gson.Gson
import io.ktor.client.request.*
import io.ktor.http.*
import io.mockk.coEvery
import kotlin.test.Test
import kotlin.test.assertEquals

class E2EChangePasswordTest : E2ETestBase() {

    @Test
    fun `cambio de contrasena exitoso`() {
        seedBusiness("intrale")
        val email = "user@test.com"
        configureCognitoGetUser(email)

        coEvery { cognito.changePassword(any()) } returns aws.sdk.kotlin.services.cognitoidentityprovider.model.ChangePasswordResponse {}

        e2eTest { client ->
            val response = client.post("/intrale/changePassword") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(email))
                setBody(Gson().toJson(ChangePasswordRequest("OldPass123!", "NewPass456!")))
            }
            assertEquals(HttpStatusCode.OK, response.status)
        }
    }

    @Test
    fun `cambio de contrasena con credenciales invalidas retorna no autorizado`() {
        seedBusiness("intrale")
        val email = "user@test.com"
        configureCognitoGetUser(email)

        coEvery { cognito.changePassword(any()) } throws
            NotAuthorizedException.invoke { message = "Incorrect username or password." }

        e2eTest { client ->
            val response = client.post("/intrale/changePassword") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(email))
                setBody(Gson().toJson(ChangePasswordRequest("WrongPass!", "NewPass456!")))
            }
            assertEquals(HttpStatusCode.Unauthorized, response.status)
        }
    }
}
