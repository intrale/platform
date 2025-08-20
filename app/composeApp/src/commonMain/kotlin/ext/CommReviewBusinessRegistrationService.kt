package ext

interface CommReviewBusinessRegistrationService {
    suspend fun execute(publicId: String, decision: String, twoFactorCode: String): Result<ReviewBusinessRegistrationResponse>
}
