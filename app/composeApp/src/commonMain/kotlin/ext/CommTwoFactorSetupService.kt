package ext

interface CommTwoFactorSetupService {
    suspend fun execute(token: String): Result<TwoFactorSetupResponse>
}

