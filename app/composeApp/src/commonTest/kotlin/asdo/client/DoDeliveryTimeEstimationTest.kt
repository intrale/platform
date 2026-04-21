package asdo.client

import ar.com.intrale.shared.delivery.DeliveryEstimationFactorsDTO
import ar.com.intrale.shared.delivery.DeliveryTimeEstimationDTO
import ar.com.intrale.shared.delivery.DeliveryTimeRecordDTO
import ext.client.CommDeliveryTimeEstimationService
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

/**
 * Fake service para aislar los casos de uso del HTTP real.
 */
private class FakeDeliveryTimeEstimationService(
    private val estimation: Result<DeliveryTimeEstimationDTO> = Result.success(sampleEstimationDto()),
    private val calculation: Result<DeliveryTimeEstimationDTO> = Result.success(sampleEstimationDto()),
    private val record: Result<Unit> = Result.success(Unit)
) : CommDeliveryTimeEstimationService {

    var lastOrderId: String? = null
    var lastRecord: DeliveryTimeRecordDTO? = null
    var calculateCalls: Int = 0

    override suspend fun getEstimation(orderId: String): Result<DeliveryTimeEstimationDTO> {
        lastOrderId = orderId
        return estimation
    }

    override suspend fun calculateEstimation(
        deliveryLatitude: Double?,
        deliveryLongitude: Double?,
        deliveryAddress: String?
    ): Result<DeliveryTimeEstimationDTO> {
        calculateCalls += 1
        return calculation
    }

    override suspend fun recordActualTime(record: DeliveryTimeRecordDTO): Result<Unit> {
        lastRecord = record
        return this.record
    }
}

private fun sampleEstimationDto() = DeliveryTimeEstimationDTO(
    estimatedMinutes = 28,
    minMinutes = 20,
    maxMinutes = 40,
    confidence = 0.82,
    displayText = "Tu pedido llega en ~28 minutos",
    factors = DeliveryEstimationFactorsDTO(
        activeOrders = 3,
        distanceKm = 2.4,
        hourOfDay = 13,
        dayOfWeek = 2,
        historicalAvgMinutes = 24.0
    )
)

class DoDeliveryTimeEstimationTest {

    @Test
    fun `DoGetDeliveryTimeEstimation devuelve el modelo de dominio mapeado`() = runTest {
        val service = FakeDeliveryTimeEstimationService()
        val useCase = DoGetDeliveryTimeEstimation(service)

        val result = useCase.execute("ord-42")

        assertTrue(result.isSuccess)
        val estimation = result.getOrThrow()
        assertEquals(28, estimation.estimatedMinutes)
        assertEquals(20, estimation.minMinutes)
        assertEquals(40, estimation.maxMinutes)
        assertEquals("Tu pedido llega en ~28 minutos", estimation.displayText)
        assertEquals(3, estimation.factors.activeOrders)
        assertEquals(2.4, estimation.factors.distanceKm)
        assertEquals(24.0, estimation.factors.historicalAvgMinutes)
        assertEquals("ord-42", service.lastOrderId)
    }

    @Test
    fun `DoGetDeliveryTimeEstimation propaga el error del servicio`() = runTest {
        val service = FakeDeliveryTimeEstimationService(
            estimation = Result.failure(RuntimeException("Sin conexion"))
        )
        val useCase = DoGetDeliveryTimeEstimation(service)

        val result = useCase.execute("ord-1")

        assertTrue(result.isFailure)
        assertNotNull(result.exceptionOrNull())
    }

    @Test
    fun `DoCalculateDeliveryTimeEstimation invoca el servicio con las coordenadas`() = runTest {
        val service = FakeDeliveryTimeEstimationService()
        val useCase = DoCalculateDeliveryTimeEstimation(service)

        val result = useCase.execute(
            deliveryLatitude = -34.6,
            deliveryLongitude = -58.4,
            deliveryAddress = "Av. Corrientes 1234"
        )

        assertTrue(result.isSuccess)
        assertEquals(1, service.calculateCalls)
    }

    @Test
    fun `DoRecordActualDeliveryTime envia el registro completo al servicio`() = runTest {
        val service = FakeDeliveryTimeEstimationService()
        val useCase = DoRecordActualDeliveryTime(service)

        val result = useCase.execute(
            orderId = "ord-99",
            estimatedMinutes = 30,
            actualMinutes = 35,
            activeOrdersAtTime = 4,
            distanceKm = 1.8,
            hourOfDay = 21,
            dayOfWeek = 5
        )

        assertTrue(result.isSuccess)
        val record = service.lastRecord
        assertNotNull(record)
        assertEquals("ord-99", record.orderId)
        assertEquals(30, record.estimatedMinutes)
        assertEquals(35, record.actualMinutes)
        assertEquals(4, record.activeOrdersAtTime)
        assertEquals(1.8, record.distanceKm)
        assertEquals(21, record.hourOfDay)
        assertEquals(5, record.dayOfWeek)
    }

    @Test
    fun `DoRecordActualDeliveryTime propaga error cuando falla el registro`() = runTest {
        val service = FakeDeliveryTimeEstimationService(
            record = Result.failure(RuntimeException("503"))
        )
        val useCase = DoRecordActualDeliveryTime(service)

        val result = useCase.execute(
            orderId = "ord-1",
            estimatedMinutes = 20,
            actualMinutes = 18
        )

        assertFalse(result.isSuccess)
    }
}
