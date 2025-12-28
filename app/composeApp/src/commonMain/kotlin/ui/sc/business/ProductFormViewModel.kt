package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ar.com.intrale.strings.model.MessageKey
import ar.com.intrale.strings.resolveMessage
import asdo.business.ToDoCreateProduct
import asdo.business.ToDoDeleteProduct
import asdo.business.ToDoListProducts
import asdo.business.ToDoUpdateProduct
import ext.business.ProductDTO
import ext.business.ProductRequest
import ext.business.ProductStatus
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
    val status: ProductStatus = ProductStatus.Draft
)

class ProductFormViewModel(
    private val createProduct: ToDoCreateProduct = DIManager.di.direct.instance(),
    private val updateProduct: ToDoUpdateProduct = DIManager.di.direct.instance(),
    private val deleteProduct: ToDoDeleteProduct = DIManager.di.direct.instance(),
    private val listProducts: ToDoListProducts = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<ProductFormViewModel>()

    var uiState by mutableStateOf(ProductFormUiState())
    var loading by mutableStateOf(false)
    var mode by mutableStateOf(ProductFormMode.Create)
        private set
    var errorMessage by mutableStateOf<String?>(null)
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
                status = draft.status
            )
        }
        mode = if (uiState.id == null) ProductFormMode.Create else ProductFormMode.Edit
        errorMessage = null
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
        val request = ProductRequest(
            name = uiState.name.trim(),
            shortDescription = uiState.shortDescription.ifBlank { null },
            basePrice = price,
            unit = uiState.unit.trim(),
            categoryId = uiState.categoryId.trim(),
            status = uiState.status
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

    private fun ProductDTO.toDraft(): ProductDraft = ProductDraft(
        id = id,
        name = name,
        shortDescription = shortDescription.orEmpty(),
        basePrice = basePrice,
        unit = unit,
        categoryId = categoryId,
        status = status
    )
}
