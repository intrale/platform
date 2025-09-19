package ext.auth

interface CommChangePasswordService {
    suspend fun execute(oldPassword: String, newPassword: String, token: String): Result<ChangePasswordResponse>
}
