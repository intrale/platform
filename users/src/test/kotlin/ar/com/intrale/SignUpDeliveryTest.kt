package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
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

class SignUpDeliveryTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("test")
    private val cognito = CognitoIdentityProviderClient {
        region = config.region
    }

    @Test
    fun profileIsDelivery() {
        val table = object : DynamoDbTable<UserBusinessProfile> {
            val items = mutableListOf<UserBusinessProfile>()
            override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
            override fun tableSchema(): TableSchema<UserBusinessProfile> = TableSchema.fromBean(UserBusinessProfile::class.java)
            override fun tableName(): String = "profiles"
            override fun keyFrom(item: UserBusinessProfile): Key = Key.builder().partitionValue(item.compositeKey).build()
            override fun index(indexName: String) = throw UnsupportedOperationException()
            override fun putItem(item: UserBusinessProfile) { items.add(item) }
            override fun scan(): PageIterable<UserBusinessProfile> =
                PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })
            override fun getItem(key: Key): UserBusinessProfile? = null
        }
        val signup = SignUpDelivery(config, logger, cognito, table)
        assertEquals(PROFILE_DELIVERY, signup.getProfile())
    }
}
