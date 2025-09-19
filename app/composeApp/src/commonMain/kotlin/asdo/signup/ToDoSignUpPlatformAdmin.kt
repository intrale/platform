package asdo.signup

interface ToDoSignUpPlatformAdmin { suspend fun execute(email:String): Result<DoSignUpResult> }
