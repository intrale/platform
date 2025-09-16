package asdo

import ext.CommKeyValueStorage
import ext.CommRegisterSalerService
import ext.ExceptionResponse

class DoRegisterSaler(
    private val service: CommRegisterSalerService,
    private val storage: CommKeyValueStorage
) : ToDoRegisterSaler {

    override suspend fun execute(email: String): Result<DoRegisterSalerResult> {
        return try {
            val token = storage.token ?: return Result.failure(Exception("Token no encontrado"))
            service.execute(email, token)
                .mapCatching { it.toDoRegisterSalerResult() }
                .recoverCatching { throwable ->
                    throw (throwable as? ExceptionResponse)?.toDoRegisterSalerException()
                        ?: throwable.toDoRegisterSalerException()
                }
        } catch (e: Exception) {
            Result.failure(e.toDoRegisterSalerException())
        }
    }
}
