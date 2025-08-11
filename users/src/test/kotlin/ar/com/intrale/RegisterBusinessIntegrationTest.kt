package ar.com.intrale

import com.google.gson.Gson
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.receiveText
import io.ktor.server.response.respondText
import io.ktor.server.routing.*
import io.ktor.server.testing.*
import org.kodein.di.*
import org.kodein.di.ktor.closestDI
import org.kodein.di.ktor.di
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import kotlin.test.Test
import kotlin.test.assertEquals

class RegisterBusinessIntegrationTest {

    class DummyBusinessTable : DynamoDbTable<Business> {
        val items = mutableListOf<Business>()
        override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
        override fun tableSchema(): TableSchema<Business> = TableSchema.fromBean(Business::class.java)
        override fun tableName(): String = "business"
        override fun keyFrom(item: Business): Key = Key.builder().partitionValue(item.name).build()
        override fun index(indexName: String) = throw UnsupportedOperationException()
        override fun putItem(item: Business) { items.add(item) }
        override fun getItem(item: Business): Business? = items.find { it.name == item.name }
    }

    private fun testModule(table: DummyBusinessTable): DI.Module {
        val config = UsersConfig(setOf("biz"), "us-east-1", "key", "secret", "pool", "client")
        return DI.Module(name = "test", allowSilentOverride = true) {
            bind<UsersConfig>(overrides = true) { singleton { config } }
            bind<DynamoDbTable<Business>>(overrides = true) { singleton { table } }
        }
    }

    @Test
    fun `registro exitoso del negocio`() = testApplication {
        val table = DummyBusinessTable()

        application {
            di {
                import(appModule, allowOverride = true)
                import(testModule(table), allowOverride = true)
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
                        text = Gson().toJson(functionResponse),
                        contentType = ContentType.Application.Json,
                        status = functionResponse.statusCode
                    )
                }
            }
        }

        val response = client.post("/biz/registerBusiness") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            setBody("{\"name\":\"Biz\",\"emailAdmin\":\"biz@test.com\",\"description\":\"desc\"}")
        }

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(1, table.items.size)
    }

    @Test
    fun `email invalido retorna error`() = testApplication {
        val table = DummyBusinessTable()

        application {
            di {
                import(appModule, allowOverride = true)
                import(testModule(table), allowOverride = true)
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
                        text = Gson().toJson(functionResponse),
                        contentType = ContentType.Application.Json,
                        status = functionResponse.statusCode
                    )
                }
            }
        }

        val response = client.post("/biz/registerBusiness") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            setBody("{\"name\":\"Biz\",\"emailAdmin\":\"invalid\",\"description\":\"desc\"}")
        }

        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals(0, table.items.size)
    }

    @Test
    fun `registro duplicado retorna error`() = testApplication {
        val table = DummyBusinessTable()

        application {
            di {
                import(appModule, allowOverride = true)
                import(testModule(table), allowOverride = true)
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
                        text = Gson().toJson(functionResponse),
                        contentType = ContentType.Application.Json,
                        status = functionResponse.statusCode
                    )
                }
            }
        }

        val body = "{\"name\":\"Biz\",\"emailAdmin\":\"biz@test.com\",\"description\":\"desc\"}"
        val first = client.post("/biz/registerBusiness") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            setBody(body)
        }
        assertEquals(HttpStatusCode.OK, first.status)

        val second = client.post("/biz/registerBusiness") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            setBody(body)
        }
        assertEquals(HttpStatusCode.BadRequest, second.status)
        assertEquals(1, table.items.size)
    }
}

