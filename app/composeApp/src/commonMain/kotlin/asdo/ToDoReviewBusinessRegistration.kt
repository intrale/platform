package asdo

import ext.ReviewBusinessRegistrationResponse

interface ToDoReviewBusinessRegistration {
    suspend fun execute(name: String, decision: String, twoFactorCode: String): Result<ReviewBusinessRegistrationResponse>
}
