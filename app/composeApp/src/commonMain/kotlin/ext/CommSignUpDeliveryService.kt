package ext

interface CommSignUpDeliveryService {
    suspend fun execute(email: String): Result<SignUpResponse>
}
