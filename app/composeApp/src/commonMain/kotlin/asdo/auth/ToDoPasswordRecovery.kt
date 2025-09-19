package asdo.auth

interface ToDoPasswordRecovery {
    suspend fun execute(email: String): Result<DoPasswordRecoveryResult>
}
