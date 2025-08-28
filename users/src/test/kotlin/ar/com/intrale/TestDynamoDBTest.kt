import ar.com.intrale.*
import kotlinx.coroutines.runBlocking
import net.datafaker.Faker
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals

class TestDynamoDBTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val faker = Faker()
    private val testDynamo = TestDynamoDB(config, faker, logger)

    @Test
    fun `securedExecute retorna respuesta exitosa`() = runBlocking {
        val resp = testDynamo.securedExecute("biz", "test", emptyMap(), "")
        assertEquals(io.ktor.http.HttpStatusCode.OK, resp.statusCode)
    }
}
