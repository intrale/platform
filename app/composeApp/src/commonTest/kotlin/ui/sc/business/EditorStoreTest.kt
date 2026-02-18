package ui.sc.business

import ext.business.ProductStatus
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
