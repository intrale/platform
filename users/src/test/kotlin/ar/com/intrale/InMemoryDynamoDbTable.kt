package ar.com.intrale

import software.amazon.awssdk.core.pagination.sync.SdkIterable
import software.amazon.awssdk.enhanced.dynamodb.*
import software.amazon.awssdk.enhanced.dynamodb.model.GetItemEnhancedRequest
import software.amazon.awssdk.enhanced.dynamodb.model.Page
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable
import java.util.function.Consumer

/**
 * Implementacion generica in-memory de DynamoDbTable para tests.
 * Reemplaza las multiples DummyTable classes dispersas en los tests.
 */
class InMemoryDynamoDbTable<T>(
    private val tableName: String,
    private val schema: TableSchema<T>,
    private val keyExtractor: (T) -> String
) : DynamoDbTable<T> {

    val items = mutableListOf<T>()

    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<T> = schema
    override fun tableName(): String = tableName
    override fun keyFrom(item: T): Key = Key.builder().partitionValue(keyExtractor(item)).build()
    override fun index(indexName: String): DynamoDbIndex<T> = throw UnsupportedOperationException()

    override fun putItem(item: T) {
        val key = keyExtractor(item)
        val index = items.indexOfFirst { keyExtractor(it) == key }
        if (index >= 0) {
            items[index] = item
        } else {
            items.add(item)
        }
    }

    override fun getItem(key: Key): T? =
        items.firstOrNull { keyExtractor(it) == key.partitionKeyValue().s() }

    override fun getItem(item: T): T? =
        items.firstOrNull { keyExtractor(it) == keyExtractor(item) }

    override fun getItem(request: GetItemEnhancedRequest): T? = getItem(request.key())

    override fun getItem(requestConsumer: Consumer<GetItemEnhancedRequest.Builder>): T? {
        val builder = GetItemEnhancedRequest.builder()
        requestConsumer.accept(builder)
        return getItem(builder.build().key())
    }

    override fun updateItem(item: T): T {
        val key = keyExtractor(item)
        val index = items.indexOfFirst { keyExtractor(it) == key }
        if (index >= 0) {
            items[index] = item
        } else {
            items.add(item)
        }
        return item
    }

    override fun deleteItem(key: Key): T? {
        val index = items.indexOfFirst { keyExtractor(it) == key.partitionKeyValue().s() }
        return if (index >= 0) items.removeAt(index) else null
    }

    override fun deleteItem(item: T): T? {
        val key = keyExtractor(item)
        val index = items.indexOfFirst { keyExtractor(it) == key }
        return if (index >= 0) items.removeAt(index) else null
    }

    override fun scan(): PageIterable<T> =
        PageIterable.create(SdkIterable { mutableListOf(Page.create(items.toList())).iterator() })

    companion object {
        fun forBusiness(): InMemoryDynamoDbTable<Business> =
            InMemoryDynamoDbTable("business", TableSchema.fromBean(Business::class.java)) { it.name ?: "" }

        fun forUser(): InMemoryDynamoDbTable<User> =
            InMemoryDynamoDbTable("users", TableSchema.fromBean(User::class.java)) { it.email ?: "" }

        fun forProfile(): InMemoryDynamoDbTable<UserBusinessProfile> =
            InMemoryDynamoDbTable("userbusinessprofile", TableSchema.fromBean(UserBusinessProfile::class.java)) { it.compositeKey }
    }
}
