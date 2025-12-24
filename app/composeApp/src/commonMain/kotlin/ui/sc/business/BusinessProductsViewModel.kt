package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.business.ToGetBusinessProducts
import ext.dto.BusinessProductDTO
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel
import io.konform.validation.Validation

enum class BusinessProductsFilter {
    ALL, PUBLISHED, DRAFT;

    fun toQuery(): String = when (this) {
        ALL -> "ALL"
        PUBLISHED -> "PUBLISHED"
        DRAFT -> "DRAFT"
    }
}

enum class BusinessProductStatus {
    Published,
    Draft,
    Unknown;

    companion object {
        fun fromRaw(value: String?): BusinessProductStatus = when (value?.uppercase()) {
            "PUBLISHED" -> Published
            "DRAFT" -> Draft
            else -> Unknown
        }
    }
}

data class BusinessProduct(
    val id: String,
    val name: String,
    val priceLabel: String,
    val status: BusinessProductStatus,
    val emoji: String
)

data class BusinessProductsUiState(
    val products: List<BusinessProduct> = emptyList(),
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val selectedFilter: BusinessProductsFilter = BusinessProductsFilter.ALL
)

class BusinessProductsViewModel(
    private val toGetBusinessProducts: ToGetBusinessProducts = DIManager.di.direct.instance()
) : ViewModel() {

    private val logger = LoggerFactory.default.newLogger<BusinessProductsViewModel>()

    var state by mutableStateOf(BusinessProductsUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {
        inputsStates = mutableMapOf()
    }

    init {
        validation = Validation<BusinessProductsUiState> { } as Validation<Any>
        initInputState()
    }

    suspend fun loadProducts(
        businessId: String,
        filter: BusinessProductsFilter = state.selectedFilter
    ) {
        state = state.copy(isLoading = true, errorMessage = null, selectedFilter = filter)
        toGetBusinessProducts.execute(businessId, filter.toQuery())
            .onSuccess { response ->
                state = state.copy(
                    isLoading = false,
                    products = response.products.map(::mapProduct),
                    errorMessage = null
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al cargar productos" }
                state = state.copy(
                    isLoading = false,
                    errorMessage = error.message ?: ""
                )
            }
    }

    suspend fun updateFilter(businessId: String, filter: BusinessProductsFilter) {
        if (state.selectedFilter == filter) return
        loadProducts(businessId, filter)
    }

    private fun mapProduct(dto: BusinessProductDTO): BusinessProduct {
        val status = BusinessProductStatus.fromRaw(dto.status)
        val priceLabel = "$${dto.basePrice}"
        val emoji = dto.emoji?.takeIf { it.isNotBlank() } ?: "📦"

        return BusinessProduct(
            id = dto.id,
            name = dto.name,
            priceLabel = priceLabel,
            status = status,
            emoji = emoji
        )
    }
}
