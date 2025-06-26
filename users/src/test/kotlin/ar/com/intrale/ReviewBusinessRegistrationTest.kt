import ar.com.intrale.*
import ar.com.intrale.Function
import io.ktor.http.HttpStatusCode
import org.slf4j.helpers.NOPLogger
import aws.sdk.kotlin.runtime.auth.credentials.StaticCredentialsProvider
import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.smithy.kotlin.runtime.auth.awscredentials.Credentials
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import software.amazon.awssdk.enhanced.dynamodb.Key
import kotlin.test.Test
import kotlin.test.assertEquals

class DummyBusinessTable : DynamoDbTable<Business> {
    val items = mutableListOf<Business>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<Business> = TableSchema.fromBean(Business::class.java)
    override fun tableName(): String = "business"
    override fun keyFrom(item: Business): Key = Key.builder().partitionValue(item.name).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun putItem(item: Business) { items.add(item) }
    override fun getItem(key: Key): Business? = items.find { it.name == key.partitionKeyValue().s() }
}

class DummyUserTable : DynamoDbTable<User> {
    val items = mutableListOf<User>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<User> = TableSchema.fromBean(User::class.java)
    override fun tableName(): String = "users"
    override fun keyFrom(item: User): Key = Key.builder().partitionValue(item.email).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun getItem(key: Key): User? = items.find { it.email == key.partitionKeyValue().s() }
    override fun putItem(item: User) { items.add(item) }
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

class ReviewBusinessRegistrationTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = UsersConfig(setOf("biz"), "us-east-1", "key", "secret", "pool", "client")
    private val tableBusiness = DummyBusinessTable()
    private val tableUsers = DummyUserTable()
    private val tableProfiles = DummyProfileTable()

    private val dummyFn = object : ar.com.intrale.Function {
        override suspend fun execute(
            business: String,
            function: String,
            headers: Map<String, String>,
            textBody: String
        ) = Response()
    }

    private val cognito = CognitoIdentityProviderClient {
        region = config.region
        credentialsProvider = StaticCredentialsProvider(
            Credentials(accessKeyId = "key", secretAccessKey = "secret")
        )
    }

    private val review = ReviewBusinessRegistration(
        config,
        logger,
        dummyFn,
        dummyFn,
        cognito = cognito,
        tableBusiness = tableBusiness,
        tableUsers = tableUsers,
        tableProfiles = tableProfiles
    )

    @Test
    fun validRequestPassesValidation() {
        val req = ReviewBusinessRegistrationRequest("Biz", "approved", "123456")
        val resp = review.requestValidation(req)
        assertEquals(null, resp)
    }

    @Test
    fun invalidDecisionReturnsError() {
        val req = ReviewBusinessRegistrationRequest("Biz", "invalid", "123456")
        val resp = review.requestValidation(req)
        assertEquals(HttpStatusCode.BadRequest, (resp as RequestValidationException).statusCode)
    }
}
