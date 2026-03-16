package asdo.business

import ar.com.intrale.shared.business.ReviewJoinBusinessResponse

interface ToDoReviewJoinBusiness {
    suspend fun execute(business: String, email: String, decision: String): Result<ReviewJoinBusinessResponse>
}
