package ext.auth

import ar.com.intrale.shared.auth.ChangePasswordResponse

interface CommChangePasswordService {
    suspend fun execute(oldPassword: String, newPassword: String, token: String): Result<ChangePasswordResponse>
}
