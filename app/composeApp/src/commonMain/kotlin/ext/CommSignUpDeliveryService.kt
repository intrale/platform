package ext

interface CommSignUpDeliveryService {
    suspend fun execute(business: String, email: String): Result<SignUpResponse>
}
