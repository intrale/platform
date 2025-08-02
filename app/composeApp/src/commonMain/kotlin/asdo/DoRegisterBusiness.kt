package asdo

import ext.CommRegisterBusinessService
import ext.RegisterBusinessResponse

class DoRegisterBusiness(private val service: CommRegisterBusinessService) : ToDoRegisterBusiness {
    override suspend fun execute(name: String, emailAdmin: String, description: String): Result<RegisterBusinessResponse> =
        service.execute(name, emailAdmin, description)
}
