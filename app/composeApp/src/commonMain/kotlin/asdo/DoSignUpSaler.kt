package asdo

import ext.CommSignUpSalerService
import ext.ExceptionResponse

class DoSignUpSaler(private val service: CommSignUpSalerService) : ToDoSignUpSaler {
    override suspend fun execute(email: String): Result<DoSignUpResult> {
        return try {
            service.execute(/*"signupSaler",*/ email)
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

