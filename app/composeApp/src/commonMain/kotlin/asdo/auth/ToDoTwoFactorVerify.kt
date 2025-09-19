package asdo.auth

interface ToDoTwoFactorVerify {
    suspend fun execute(code: String): Result<DoTwoFactorVerifyResult>
}

