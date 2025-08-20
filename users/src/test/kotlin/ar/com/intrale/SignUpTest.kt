package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import com.google.gson.Gson
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.enhanced.dynamodb.model.Page
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable
import software.amazon.awssdk.core.pagination.sync.SdkIterable
import kotlin.test.Test
import kotlin.test.assertEquals

class SignUpTest {
    private val config = UsersConfig(setOf("test"), "us-east-1", "key", "secret", "pool", "client")
    private val cognito = mockk<CognitoIdentityProviderClient>(relaxed = true)
    private val table = object : DynamoDbTable<UserBusinessProfile> {
        val items = mutableListOf<UserBusinessProfile>()
        override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
        override fun tableSchema(): TableSchema<UserBusinessProfile> = TableSchema.fromBean(UserBusinessProfile::class.java)
        override fun tableName(): String = "profiles"
        override fun keyFrom(item: UserBusinessProfile): Key = Key.builder().partitionValue(item.compositeKey).build()
        override fun index(indexName: String) = throw UnsupportedOperationException()
        override fun putItem(item: UserBusinessProfile) { items.add(item) }
        override fun scan(): PageIterable<UserBusinessProfile> =
            PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })
        override fun getItem(key: Key): UserBusinessProfile? = items.find { it.compositeKey == key.partitionKeyValue().s() }
    }
    private val signUp = SignUp(config, NOPLogger.NOP_LOGGER, cognito, table)

    @Test
    fun profileIsDefault() {
        assertEquals(DEFAULT_PROFILE, signUp.getProfile())
    }

    @Test
    fun emptyBodyReturnsError() = runBlocking {
        val resp = signUp.execute("biz", "signup", emptyMap(), "")
        assertEquals("Request body not found", (resp as RequestValidationException).message)
    }

    @Test
    fun statePendingWhenNoApprovedProfile() = runBlocking {
        table.items.clear()
        val body = Gson().toJson(SignUpRequest("user@test.com"))
        signUp.execute("biz", "signup", emptyMap(), body)
        val saved = table.items.first()
        assertEquals(BusinessState.PENDING, saved.state)
    }

    @Test
    fun stateApprovedWhenExistingApproved() = runBlocking {
        table.items.clear()
        table.items.add(UserBusinessProfile().apply {
            email = "user@test.com"
            business = "other"
            profile = DEFAULT_PROFILE
            state = BusinessState.APPROVED
        })
        val body = Gson().toJson(SignUpRequest("user@test.com"))
        signUp.execute("biz", "signup", emptyMap(), body)
        val saved = table.items.last()
        assertEquals(BusinessState.APPROVED, saved.state)
    }
}
