package asdo

import ext.CommSignUpPlatformAdminService
import ext.ExceptionResponse

class DoSignUpPlatformAdmin(private val service: CommSignUpPlatformAdminService) : ToDoSignUpPlatformAdmin {
    override suspend fun execute(email: String): Result<DoSignUpResult> {
        return try {
            service.execute(/*"signupPlatformAdmin",*/ email)
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
