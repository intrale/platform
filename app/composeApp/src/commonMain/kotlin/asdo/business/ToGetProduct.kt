package asdo.business

import ar.com.intrale.shared.business.ProductDTO

interface ToGetProduct {
    suspend fun execute(businessId: String, productId: String): Result<ProductDTO>
}
