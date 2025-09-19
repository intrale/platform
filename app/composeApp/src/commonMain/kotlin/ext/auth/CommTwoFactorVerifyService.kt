package ext.auth

interface CommTwoFactorVerifyService {
    suspend fun execute(code: String, token: String): Result<TwoFactorVerifyResponse>
}

