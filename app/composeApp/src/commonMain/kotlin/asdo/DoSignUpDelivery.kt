package asdo

import ext.CommSignUpDeliveryService
import ext.ExceptionResponse

class DoSignUpDelivery(private val service: CommSignUpDeliveryService) : ToDoSignUpDelivery {
    override suspend fun execute(business: String, email: String): Result<DoSignUpResult> {
        return try {
            service.execute(business, email)
                .mapCatching { it.toDoSignUpResult() }
                .recoverCatching { e ->
                    throw (e as? ExceptionResponse)?.toDoSignUpException()
                        ?: e.toDoSignUpException()
                }
        } catch (e: Exception) {
            Result.failure(e.toDoSignUpException())
        }
    }
}
