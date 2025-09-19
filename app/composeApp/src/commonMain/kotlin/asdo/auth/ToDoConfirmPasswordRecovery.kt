package asdo.auth

interface ToDoConfirmPasswordRecovery {
    suspend fun execute(email: String, code: String, password: String): Result<DoConfirmPasswordRecoveryResult>
}
