package asdo.business

import ext.business.RequestJoinBusinessResponse

interface ToDoRequestJoinBusiness {
    suspend fun execute(business: String): Result<RequestJoinBusinessResponse>
}
