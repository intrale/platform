package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminCreateUserResponse
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.GetUserResponse
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receiveText
import io.ktor.server.response.respondText
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import io.ktor.server.testing.TestApplicationBuilder
import io.ktor.server.testing.testApplication
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import org.kodein.di.DI
import org.kodein.di.bind
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.di.singleton
import org.kodein.di.ktor.closestDI
import org.kodein.di.ktor.di
import software.amazon.awssdk.core.pagination.sync.SdkIterable
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbIndex
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.enhanced.dynamodb.model.Page
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

private class InMemoryProfilesTable : DynamoDbTable<UserBusinessProfile> {
    val items = mutableListOf<UserBusinessProfile>()

    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null

    override fun tableSchema(): TableSchema<UserBusinessProfile> =
        TableSchema.fromBean(UserBusinessProfile::class.java)

    override fun tableName(): String = "profiles"

    override fun keyFrom(item: UserBusinessProfile): Key =
        Key.builder().partitionValue(item.compositeKey).build()

    override fun index(indexName: String): DynamoDbIndex<UserBusinessProfile> =
        throw UnsupportedOperationException()

    override fun putItem(item: UserBusinessProfile) {
        items.removeIf { it.compositeKey == item.compositeKey }
        items.add(item)
    }

    override fun getItem(key: Key): UserBusinessProfile? =
        items.firstOrNull { it.compositeKey == key.partitionKeyValue().s() }

    override fun getItem(item: UserBusinessProfile): UserBusinessProfile? =
        items.firstOrNull { it.compositeKey == item.compositeKey }

    override fun updateItem(item: UserBusinessProfile): UserBusinessProfile {
        putItem(item)
        return item
    }

    override fun scan(): PageIterable<UserBusinessProfile> =
        PageIterable.create(SdkIterable { mutableListOf(Page.create(items.toList())).iterator() })
}

class RegisterSalerIntegrationTest {

    private fun TestApplicationBuilder.configureTestApplication(
        cognito: CognitoIdentityProviderClient,
        profilesTable: InMemoryProfilesTable
    ) {
        application {
            di {
                import(appModule, allowOverride = true)
                import(testModule(cognito, profilesTable), allowOverride = true)
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
                        val config = di.direct.instance<Config>() as UsersConfig
                        logger.info("config.businesses: ${config.businesses()}")
                        if (!config.businesses().contains(businessName)) {
                            ExceptionResponse("Business not available with name $businessName")
                        } else if (functionName == null) {
                            RequestValidationException("No function defined on path")
                        } else {
                            try {
                                val function = di.direct.instance<Function>(tag = functionName)
                                val headers = call.request.headers.entries().associate { it.key to it.value.joinToString(",") }
                                if (function is SecuredFunction) {
                                    function.securedExecute(businessName, functionName, headers, call.receiveText())
                                } else {
                                    function.execute(businessName, functionName, headers, call.receiveText())
                                }
                            } catch (e: DI.NotFoundException) {
                                ExceptionResponse("No function with name $functionName found")
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
    }

    private fun testModule(
        cognito: CognitoIdentityProviderClient,
        profilesTable: InMemoryProfilesTable
    ): DI.Module {
        val config = testConfig("biz")
        return DI.Module(name = "test", allowSilentOverride = true) {
            bind<UsersConfig>(overrides = true) { singleton { config } }
            bind<CognitoIdentityProviderClient>(overrides = true) { singleton { cognito } }
            bind<DynamoDbTable<UserBusinessProfile>>(overrides = true) { singleton { profilesTable } }
        }
    }

    @Test
    fun `registro de saler exitoso`() = testApplication {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.adminCreateUser(any()) } returns AdminCreateUserResponse {}
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(
                AttributeType {
                    name = EMAIL_ATT_NAME
                    value = "admin@biz.com"
                }
            )
        }
        coEvery { cognito.close() } returns Unit

        val profilesTable = InMemoryProfilesTable().apply {
            putItem(
                UserBusinessProfile().apply {
                    email = "admin@biz.com"
                    business = "biz"
                    profile = PROFILE_BUSINESS_ADMIN
                    state = BusinessState.APPROVED
                }
            )
        }

        configureTestApplication(cognito, profilesTable)

        val response = client.post("/biz/registerSaler") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            header("Authorization", "token")
            setBody("{\"email\":\"saler@test.com\"}")
        }

        assertEquals(HttpStatusCode.OK, response.status)
        coVerify(exactly = 1) { cognito.adminCreateUser(any()) }
        val relation = profilesTable.items.firstOrNull { it.email == "saler@test.com" }
        assertNotNull(relation)
        assertEquals(BusinessState.APPROVED, relation.state)
        assertEquals(PROFILE_SALER, relation.profile)
    }

    @Test
    fun `falta token retorna unauthorized`() = testApplication {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.close() } returns Unit
        val profilesTable = InMemoryProfilesTable()

        configureTestApplication(cognito, profilesTable)

        val response = client.post("/biz/registerSaler") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            setBody("{\"email\":\"saler@test.com\"}")
        }

