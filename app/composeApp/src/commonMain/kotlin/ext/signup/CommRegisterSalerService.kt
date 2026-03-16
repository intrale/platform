package ext.signup

import ar.com.intrale.shared.auth.RegisterSalerResponse

interface CommRegisterSalerService {
    suspend fun execute(email: String, token: String): Result<RegisterSalerResponse>
}
