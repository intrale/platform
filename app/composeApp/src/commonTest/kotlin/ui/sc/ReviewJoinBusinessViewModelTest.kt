package ui.sc

import asdo.business.ToDoReviewJoinBusiness
import ar.com.intrale.shared.business.ReviewJoinBusinessResponse
import ar.com.intrale.shared.StatusCodeDTO
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import ui.sc.business.ReviewJoinBusinessViewModel

private class FakeReviewJoinBusiness : ToDoReviewJoinBusiness {
    override suspend fun execute(business: String, email: String, decision: String) =
        Result.success(ReviewJoinBusinessResponse(StatusCodeDTO(200, "OK")))
}

class ReviewJoinBusinessViewModelTest {
    @Test
    fun `email requerido y valido`() {
        val vm = ReviewJoinBusinessViewModel(FakeReviewJoinBusiness(), LoggerFactory(listOf(simplePrintFrontend)))
        assertFalse(vm.isValid())
        vm.state = vm.state.copy(email = "correo@dominio.com")
        assertTrue(vm.isValid())
    }
}
