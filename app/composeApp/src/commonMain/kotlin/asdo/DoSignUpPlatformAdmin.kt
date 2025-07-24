package asdo

import ext.CommSignUpService
import ext.ExceptionResponse

class DoSignUpPlatformAdmin(private val service: CommSignUpService) : ToDoSignUpPlatformAdmin {
    override suspend fun execute(email: String): Result<DoSignUpResult> {
        return try {
            service.execute(/*"signupPlatformAdmin",*/ email).fold(
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
