package ext.auth

import ar.com.intrale.shared.auth.TwoFactorVerifyResponse

interface CommTwoFactorVerifyService {
    suspend fun execute(code: String, token: String): Result<TwoFactorVerifyResponse>
}
