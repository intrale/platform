package ext

interface CommReviewBusinessRegistrationService {
    suspend fun execute(name: String, decision: String, twoFactorCode: String): Result<ReviewBusinessRegistrationResponse>
}
