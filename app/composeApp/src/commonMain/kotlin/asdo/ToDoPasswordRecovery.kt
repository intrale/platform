package asdo

interface ToDoPasswordRecovery {
    suspend fun execute(email: String): Result<DoPasswordRecoveryResult>
}
