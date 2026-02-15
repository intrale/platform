import ar.com.intrale.*
import io.ktor.http.HttpStatusCode
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.GetUserResponse
import io.mockk.*
import kotlinx.coroutines.runBlocking
import com.google.gson.Gson
import software.amazon.awssdk.enhanced.dynamodb.model.Page
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable
import software.amazon.awssdk.core.pagination.sync.SdkIterable
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
    override fun getItem(key: UserBusinessProfile): UserBusinessProfile? =
        items.firstOrNull { it.compositeKey == key.compositeKey }
    override fun scan(): PageIterable<UserBusinessProfile> =
        PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })
}

class AssignProfileTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val table = DummyAssignProfileTable()
    private val cognito = mockk<CognitoIdentityProviderClient>()
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

    @Test
    fun asignaPerfilConEstadoApproved() = runBlocking {
        table.items.clear()
        table.items.add(UserBusinessProfile().apply {
            email = "admin@test.com"
            business = "biz"
            profile = PROFILE_PLATFORM_ADMIN
            state = BusinessState.APPROVED
        })
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "admin@test.com" })
        }
        val body = Gson().toJson(AssignProfileRequest("user@test.com", PROFILE_CLIENT))
        val response = assign.securedExecute("biz", "assign", mapOf("Authorization" to "token"), body)
        assertEquals(HttpStatusCode.OK, response.statusCode)
        val saved = table.items.last()
        assertEquals(BusinessState.APPROVED, saved.state)
    }
}
