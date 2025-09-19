package asdo.business

import ext.business.ReviewBusinessRegistrationResponse

interface ToDoReviewBusinessRegistration {
    suspend fun execute(publicId: String, decision: String, twoFactorCode: String): Result<ReviewBusinessRegistrationResponse>
}
