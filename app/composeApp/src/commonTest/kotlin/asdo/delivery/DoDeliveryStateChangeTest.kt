package asdo.delivery

import ext.delivery.CommDeliveryStateService
import ext.delivery.DeliveryExceptionResponse
import ext.delivery.DeliveryStateChangeResponse
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class FakeDeliveryStateService(
    private val changeStateResult: Result<DeliveryStateChangeResponse> = Result.success(
        DeliveryStateChangeResponse(orderId = "o1", state = "picked_up")
    )
) : CommDeliveryStateService {
    override suspend fun changeState(orderId: String, newState: String) = changeStateResult
}

// region DoDeliveryStateChange

class DoDeliveryStateChangeTest {

    @Test
    fun `cambiar estado exitoso retorna resultado mapeado`() = runTest {
        val sut = DoDeliveryStateChange(FakeDeliveryStateService())

        val result = sut.execute("o1", DeliveryState.PICKED_UP)

        assertTrue(result.isSuccess)
        val stateResult = result.getOrThrow()
        assertEquals("o1", stateResult.orderId)
        assertEquals(DeliveryState.PICKED_UP, stateResult.newState)
    }

    @Test
    fun `cambiar estado fallido retorna DeliveryExceptionResponse`() = runTest {
        val sut = DoDeliveryStateChange(
            FakeDeliveryStateService(changeStateResult = Result.failure(RuntimeException("Error de red")))
        )

        val result = sut.execute("o1", DeliveryState.PICKED_UP)

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is DeliveryExceptionResponse)
    }

    @Test
    fun `cambiar estado a DELIVERED retorna estado entregado`() = runTest {
        val sut = DoDeliveryStateChange(
            FakeDeliveryStateService(
                changeStateResult = Result.success(
                    DeliveryStateChangeResponse(orderId = "o2", state = "delivered")
                )
            )
        )

        val result = sut.execute("o2", DeliveryState.DELIVERED)

        assertTrue(result.isSuccess)
        assertEquals(DeliveryState.DELIVERED, result.getOrThrow().newState)
    }

    @Test
    fun `cambiar estado a CANCELLED retorna estado cancelado`() = runTest {
        val sut = DoDeliveryStateChange(
            FakeDeliveryStateService(
                changeStateResult = Result.success(
                    DeliveryStateChangeResponse(orderId = "o3", state = "cancelled")
                )
            )
        )

        val result = sut.execute("o3", DeliveryState.CANCELLED)

        assertTrue(result.isSuccess)
        assertEquals(DeliveryState.CANCELLED, result.getOrThrow().newState)
        assertEquals("o3", result.getOrThrow().orderId)
    }
}

// endregion DoDeliveryStateChange
