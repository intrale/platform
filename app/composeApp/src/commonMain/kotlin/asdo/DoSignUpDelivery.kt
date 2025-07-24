package asdo

import ext.CommSignUpService
import ext.ExceptionResponse

class DoSignUpDelivery(private val service: CommSignUpService) : ToDoSignUpDelivery {
    override suspend fun execute(email: String): Result<DoSignUpResult> {
        return try {
            service.execute(/*"signupDelivery",*/ email).fold(
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
