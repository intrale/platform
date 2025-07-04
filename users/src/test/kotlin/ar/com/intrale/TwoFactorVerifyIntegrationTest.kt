package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.GetUserResponse
import com.eatthepath.otp.TimeBasedOneTimePasswordGenerator
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.apache.commons.codec.binary.Base32
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import java.time.Instant
import javax.crypto.spec.SecretKeySpec
import kotlin.test.Test
import kotlin.test.assertEquals

class DummyVerifyTable : DynamoDbTable<User> {
    val items = mutableListOf<User>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<User> = TableSchema.fromBean(User::class.java)
    override fun tableName(): String = "users"
    override fun keyFrom(item: User): Key = Key.builder().partitionValue(item.email).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun putItem(item: User) { items.add(item) }
    override fun getItem(key: Key): User? = items.find { it.email == key.partitionKeyValue().s() }
    override fun getItem(item: User): User? = items.find { it.email == item.email }
    override fun getItem(request: software.amazon.awssdk.enhanced.dynamodb.model.GetItemEnhancedRequest): User? = getItem(request.key())
    override fun getItem(requestConsumer: java.util.function.Consumer<software.amazon.awssdk.enhanced.dynamodb.model.GetItemEnhancedRequest.Builder>): User? {
        val builder = software.amazon.awssdk.enhanced.dynamodb.model.GetItemEnhancedRequest.builder()
        requestConsumer.accept(builder)
        return getItem(builder.build().key())
    }
}

class TwoFactorVerifyIntegrationTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = UsersConfig(setOf("biz"), "us-east-1", "key", "secret", "pool", "client")

    @Test
    fun `codigo valido retorna exito`() = runBlocking {
        val table = DummyVerifyTable()
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "user"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "user@test.com" })
        }
        coEvery { cognito.close() } returns Unit
        val verify = TwoFactorVerify(config, logger, cognito, table)

        val secret = verify.generateSecret()
        table.putItem(User(email = "user@test.com", secret = secret))

        val generator = TimeBasedOneTimePasswordGenerator()
        val key = SecretKeySpec(Base32().decode(secret), "HmacSHA1")
        val code = generator.generateOneTimePassword(key, Instant.now()).toString()

        val resp = verify.securedExecute(
            business = "biz",
            function = "2faverify",
            headers = mapOf("Authorization" to "token"),
            textBody = "{\"code\":\"$code\"}"
        )

        assertEquals(io.ktor.http.HttpStatusCode.OK, resp.statusCode)
    }

    @Test
    fun `codigo invalido retorna error`() = runBlocking {
        val table = DummyVerifyTable()
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "user"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "user@test.com" })
        }
        coEvery { cognito.close() } returns Unit
        val verify = TwoFactorVerify(config, logger, cognito, table)

        val secret = verify.generateSecret()
        table.putItem(User(email = "user@test.com", secret = secret))

        val resp = verify.securedExecute(
            business = "biz",
            function = "2faverify",
            headers = mapOf("Authorization" to "token"),
            textBody = "{\"code\":\"000000\"}"
        )

        assertEquals(io.ktor.http.HttpStatusCode.InternalServerError, resp.statusCode)
    }
}
