package asdo.client

import ar.com.intrale.shared.client.RecommendedProductsResponse
import ext.client.CommRecommendedProductsService

class DoGetRecommendedProducts(
    private val service: CommRecommendedProductsService
) : ToGetRecommendedProducts {
    override suspend fun execute(businessId: String): Result<RecommendedProductsResponse> =
        service.execute(businessId)
}
