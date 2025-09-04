package asdo

interface ToDoTwoFactorVerify {
    suspend fun execute(code: String): Result<DoTwoFactorVerifyResult>
}

