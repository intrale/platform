package asdo.business

import ext.business.*
import ext.dto.*
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// region DoRegisterBusiness

class DoRegisterBusinessTest {

    private fun fakeService(result: Result<RegisterBusinessResponse>) = object : CommRegisterBusinessService {
        override suspend fun execute(name: String, emailAdmin: String, description: String) = result
    }

    @Test
    fun `registro exitoso retorna resultado`() = runTest {
        val response = RegisterBusinessResponse(StatusCodeDTO(200, "OK"))
        val sut = DoRegisterBusiness(fakeService(Result.success(response)))

        val result = sut.execute("Mi Negocio", "admin@test.com", "Descripcion")

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `registro fallido retorna error`() = runTest {
        val sut = DoRegisterBusiness(fakeService(Result.failure(RuntimeException("Error"))))

        val result = sut.execute("Mi Negocio", "admin@test.com", "Descripcion")

        assertTrue(result.isFailure)
    }
}

// endregion

// region DoRequestJoinBusiness

class DoRequestJoinBusinessTest {

    private fun fakeService(result: Result<RequestJoinBusinessResponse>) = object : CommRequestJoinBusinessService {
        override suspend fun execute(business: String) = result
    }

    @Test
    fun `solicitud exitosa retorna resultado`() = runTest {
        val response = RequestJoinBusinessResponse(state = "PENDING")
        val sut = DoRequestJoinBusiness(fakeService(Result.success(response)))

        val result = sut.execute("negocio-1")

        assertTrue(result.isSuccess)
        assertEquals("PENDING", result.getOrThrow().state)
    }

    @Test
    fun `solicitud fallida retorna error`() = runTest {
        val sut = DoRequestJoinBusiness(fakeService(Result.failure(RuntimeException("Error"))))

        val result = sut.execute("negocio-1")

        assertTrue(result.isFailure)
    }
}

// endregion

// region DoReviewJoinBusiness

class DoReviewJoinBusinessTest {

    private fun fakeService(result: Result<ReviewJoinBusinessResponse>) = object : CommReviewJoinBusinessService {
        override suspend fun execute(business: String, email: String, decision: String) = result
    }

    @Test
    fun `revision exitosa retorna resultado`() = runTest {
        val response = ReviewJoinBusinessResponse(StatusCodeDTO(200, "OK"))
        val sut = DoReviewJoinBusiness(fakeService(Result.success(response)))

        val result = sut.execute("negocio-1", "user@test.com", "approved")

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `revision fallida retorna error`() = runTest {
        val sut = DoReviewJoinBusiness(fakeService(Result.failure(RuntimeException("Error"))))

        val result = sut.execute("negocio-1", "user@test.com", "rejected")

        assertTrue(result.isFailure)
    }
}

// endregion

// region DoGetBusinesses

class DoGetBusinessesTest {

    private fun fakeService(result: Result<SearchBusinessesResponse>) = object : CommSearchBusinessesService {
        override suspend fun execute(query: String, status: String?, limit: Int?, lastKey: String?) = result
    }

    @Test
    fun `busqueda exitosa retorna resultado`() = runTest {
        val response = SearchBusinessesResponse(StatusCodeDTO(200, "OK"), emptyList(), null)
        val sut = DoGetBusinesses(fakeService(Result.success(response)))

        val result = sut.execute("test", null, null, null)

        assertTrue(result.isSuccess)
        assertEquals(0, result.getOrThrow().businesses.size)
    }

    @Test
    fun `busqueda fallida retorna error`() = runTest {
        val sut = DoGetBusinesses(fakeService(Result.failure(RuntimeException("Error"))))

        val result = sut.execute("test", null, null, null)

        assertTrue(result.isFailure)
    }
}

// endregion

// region DoGetBusinessProducts

class DoGetBusinessProductsTest {

    private fun fakeService(result: Result<BusinessProductsResponse>) = object : CommGetBusinessProductsService {
        override suspend fun execute(businessId: String, status: String) = result
    }

    @Test
    fun `obtener productos exitoso retorna resultado`() = runTest {
        val response = BusinessProductsResponse(StatusCodeDTO(200, "OK"), emptyList())
        val sut = DoGetBusinessProducts(fakeService(Result.success(response)))

        val result = sut.execute("biz-1", "ALL")

        assertTrue(result.isSuccess)
        assertEquals(0, result.getOrThrow().products.size)
    }

    @Test
    fun `obtener productos fallido retorna error`() = runTest {
        val sut = DoGetBusinessProducts(fakeService(Result.failure(RuntimeException("Error"))))

        val result = sut.execute("biz-1", "ALL")

        assertTrue(result.isFailure)
    }
}

// endregion

// region DoGetBusinessDashboardSummary

class DoGetBusinessDashboardSummaryTest {

