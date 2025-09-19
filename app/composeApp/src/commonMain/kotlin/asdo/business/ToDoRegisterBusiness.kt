package asdo.business

import ext.business.RegisterBusinessResponse

interface ToDoRegisterBusiness {
    suspend fun execute(name: String, emailAdmin: String, description: String): Result<RegisterBusinessResponse>
}
