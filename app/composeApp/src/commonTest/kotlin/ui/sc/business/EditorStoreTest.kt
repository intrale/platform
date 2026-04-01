package ui.sc.business

import ar.com.intrale.shared.business.ProductStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class EditorStoreTest {

    // ── CategoryEditorStore ─────────────────────────────────────────

    @Test
    fun `CategoryEditorStore setDraft establece borrador`() {
        CategoryEditorStore.clear()

        val draft = CategoryDraft(
            id = "cat-1",
            name = "Bebidas",
            description = "Bebidas frías y calientes",
            productCount = 5,
        )
        CategoryEditorStore.setDraft(draft)

        assertEquals(draft, CategoryEditorStore.draft.value)
    }

    @Test
    fun `CategoryEditorStore clear limpia borrador`() {
        CategoryEditorStore.setDraft(
            CategoryDraft(id = "cat-2", name = "Snacks", description = "Aperitivos")
        )

        CategoryEditorStore.clear()

        assertNull(CategoryEditorStore.draft.value)
    }

    // ── ProductEditorStore ──────────────────────────────────────────

    @Test
    fun `ProductEditorStore setDraft establece borrador`() {
        ProductEditorStore.clear()

        val draft = ProductDraft(
            id = "prod-1",
            name = "Agua mineral",
            shortDescription = "500ml",
            basePrice = 1.50,
            unit = "unidad",
            categoryId = "cat-1",
            status = ProductStatus.Draft,
        )
        ProductEditorStore.setDraft(draft)

        assertEquals(draft, ProductEditorStore.draft.value)
    }

    @Test
    fun `CategoryEditorStore update transforma borrador`() {
        val initial = CategoryDraft(
            id = "cat-3",
            name = "Lacteos",
            description = "Leche y derivados",
            productCount = 3,
        )
        CategoryEditorStore.setDraft(initial)

        CategoryEditorStore.update { current ->
            current?.copy(name = "Lacteos y huevos", description = "Leche, queso, yogur y huevos")
        }

        val updated = CategoryEditorStore.draft.value
        assertEquals("Lacteos y huevos", updated?.name)
        assertEquals("Leche, queso, yogur y huevos", updated?.description)
    }

    // ── BannerEditorStore ──────────────────────────────────────────

    @Test
    fun `BannerEditorStore setDraft establece borrador`() {
        BannerEditorStore.clear()

        val draft = BannerDraft(
            id = "banner-1",
            title = "Promo verano",
            text = "20% en bebidas",
            imageUrl = "https://example.com/banner.jpg",
            position = "home",
            active = true
        )
        BannerEditorStore.setDraft(draft)

        assertEquals(draft, BannerEditorStore.draft.value)
    }

    @Test
    fun `BannerEditorStore update transforma borrador`() {
        val initial = BannerDraft(
            id = "banner-2",
            title = "Oferta",
            text = "Descuento",
            imageUrl = "https://example.com/img.jpg",
        )
        BannerEditorStore.setDraft(initial)

        BannerEditorStore.update { current ->
            current?.copy(title = "Super oferta", active = false)
        }

        val updated = BannerEditorStore.draft.value
        assertEquals("Super oferta", updated?.title)
        assertEquals(false, updated?.active)
    }

    @Test
    fun `BannerEditorStore clear limpia borrador`() {
        BannerEditorStore.setDraft(
            BannerDraft(id = "banner-3", title = "Test", text = "Borrar")
        )

        BannerEditorStore.clear()

        assertNull(BannerEditorStore.draft.value)
    }

    // ── BusinessOrderSelectionStore ────────────────────────────────

    @Test
    fun `BusinessOrderSelectionStore select establece orderId`() {
        BusinessOrderSelectionStore.clear()

        BusinessOrderSelectionStore.select("order-123")

        assertEquals("order-123", BusinessOrderSelectionStore.selectedOrderId.value)
    }

    @Test
    fun `BusinessOrderSelectionStore clear resetea orderId`() {
        BusinessOrderSelectionStore.select("order-456")

        BusinessOrderSelectionStore.clear()

        assertNull(BusinessOrderSelectionStore.selectedOrderId.value)
    }

    @Test
    fun `BusinessOrderSelectionStore select reemplaza seleccion anterior`() {
        BusinessOrderSelectionStore.select("order-1")
        BusinessOrderSelectionStore.select("order-2")

        assertEquals("order-2", BusinessOrderSelectionStore.selectedOrderId.value)
    }

    @Test
    fun `ProductEditorStore update transforma borrador`() {
        val initial = ProductDraft(
            id = "prod-2",
            name = "Gaseosa",
            shortDescription = "1L",
            basePrice = 2.00,
            unit = "unidad",
            categoryId = "cat-1",
            status = ProductStatus.Draft,
        )
        ProductEditorStore.setDraft(initial)

        ProductEditorStore.update { current ->
            current?.copy(name = "Gaseosa cola", status = ProductStatus.Published)
        }

        val updated = ProductEditorStore.draft.value
        assertEquals("Gaseosa cola", updated?.name)
        assertEquals(ProductStatus.Published, updated?.status)
    }
}
