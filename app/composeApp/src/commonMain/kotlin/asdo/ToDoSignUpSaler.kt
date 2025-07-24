package asdo

interface ToDoSignUpSaler { suspend fun execute(email:String): Result<DoSignUpResult> }
