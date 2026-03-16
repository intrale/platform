package ext.auth

import ar.com.intrale.shared.auth.PasswordRecoveryResponse

interface CommPasswordRecoveryService {
    suspend fun recovery(email: String): Result<PasswordRecoveryResponse>
    suspend fun confirm(email: String, code: String, password: String): Result<PasswordRecoveryResponse>
}
