package ext.auth

interface CommTwoFactorSetupService {
    suspend fun execute(token: String): Result<TwoFactorSetupResponse>
}

