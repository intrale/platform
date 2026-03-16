package ext.business

import ar.com.intrale.shared.business.RequestJoinBusinessResponse

interface CommRequestJoinBusinessService {
    suspend fun execute(business: String): Result<RequestJoinBusinessResponse>
}
