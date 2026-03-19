package asdo.business

import ar.com.intrale.shared.business.BusinessOrderDTO
import ext.business.CommAssignOrderDeliveryPersonService
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

private class FakeCommAssignService(
    private val result: Result<BusinessOrderDTO>
) : CommAssignOrderDeliveryPersonService {
    var lastOrderId: String? = null
        private set
    var lastEmail: String? = null
        private set

    override suspend fun assignDeliveryPerson(
        businessId: String,
        orderId: String,
        deliveryPersonEmail: String?
    ): Result<BusinessOrderDTO> {
        lastOrderId = orderId
        lastEmail = deliveryPersonEmail
        return result
    }
}

class DoAssignOrderDeliveryPersonTest {

    @Test
    fun `execute exitoso asigna repartidor al pedido`() = runTest {
        val dto = BusinessOrderDTO(
            id = "order-1",
            shortCode = "ABC123",
            clientEmail = "client@test.com",
            status = "PENDING",
            total = 100.0,
            assignedDeliveryPersonEmail = "driver@test.com"
        )
        val service = FakeCommAssignService(Result.success(dto))
        val doAssign = DoAssignOrderDeliveryPerson(service)

        val result = doAssign.execute("biz-1", "order-1", "driver@test.com")

        assertTrue(result.isSuccess)
        val order = result.getOrNull()
        assertNotNull(order)
        assertEquals("order-1", order.id)
        assertEquals("driver@test.com", order.assignedDeliveryPersonEmail)
        assertEquals("order-1", service.lastOrderId)
        assertEquals("driver@test.com", service.lastEmail)
    }

    @Test
    fun `execute con null desasigna repartidor`() = runTest {
        val dto = BusinessOrderDTO(
            id = "order-1",
            shortCode = "ABC123",
            clientEmail = "client@test.com",
            status = "DELIVERING",
            total = 50.0,
            assignedDeliveryPersonEmail = null
        )
        val service = FakeCommAssignService(Result.success(dto))
        val doAssign = DoAssignOrderDeliveryPerson(service)

        val result = doAssign.execute("biz-1", "order-1", null)

        assertTrue(result.isSuccess)
        val order = result.getOrNull()
        assertNotNull(order)
        assertEquals(null, order.assignedDeliveryPersonEmail)
    }

    @Test
    fun `execute con error retorna failure`() = runTest {
        val service = FakeCommAssignService(Result.failure(RuntimeException("network error")))
        val doAssign = DoAssignOrderDeliveryPerson(service)

        val result = doAssign.execute("biz-1", "order-1", "driver@test.com")

        assertTrue(result.isFailure)
    }
}
