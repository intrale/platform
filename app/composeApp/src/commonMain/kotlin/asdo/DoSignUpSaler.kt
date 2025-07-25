package asdo

import ext.CommSignUpSalerService
import ext.ExceptionResponse

class DoSignUpSaler(private val service: CommSignUpSalerService) : ToDoSignUpSaler {
    override suspend fun execute(email: String): Result<DoSignUpResult> {
        return try {
            service.execute(/*"signupSaler",*/ email).fold(
                onSuccess = { Result.success(it.toDoSignUpResult()) },
                onFailure = { error ->
                    Result.failure(
                        (error as? ExceptionResponse)?.toDoSignUpException() ?: (error as Exception).toDoSignUpException()
                    )
                }
            )
        } catch (e: Exception) {
            Result.failure(e.toDoSignUpException())
        }
    }
}

