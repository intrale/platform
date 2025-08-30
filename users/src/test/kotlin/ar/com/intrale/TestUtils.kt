package ar.com.intrale

import software.amazon.awssdk.core.pagination.sync.SdkIterable
import software.amazon.awssdk.enhanced.dynamodb.*
import software.amazon.awssdk.enhanced.dynamodb.model.Page
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable

class DummyBusinessTable : DynamoDbTable<Business> {
    val items = mutableListOf<Business>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<Business> = TableSchema.fromBean(Business::class.java)
    override fun tableName(): String = "business"
    override fun keyFrom(item: Business): Key = Key.builder().partitionValue(item.name).build()
    override fun index(indexName: String): DynamoDbIndex<Business> = throw UnsupportedOperationException()
    override fun putItem(item: Business) { items.add(item) }
    override fun scan(): PageIterable<Business> =
        PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })
}

fun testConfig(vararg businesses: String): UsersConfig {
    val table = DummyBusinessTable().apply {
        businesses.forEach {
            items.add(
                Business(
                    name = it,
                    publicId = it,
                    state = BusinessState.APPROVED
                )
            )
        }
    }
    return UsersConfig(
        region = "us-east-1",
        accessKeyId = "key",
        secretAccessKey = "secret",
        awsCognitoUserPoolId = "pool",
        awsCognitoClientId = "client",
        tableBusiness = table
    )
}
