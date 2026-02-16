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

class DummyReviewTable : DynamoDbTable<UserBusinessProfile> {
    val items = mutableListOf<UserBusinessProfile>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<UserBusinessProfile> = TableSchema.fromBean(UserBusinessProfile::class.java)
    override fun tableName(): String = "profiles"
    override fun keyFrom(item: UserBusinessProfile): Key = Key.builder().partitionValue(item.compositeKey).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun putItem(item: UserBusinessProfile) { items.add(item) }
    override fun getItem(key: Key): UserBusinessProfile? = items.find { it.compositeKey == key.partitionKeyValue().s() }
    override fun getItem(item: UserBusinessProfile): UserBusinessProfile? = items.find { it.compositeKey == item.compositeKey }
    override fun updateItem(item: UserBusinessProfile): UserBusinessProfile {
        val idx = items.indexOfFirst { it.compositeKey == item.compositeKey }
        if (idx >= 0) items[idx] = item
        return item
    }
}

class ReviewJoinBusinessTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")

    @Test
    fun `solicitud existente cambia de estado`() = runBlocking {
        val table = DummyReviewTable().apply {
            // Pre-seed con perfil admin aprobado
            putItem(UserBusinessProfile().apply {
                email = "admin@biz.com"
                business = "biz"
                profile = PROFILE_BUSINESS_ADMIN
                state = BusinessState.APPROVED
            })
            // Pre-seed con perfil delivery pendiente
            putItem(UserBusinessProfile().apply {
                email = "delivery@test.com"
                business = "biz"
                profile = PROFILE_DELIVERY
                state = BusinessState.PENDING
            })
        }
        val cognito = mockk<CognitoIdentityProviderClient>(relaxed = true)
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "admin@biz.com" })
        }
        val review = ReviewJoinBusiness(config, logger, cognito, table)

        val response = review.securedExecute(
            business = "biz",
            function = "reviewJoinBusiness",
            headers = mapOf("Authorization" to "token"),
            textBody = "{\"email\":\"delivery@test.com\",\"decision\":\"APPROVED\"}"
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val deliveryProfile = table.items.find { it.profile == PROFILE_DELIVERY }
        assertEquals(BusinessState.APPROVED, deliveryProfile?.state)
    }
}
