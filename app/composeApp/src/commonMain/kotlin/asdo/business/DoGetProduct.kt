package asdo.business

import ext.business.CommProductService
import ext.business.ProductDTO

class DoGetProduct(
    private val service: CommProductService
) : ToGetProduct {
    override suspend fun execute(
        businessId: String,
        productId: String
    ): Result<ProductDTO> = service.getProduct(businessId, productId)
}
