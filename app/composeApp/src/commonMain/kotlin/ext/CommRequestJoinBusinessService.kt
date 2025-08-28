package ext

interface CommRequestJoinBusinessService {
    suspend fun execute(business: String): Result<RequestJoinBusinessResponse>
}

