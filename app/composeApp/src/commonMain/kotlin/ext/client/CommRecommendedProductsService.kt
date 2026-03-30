package ext.client

import ar.com.intrale.shared.client.RecommendedProductsResponse

interface CommRecommendedProductsService {
    suspend fun execute(businessId: String): Result<RecommendedProductsResponse>
}
