package asdo

interface ToDoSignUpPlatformAdmin { suspend fun execute(email:String): Result<DoSignUpResult> }
