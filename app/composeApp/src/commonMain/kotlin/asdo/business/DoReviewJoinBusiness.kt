package asdo.business

import ext.business.CommReviewJoinBusinessService
import ext.business.ReviewJoinBusinessResponse

class DoReviewJoinBusiness(private val service: CommReviewJoinBusinessService) : ToDoReviewJoinBusiness {
    override suspend fun execute(business: String, email: String, decision: String): Result<ReviewJoinBusinessResponse> =
        service.execute(business, email, decision)
}
