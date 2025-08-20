package asdo

import ext.ReviewBusinessRegistrationResponse

interface ToDoReviewBusinessRegistration {
    suspend fun execute(publicId: String, decision: String, twoFactorCode: String): Result<ReviewBusinessRegistrationResponse>
}
