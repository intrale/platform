import ar.com.intrale.*
import io.ktor.http.HttpStatusCode
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.runtime.auth.credentials.StaticCredentialsProvider
import aws.smithy.kotlin.runtime.auth.awscredentials.Credentials
import kotlin.test.Test
import kotlin.test.assertEquals

class DummyAssignProfileTable : DynamoDbTable<UserBusinessProfile> {
    val items = mutableListOf<UserBusinessProfile>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<UserBusinessProfile> = TableSchema.fromBean(UserBusinessProfile::class.java)
    override fun tableName(): String = "profiles"
    override fun keyFrom(item: UserBusinessProfile): Key = Key.builder().partitionValue(item.compositeKey).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun putItem(item: UserBusinessProfile) { items.add(item) }
}

class AssignProfileTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = UsersConfig(setOf("biz"), "us-east-1", "key", "secret", "pool", "client")
    private val table = DummyAssignProfileTable()
    private val cognito = CognitoIdentityProviderClient {
        region = config.region
        credentialsProvider = StaticCredentialsProvider(Credentials(accessKeyId = "key", secretAccessKey = "secret"))
    }
    private val assign = AssignProfile(config, logger, cognito, table)

    @Test
    fun validRequestPassesValidation() {
        val req = AssignProfileRequest("user@test.com", "CLIENT")
        val resp = assign.requestValidation(req)
        assertEquals(null, resp)
    }

    @Test
    fun invalidEmailReturnsError() {
        val req = AssignProfileRequest("invalid", "CLIENT")
        val resp = assign.requestValidation(req)
        assertEquals(HttpStatusCode.BadRequest, (resp as RequestValidationException).statusCode)
    }
}
