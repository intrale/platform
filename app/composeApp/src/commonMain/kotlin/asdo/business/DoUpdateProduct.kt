package asdo.business

import ext.business.CommProductService
import ext.business.ProductDTO
import ext.business.ProductRequest

class DoUpdateProduct(
    private val service: CommProductService
) : ToDoUpdateProduct {
    override suspend fun execute(
        businessId: String,
        productId: String,
        request: ProductRequest
    ): Result<ProductDTO> = service.updateProduct(businessId, productId, request)
}
