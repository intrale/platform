package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AdminCreateUserResponse
import aws.sdk.kotlin.services.cognitoidentityprovider.model.ListUsersResponse
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
import kotlin.test.Test
import kotlin.test.assertEquals

class SignUpPlatformAdminTest {
    private val config = testConfig("test")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val table = object : DynamoDbTable<UserBusinessProfile> {
        val items = mutableListOf<UserBusinessProfile>()
        override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
        override fun tableSchema(): TableSchema<UserBusinessProfile> = TableSchema.fromBean(UserBusinessProfile::class.java)
        override fun tableName(): String = "profiles"
        override fun keyFrom(item: UserBusinessProfile): Key = Key.builder().partitionValue(item.compositeKey).build()
        override fun index(indexName: String) = throw UnsupportedOperationException()
        override fun putItem(item: UserBusinessProfile) {
            items.removeIf { it.compositeKey == item.compositeKey }
            items.add(item)
        }
        override fun scan(): PageIterable<UserBusinessProfile> = PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })
        override fun getItem(key: Key): UserBusinessProfile? = null
    }
    private val signUp = SignUpPlatformAdmin(config, NOPLogger.NOP_LOGGER, cognito, table)

    @Test
    fun profileIsPlatformAdmin() {
        assertEquals(PROFILE_PLATFORM_ADMIN, signUp.getProfile())
    }

    @Test
    fun `crea relacion aprobada e idempotente`() = runBlocking {
        coEvery { cognito.listUsers(any()) } returns ListUsersResponse { users = listOf() }
        coEvery { cognito.adminCreateUser(any()) } returns AdminCreateUserResponse {}

        val body = com.google.gson.Gson().toJson(SignUpRequest("admin@test.com"))
        signUp.execute("biz", "signupPlatformAdmin", emptyMap(), body)
        signUp.execute("biz", "signupPlatformAdmin", emptyMap(), body)

        val saved = table.items.first()
        assertEquals(PROFILE_PLATFORM_ADMIN, saved.profile)
        assertEquals(BusinessState.APPROVED, saved.state)
        assertEquals(1, table.items.size)
    }
}
