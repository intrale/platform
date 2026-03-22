package asdo.business

import ar.com.intrale.shared.business.BusinessPaymentMethodDTO
import ar.com.intrale.shared.business.UpdatePaymentMethodsRequest
import ext.business.CommBusinessPaymentMethodsService
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

private val sampleMethods = listOf(
    BusinessPaymentMethodDTO(id = "cash", name = "Efectivo", type = "CASH", enabled = true),
    BusinessPaymentMethodDTO(id = "transfer", name = "Transferencia", type = "TRANSFER", enabled = false)
)

private class FakeBusinessPaymentMethodsService(
    private val getResult: Result<List<BusinessPaymentMethodDTO>> = Result.success(sampleMethods),
    private val updateResult: Result<List<BusinessPaymentMethodDTO>> = Result.success(sampleMethods)
) : CommBusinessPaymentMethodsService {
    override suspend fun getPaymentMethods(): Result<List<BusinessPaymentMethodDTO>> = getResult
    override suspend fun updatePaymentMethods(
        request: UpdatePaymentMethodsRequest
    ): Result<List<BusinessPaymentMethodDTO>> = updateResult
}

class BusinessPaymentMethodsUseCaseTest {

    @Test
    fun `DoGetBusinessPaymentMethods delega en el servicio`() = runTest {
        val service = FakeBusinessPaymentMethodsService()
        val useCase = DoGetBusinessPaymentMethods(service)

        val result = useCase.execute()

        assertTrue(result.isSuccess)
        assertEquals(2, result.getOrNull()?.size)
    }

    @Test
    fun `DoGetBusinessPaymentMethods propaga fallo del servicio`() = runTest {
        val service = FakeBusinessPaymentMethodsService(
            getResult = Result.failure(RuntimeException("Error de red"))
        )
        val useCase = DoGetBusinessPaymentMethods(service)

        val result = useCase.execute()

        assertTrue(result.isFailure)
    }

    @Test
    fun `DoUpdateBusinessPaymentMethods envía request al servicio`() = runTest {
        val updatedMethods = sampleMethods.map { it.copy(enabled = true) }
        val service = FakeBusinessPaymentMethodsService(
            updateResult = Result.success(updatedMethods)
        )
        val useCase = DoUpdateBusinessPaymentMethods(service)
        val request = UpdatePaymentMethodsRequest(paymentMethods = updatedMethods)

        val result = useCase.execute(request)

        assertTrue(result.isSuccess)
        assertTrue(result.getOrNull()?.all { it.enabled } == true)
    }

    @Test
    fun `DoUpdateBusinessPaymentMethods propaga fallo del servicio`() = runTest {
        val service = FakeBusinessPaymentMethodsService(
            updateResult = Result.failure(RuntimeException("Error al guardar"))
        )
        val useCase = DoUpdateBusinessPaymentMethods(service)

        val result = useCase.execute(UpdatePaymentMethodsRequest(sampleMethods))

        assertTrue(result.isFailure)
    }
}
