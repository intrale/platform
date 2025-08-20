package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.receiveText
import io.ktor.server.response.respondText
import io.ktor.server.routing.*
import io.ktor.server.testing.*
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.enhanced.dynamodb.model.Page
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable
import software.amazon.awssdk.core.pagination.sync.SdkIterable
import org.kodein.di.*
import org.kodein.di.ktor.closestDI
import org.kodein.di.ktor.di
import kotlin.test.Test
import kotlin.test.assertEquals

class SignUpPlatformAdminIntegrationTest {

    private fun testModule(cognito: CognitoIdentityProviderClient, items: MutableList<UserBusinessProfile>): DI.Module {
        val config = UsersConfig(setOf("biz"), "us-east-1", "key", "secret", "pool", "client")
        return DI.Module(name = "test", allowSilentOverride = true) {
            bind<UsersConfig>(overrides = true) { singleton { config } }
            bind<CognitoIdentityProviderClient>(overrides = true) { singleton { cognito } }
            bind<DynamoDbTable<UserBusinessProfile>>(overrides = true) {
                singleton {
                    object : DynamoDbTable<UserBusinessProfile> {
                        override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
                        override fun tableSchema(): TableSchema<UserBusinessProfile> = TableSchema.fromBean(UserBusinessProfile::class.java)
                        override fun tableName() = "profiles"
                        override fun keyFrom(item: UserBusinessProfile) = Key.builder().partitionValue(item.compositeKey).build()
                        override fun index(indexName: String) = throw UnsupportedOperationException()
                        override fun putItem(item: UserBusinessProfile) {
                            items.removeIf { it.compositeKey == item.compositeKey }
                            items.add(item)
                        }
                        override fun scan(): PageIterable<UserBusinessProfile> = PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })
                        override fun getItem(key: Key): UserBusinessProfile? = items.find { it.compositeKey == key.partitionKeyValue().s() }
                    }
                }
            }
        }
    }

    @Test
    fun `primer usuario se registra y puede iniciar sesion`() = testApplication {
        val items = mutableListOf<UserBusinessProfile>()
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.listUsers(any()) } returns ListUsersResponse { users = listOf() }
        coEvery { cognito.adminCreateUser(any()) } returns AdminCreateUserResponse { }
        coEvery { cognito.adminInitiateAuth(any()) } returns AdminInitiateAuthResponse {
            authenticationResult = AuthenticationResultType {
                idToken = "id"
                accessToken = "access"
                refreshToken = "refresh"
            }
        }
        coEvery { cognito.adminGetUser(any()) } returns AdminGetUserResponse {
            username = "admin@test.com"
            userAttributes = listOf(AttributeType { name = BUSINESS_ATT_NAME; value = "biz" })
        }
        coEvery { cognito.close() } returns Unit

        application {
            di {
                import(appModule, allowOverride = true)
                import(testModule(cognito, items), allowOverride = true)
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
                            ExceptionResponse("Business not available with name ${'$'}businessName")
                        } else if (functionName == null) {
                            RequestValidationException("No function defined on path")
                        } else {
                            try {
                                val function = di.direct.instance<Function>(tag = functionName)
                                val headers = call.request.headers.entries().associate { it.key to it.value.joinToString(",") }
                                function.execute(businessName, functionName, headers, call.receiveText())
                            } catch (e: DI.NotFoundException) {
                                ExceptionResponse("No function with name ${'$'}functionName found")
                            }
                        }
                    }

                    call.respondText(
                        text = com.google.gson.Gson().toJson(functionResponse),
                        contentType = ContentType.Application.Json,
                        status = functionResponse.statusCode
                    )
                }
            }
        }

        val response = client.post("/biz/signupPlatformAdmin") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            setBody("{\"email\":\"admin@test.com\"}")
        }

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(1, items.size)
        assertEquals(PROFILE_PLATFORM_ADMIN, items.first().profile)
        assertEquals(BusinessState.APPROVED, items.first().state)

        val signInResponse = client.post("/biz/signin") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            setBody("{\"email\":\"admin@test.com\",\"password\":\"pass\"}")
        }
        assertEquals(HttpStatusCode.OK, signInResponse.status)

        coVerify(exactly = 1) { cognito.listUsers(any()) }
        coVerify(exactly = 1) { cognito.adminCreateUser(any()) }
        coVerify(exactly = 1) { cognito.adminInitiateAuth(any()) }
    }

    @Test
    fun `segundo usuario retorna no autorizado`() = testApplication {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.listUsers(any()) } returns ListUsersResponse {
            users = listOf(UserType { username = "existing" })
        }
        coEvery { cognito.close() } returns Unit

        application {
            di {
                import(appModule, allowOverride = true)
                import(testModule(cognito, mutableListOf()), allowOverride = true)
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
                            ExceptionResponse("Business not available with name ${'$'}businessName")
                        } else if (functionName == null) {
                            RequestValidationException("No function defined on path")
                        } else {
                            try {
                                val function = di.direct.instance<Function>(tag = functionName)
                                val headers = call.request.headers.entries().associate { it.key to it.value.joinToString(",") }
                                function.execute(businessName, functionName, headers, call.receiveText())
                            } catch (e: DI.NotFoundException) {
                                ExceptionResponse("No function with name ${'$'}functionName found")
                            }
                        }
                    }

                    call.respondText(
                        text = com.google.gson.Gson().toJson(functionResponse),
                        contentType = ContentType.Application.Json,
                        status = functionResponse.statusCode
                    )
                }
            }
        }

        val response = client.post("/biz/signupPlatformAdmin") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            setBody("{\"email\":\"admin@test.com\"}")
        }

        assertEquals(HttpStatusCode.Unauthorized, response.status)
        coVerify(exactly = 1) { cognito.listUsers(any()) }
        coVerify(exactly = 0) { cognito.adminCreateUser(any()) }
    }
}

