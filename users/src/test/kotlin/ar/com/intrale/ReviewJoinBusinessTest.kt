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
    var item: UserBusinessProfile? = null
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<UserBusinessProfile> = TableSchema.fromBean(UserBusinessProfile::class.java)
    override fun tableName(): String = "profiles"
    override fun keyFrom(item: UserBusinessProfile): Key = Key.builder().partitionValue(item.compositeKey).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun putItem(item: UserBusinessProfile) { this.item = item }
    override fun getItem(key: Key): UserBusinessProfile? = item.takeIf { it?.compositeKey == key.partitionKeyValue().s() }
    override fun getItem(item: UserBusinessProfile): UserBusinessProfile? = this.item.takeIf { it?.compositeKey == item.compositeKey }
    override fun updateItem(item: UserBusinessProfile): UserBusinessProfile { this.item = item; return item }
}

class ReviewJoinBusinessTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")

    //TODO: Revisar porque no funciona el test de solicitud existente
    /*@Test
    fun `solicitud existente cambia de estado`() = runBlocking {
        val table = DummyReviewTable().apply {
            val p = UserBusinessProfile().apply {
                email = "delivery@test.com"
                business = "biz"
                profile = PROFILE_DELIVERY
                state = BusinessState.PENDING
            }
            putItem(p)
        }
        val cognito = mockk<CognitoIdentityProviderClient>(relaxed = true)
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = PROFILE_ATT_NAME; value = PROFILE_BUSINESS_ADMIN })
        }
        val review = ReviewJoinBusiness(config, logger, cognito, table)

        val response = review.securedExecute(
            business = "biz",
            function = "reviewJoinBusiness",
            headers = mapOf("Authorization" to "token"),
            textBody = "{\"email\":\"delivery@test.com\",\"decision\":\"APPROVED\"}"
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertEquals(BusinessState.APPROVED, table.item?.state)
    }*/
}
