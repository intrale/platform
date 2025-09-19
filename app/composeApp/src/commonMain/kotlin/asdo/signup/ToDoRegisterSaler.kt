package asdo.signup

interface ToDoRegisterSaler {
    suspend fun execute(email: String): Result<DoRegisterSalerResult>
}
