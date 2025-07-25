package ext

interface CommSignUpPlatformAdminService {
    suspend fun execute(email: String): Result<SignUpResponse>
}
