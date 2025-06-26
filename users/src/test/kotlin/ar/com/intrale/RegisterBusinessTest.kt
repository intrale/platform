import ar.com.intrale.*
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import kotlin.test.Test
import kotlin.test.assertEquals

class DummyTable : DynamoDbTable<Business> {
    val items = mutableListOf<Business>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<Business> = TableSchema.fromBean(Business::class.java)
    override fun tableName(): String = "dummy"
    override fun keyFrom(item: Business): Key = Key.builder().partitionValue(item.name).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun putItem(item: Business) { items.add(item) }
}

class RegisterBusinessTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = UsersConfig(setOf("test"), "us-east-1", "key", "secret", "pool", "client")
    private val table = DummyTable()
    private val register = RegisterBusiness(config, logger, table)

    @Test
    fun validRequestPassesValidation() {
        val req = RegisterBusinessRequest("Biz", "biz@test.com", "desc")
        val resp = register.requestValidation(req)
        assertEquals(null, resp)
    }

    @Test
    fun invalidEmailReturnsError() {
        val req = RegisterBusinessRequest("Biz", "invalid", "desc")
        val resp = register.requestValidation(req)
        assertEquals(HttpStatusCode.BadRequest, (resp as RequestValidationException).statusCode)
    }

    @Test
    fun executeStoresBusiness() = runBlocking {
        val body = "{\"name\":\"Biz\",\"emailAdmin\":\"biz@test.com\",\"description\":\"desc\"}"
        val resp = register.execute("test","register", emptyMap(), body)
        assertEquals(HttpStatusCode.OK, resp.statusCode)
        assertEquals(1, table.items.size)
    }
}
