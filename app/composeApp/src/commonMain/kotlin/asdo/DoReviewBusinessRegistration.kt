package asdo

import ext.CommReviewBusinessRegistrationService
import ext.ReviewBusinessRegistrationResponse

class DoReviewBusinessRegistration(private val service: CommReviewBusinessRegistrationService) : ToDoReviewBusinessRegistration {
    override suspend fun execute(publicId: String, decision: String, twoFactorCode: String): Result<ReviewBusinessRegistrationResponse> =
        service.execute(publicId, decision, twoFactorCode)
}
