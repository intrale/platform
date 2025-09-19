package asdo.business

import ext.storage.CommKeyValueStorage
import ext.business.CommReviewBusinessRegistrationService
import ext.business.ReviewBusinessRegistrationResponse

class DoReviewBusinessRegistration(
    private val service: CommReviewBusinessRegistrationService,
    private val storage: CommKeyValueStorage
) : ToDoReviewBusinessRegistration {
    override suspend fun execute(
        publicId: String,
        decision: String,
        twoFactorCode: String
    ): Result<ReviewBusinessRegistrationResponse> {
        val token = storage.token ?: return Result.failure(Exception("Token no encontrado"))
        return service.execute(publicId, decision, twoFactorCode, token)
    }
}
