package ext.business

interface CommReviewJoinBusinessService {
    suspend fun execute(business: String, email: String, decision: String): Result<ReviewJoinBusinessResponse>
}

