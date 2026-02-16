package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.model.*
import com.google.gson.Gson
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.mockk.coEvery
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class E2ESignUpSignInTest : E2ETestBase() {

    @Test
    fun `registro de usuario y luego inicio de sesion exitoso`() {
        seedBusiness("intrale")
        val email = "user@test.com"

        coEvery { cognito.adminCreateUser(any<AdminCreateUserRequest>()) } returns AdminCreateUserResponse {
            user = UserType {
                username = email
                attributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = email })
            }
        }

        coEvery { cognito.adminInitiateAuth(any<AdminInitiateAuthRequest>()) } returns AdminInitiateAuthResponse {
            authenticationResult = AuthenticationResultType {
                idToken = "test-id-token"
                accessToken = "test-access-token"
                refreshToken = "test-refresh-token"
            }
        }

        e2eTest { client ->
            // 1. SignUp
            val signUpResponse = client.post("/intrale/signup") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                setBody(Gson().toJson(SignUpRequest(email)))
            }
            assertEquals(HttpStatusCode.OK, signUpResponse.status)

            // 2. Simular aprobacion del perfil (en produccion lo haria un admin)
            seedClientProfile(email, "intrale", DEFAULT_PROFILE, BusinessState.APPROVED)

            // 3. SignIn
            val signInResponse = client.post("/intrale/signin") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                setBody(Gson().toJson(SignInRequest(email, "Password123!", "", "", "")))
            }
            assertEquals(HttpStatusCode.OK, signInResponse.status)
            val body = signInResponse.bodyAsText()
            assertTrue(body.contains("test-access-token"))
        }
    }

    @Test
    fun `inicio de sesion con usuario no registrado falla`() {
        seedBusiness("intrale")

        coEvery { cognito.adminInitiateAuth(any<AdminInitiateAuthRequest>()) } throws
            NotAuthorizedException.invoke { message = "Incorrect username or password." }

        e2eTest { client ->
            val response = client.post("/intrale/signin") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                setBody(Gson().toJson(SignInRequest("nobody@test.com", "wrong", "", "", "")))
            }
            assertEquals(HttpStatusCode.Unauthorized, response.status)
        }
    }
}
