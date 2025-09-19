package ext.signup

interface CommSignUpPlatformAdminService {
    suspend fun execute(email: String): Result<SignUpResponse>
}
