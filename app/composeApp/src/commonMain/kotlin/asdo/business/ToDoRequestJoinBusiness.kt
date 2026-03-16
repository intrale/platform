package asdo.business

import ar.com.intrale.shared.business.RequestJoinBusinessResponse

interface ToDoRequestJoinBusiness {
    suspend fun execute(business: String): Result<RequestJoinBusinessResponse>
}
