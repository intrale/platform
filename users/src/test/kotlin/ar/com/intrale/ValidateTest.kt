package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import net.datafaker.Faker
import org.slf4j.Logger
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals

class ValidateTest {
    private val faker = Faker()
    private val logger: Logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("test")

    @Test
    fun returnsOk() = runBlocking {
        val validate = Validate(config, logger)
        val response = validate.securedExecute("", "", emptyMap(), "")
        assertEquals(HttpStatusCode.OK, response.statusCode)
    }
}
