package ui.sc

import asdo.business.ToDoRequestJoinBusiness
import ext.business.RequestJoinBusinessResponse
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import ui.sc.business.RequestJoinBusinessViewModel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private class FakeRequestJoinBusiness(
    private val result: Result<RequestJoinBusinessResponse> = Result.success(
        RequestJoinBusinessResponse(state = "PENDING")
    )
) : ToDoRequestJoinBusiness {
    override suspend fun execute(business: String): Result<RequestJoinBusinessResponse> = result
}

class RequestJoinBusinessViewModelTest {

    private fun createVm(
        requestJoin: ToDoRequestJoinBusiness = FakeRequestJoinBusiness()
    ) = RequestJoinBusinessViewModel(
        requestJoin = requestJoin,
        loggerFactory = testLoggerFactory
    )

    @Test
    fun `isValid retorna true con business valido`() {
        val vm = createVm()
        vm.state = vm.state.copy(business = "intrale")

        assertTrue(vm.isValid())
    }

    @Test
    fun `request exitoso actualiza resultState`() = runTest {
        val vm = createVm()
        vm.state = vm.state.copy(business = "intrale")

        val result = vm.request()

        assertTrue(result.isSuccess)
        assertEquals("PENDING", vm.state.resultState)
    }

    @Test
    fun `request con error no modifica resultState`() = runTest {
        val vm = createVm(
            requestJoin = FakeRequestJoinBusiness(
                Result.failure(RuntimeException("error de red"))
            )
        )
        vm.state = vm.state.copy(business = "intrale")

        val result = vm.request()

        assertTrue(result.isFailure)
        assertNull(vm.state.resultState)
    }
}