        assertEquals(HttpStatusCode.Unauthorized, response.status)
        coVerify(exactly = 0) { cognito.adminCreateUser(any()) }
    }

    @Test
    fun `perfil sin aprobar retorna unauthorized`() = testApplication {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(
                AttributeType {
                    name = EMAIL_ATT_NAME
                    value = "admin@biz.com"
                }
            )
        }
        coEvery { cognito.close() } returns Unit
        val profilesTable = InMemoryProfilesTable()

        configureTestApplication(cognito, profilesTable)

        val response = client.post("/biz/registerSaler") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            header("Authorization", "token")
            setBody("{\"email\":\"saler@test.com\"}")
        }

        assertEquals(HttpStatusCode.Unauthorized, response.status)
        coVerify(exactly = 0) { cognito.adminCreateUser(any()) }
    }

    @Test
    fun `email invalido retorna error`() = testApplication {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(
                AttributeType {
                    name = EMAIL_ATT_NAME
                    value = "admin@biz.com"
                }
            )
        }
        coEvery { cognito.close() } returns Unit
        val profilesTable = InMemoryProfilesTable().apply {
            putItem(
                UserBusinessProfile().apply {
                    email = "admin@biz.com"
                    business = "biz"
                    profile = PROFILE_BUSINESS_ADMIN
                    state = BusinessState.APPROVED
                }
            )
        }

        configureTestApplication(cognito, profilesTable)

        val response = client.post("/biz/registerSaler") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            header("Authorization", "token")
            setBody("{\"email\":\"invalid\"}")
        }

        assertEquals(HttpStatusCode.BadRequest, response.status)
        coVerify(exactly = 0) { cognito.adminCreateUser(any()) }
    }

    @Test
    fun `relacion aprobada retorna conflicto`() = testApplication {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.adminCreateUser(any()) } returns AdminCreateUserResponse {}
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(
                AttributeType {
                    name = EMAIL_ATT_NAME
                    value = "admin@biz.com"
                }
            )
        }
        coEvery { cognito.close() } returns Unit
        val profilesTable = InMemoryProfilesTable().apply {
            putItem(
                UserBusinessProfile().apply {
                    email = "admin@biz.com"
                    business = "biz"
                    profile = PROFILE_BUSINESS_ADMIN
                    state = BusinessState.APPROVED
                }
            )
            putItem(
                UserBusinessProfile().apply {
                    email = "saler@test.com"
                    business = "biz"
                    profile = PROFILE_SALER
                    state = BusinessState.APPROVED
                }
            )
        }

        configureTestApplication(cognito, profilesTable)

        val response = client.post("/biz/registerSaler") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            header("Authorization", "token")
            setBody("{\"email\":\"saler@test.com\"}")
        }

        assertEquals(HttpStatusCode.Conflict, response.status)
        coVerify(exactly = 0) { cognito.adminCreateUser(any()) }
    }
}
