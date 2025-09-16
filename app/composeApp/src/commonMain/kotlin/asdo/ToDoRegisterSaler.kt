package asdo

interface ToDoRegisterSaler {
    suspend fun execute(email: String): Result<DoRegisterSalerResult>
}
