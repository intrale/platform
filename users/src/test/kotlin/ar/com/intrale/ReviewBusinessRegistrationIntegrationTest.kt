package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.GetUserResponse
import com.google.gson.Gson
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
import io.mockk.every
import org.kodein.di.*
import org.kodein.di.ktor.closestDI
import org.kodein.di.ktor.di
import ar.com.intrale.SecuredFunction
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import software.amazon.awssdk.enhanced.dynamodb.Key
import kotlin.test.Test
import kotlin.test.assertEquals

class ReviewBusinessRegistrationIntegrationTest {

    class DummyBusinessTable : DynamoDbTable<Business> {
        val items = mutableListOf<Business>()
        override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
        override fun tableSchema(): TableSchema<Business> = TableSchema.fromBean(Business::class.java)
        override fun tableName(): String = "business"
        override fun keyFrom(item: Business): Key = Key.builder().partitionValue(item.name).build()
        override fun index(indexName: String) = throw UnsupportedOperationException()
        override fun putItem(item: Business) { items.add(item) }
        override fun getItem(key: Key): Business? = items.find { it.name == key.partitionKeyValue().s() }
        override fun getItem(item: Business): Business? = items.find { it.name == item.name }
        override fun getItem(request: software.amazon.awssdk.enhanced.dynamodb.model.GetItemEnhancedRequest): Business? = getItem(request.key())
        override fun getItem(requestConsumer: java.util.function.Consumer<software.amazon.awssdk.enhanced.dynamodb.model.GetItemEnhancedRequest.Builder>): Business? {
            val builder = software.amazon.awssdk.enhanced.dynamodb.model.GetItemEnhancedRequest.builder()
            requestConsumer.accept(builder)
            return getItem(builder.build().key())
        }
        override fun updateItem(item: Business): Business {
            val index = items.indexOfFirst { it.name == item.name }
            if (index >= 0) {
                items[index] = item
            } else {
                items.add(item)
            }
            return item
        }
    }


    class DummyProfileTable : DynamoDbTable<UserBusinessProfile> {
        val items = mutableListOf<UserBusinessProfile>()
        override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
        override fun tableSchema(): TableSchema<UserBusinessProfile> = TableSchema.fromBean(UserBusinessProfile::class.java)
        override fun tableName(): String = "profiles"
        override fun keyFrom(item: UserBusinessProfile): Key = Key.builder().partitionValue(item.email).sortValue(item.business).build()
        override fun index(indexName: String) = throw UnsupportedOperationException()
        override fun putItem(item: UserBusinessProfile) { items.add(item) }
    }

    private fun testModule(
        twoFactor: Function,
        signUp: Function,
        cognito: CognitoIdentityProviderClient,
        business: DummyBusinessTable,
        users: DynamoDbTable<User>,
        profiles: DummyProfileTable
    ): DI.Module {
        val config = testConfig("biz")
        return DI.Module(name = "test", allowSilentOverride = true) {
            bind<UsersConfig>(overrides = true) { singleton { config } }
            bind<Function>(tag = "2faverify", overrides = true) { singleton { twoFactor } }
            bind<Function>(tag = "signup", overrides = true) { singleton { signUp } }
            bind<CognitoIdentityProviderClient>(overrides = true) { singleton { cognito } }
            bind<DynamoDbTable<Business>>(overrides = true) { singleton { business } }
            bind<DynamoDbTable<User>>(overrides = true) { singleton { users } }
            bind<DynamoDbTable<UserBusinessProfile>>(overrides = true) { singleton { profiles } }
        }
    }

    //TODO: Revisar porque no funciona el test de revision de negocio
    /*@Test
    fun `revision exitosa del negocio`() = testApplication {
        val twoFactor = mockk<Function>()
        coEvery { twoFactor.execute(any(), any(), any(), any()) } returns Response()
        val signUp = mockk<Function>()
        coEvery { signUp.execute(any(), any(), any(), any()) } returns Response()

        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(
                AttributeType { name = EMAIL_ATT_NAME; value = "admin@biz.com" },
                AttributeType { name = PROFILE_ATT_NAME; value = PLATFORM_ADMIN_PROFILE }
            )
        }
        coEvery { cognito.close() } returns Unit

        val businessTable = DummyBusinessTable().apply {
            putItem(Business(name = "Biz", emailAdmin = "admin@biz.com"))
        }
        val userTable = mockk<DynamoDbTable<User>>()
        every { userTable.getItem(any<User>()) } returns null
        every { userTable.getItem(any<java.util.function.Consumer<software.amazon.awssdk.enhanced.dynamodb.model.GetItemEnhancedRequest.Builder>>()) } returns null
        every { userTable.getItem(any<software.amazon.awssdk.enhanced.dynamodb.model.GetItemEnhancedRequest>()) } returns null
        every { userTable.putItem(any<User>()) } returns Unit
        val profileTable = DummyProfileTable()

        application {
            di {
                import(appModule, allowOverride = true)
                import(testModule(twoFactor, signUp, cognito, businessTable, userTable, profileTable), allowOverride = true)
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
                        text = Gson().toJson(functionResponse),
                        contentType = ContentType.Application.Json,
                        status = functionResponse.statusCode
                    )
                }
            }
        }

        val response = client.post("/biz/reviewBusiness") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            header("Authorization", "token")
            setBody("{\"name\":\"Biz\",\"decision\":\"approved\",\"twoFactorCode\":\"123456\"}")
        }

        assertEquals(HttpStatusCode.OK, response.status)
        coVerify(exactly = 1) { twoFactor.execute(any(), any(), any(), any()) }
        coVerify(exactly = 1) { signUp.execute(any(), any(), any(), any()) }
        assertEquals(BusinessState.APPROVED, businessTable.items.first().state)
    }*/

    @Test
    fun `decision invalida retorna error`() = testApplication {
        val twoFactor = mockk<Function>()
        val signUp = mockk<Function>()
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = emptyList()
        }
        coEvery { cognito.close() } returns Unit

        val businessTable = DummyBusinessTable().apply {
            putItem(Business(name = "Biz", emailAdmin = "admin@biz.com"))
        }
        val userTable = mockk<DynamoDbTable<User>>()
        every { userTable.getItem(any<User>()) } returns null
        every { userTable.getItem(any<java.util.function.Consumer<software.amazon.awssdk.enhanced.dynamodb.model.GetItemEnhancedRequest.Builder>>()) } returns null
        every { userTable.getItem(any<software.amazon.awssdk.enhanced.dynamodb.model.GetItemEnhancedRequest>()) } returns null
        every { userTable.putItem(any<User>()) } returns Unit
        val profileTable = DummyProfileTable()

        application {
            di {
                import(appModule, allowOverride = true)
                import(testModule(twoFactor, signUp, cognito, businessTable, userTable, profileTable), allowOverride = true)
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
                        text = Gson().toJson(functionResponse),
                        contentType = ContentType.Application.Json,
                        status = functionResponse.statusCode
                    )
                }
            }
        }

        val response = client.post("/biz/reviewBusiness") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            setBody("{\"name\":\"Biz\",\"decision\":\"invalid\",\"twoFactorCode\":\"123456\"}")
        }

        assertEquals(HttpStatusCode.BadRequest, response.status)
    }
}

