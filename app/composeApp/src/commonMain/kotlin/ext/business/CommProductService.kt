package ext.business

interface CommProductService {
    suspend fun listProducts(businessId: String): Result<List<ProductDTO>>
    suspend fun getProduct(businessId: String, productId: String): Result<ProductDTO>
    suspend fun createProduct(
        businessId: String,
        request: ProductRequest
    ): Result<ProductDTO>

    suspend fun updateProduct(
        businessId: String,
        productId: String,
        request: ProductRequest
    ): Result<ProductDTO>

    suspend fun deleteProduct(businessId: String, productId: String): Result<Unit>
}
