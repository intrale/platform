package ext.business

interface CommReviewBusinessRegistrationService {
    suspend fun execute(
        publicId: String,
        decision: String,
        twoFactorCode: String,
        token: String
    ): Result<ReviewBusinessRegistrationResponse>
}
