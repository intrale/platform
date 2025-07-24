package asdo

interface ToDoSignUpDelivery { suspend fun execute(email:String): Result<DoSignUpResult> }
