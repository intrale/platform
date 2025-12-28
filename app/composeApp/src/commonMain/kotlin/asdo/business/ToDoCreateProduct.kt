package asdo.business

import ext.business.ProductDTO
import ext.business.ProductRequest

interface ToDoCreateProduct {
    suspend fun execute(businessId: String, request: ProductRequest): Result<ProductDTO>
}
