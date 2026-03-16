package ext.auth

import ar.com.intrale.shared.auth.LoginResponse

interface CommLoginService {
    suspend fun execute(
        user: String,
        password: String,
        newPassword: String? = null,
        name: String? = null,
        familyName: String? = null
    ): Result<LoginResponse>
}