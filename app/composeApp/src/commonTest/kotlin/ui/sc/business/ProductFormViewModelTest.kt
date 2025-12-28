package ui.sc.business

import asdo.business.ToDoCreateProduct
import asdo.business.ToDoDeleteProduct
import asdo.business.ToDoListProducts
import asdo.business.ToDoUpdateProduct
import ext.business.ProductDTO
import ext.business.ProductRequest
import ext.business.ProductStatus
import kotlinx.coroutines.runBlocking
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
    fun `precio invalido bloquea guardado`() = runBlocking {
        val fake = FakeProductCrud()
        val viewModel = ProductFormViewModel(fake, fake, fake, fake)
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
    fun `creacion exitosa cambia a modo edicion`() = runBlocking {
        val fake = FakeProductCrud()
        val viewModel = ProductFormViewModel(fake, fake, fake, fake)
        viewModel.uiState = viewModel.uiState.copy(
            name = "Test",
            basePrice = "12.5",
            unit = "kg",
            categoryId = "fruta"
        )
        val result = viewModel.save("biz-1")
        assertTrue(result.isSuccess)
        assertEquals(ProductFormMode.Edit, viewModel.mode)
        assertEquals("new-id", viewModel.uiState.id)
    }

    @Test
    fun `no se puede eliminar sin id`() = runBlocking {
        val fake = FakeProductCrud()
        val viewModel = ProductFormViewModel(fake, fake, fake, fake)
        val result = viewModel.delete("biz-1")
        assertTrue(result.isFailure)
        assertFalse(viewModel.loading)
    }
}
