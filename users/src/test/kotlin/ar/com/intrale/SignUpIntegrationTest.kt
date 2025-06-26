package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminCreateUserRequest
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminCreateUserResponse
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminGetUserRequest
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminGetUserResponse
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminUpdateUserAttributesRequest
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminUpdateUserAttributesResponse
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.UsernameExistsException
import com.google.gson.Gson
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.server.request.receiveText
import io.ktor.server.response.respondText
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.routing.*
import io.ktor.server.testing.*
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import org.kodein.di.DI
import org.kodein.di.bind
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.di.ktor.closestDI
import org.kodein.di.ktor.di
import org.kodein.di.singleton
import kotlin.test.Test
import kotlin.test.assertEquals

class SignUpIntegrationTest {

    private fun testModule(cognito: CognitoIdentityProviderClient): DI.Module {
        val config = UsersConfig(setOf("biz"), "us-east-1", "key", "secret", "pool", "client")
        return DI.Module("test") {
            bind<UsersConfig>(overrides = true) { singleton { config } }
            bind<CognitoIdentityProviderClient>(overrides = true) { singleton { cognito } }
        }
    }

    @Test
    fun `registro exitoso de nuevo usuario`() = testApplication {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.adminCreateUser(any<AdminCreateUserRequest>()) } returns AdminCreateUserResponse {}
        application {
            di {
                import(appModule)
                import(testModule(cognito))
            }
            routing {
                post("/{business}/{function}") {
                    val di = closestDI()
                    val logger: org.slf4j.Logger by di.instance()

                    val businessName = call.parameters["business"]
                    val functionName = call.parameters["function"]

                    val functionResponse: Response = if (businessName == null) {
                        RequestValidationException("No business defined on path")
                    } else {
                        val config = di.direct.instance<Config>()
                        logger.info("config.businesses: ${'$'}{config.businesses}")
                        if (!config.businesses.contains(businessName)) {
                            ExceptionResponse("Business not avaiable with name ${'$'}businessName")
                        } else if (functionName == null) {
                            RequestValidationException("No function defined on path")
                        } else {
                            try {
                                val function = di.direct.instance<Function>(tag = functionName)
                                val headers: Map<String, String> = call.request.headers.entries().associate {
                                    it.key to it.value.joinToString(",")
                                }
                                function.execute(businessName, functionName, headers, call.receiveText())
                            } catch (e: DI.NotFoundException) {
                                ExceptionResponse("No function with name ${'$'}functionName found")
                            }
                        }
                    }

                    call.respondText(
                        text = Gson().toJson(functionResponse),
                        contentType = ContentType.Application.Json,
                        status = functionResponse.statusCode
                    )
                }
            }
        }
        val response = client.post("/biz/signup") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            setBody("{\"email\":\"test@example.com\"}")
        }
        assertEquals(HttpStatusCode.OK, response.status)
        coVerify(exactly = 1) { cognito.adminCreateUser(any<AdminCreateUserRequest>()) }
    }

    @Test
    fun `usuario ya existente devuelve error`() = testApplication {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.adminCreateUser(any<AdminCreateUserRequest>()) } throws UsernameExistsException { message = "exists" }
        coEvery { cognito.adminGetUser(any<AdminGetUserRequest>()) } returns AdminGetUserResponse {
            username = "testUser"
            userAttributes = listOf(
                AttributeType { name = BUSINESS_ATT_NAME; value = "biz" }
            )
        }
        coEvery { cognito.adminUpdateUserAttributes(any<AdminUpdateUserAttributesRequest>()) } returns AdminUpdateUserAttributesResponse {}
        application {
            di {
                import(appModule)
                import(testModule(cognito))
            }
            routing {
                post("/{business}/{function}") {
                    val di = closestDI()
                    val logger: org.slf4j.Logger by di.instance()

                    val businessName = call.parameters["business"]
                    val functionName = call.parameters["function"]

                    val functionResponse: Response = if (businessName == null) {
                        RequestValidationException("No business defined on path")
                    } else {
                        val config = di.direct.instance<Config>()
                        logger.info("config.businesses: ${'$'}{config.businesses}")
                        if (!config.businesses.contains(businessName)) {
                            ExceptionResponse("Business not avaiable with name ${'$'}businessName")
                        } else if (functionName == null) {
                            RequestValidationException("No function defined on path")
                        } else {
                            try {
                                val function = di.direct.instance<Function>(tag = functionName)
                                val headers: Map<String, String> = call.request.headers.entries().associate {
                                    it.key to it.value.joinToString(",")
                                }
                                function.execute(businessName, functionName, headers, call.receiveText())
                            } catch (e: DI.NotFoundException) {
                                ExceptionResponse("No function with name ${'$'}functionName found")
                            }
                        }
                    }

                    call.respondText(
                        text = Gson().toJson(functionResponse),
                        contentType = ContentType.Application.Json,
                        status = functionResponse.statusCode
                    )
                }
            }
        }
        val response = client.post("/biz/signup") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            setBody("{\"email\":\"test@example.com\"}")
        }
        assertEquals(HttpStatusCode.InternalServerError, response.status)
    }
}
