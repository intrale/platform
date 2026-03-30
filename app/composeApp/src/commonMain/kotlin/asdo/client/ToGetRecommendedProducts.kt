package asdo.client

import ar.com.intrale.shared.client.RecommendedProductsResponse

interface ToGetRecommendedProducts {
    suspend fun execute(businessId: String): Result<RecommendedProductsResponse>
}
