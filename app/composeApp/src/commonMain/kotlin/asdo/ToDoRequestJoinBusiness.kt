package asdo

import ext.RequestJoinBusinessResponse

interface ToDoRequestJoinBusiness {
    suspend fun execute(business: String): Result<RequestJoinBusinessResponse>
}
