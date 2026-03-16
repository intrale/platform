package asdo.business

import ext.business.CommProductService
import ar.com.intrale.shared.business.ProductDTO
import ar.com.intrale.shared.business.ProductRequest

class DoCreateProduct(
    private val service: CommProductService
) : ToDoCreateProduct {
    override suspend fun execute(
        businessId: String,
        request: ProductRequest
    ): Result<ProductDTO> = service.createProduct(businessId, request)
}
