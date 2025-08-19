import ar.com.intrale.*
import ar.com.intrale.Function
import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.GetUserResponse
import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.enhanced.dynamodb.model.Page
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable
import software.amazon.awssdk.core.pagination.sync.SdkIterable
import java.util.function.Consumer
import software.amazon.awssdk.enhanced.dynamodb.model.GetItemEnhancedRequest
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
    override fun getItem(item: Business): Business? = items.find { it.name == item.name }
    override fun getItem(request: GetItemEnhancedRequest): Business? = getItem(request.key())
    override fun getItem(requestConsumer: Consumer<GetItemEnhancedRequest.Builder>): Business? {
        val builder = GetItemEnhancedRequest.builder()
        requestConsumer.accept(builder)
        return getItem(builder.build().key())
    }
    override fun scan(): PageIterable<Business> =
        PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })
    override fun updateItem(item: Business): Business {
        val index = items.indexOfFirst { it.name == item.name }
        if (index >= 0) {
            items[index] = item
        } else {
            items.add(item)
        }
        return item
    }
}

class DummyUserTable : DynamoDbTable<User> {
    val items = mutableListOf<User>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<User> = TableSchema.fromBean(User::class.java)
    override fun tableName(): String = "users"
    override fun keyFrom(item: User): Key = Key.builder().partitionValue(item.email).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun getItem(key: Key): User? = items.find { it.email == key.partitionKeyValue().s() }
    override fun getItem(requestConsumer: Consumer<GetItemEnhancedRequest.Builder>): User? {
        val builder = GetItemEnhancedRequest.builder()
        requestConsumer.accept(builder)
        return getItem(builder.build().key())
    }
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
    override fun scan(): PageIterable<UserBusinessProfile> =
        PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })
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

    private val cognito = mockk<CognitoIdentityProviderClient>()

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

    @Test
    fun negocioDuplicadoNoSeAprueba() = runBlocking {
        tableBusiness.items.clear()
        tableProfiles.items.clear()
        tableUsers.items.clear()

        tableBusiness.putItem(Business(name = "Tienda", state = BusinessState.APPROVED))
        tableBusiness.putItem(Business(name = "tienda", emailAdmin = "admin@biz.com", state = BusinessState.PENDING))
        tableProfiles.putItem(UserBusinessProfile().apply {
            email = "admin@biz.com"
            business = "biz"
            profile = PROFILE_PLATFORM_ADMIN
            state = BusinessState.APPROVED
        })
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "admin@biz.com" })
        }

        val req = ReviewBusinessRegistrationRequest("tienda", "approved", "123456")
        val resp = review.securedExecute("biz", "review", mapOf("Authorization" to "token"), Gson().toJson(req))

        assertEquals("El nombre del negocio ya existe", (resp as ExceptionResponse).message)
    }
}
