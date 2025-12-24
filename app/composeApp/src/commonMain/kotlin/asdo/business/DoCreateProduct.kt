package asdo.business

import ext.business.CommProductService
import ext.business.ProductDTO
import ext.business.ProductRequest

class DoCreateProduct(
    private val service: CommProductService
) : ToDoCreateProduct {
    override suspend fun execute(
        businessId: String,
        request: ProductRequest
    ): Result<ProductDTO> = service.createProduct(businessId, request)
}
