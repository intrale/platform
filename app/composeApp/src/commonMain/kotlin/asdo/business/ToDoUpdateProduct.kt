package asdo.business

import ar.com.intrale.shared.business.ProductDTO
import ar.com.intrale.shared.business.ProductRequest

interface ToDoUpdateProduct {
    suspend fun execute(
        businessId: String,
        productId: String,
        request: ProductRequest
    ): Result<ProductDTO>
}
