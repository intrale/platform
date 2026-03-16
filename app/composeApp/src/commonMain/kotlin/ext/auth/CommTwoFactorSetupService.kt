package ext.auth

import ar.com.intrale.shared.auth.TwoFactorSetupResponse

interface CommTwoFactorSetupService {
    suspend fun execute(token: String): Result<TwoFactorSetupResponse>
}
