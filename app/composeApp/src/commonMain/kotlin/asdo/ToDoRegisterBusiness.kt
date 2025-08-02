package asdo

import ext.RegisterBusinessResponse

interface ToDoRegisterBusiness {
    suspend fun execute(name: String, emailAdmin: String, description: String): Result<RegisterBusinessResponse>
}
