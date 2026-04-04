package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ar.com.intrale.strings.model.MessageKey
import ar.com.intrale.strings.resolveMessage
import asdo.business.ToDoAnalyzeProductPhoto
import asdo.business.ToDoCreateProduct
import asdo.business.ToDoDeleteProduct
import asdo.business.ToDoListProducts
import asdo.business.ToDoUpdateProduct
import asdo.business.ToDoListCategories
import ar.com.intrale.shared.business.CategoryDTO
import ar.com.intrale.shared.business.ProductDTO
import ar.com.intrale.shared.business.ProductRequest
import ar.com.intrale.shared.business.ProductStatus
import io.konform.validation.Validation
import io.konform.validation.jsonschema.minLength
import io.konform.validation.jsonschema.pattern
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

enum class ProductFormMode { Create, Edit }

data class ProductFormUiState(
    val id: String? = null,
    val name: String = "",
    val shortDescription: String = "",
    val basePrice: String = "",
    val unit: String = "",
    val categoryId: String = "",
    val status: ProductStatus = ProductStatus.Draft,
    val isAvailable: Boolean = true,
    val stockQuantity: String = "",
    val isFeatured: Boolean = false,
    val promotionPrice: String = ""
)

class ProductFormViewModel(
    private val createProduct: ToDoCreateProduct = DIManager.di.direct.instance(),
    private val updateProduct: ToDoUpdateProduct = DIManager.di.direct.instance(),
    private val deleteProduct: ToDoDeleteProduct = DIManager.di.direct.instance(),
    private val listProducts: ToDoListProducts = DIManager.di.direct.instance(),
    private val listCategories: ToDoListCategories = DIManager.di.direct.instance(),
    private val analyzeProductPhoto: ToDoAnalyzeProductPhoto = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<ProductFormViewModel>()

    var uiState by mutableStateOf(ProductFormUiState())
    var loading by mutableStateOf(false)
    var mode by mutableStateOf(ProductFormMode.Create)
        private set
    var errorMessage by mutableStateOf<String?>(null)
        private set
    var categories by mutableStateOf<List<CategoryDTO>>(emptyList())
        private set
    var categoriesLoading by mutableStateOf(false)
        private set
    var categoryError by mutableStateOf<String?>(null)
        private set
    var photoAnalyzing by mutableStateOf(false)
        private set
    var photoError by mutableStateOf<String?>(null)
        private set

    override fun getState(): Any = uiState

    init {
        validation = Validation<ProductFormUiState> {
            ProductFormUiState::name required {
                minLength(1) hint resolveMessage(MessageKey.form_error_required)
            }
            ProductFormUiState::unit required {
                minLength(1) hint resolveMessage(MessageKey.form_error_required)
            }
            ProductFormUiState::categoryId required {
                minLength(1) hint resolveMessage(MessageKey.form_error_required)
            }
            ProductFormUiState::basePrice required {
                minLength(1) hint resolveMessage(MessageKey.form_error_required)
                pattern("^\\d+(\\.\\d+)?$") hint resolveMessage(MessageKey.product_form_error_invalid_price)
            }
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(ProductFormUiState::name.name),
            entry(ProductFormUiState::shortDescription.name),
            entry(ProductFormUiState::basePrice.name),
            entry(ProductFormUiState::unit.name),
            entry(ProductFormUiState::categoryId.name)
        )
    }

    fun applyDraft(draft: ProductDraft?) {
        uiState = if (draft == null) {
            ProductFormUiState()
        } else {
            ProductFormUiState(
                id = draft.id,
                name = draft.name,
                shortDescription = draft.shortDescription,
                basePrice = draft.basePrice?.toString().orEmpty(),
                unit = draft.unit,
                categoryId = draft.categoryId,
                status = draft.status,
                isAvailable = draft.isAvailable,
                stockQuantity = draft.stockQuantity?.toString().orEmpty(),
                isFeatured = draft.isFeatured,
                promotionPrice = draft.promotionPrice?.toString().orEmpty()
            )
        }
        mode = if (uiState.id == null) ProductFormMode.Create else ProductFormMode.Edit
        errorMessage = null
    }

    suspend fun loadCategories(businessId: String?) {
        if (businessId.isNullOrBlank()) return
        categoriesLoading = true
        categoryError = null
        listCategories.execute(businessId)
            .onSuccess { loaded ->
                categories = loaded.filter { !it.id.isNullOrBlank() }
                if (uiState.categoryId.isNotBlank() &&
                    categories.none { it.id == uiState.categoryId }
                ) {
                    uiState = uiState.copy(categoryId = "")
                }
            }
            .onFailure { error ->
                logger.error(error) { "No se pudieron cargar categorías" }
                categoryError = error.message
            }
        categoriesLoading = false
    }

    suspend fun ensureProductLoaded(businessId: String, productId: String?) {
        if (productId.isNullOrBlank()) return
        if (uiState.id == productId && uiState.name.isNotBlank()) return
        listProducts.execute(businessId)
            .onSuccess { products ->
                products.firstOrNull { it.id == productId }?.let { product ->
                    applyDraft(product.toDraft())
                }
            }
            .onFailure { error ->
                logger.error(error) { "No se pudo cargar el producto $productId" }
                errorMessage = error.message
        }
    }

    fun updateCategory(categoryId: String) {
        uiState = uiState.copy(categoryId = categoryId)
    }

    fun categoryName(categoryId: String): String =
        categories.firstOrNull { it.id == categoryId }?.name.orEmpty()

    /**
     * Analiza una foto de producto con IA y pre-llena los campos del formulario.
     */
    suspend fun analyzePhoto(businessId: String, imageBase64: String, mediaType: String) {
        photoAnalyzing = true
        photoError = null
        val categoryNames = categories.mapNotNull { cat ->
            cat.id?.let { id -> cat.name }
        }
        analyzeProductPhoto.execute(
            businessId = businessId,
            imageBase64 = imageBase64,
            mediaType = mediaType,
            existingCategories = categoryNames
        ).onSuccess { response ->
            if (response.suggestedName.isNotBlank()) {
                uiState = uiState.copy(name = response.suggestedName)
            }
            if (response.suggestedDescription.isNotBlank()) {
                uiState = uiState.copy(shortDescription = response.suggestedDescription)
            }
            // Intentar matchear la categoria sugerida con las existentes
            if (response.suggestedCategory.isNotBlank()) {
                val matchedCategory = categories.firstOrNull { cat ->
                    cat.name.equals(response.suggestedCategory, ignoreCase = true)
                }
                if (matchedCategory?.id != null) {
                    uiState = uiState.copy(categoryId = matchedCategory.id!!)
                }
            }
            logger.info { "Foto analizada: nombre='${response.suggestedName}' confidence=${response.confidence}" }
        }.onFailure { error ->
            logger.error(error) { "Error al analizar foto de producto" }
            photoError = error.message
        }
        photoAnalyzing = false
    }

    suspend fun save(businessId: String): Result<ProductDTO> {
        if (!isValid()) {
            errorMessage = resolveMessage(MessageKey.form_error_required)
            return Result.failure(IllegalStateException(errorMessage))
        }
        val price = uiState.basePrice.replace(",", ".").toDoubleOrNull()
            ?: return Result.failure(IllegalArgumentException(resolveMessage(MessageKey.product_form_error_invalid_price)))
        if (price <= 0) {
            return Result.failure(IllegalArgumentException(resolveMessage(MessageKey.product_form_error_invalid_price)))
        }
        val stockQty = uiState.stockQuantity.toIntOrNull()
        val promoPrice = uiState.promotionPrice.replace(",", ".").toDoubleOrNull()
        val request = ProductRequest(
            name = uiState.name.trim(),
            shortDescription = uiState.shortDescription.ifBlank { null },
            basePrice = price,
            unit = uiState.unit.trim(),
            categoryId = uiState.categoryId.trim(),
            status = uiState.status,
            isAvailable = uiState.isAvailable,
            stockQuantity = stockQty,
            isFeatured = uiState.isFeatured,
            promotionPrice = promoPrice
        )
        return if (uiState.id == null) {
            createProduct.execute(businessId, request)
        } else {
            updateProduct.execute(businessId, uiState.id!!, request)
        }.onSuccess { product ->
            applyDraft(product.toDraft())
        }.onFailure { error ->
            errorMessage = error.message
        }
    }

    suspend fun delete(businessId: String): Result<Unit> {
        val productId = uiState.id
            ?: return Result.failure(IllegalStateException("Producto sin id"))
        return deleteProduct.execute(businessId, productId)
            .onFailure { error -> errorMessage = error.message }
    }

    fun updateStatus(status: ProductStatus) {
        uiState = uiState.copy(status = status)
    }

    fun updateAvailability(isAvailable: Boolean) {
        uiState = uiState.copy(isAvailable = isAvailable)
    }

    fun updateStockQuantity(value: String) {
        uiState = uiState.copy(stockQuantity = value)
    }

    fun updateFeatured(isFeatured: Boolean) {
        uiState = uiState.copy(isFeatured = isFeatured)
    }

    fun updatePromotionPrice(value: String) {
        uiState = uiState.copy(promotionPrice = value)
    }

    private fun ProductDTO.toDraft(): ProductDraft = ProductDraft(
        id = id,
        name = name,
        shortDescription = shortDescription.orEmpty(),
        basePrice = basePrice,
        unit = unit,
        categoryId = categoryId,
        status = status,
        isAvailable = isAvailable,
        stockQuantity = stockQuantity,
        isFeatured = isFeatured,
        promotionPrice = promotionPrice
    )
}
