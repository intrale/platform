package asdo

import ext.CommReviewBusinessRegistrationService
import ext.ReviewBusinessRegistrationResponse

class DoReviewBusinessRegistration(private val service: CommReviewBusinessRegistrationService) : ToDoReviewBusinessRegistration {
    override suspend fun execute(name: String, decision: String, twoFactorCode: String): Result<ReviewBusinessRegistrationResponse> =
        service.execute(name, decision, twoFactorCode)
}
