package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BusinessOrderAnomaliesFunctionTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val anomalyRepository = OrderAnomalyRepository()
    private val configStore = AnomalyConfigStore()
    private val validator = LocalJwtValidator()

    private fun createFunction() = BusinessOrderAnomaliesFunction(
        config, logger, anomalyRepository, configStore, validator
    )

    @Test
    fun `listar anomalías retorna lista vacía cuando no hay registros`() = runBlocking {
        val function = createFunction()
        val email = "admin@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "business/anomalies",
            headers = mapOf("Authorization" to validator.generateToken(email)),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is AnomalyListResponse)
        assertEquals(0, (response as AnomalyListResponse).anomalies.size)
        assertEquals(0, response.total)
    }

    @Test
    fun `listar anomalías retorna registros existentes`() = runBlocking {
        // Registrar una anomalía
        anomalyRepository.record(
            "biz", "user@test.com", "order-1",
            OrderAnomaly(
                type = AnomalyType.DUPLICATE_ORDER,
                severity = AnomalySeverity.HIGH,
                description = "Pedido duplicado"
            )
        )

        val function = createFunction()
        val response = function.securedExecute(
            business = "biz",
            function = "business/anomalies",
            headers = mapOf("Authorization" to validator.generateToken("admin@test.com")),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val anomalyResponse = response as AnomalyListResponse
        assertEquals(1, anomalyResponse.anomalies.size)
        assertEquals(1, anomalyResponse.unresolved)
        assertEquals("Pedido duplicado", anomalyResponse.anomalies.first().description)
    }

    @Test
    fun `resolver anomalía la marca como resuelta`() = runBlocking {
        val anomaly = OrderAnomaly(
            id = "anomaly-123",
            type = AnomalyType.UNUSUAL_AMOUNT,
            severity = AnomalySeverity.MEDIUM,
            description = "Monto inusual"
        )
        anomalyRepository.record("biz", "user@test.com", "order-1", anomaly)

        val function = createFunction()
        val response = function.securedExecute(
            business = "biz",
            function = "business/anomalies/resolve",
            headers = mapOf(
                "Authorization" to validator.generateToken("admin@test.com"),
                "X-Http-Method" to "PUT"
            ),
            textBody = """{"anomalyId": "anomaly-123"}"""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is AnomalyResolveResponse)

        // Verificar que la anomalía fue resuelta
        val unresolved = anomalyRepository.listUnresolved("biz")
        assertEquals(0, unresolved.size)
    }

    @Test
    fun `resolver anomalía inexistente retorna not found`() = runBlocking {
        val function = createFunction()
        val response = function.securedExecute(
            business = "biz",
            function = "business/anomalies/resolve",
            headers = mapOf(
                "Authorization" to validator.generateToken("admin@test.com"),
                "X-Http-Method" to "PUT"
            ),
            textBody = """{"anomalyId": "no-existe"}"""
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `obtener configuración retorna valores por defecto`() = runBlocking {
        val function = createFunction()
        val response = function.securedExecute(
            business = "biz",
            function = "business/anomalies/config",
            headers = mapOf("Authorization" to validator.generateToken("admin@test.com")),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val configResponse = response as AnomalyConfigResponse
        assertEquals(5L, configResponse.config.duplicateWindowMinutes)
        assertEquals(3.0, configResponse.config.amountMultiplierThreshold)
    }

    @Test
    fun `actualizar configuración modifica los valores`() = runBlocking {
        val function = createFunction()
        val response = function.securedExecute(
            business = "biz",
            function = "business/anomalies/config",
            headers = mapOf(
                "Authorization" to validator.generateToken("admin@test.com"),
                "X-Http-Method" to "PUT"
            ),
            textBody = """{"duplicateWindowMinutes": 10, "amountMultiplierThreshold": 5.0}"""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val configResponse = response as AnomalyConfigResponse
        assertEquals(10L, configResponse.config.duplicateWindowMinutes)
        assertEquals(5.0, configResponse.config.amountMultiplierThreshold)
        // Los valores no enviados mantienen el default
        assertEquals(3, configResponse.config.minOrdersForAverage)
    }

    @Test
    fun `filtrar anomalías no resueltas`() = runBlocking {
        anomalyRepository.record(
            "biz", "user@test.com", "order-1",
            OrderAnomaly(id = "a1", type = AnomalyType.DUPLICATE_ORDER, severity = AnomalySeverity.HIGH, description = "Dup 1")
        )
        anomalyRepository.record(
            "biz", "user@test.com", "order-2",
            OrderAnomaly(id = "a2", type = AnomalyType.UNUSUAL_AMOUNT, severity = AnomalySeverity.MEDIUM, description = "Amount 1")
        )
        anomalyRepository.resolve("biz", "a1")

        val function = createFunction()
        val response = function.securedExecute(
            business = "biz",
            function = "business/anomalies",
            headers = mapOf(
                "Authorization" to validator.generateToken("admin@test.com"),
                "X-Query-Resolved" to "false"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val anomalyResponse = response as AnomalyListResponse
        assertEquals(1, anomalyResponse.anomalies.size)
        assertEquals("Amount 1", anomalyResponse.anomalies.first().description)
        assertEquals(2, anomalyResponse.total)
        assertEquals(1, anomalyResponse.unresolved)
    }
}
