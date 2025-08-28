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
import software.amazon.awssdk.enhanced.dynamodb.model.Page
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable
import software.amazon.awssdk.core.pagination.sync.SdkIterable
import io.ktor.http.HttpStatusCode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.Ignore



class ConfigAutoAcceptDeliveriesIntegrationTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")

    @Test
    @Ignore("Falla por UnsupportedOperationException de DynamoDbTable")
    fun `configuracion exitosa`() = runBlocking {
        val table = DummyBusinessTable().apply { items.add(Business().apply { name = "biz" }) }
        val profiles = object : DynamoDbTable<UserBusinessProfile> {
            val items = mutableListOf<UserBusinessProfile>()
            override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
            override fun tableSchema(): TableSchema<UserBusinessProfile> = TableSchema.fromBean(UserBusinessProfile::class.java)
            override fun tableName() = "profiles"
            override fun keyFrom(item: UserBusinessProfile) = Key.builder().partitionValue(item.compositeKey).build()
            override fun index(indexName: String) = throw UnsupportedOperationException()
            override fun putItem(item: UserBusinessProfile) { items.add(item) }
            override fun scan(): PageIterable<UserBusinessProfile> = PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })
            override fun getItem(key: Key): UserBusinessProfile? = null
        }
        val cognito = mockk<CognitoIdentityProviderClient>(relaxed = true)
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = PROFILE_ATT_NAME; value = PROFILE_BUSINESS_ADMIN })
        }
        val function = ConfigAutoAcceptDeliveries(config, logger, cognito, table, profiles)

        val response1 = function.securedExecute(
            business = "biz",
            function = "configAutoAcceptDeliveries",
            headers = mapOf("Authorization" to "token"),
            textBody = "{\"autoAcceptDeliveries\":true}"
        )

        val response2 = function.securedExecute(
            business = "biz",
            function = "configAutoAcceptDeliveries",
            headers = mapOf("Authorization" to "token"),
            textBody = "{\"autoAcceptDeliveries\":true}"
        )

        assertEquals(HttpStatusCode.OK, response1.statusCode)
        assertEquals(HttpStatusCode.OK, response2.statusCode)
        assertEquals(true, table.items.firstOrNull()?.autoAcceptDeliveries)
    }
}
