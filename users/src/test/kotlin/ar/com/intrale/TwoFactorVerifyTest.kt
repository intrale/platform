package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class DummyTwoFactorUserTable : DynamoDbTable<User> {
    val items = mutableListOf<User>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<User> = TableSchema.fromBean(User::class.java)
    override fun tableName(): String = "users"
    override fun keyFrom(item: User): Key = Key.builder().partitionValue(item.email).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun putItem(item: User) { items.add(item) }
    override fun getItem(key: Key): User? = items.find { it.email == key.partitionKeyValue().s() }
}

class TwoFactorVerifyTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = UsersConfig(setOf("biz"), "us-east-1", "key", "secret", "pool", "client")
    private val table = DummyTwoFactorUserTable()
    private val cognito = CognitoIdentityProviderClient { region = config.region }
    private val verify = TwoFactorVerify(config, logger, cognito, table)

    @Test
    fun validRequestPassesValidation() {
        val req = TwoFactorVerifyRequest("123456")
        val resp = verify.requestValidation(req)
        assertEquals(null, resp)
    }

    @Test
    fun generateSecretCreatesBase32String() {
        val secret = verify.generateSecret()
        assertEquals(32, secret.length)
        val other = verify.generateSecret()
        assertNotEquals(secret, other)
    }

    @Test
    fun buildOtpAuthUriFormatsCorrectly() {
        val uri = verify.buildOtpAuthUri("ABC", "user@test.com")
        val expected = "otpauth://totp/intrale:user@test.com?secret=ABC&issuer=intrale&algorithm=SHA1&digits=6&period=30"
        assertEquals(expected, uri)
    }
}

