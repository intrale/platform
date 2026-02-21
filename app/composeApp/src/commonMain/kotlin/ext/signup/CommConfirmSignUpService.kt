package ext.signup

interface CommConfirmSignUpService {
    suspend fun execute(email: String, code: String): Result<ConfirmSignUpResponse>
}
