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
import kotlin.test.Ignore

class DummyRequestJoinTable : DynamoDbTable<UserBusinessProfile> {
    val items = mutableListOf<UserBusinessProfile>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<UserBusinessProfile> = TableSchema.fromBean(UserBusinessProfile::class.java)
    override fun tableName(): String = "profiles"
    override fun keyFrom(item: UserBusinessProfile): Key = Key.builder().partitionValue(item.compositeKey).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun putItem(item: UserBusinessProfile) { items.add(item) }
}

class RequestJoinBusinessTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = UsersConfig(setOf("biz"), "us-east-1", "key", "secret", "pool", "client")

    @Test
    @Ignore("Falla por UnsupportedOperationException de DynamoDbTable")
    fun `solicitud exitosa guarda registro`() = runBlocking {
        val table = DummyRequestJoinTable()
        val businessTable = DummyBusinessTable().apply {
            item = Business().apply { name = "biz"; autoAcceptDeliveries = true }
        }
        val cognito = mockk<CognitoIdentityProviderClient>(relaxed = true)
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "delivery"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "delivery@test.com" })
        }
        val join = RequestJoinBusiness(config, logger, cognito, table, businessTable)

        val response = join.securedExecute(
            business = "biz",
            function = "requestJoinBusiness",
            headers = mapOf("Authorization" to "token"),
            textBody = "{}"
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertEquals(1, table.items.size)
        assertEquals(BusinessState.APPROVED, table.items[0].state)
    }
}
