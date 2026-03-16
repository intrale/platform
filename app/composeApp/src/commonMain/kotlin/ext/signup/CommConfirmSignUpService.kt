package ext.signup

import ar.com.intrale.shared.auth.ConfirmSignUpResponse

interface CommConfirmSignUpService {
    suspend fun execute(email: String, code: String): Result<ConfirmSignUpResponse>
}
