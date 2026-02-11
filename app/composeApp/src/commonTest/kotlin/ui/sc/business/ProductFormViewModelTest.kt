package ui.sc.business

import asdo.business.ToDoCreateProduct
import asdo.business.ToDoDeleteProduct
import asdo.business.ToDoListCategories
import asdo.business.ToDoListProducts
import asdo.business.ToDoUpdateProduct
import ext.business.CategoryDTO
import ext.business.ProductDTO
import ext.business.ProductRequest
import ext.business.ProductStatus
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private class FakeProductCrud(
    private val createResult: Result<ProductDTO> = Result.success(sampleProduct()),
    private val updateResult: Result<ProductDTO> = Result.success(sampleProduct(id = "updated")),
    private val deleteResult: Result<Unit> = Result.success(Unit),
    private val listResult: Result<List<ProductDTO>> = Result.success(emptyList())
) : ToDoCreateProduct, ToDoUpdateProduct, ToDoDeleteProduct, ToDoListProducts {
    override suspend fun execute(businessId: String, request: ProductRequest): Result<ProductDTO> =
        createResult

    override suspend fun execute(
        businessId: String,
        productId: String,
        request: ProductRequest
    ): Result<ProductDTO> = updateResult

    override suspend fun execute(businessId: String, productId: String): Result<Unit> = deleteResult

    override suspend fun execute(businessId: String): Result<List<ProductDTO>> = listResult
}

private class ProductFormFakeCategories(
    private val listResult: Result<List<CategoryDTO>> = Result.success(emptyList())
) : ToDoListCategories {
    override suspend fun execute(businessId: String): Result<List<CategoryDTO>> = listResult
}

private fun sampleProduct(id: String = "new-id") = ProductDTO(
    id = id,
    name = "Producto",
    shortDescription = "Desc",
    basePrice = 10.0,
    unit = "kg",
    categoryId = "fruta",
    status = ProductStatus.Draft
)

class ProductFormViewModelTest {

    @Test
    fun `precio invalido bloquea guardado`() = runTest {
        val fake = FakeProductCrud()
        val viewModel = ProductFormViewModel(fake, fake, fake, fake, ProductFormFakeCategories())
        viewModel.uiState = viewModel.uiState.copy(
            name = "Test",
            basePrice = "-1",
            unit = "kg",
            categoryId = "fruta"
        )
        val result = viewModel.save("biz-1")
        assertTrue(result.isFailure)
    }

    @Test
    fun `creacion exitosa cambia a modo edicion`() = runTest {
        val fake = FakeProductCrud()
        val viewModel = ProductFormViewModel(fake, fake, fake, fake, ProductFormFakeCategories())
        viewModel.uiState = viewModel.uiState.copy(
            name = "Test",
            basePrice = "12.5",
            unit = "kg",
            categoryId = "fruta",
            isAvailable = false,
            stockQuantity = "0"
        )
        val result = viewModel.save("biz-1")
        assertTrue(result.isSuccess)
        assertEquals(ProductFormMode.Edit, viewModel.mode)
        assertEquals("new-id", viewModel.uiState.id)
        assertTrue(viewModel.uiState.isAvailable)
        assertEquals("", viewModel.uiState.stockQuantity)
    }

    @Test
    fun `no se puede eliminar sin id`() = runTest {
        val fake = FakeProductCrud()
        val viewModel = ProductFormViewModel(fake, fake, fake, fake, ProductFormFakeCategories())
        val result = viewModel.delete("biz-1")
        assertTrue(result.isFailure)
        assertFalse(viewModel.loading)
    }
}
