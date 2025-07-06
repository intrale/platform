package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.GetUserResponse
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import io.ktor.http.HttpStatusCode
import kotlin.test.Test
import kotlin.test.assertEquals

class DummyBusinessConfigTable : DynamoDbTable<Business> {
    var item: Business? = null
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<Business> = TableSchema.fromBean(Business::class.java)
    override fun tableName(): String = "business"
    override fun keyFrom(item: Business): Key = Key.builder().partitionValue(item.name).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun getItem(key: Key): Business? = item
    override fun updateItem(item: Business) { this.item = item }
    override fun putItem(item: Business) { this.item = item }
}

class ConfigAutoAcceptDeliveriesIntegrationTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = UsersConfig(setOf("biz"), "us-east-1", "key", "secret", "pool", "client")

    @Test
    fun `configuracion exitosa`() = runBlocking {
        val table = DummyBusinessConfigTable().apply { item = Business().apply { name = "biz" } }
        val cognito = mockk<CognitoIdentityProviderClient>(relaxed = true)
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = PROFILE_ATT_NAME; value = PROFILE_BUSINESS_ADMIN })
        }
        val function = ConfigAutoAcceptDeliveries(config, logger, cognito, table)

        val response = function.securedExecute(
            business = "biz",
            function = "configAutoAcceptDeliveries",
            headers = mapOf("Authorization" to "token"),
            textBody = "{\"autoAcceptDeliveries\":true}"
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertEquals(true, table.item?.autoAcceptDeliveries)
    }
}
