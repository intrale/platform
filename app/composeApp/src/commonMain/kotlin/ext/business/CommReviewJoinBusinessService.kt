package ext.business

import ar.com.intrale.shared.business.ReviewJoinBusinessResponse

interface CommReviewJoinBusinessService {
    suspend fun execute(business: String, email: String, decision: String): Result<ReviewJoinBusinessResponse>
}
