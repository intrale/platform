package ar.com.intrale

import com.google.gson.Gson
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.enhanced.dynamodb.model.Page
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable
import software.amazon.awssdk.enhanced.dynamodb.model.ScanEnhancedRequest
import software.amazon.awssdk.core.pagination.sync.SdkIterable
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SearchDummyBusinessTable : DynamoDbTable<Business> {
    val items = mutableListOf<Business>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<Business> = TableSchema.fromBean(Business::class.java)
    override fun tableName(): String = "business"
    override fun keyFrom(item: Business): Key = Key.builder().partitionValue(item.name).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun scan(request: ScanEnhancedRequest?): PageIterable<Business> {
        val sorted = items.sortedBy { it.name }
        val startKey = request?.exclusiveStartKey()?.get("name")?.s()
        val startIndex = startKey?.let { sorted.indexOfFirst { b -> b.name == it } + 1 } ?: 0
        val limit = request?.limit() ?: sorted.size
        val pageItems = sorted.drop(startIndex).take(limit)
        val last = if (startIndex + pageItems.size < sorted.size) sorted[startIndex + pageItems.size - 1].name else null
        val page = if (last != null)
            Page.create(pageItems, mutableMapOf("name" to AttributeValue.builder().s(last).build()))
        else Page.create(pageItems)
        return PageIterable.create(SdkIterable { mutableListOf(page).iterator() })
    }

    override fun scan(): PageIterable<Business> {
        val page = Page.create(items)
        return PageIterable.create(SdkIterable { mutableListOf(page).iterator() })
    }
}

class SearchBusinessesTest {
    private val logger = NOPLogger.NOP_LOGGER

    @Test
    fun `busca negocios con filtros y paginacion`() = runBlocking {
        val table = SearchDummyBusinessTable()
        table.items += Business(name = "Alpha", emailAdmin = "a@admin.com", description = "", state = BusinessState.APPROVED, autoAcceptDeliveries = false)
        table.items += Business(name = "Beta", emailAdmin = "b@admin.com", description = "", state = BusinessState.PENDING, autoAcceptDeliveries = false)
        table.items += Business(name = "Gamma", emailAdmin = "g@admin.com", description = "", state = BusinessState.APPROVED, autoAcceptDeliveries = true)

        val search = SearchBusinesses(table, logger)

        val req1 = SearchBusinessesRequest(query = "a", status = "APPROVED", limit = 1)
        val resp1 = search.execute("biz", "searchBusinesses", emptyMap(), Gson().toJson(req1)) as SearchBusinessesResponse
        assertEquals(1, resp1.businesses.size)
        assertEquals("Alpha", resp1.businesses[0].name)
        assertEquals("Alpha", resp1.lastKey)

        val req2 = SearchBusinessesRequest(query = "a", status = "APPROVED", limit = 1, lastKey = resp1.lastKey)
        val resp2 = search.execute("biz", "searchBusinesses", emptyMap(), Gson().toJson(req2)) as SearchBusinessesResponse
        assertEquals(1, resp2.businesses.size)
        assertEquals("Gamma", resp2.businesses[0].name)
        assertNull(resp2.lastKey)
    }
}
