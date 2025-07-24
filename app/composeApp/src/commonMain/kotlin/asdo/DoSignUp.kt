package asdo

import ext.CommSignUpService
import ext.ExceptionResponse
import ext.SignUpResponse

class DoSignUp(private val service: CommSignUpService) : ToDoSignUp {
    override suspend fun execute(email: String): Result<DoSignUpResult> {
        return try {
            service.execute(email).fold(
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
