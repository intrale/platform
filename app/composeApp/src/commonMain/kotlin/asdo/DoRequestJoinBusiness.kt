package asdo

import ext.CommRequestJoinBusinessService
import ext.RequestJoinBusinessResponse

class DoRequestJoinBusiness(private val service: CommRequestJoinBusinessService) : ToDoRequestJoinBusiness {
    override suspend fun execute(business: String): Result<RequestJoinBusinessResponse> =
        service.execute(business)
}
