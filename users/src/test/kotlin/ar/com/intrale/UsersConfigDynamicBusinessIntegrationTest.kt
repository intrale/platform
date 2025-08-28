package ar.com.intrale

import com.google.gson.Gson
import io.ktor.client.request.*
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.receiveText
import io.ktor.server.response.respondText
import io.ktor.server.routing.*
import io.ktor.server.testing.*
import io.mockk.coEvery
import io.mockk.mockk
import software.amazon.awssdk.core.pagination.sync.SdkIterable
import software.amazon.awssdk.enhanced.dynamodb.*
import software.amazon.awssdk.enhanced.dynamodb.model.Page
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable
import kotlin.test.Test
import kotlin.test.assertEquals

class UsersConfigDynamicBusinessIntegrationTest {

    class DummyBusinessTable : DynamoDbTable<Business> {
        val items = mutableListOf<Business>()
        override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
        override fun tableSchema(): TableSchema<Business> = TableSchema.fromBean(Business::class.java)
        override fun tableName(): String = "business"
        override fun keyFrom(item: Business): Key = Key.builder().partitionValue(item.name).build()
        override fun index(indexName: String) = throw UnsupportedOperationException()
        override fun putItem(item: Business) { items.add(item) }
        override fun scan(): PageIterable<Business> = PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })
    }

    private fun buildConfig(table: DummyBusinessTable): UsersConfig {
        return UsersConfig(
            region = "us-east-1",
            accessKeyId = "key",
            secretAccessKey = "secret",
            awsCognitoUserPoolId = "pool",
            awsCognitoClientId = "client",
            tableBusiness = table
        )
    }

    @Test
    fun `nuevo negocio aprobado se habilita sin reiniciar`() = testApplication {
        val dummy = mockk<Function>()
        coEvery { dummy.execute(any(), any(), any(), any()) } returns Response()

        val table = DummyBusinessTable()

        application {
            routing {
                post("/{business}/{function}") {
                    val businessName = call.parameters["business"]
                    val functionName = call.parameters["function"]

                    val config = buildConfig(table)
                    val functionResponse: Response = if (businessName == null) {
                        RequestValidationException("No business defined on path")
                    } else if (!config.businesses().contains(businessName)) {
                        ExceptionResponse("Business not available with name $businessName")
                    } else if (functionName == null) {
                        RequestValidationException("No function defined on path")
                    } else {
                        dummy.execute(businessName, functionName, emptyMap(), call.receiveText())
                    }

                    call.respondText(
                        text = Gson().toJson(functionResponse),
                        contentType = ContentType.Application.Json,
                        status = functionResponse.statusCode
                    )
                }
            }
        }

        val before = client.post("/biz/dummy") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            setBody("{}")
        }
        assertEquals(HttpStatusCode.InternalServerError, before.status)

        table.putItem(Business(name = "biz", state = BusinessState.APPROVED))

        val after = client.post("/biz/dummy") {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            setBody("{}")
        }
        assertEquals(HttpStatusCode.OK, after.status)
    }
}
