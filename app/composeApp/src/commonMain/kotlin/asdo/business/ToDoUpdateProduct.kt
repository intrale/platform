package asdo.business

import ext.business.ProductDTO
import ext.business.ProductRequest

interface ToDoUpdateProduct {
    suspend fun execute(
        businessId: String,
        productId: String,
        request: ProductRequest
    ): Result<ProductDTO>
}
