package ui.sc.business

import asdo.business.ToDoCreateProduct
import asdo.business.ToDoDeleteProduct
import asdo.business.ToDoListCategories
import asdo.business.ToDoListProducts
import asdo.business.ToDoUpdateProduct
import ar.com.intrale.shared.business.CategoryDTO
import ar.com.intrale.shared.business.ProductDTO
import ar.com.intrale.shared.business.ProductRequest
import ar.com.intrale.shared.business.ProductStatus
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

private fun sampleProduct(
    id: String = "new-id",
    isAvailable: Boolean = true,
    stockQuantity: Int? = null,
    isFeatured: Boolean = false,
    promotionPrice: Double? = null
) = ProductDTO(
    id = id,
    name = "Producto",
    shortDescription = "Desc",
    basePrice = 10.0,
    unit = "kg",
    categoryId = "fruta",
    status = ProductStatus.Draft,
    isAvailable = isAvailable,
    stockQuantity = stockQuantity,
    isFeatured = isFeatured,
    promotionPrice = promotionPrice
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
            categoryId = "fruta"
        )
        val result = viewModel.save("biz-1")
        assertTrue(result.isSuccess)
        assertEquals(ProductFormMode.Edit, viewModel.mode)
        assertEquals("new-id", viewModel.uiState.id)
    }

    @Test
    fun `no se puede eliminar sin id`() = runTest {
        val fake = FakeProductCrud()
        val viewModel = ProductFormViewModel(fake, fake, fake, fake, ProductFormFakeCategories())
        val result = viewModel.delete("biz-1")
        assertTrue(result.isFailure)
        assertFalse(viewModel.loading)
    }

    @Test
    fun `disponibilidad se incluye en el estado al aplicar draft`() = runTest {
        val fake = FakeProductCrud()
        val viewModel = ProductFormViewModel(fake, fake, fake, fake, ProductFormFakeCategories())
        viewModel.applyDraft(
            ProductDraft(
                id = "p1",
                name = "Test",
                basePrice = 5.0,
                unit = "kg",
                categoryId = "fruta",
                isAvailable = false,
                stockQuantity = 10
            )
        )
        assertFalse(viewModel.uiState.isAvailable)
        assertEquals("10", viewModel.uiState.stockQuantity)
    }

    @Test
    fun `guardado exitoso incluye disponibilidad y stock`() = runTest {
        val saved = sampleProduct(isAvailable = false, stockQuantity = 5)
        val fake = FakeProductCrud(createResult = Result.success(saved))
        val viewModel = ProductFormViewModel(fake, fake, fake, fake, ProductFormFakeCategories())
        viewModel.uiState = viewModel.uiState.copy(
            name = "Test",
            basePrice = "10",
            unit = "kg",
            categoryId = "fruta",
            isAvailable = false,
            stockQuantity = "5"
        )
        val result = viewModel.save("biz-1")
        assertTrue(result.isSuccess)
        assertFalse(viewModel.uiState.isAvailable)
    }

    @Test
    fun `destacado se aplica correctamente desde draft`() = runTest {
        val fake = FakeProductCrud()
        val viewModel = ProductFormViewModel(fake, fake, fake, fake, ProductFormFakeCategories())
        viewModel.applyDraft(
            ProductDraft(
                id = "p2",
                name = "Manzana",
                basePrice = 1200.0,
                unit = "kg",
                categoryId = "fruta",
                isFeatured = true
            )
        )
        assertTrue(viewModel.uiState.isFeatured)
    }

    @Test
    fun `precio promocional se aplica correctamente desde draft`() = runTest {
        val fake = FakeProductCrud()
        val viewModel = ProductFormViewModel(fake, fake, fake, fake, ProductFormFakeCategories())
        viewModel.applyDraft(
            ProductDraft(
                id = "p3",
                name = "Manzana",
                basePrice = 1200.0,
                unit = "kg",
                categoryId = "fruta",
                promotionPrice = 900.0
            )
        )
        assertEquals("900.0", viewModel.uiState.promotionPrice)
    }

    @Test
    fun `updateFeatured cambia el estado correctamente`() = runTest {
        val fake = FakeProductCrud()
        val viewModel = ProductFormViewModel(fake, fake, fake, fake, ProductFormFakeCategories())
        assertFalse(viewModel.uiState.isFeatured)
        viewModel.updateFeatured(true)
        assertTrue(viewModel.uiState.isFeatured)
        viewModel.updateFeatured(false)
        assertFalse(viewModel.uiState.isFeatured)
    }

    @Test
    fun `updatePromotionPrice actualiza el campo correctamente`() = runTest {
        val fake = FakeProductCrud()
        val viewModel = ProductFormViewModel(fake, fake, fake, fake, ProductFormFakeCategories())
        viewModel.updatePromotionPrice("850.50")
        assertEquals("850.50", viewModel.uiState.promotionPrice)
    }

    @Test
    fun `guardado exitoso incluye destacado y precio promocional`() = runTest {
        val saved = sampleProduct(isFeatured = true, promotionPrice = 900.0)
        val fake = FakeProductCrud(createResult = Result.success(saved))
        val viewModel = ProductFormViewModel(fake, fake, fake, fake, ProductFormFakeCategories())
        viewModel.uiState = viewModel.uiState.copy(
            name = "Manzana roja",
            basePrice = "1200",
            unit = "kg",
            categoryId = "fruta",
            isFeatured = true,
            promotionPrice = "900"
        )
        val result = viewModel.save("biz-1")
        assertTrue(result.isSuccess)
        assertTrue(viewModel.uiState.isFeatured)
        assertEquals("900.0", viewModel.uiState.promotionPrice)
    }
}
