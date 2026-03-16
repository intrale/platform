package asdo.business

import ext.business.CommRegisterBusinessService
import ar.com.intrale.shared.business.RegisterBusinessResponse

class DoRegisterBusiness(private val service: CommRegisterBusinessService) : ToDoRegisterBusiness {
    override suspend fun execute(name: String, emailAdmin: String, description: String): Result<RegisterBusinessResponse> =
        service.execute(name, emailAdmin, description)
}
