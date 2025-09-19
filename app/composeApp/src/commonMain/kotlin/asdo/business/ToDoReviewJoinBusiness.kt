package asdo.business

import ext.business.ReviewJoinBusinessResponse

interface ToDoReviewJoinBusiness {
    suspend fun execute(business: String, email: String, decision: String): Result<ReviewJoinBusinessResponse>
}
