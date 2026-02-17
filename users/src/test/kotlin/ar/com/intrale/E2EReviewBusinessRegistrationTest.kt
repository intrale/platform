package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminCreateUserRequest
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminCreateUserResponse
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.UserType
import com.eatthepath.otp.TimeBasedOneTimePasswordGenerator
import com.google.gson.Gson
import io.ktor.client.request.*
import io.ktor.http.*
import io.mockk.coEvery
import org.apache.commons.codec.binary.Base32
import java.time.Instant
import javax.crypto.spec.SecretKeySpec
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class E2EReviewBusinessRegistrationTest : E2ETestBase() {

    private val knownSecret = Base32().encodeToString("12345678901234567890".toByteArray())

    private fun generateTotpCode(): String {
        val generator = TimeBasedOneTimePasswordGenerator()
        val key = SecretKeySpec(Base32().decode(knownSecret), "HmacSHA1")
        return String.format("%06d", generator.generateOneTimePassword(key, Instant.now()))
    }

    @Test
    fun `aprobacion de negocio por platform admin`() {
        val adminEmail = "platformadmin@intrale.com"
        val businessAdminEmail = "owner@newbiz.com"
        seedBusiness("intrale")
        seedBusiness("newbizbiz", publicId = "newbizbiz", state = BusinessState.PENDING, emailAdmin = businessAdminEmail)
        seedPlatformAdmin(adminEmail, "intrale")
        configureCognitoGetUser(adminEmail)

        // Seedear usuario con secret 2FA para el platform admin
        tableUsers.putItem(User(email = adminEmail, secret = knownSecret))

        // Mock cognito.adminCreateUser para el signup del business admin
        coEvery { cognito.adminCreateUser(any<AdminCreateUserRequest>()) } returns AdminCreateUserResponse {
            user = UserType {
                username = businessAdminEmail
                attributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = businessAdminEmail })
            }
        }

        e2eTest { client ->
            val totpCode = generateTotpCode()
            val response = client.post("/intrale/reviewBusiness") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(adminEmail))
                setBody(
                    Gson().toJson(
                        ReviewBusinessRegistrationRequest(
                            publicId = "newbizbiz",
                            decision = "approved",
                            twoFactorCode = totpCode
                        )
                    )
                )
            }
            assertEquals(HttpStatusCode.OK, response.status)

            // Verificar que el negocio fue aprobado
            val business = tableBusiness.items.find { it.publicId == "newbizbiz" }
            assertTrue(business != null, "El negocio debe existir")
            assertEquals(BusinessState.APPROVED, business.state)

            // Verificar que se creo el perfil de business admin
            val businessAdminProfile = tableProfiles.items.find {
                it.email == businessAdminEmail && it.profile == PROFILE_BUSINESS_ADMIN && it.business == "newbizbiz"
            }
            assertTrue(businessAdminProfile != null, "Debe existir el perfil de business admin")
        }
    }

    @Test
    fun `rechazo de negocio por platform admin`() {
        val adminEmail = "platformadmin@intrale.com"
        seedBusiness("intrale")
        seedBusiness("rejectbiz", publicId = "rejectbiz", state = BusinessState.PENDING, emailAdmin = "owner@reject.com")
        seedPlatformAdmin(adminEmail, "intrale")
        configureCognitoGetUser(adminEmail)

        tableUsers.putItem(User(email = adminEmail, secret = knownSecret))

        e2eTest { client ->
            val totpCode = generateTotpCode()
            val response = client.post("/intrale/reviewBusiness") {
                header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
                header("Authorization", tokenFor(adminEmail))
                setBody(
                    Gson().toJson(
                        ReviewBusinessRegistrationRequest(
                            publicId = "rejectbiz",
                            decision = "rejected",
                            twoFactorCode = totpCode
                        )
                    )
                )
            }
            assertEquals(HttpStatusCode.OK, response.status)

            val business = tableBusiness.items.find { it.publicId == "rejectbiz" }
            assertTrue(business != null, "El negocio debe existir")
            assertEquals(BusinessState.REJECTED, business.state)
        }
    }
}
