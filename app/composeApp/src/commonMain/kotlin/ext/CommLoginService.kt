package ext

interface CommLoginService {
    suspend fun execute(
        user: String,
        password: String,
        newPassword: String? = null,
        name: String? = null,
        familyName: String? = null
    ): Result<LoginResponse>
}