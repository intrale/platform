package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DeliveryTimeEstimationFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("pizzeria")
    private val estimationRepository = DeliveryTimeEstimationRepository()
    private val clientOrderRepository = ClientOrderRepository()
    private val deliveryOrderRepository = DeliveryOrderRepository()
    private val validator = LocalJwtValidator()
    private val gson = Gson()

    private val estimationService = DeliveryTimeEstimationService(
        logger, estimationRepository, clientOrderRepository, deliveryOrderRepository
    )

    private val function = DeliveryTimeEstimationFunction(
        config, logger, estimationService, estimationRepository, validator
    )

    private fun authHeaders(email: String, method: String = "GET", path: String = "delivery/time-estimation") = mapOf(
        "Authorization" to "Bearer ${validator.generateToken(email)}",
        "X-Http-Method" to method,
        "X-Function-Path" to path
    )

    @Test
    fun `GET retorna estimacion de tiempo con status 200`() = runBlocking {
        val email = "client@test.com"

        val response = function.securedExecute(
            business = "pizzeria",
            function = "delivery/time-estimation",
            headers = authHeaders(email),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DeliveryTimeEstimationResponse)
        val estimation = response as DeliveryTimeEstimationResponse
        assertTrue(estimation.estimatedMinutes > 0, "Estimado debe ser positivo")
        assertTrue(estimation.displayText.isNotBlank(), "Texto de display no debe estar vacio")
        assertTrue(estimation.confidence > 0, "Confianza debe ser positiva")
    }

    @Test
    fun `GET con distancia retorna estimacion mayor`() = runBlocking {
        val email = "client@test.com"

        val sinDistancia = function.securedExecute(
            business = "pizzeria",
            function = "delivery/time-estimation",
            headers = authHeaders(email),
            textBody = ""
        ) as DeliveryTimeEstimationResponse

        val conDistancia = function.securedExecute(
            business = "pizzeria",
            function = "delivery/time-estimation",
            headers = authHeaders(email) + ("X-Query-distanceKm" to "10.0"),
            textBody = ""
        ) as DeliveryTimeEstimationResponse

        assertTrue(
            conDistancia.estimatedMinutes > sinDistancia.estimatedMinutes,
            "Con distancia la estimacion debe ser mayor"
        )
    }

    @Test
    fun `POST calcula estimacion y registra para tracking`() = runBlocking {
        val email = "client@test.com"
        val request = EstimationRequest(orderId = "order-123", distanceKm = 3.5)

        val response = function.securedExecute(
            business = "pizzeria",
            function = "delivery/time-estimation",
            headers = authHeaders(email, "POST"),
            textBody = gson.toJson(request)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val estimation = response as DeliveryTimeEstimationResponse
        assertTrue(estimation.estimatedMinutes > 0)

        // Verificar que se registro la estimacion
        val record = estimationRepository.getRecordByOrderId("pizzeria", "order-123")
        assertTrue(record != null, "Debe haberse registrado la estimacion")
        assertEquals(estimation.estimatedMinutes, record.estimatedMinutes)
    }

    @Test
    fun `POST sin orderId no registra estimacion`() = runBlocking {
        val email = "client@test.com"
        val request = EstimationRequest(distanceKm = 2.0)

        val response = function.securedExecute(
            business = "pizzeria",
            function = "delivery/time-estimation",
            headers = authHeaders(email, "POST"),
            textBody = gson.toJson(request)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        // No se registro nada (no hay orderId)
        val records = estimationRepository.listRecords("pizzeria")
        assertTrue(records.isEmpty(), "Sin orderId no debe registrarse la estimacion")
    }

    @Test
    fun `PUT actual registra tiempo real de entrega`() = runBlocking {
        val email = "biz-admin@test.com"

        // Primero registrar una estimacion
        estimationRepository.recordEstimation("pizzeria", DeliveryTimeRecord(
            orderId = "order-456",
            business = "pizzeria",
            estimatedMinutes = 25
        ))

        val request = RecordActualTimeRequest(orderId = "order-456", actualMinutes = 30)

        val response = function.securedExecute(
            business = "pizzeria",
            function = "delivery/time-estimation/actual",
            headers = authHeaders(email, "PUT", "delivery/time-estimation/actual"),
            textBody = gson.toJson(request)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is RecordActualTimeResponse)
        val actual = response as RecordActualTimeResponse
        assertEquals("order-456", actual.orderId)
        assertEquals(25, actual.estimatedMinutes)
        assertEquals(30, actual.actualMinutes)
        assertEquals(5, actual.deviationMinutes)
    }

    @Test
    fun `PUT actual con orderId inexistente retorna error`() = runBlocking {
        val email = "biz-admin@test.com"
        val request = RecordActualTimeRequest(orderId = "inexistente", actualMinutes = 20)

        val response = function.securedExecute(
            business = "pizzeria",
            function = "delivery/time-estimation/actual",
            headers = authHeaders(email, "PUT", "delivery/time-estimation/actual"),
            textBody = gson.toJson(request)
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `PUT actual con actualMinutes negativo retorna error`() = runBlocking {
        val email = "biz-admin@test.com"
        val request = RecordActualTimeRequest(orderId = "order-789", actualMinutes = -5)

        val response = function.securedExecute(
            business = "pizzeria",
            function = "delivery/time-estimation/actual",
            headers = authHeaders(email, "PUT", "delivery/time-estimation/actual"),
            textBody = gson.toJson(request)
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `sin token retorna no autorizado`() = runBlocking {
        val response = function.securedExecute(
            business = "pizzeria",
            function = "delivery/time-estimation",
            headers = mapOf(
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/time-estimation"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.Unauthorized, response.statusCode)
    }

    @Test
    fun `metodo no soportado retorna error de validacion`() = runBlocking {
        val email = "client@test.com"

        val response = function.securedExecute(
            business = "pizzeria",
            function = "delivery/time-estimation",
            headers = authHeaders(email, "DELETE"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `POST con body invalido retorna error de validacion`() = runBlocking {
        val email = "client@test.com"

        val response = function.securedExecute(
            business = "pizzeria",
            function = "delivery/time-estimation",
            headers = authHeaders(email, "POST"),
            textBody = "esto no es json valido {{{{"
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `respuesta incluye factores de estimacion`() = runBlocking {
        val email = "client@test.com"

        // Agregar pedidos activos para que los factores sean informativos
        clientOrderRepository.createOrder("pizzeria", "other@test.com",
            ClientOrderPayload(status = "PENDING", businessName = "pizzeria"))

        val response = function.securedExecute(
            business = "pizzeria",
            function = "delivery/time-estimation",
            headers = authHeaders(email) + ("X-Query-distanceKm" to "3.0"),
            textBody = ""
        ) as DeliveryTimeEstimationResponse

        assertEquals(1, response.factors.activeOrders)
        assertEquals(3.0, response.factors.distanceKm)
        assertTrue(response.factors.hourOfDay in 0..23)
        assertTrue(response.factors.dayOfWeek in 1..7)
    }
}
