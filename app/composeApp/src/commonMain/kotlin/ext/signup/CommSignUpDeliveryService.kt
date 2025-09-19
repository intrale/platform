package ext.signup

interface CommSignUpDeliveryService {
    suspend fun execute(business: String, email: String): Result<SignUpResponse>
}
