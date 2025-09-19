package asdo.business

import ext.business.CommRequestJoinBusinessService
import ext.business.RequestJoinBusinessResponse

class DoRequestJoinBusiness(private val service: CommRequestJoinBusinessService) : ToDoRequestJoinBusiness {
    override suspend fun execute(business: String): Result<RequestJoinBusinessResponse> =
        service.execute(business)
}
