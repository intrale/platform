package ext.business

interface CommRequestJoinBusinessService {
    suspend fun execute(business: String): Result<RequestJoinBusinessResponse>
}

