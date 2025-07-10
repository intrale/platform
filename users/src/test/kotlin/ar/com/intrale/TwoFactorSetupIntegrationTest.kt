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
import kotlin.test.assertNotNull

class DummyTwoFactorSetupUserTable : DynamoDbTable<User> {
    val items = mutableListOf<User>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<User> = TableSchema.fromBean(User::class.java)
    override fun tableName(): String = "users"
    override fun keyFrom(item: User): Key = Key.builder().partitionValue(item.email).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun putItem(item: User) {
        val existing = items.indexOfFirst { it.email == item.email }
        if (existing >= 0) {
            items[existing] = item
        } else {
            items.add(item)
        }
    }
    override fun getItem(key: Key): User? = items.find { it.email == key.partitionKeyValue().s() }
}

class TwoFactorSetupIntegrationTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = UsersConfig(setOf("biz"), "us-east-1", "key", "secret", "pool", "client")

    @Test
    fun `setup exitoso guarda usuario y retorna uri`() = runBlocking {
        val table = DummyTwoFactorSetupUserTable()
        val cognito = mockk<CognitoIdentityProviderClient>(relaxed = true)
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "user"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "user@test.com" })
        }
        val setup = TwoFactorSetup(config, logger, cognito, table)

        val response1 = setup.securedExecute(
            business = "biz",
            function = "2fasetup",
            headers = mapOf("Authorization" to "token"),
            textBody = ""
        )

        val response2 = setup.securedExecute(
            business = "biz",
            function = "2fasetup",
            headers = mapOf("Authorization" to "token"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response1.statusCode)
        assertEquals(HttpStatusCode.OK, response2.statusCode)
        assertEquals(1, table.items.size)
        assertEquals("user@test.com", table.items[0].email)
        assertNotNull(table.items[0].secret)
        assert(response1 is TwoFactorSetupResponse)
    }

    @Test
    fun `falta email retorna error`() = runBlocking {
        val table = DummyTwoFactorSetupUserTable()
        val cognito = mockk<CognitoIdentityProviderClient>(relaxed = true)
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "user"
            userAttributes = emptyList()
        }
        val setup = TwoFactorSetup(config, logger, cognito, table)

        val response = setup.securedExecute(
            business = "biz",
            function = "2fasetup",
            headers = mapOf("Authorization" to "token"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.InternalServerError, response.statusCode)
        assertEquals(0, table.items.size)
        assert(response is ExceptionResponse)
    }
}

