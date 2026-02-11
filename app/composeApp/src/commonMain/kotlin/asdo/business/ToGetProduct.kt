package asdo.business

import ext.business.ProductDTO

interface ToGetProduct {
    suspend fun execute(
        businessId: String,
        productId: String
    ): Result<ProductDTO>
}