    private fun fakeService(result: Result<BusinessDashboardSummaryDTO>) = object : CommGetBusinessDashboardSummaryService {
        override suspend fun execute(businessId: String) = result
    }

    @Test
    fun `obtener resumen exitoso retorna resultado`() = runTest {
        val response = BusinessDashboardSummaryDTO(productsCount = 5, pendingOrders = 2, activeDrivers = 1)
        val sut = DoGetBusinessDashboardSummary(fakeService(Result.success(response)))

        val result = sut.execute("biz-1")

        assertTrue(result.isSuccess)
        assertEquals(5, result.getOrThrow().productsCount)
    }

    @Test
    fun `obtener resumen fallido retorna error`() = runTest {
        val sut = DoGetBusinessDashboardSummary(fakeService(Result.failure(RuntimeException("Error"))))

        val result = sut.execute("biz-1")

        assertTrue(result.isFailure)
    }
}

// endregion

// region DoListCategories, DoCreateCategory, DoUpdateCategory, DoDeleteCategory

private class FakeCategoryService(
    private val listResult: Result<List<CategoryDTO>> = Result.success(emptyList()),
    private val createResult: Result<CategoryDTO> = Result.success(CategoryDTO(name = "test")),
    private val updateResult: Result<CategoryDTO> = Result.success(CategoryDTO(name = "updated")),
    private val deleteResult: Result<Unit> = Result.success(Unit)
) : CommCategoryService {
    override suspend fun listCategories(businessId: String) = listResult
    override suspend fun createCategory(businessId: String, request: CategoryRequest) = createResult
    override suspend fun updateCategory(businessId: String, categoryId: String, request: CategoryRequest) = updateResult
    override suspend fun deleteCategory(businessId: String, categoryId: String, reassignToCategoryId: String?) = deleteResult
}

class DoListCategoriesTest {

    @Test
    fun `listar categorias exitoso retorna lista`() = runTest {
        val categories = listOf(CategoryDTO(id = "1", name = "Cat A"), CategoryDTO(id = "2", name = "Cat B"))
        val sut = DoListCategories(FakeCategoryService(listResult = Result.success(categories)))

        val result = sut.execute("biz-1")

        assertTrue(result.isSuccess)
        assertEquals(2, result.getOrThrow().size)
    }

    @Test
    fun `listar categorias fallido retorna error`() = runTest {
        val sut = DoListCategories(FakeCategoryService(listResult = Result.failure(RuntimeException("Error"))))

        val result = sut.execute("biz-1")

        assertTrue(result.isFailure)
    }
}

class DoCreateCategoryTest {

    @Test
    fun `crear categoria exitoso retorna DTO`() = runTest {
        val dto = CategoryDTO(id = "new-1", name = "Nueva")
        val sut = DoCreateCategory(FakeCategoryService(createResult = Result.success(dto)))

        val result = sut.execute("biz-1", CategoryRequest("Nueva"))

        assertTrue(result.isSuccess)
        assertEquals("Nueva", result.getOrThrow().name)
    }

    @Test
    fun `crear categoria fallido retorna error`() = runTest {
        val sut = DoCreateCategory(FakeCategoryService(createResult = Result.failure(RuntimeException("Error"))))

        val result = sut.execute("biz-1", CategoryRequest("Nueva"))

        assertTrue(result.isFailure)
    }
}

class DoUpdateCategoryTest {

    @Test
    fun `actualizar categoria exitoso retorna DTO`() = runTest {
        val dto = CategoryDTO(id = "1", name = "Modificada")
        val sut = DoUpdateCategory(FakeCategoryService(updateResult = Result.success(dto)))

        val result = sut.execute("biz-1", "1", CategoryRequest("Modificada"))

        assertTrue(result.isSuccess)
        assertEquals("Modificada", result.getOrThrow().name)
    }

    @Test
    fun `actualizar categoria fallido retorna error`() = runTest {
        val sut = DoUpdateCategory(FakeCategoryService(updateResult = Result.failure(RuntimeException("Error"))))

        val result = sut.execute("biz-1", "1", CategoryRequest("Modificada"))

        assertTrue(result.isFailure)
    }
}

class DoDeleteCategoryTest {

    @Test
    fun `eliminar categoria exitoso retorna Unit`() = runTest {
        val sut = DoDeleteCategory(FakeCategoryService(deleteResult = Result.success(Unit)))

        val result = sut.execute("biz-1", "cat-1", null)

        assertTrue(result.isSuccess)
    }

