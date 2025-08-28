package asdo

import ext.ReviewJoinBusinessResponse

interface ToDoReviewJoinBusiness {
    suspend fun execute(business: String, email: String, decision: String): Result<ReviewJoinBusinessResponse>
}
