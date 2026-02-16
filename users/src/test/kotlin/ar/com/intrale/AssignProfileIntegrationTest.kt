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

class DummyAssignProfileIntgTable : DynamoDbTable<UserBusinessProfile> {
    val items = mutableListOf<UserBusinessProfile>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<UserBusinessProfile> = TableSchema.fromBean(UserBusinessProfile::class.java)
    override fun tableName(): String = "profiles"
    override fun keyFrom(item: UserBusinessProfile): Key = Key.builder().partitionValue(item.compositeKey).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun putItem(item: UserBusinessProfile) { items.add(item) }
    override fun getItem(key: UserBusinessProfile): UserBusinessProfile? =
        items.firstOrNull { it.compositeKey == key.compositeKey }
}

class AssignProfileIntegrationTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")

    @Test
    fun `asignacion exitosa de perfil`() = runBlocking {
        val table = DummyAssignProfileIntgTable()
        // Pre-seed con perfil de admin aprobado
        table.items.add(UserBusinessProfile().apply {
            email = "admin@test.com"
            business = "biz"
            profile = PROFILE_PLATFORM_ADMIN
            state = BusinessState.APPROVED
        })
        val cognito = mockk<CognitoIdentityProviderClient>(relaxed = true)
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "admin@test.com" })
        }
        val assign = AssignProfile(config, logger, cognito, table)

        val response = assign.securedExecute(
            business = "biz",
            function = "assignProfile",
            headers = mapOf("Authorization" to "token"),
            textBody = "{\"email\":\"user@test.com\",\"profile\":\"CLIENT\"}"
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertEquals(2, table.items.size)
        assertEquals("user@test.com#biz#CLIENT", table.items[1].compositeKey)
    }

    @Test
    fun `perfil no autorizado retorna error`() = runBlocking {
        val table = DummyAssignProfileIntgTable()
        val cognito = mockk<CognitoIdentityProviderClient>(relaxed = true)
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = PROFILE_ATT_NAME; value = "OTHER" })
        }
        val assign = AssignProfile(config, logger, cognito, table)

        val response = assign.securedExecute(
            business = "biz",
            function = "assignProfile",
            headers = mapOf("Authorization" to "token"),
            textBody = "{\"email\":\"user@test.com\",\"profile\":\"CLIENT\"}"
        )

        assertEquals(HttpStatusCode.Unauthorized, response.statusCode)
        assertEquals(0, table.items.size)
    }
}
