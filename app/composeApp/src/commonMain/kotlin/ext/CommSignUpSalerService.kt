package ext

interface CommSignUpSalerService {
    suspend fun execute(email: String): Result<SignUpResponse>
}
