package asdo.business

import ar.com.intrale.shared.business.ProductDTO
import ar.com.intrale.shared.business.ProductRequest

interface ToDoCreateProduct {
    suspend fun execute(businessId: String, request: ProductRequest): Result<ProductDTO>
}
