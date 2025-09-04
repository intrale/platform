package ext

interface CommTwoFactorVerifyService {
    suspend fun execute(code: String, token: String): Result<TwoFactorVerifyResponse>
}