    @Test
    fun `eliminar categoria fallido retorna error`() = runTest {
        val sut = DoDeleteCategory(FakeCategoryService(deleteResult = Result.failure(RuntimeException("Error"))))

        val result = sut.execute("biz-1", "cat-1", null)

        assertTrue(result.isFailure)
    }
}

// endregion

// region DoListProducts, DoCreateProduct, DoUpdateProduct, DoDeleteProduct

private class FakeProductService(
    private val listResult: Result<List<ProductDTO>> = Result.success(emptyList()),
    private val getResult: Result<ProductDTO> = Result.success(ProductDTO(name = "test", basePrice = 1.0, unit = "kg", categoryId = "c1")),
    private val createResult: Result<ProductDTO> = Result.success(ProductDTO(name = "test", basePrice = 1.0, unit = "kg", categoryId = "c1")),
    private val updateResult: Result<ProductDTO> = Result.success(ProductDTO(name = "updated", basePrice = 2.0, unit = "kg", categoryId = "c1")),
    private val deleteResult: Result<Unit> = Result.success(Unit)
) : CommProductService {
    override suspend fun listProducts(businessId: String) = listResult
    override suspend fun getProduct(businessId: String, productId: String) = getResult
    override suspend fun createProduct(businessId: String, request: ProductRequest) = createResult
    override suspend fun updateProduct(businessId: String, productId: String, request: ProductRequest) = updateResult
    override suspend fun deleteProduct(businessId: String, productId: String) = deleteResult
}

class DoListProductsTest {

    @Test
    fun `listar productos exitoso retorna lista`() = runTest {
        val products = listOf(ProductDTO(id = "1", name = "Prod A", basePrice = 10.0, unit = "u", categoryId = "c1"))
        val sut = DoListProducts(FakeProductService(listResult = Result.success(products)))

        val result = sut.execute("biz-1")

        assertTrue(result.isSuccess)
        assertEquals(1, result.getOrThrow().size)
    }

    @Test
    fun `listar productos fallido retorna error`() = runTest {
        val sut = DoListProducts(FakeProductService(listResult = Result.failure(RuntimeException("Error"))))

        val result = sut.execute("biz-1")

        assertTrue(result.isFailure)
    }
}

class DoCreateProductTest {

    @Test
    fun `crear producto exitoso retorna DTO`() = runTest {
        val dto = ProductDTO(id = "new-1", name = "Nuevo", basePrice = 5.0, unit = "kg", categoryId = "c1")
        val sut = DoCreateProduct(FakeProductService(createResult = Result.success(dto)))

        val result = sut.execute("biz-1", ProductRequest("Nuevo", null, 5.0, "kg", "c1", ProductStatus.Draft))

        assertTrue(result.isSuccess)
        assertEquals("Nuevo", result.getOrThrow().name)
    }

    @Test
    fun `crear producto fallido retorna error`() = runTest {
        val sut = DoCreateProduct(FakeProductService(createResult = Result.failure(RuntimeException("Error"))))

        val result = sut.execute("biz-1", ProductRequest("Nuevo", null, 5.0, "kg", "c1", ProductStatus.Draft))

        assertTrue(result.isFailure)
    }
}

class DoUpdateProductTest {

    @Test
    fun `actualizar producto exitoso retorna DTO`() = runTest {
        val dto = ProductDTO(id = "1", name = "Modificado", basePrice = 7.0, unit = "kg", categoryId = "c1")
        val sut = DoUpdateProduct(FakeProductService(updateResult = Result.success(dto)))

        val result = sut.execute("biz-1", "1", ProductRequest("Modificado", null, 7.0, "kg", "c1", ProductStatus.Published))

        assertTrue(result.isSuccess)
        assertEquals("Modificado", result.getOrThrow().name)
    }

    @Test
    fun `actualizar producto fallido retorna error`() = runTest {
        val sut = DoUpdateProduct(FakeProductService(updateResult = Result.failure(RuntimeException("Error"))))

        val result = sut.execute("biz-1", "1", ProductRequest("Modificado", null, 7.0, "kg", "c1", ProductStatus.Published))

        assertTrue(result.isFailure)
    }
}

class DoDeleteProductTest {

    @Test
    fun `eliminar producto exitoso retorna Unit`() = runTest {
        val sut = DoDeleteProduct(FakeProductService(deleteResult = Result.success(Unit)))

        val result = sut.execute("biz-1", "prod-1")

        assertTrue(result.isSuccess)
    }

    @Test
    fun `eliminar producto fallido retorna error`() = runTest {
        val sut = DoDeleteProduct(FakeProductService(deleteResult = Result.failure(RuntimeException("Error"))))

        val result = sut.execute("biz-1", "prod-1")

        assertTrue(result.isFailure)
    }
}

// endregion
