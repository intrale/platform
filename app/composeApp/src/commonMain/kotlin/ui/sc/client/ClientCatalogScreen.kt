package ui.sc.client

import DIManager
import ar.com.intrale.BuildKonfig
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.business.ToDoListCategories
import asdo.business.ToDoListProducts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.shared.business.CategoryDTO
import ar.com.intrale.shared.business.ProductDTO
import ar.com.intrale.shared.business.ProductStatus
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.sc.shared.ViewModel
import ui.session.SessionStore
import ui.th.elevations
import ui.th.spacing
import ui.util.formatPrice

const val CLIENT_CATALOG_PATH = "/client/catalog"

data class CategoryItem(
    val id: String,
    val name: String
)

data class SearchSuggestion(
    val product: ClientProduct,
    val matchRanges: List<IntRange> = emptyList()
)

data class ClientCatalogUiState(
    val productsState: ClientProductsState = ClientProductsState.Loading,
    val categories: List<CategoryItem> = emptyList(),
    val selectedCategoryId: String? = null,
    val searchQuery: String = "",
    val lastAddedProduct: ClientProduct? = null,
    val suggestions: List<SearchSuggestion> = emptyList(),
    val showSuggestions: Boolean = false,
    val isSearchFocused: Boolean = false
)

class ClientCatalogViewModel(
    private val toDoListProducts: ToDoListProducts = DIManager.di.direct.instance(),
    private val toDoListCategories: ToDoListCategories = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<ClientCatalogViewModel>()

    var state by mutableStateOf(ClientCatalogUiState())
        private set

    private var allProducts: List<ClientProduct> = emptyList()

    override fun getState(): Any = state

    override fun initInputState() { /* Sin formulario */ }

    suspend fun loadCatalog() {
        logger.info { "Cargando catalogo completo para cliente" }
        state = state.copy(productsState = ClientProductsState.Loading)

        state = runCatching {
            val businessId = resolveBusinessId()
            coroutineScope {
                val productsDeferred = async { fetchProducts(businessId) }
                val categoriesDeferred = async { fetchCategories(businessId) }
                productsDeferred.await() to categoriesDeferred.await()
            }
        }.fold(
            onSuccess = { (products, categories) ->
                allProducts = products
                val nextState = if (products.isEmpty()) {
                    ClientProductsState.Empty
                } else {
                    ClientProductsState.Loaded(products)
                }
                state.copy(
                    productsState = nextState,
                    categories = categories,
                    selectedCategoryId = null,
                    searchQuery = ""
                )
            },
            onFailure = { error ->
                logger.error(error) { "Error al cargar catalogo" }
                state.copy(
                    productsState = ClientProductsState.Error(error.message ?: "")
                )
            }
        )
    }

    fun selectCategory(categoryId: String?) {
        state = state.copy(selectedCategoryId = categoryId)
        applyFilters()
    }

    /**
     * Actualiza el query de busqueda. Las sugerencias se calculan
     * via debounce en el Composable con [computeSuggestions].
     */
    fun onSearchChange(query: String) {
        state = state.copy(searchQuery = query, showSuggestions = query.length >= 2)
        applyFilters()
    }

    /**
     * Calcula las sugerencias filtrando productos disponibles con stock
     * y generando rangos de match para highlighting.
     */
    fun computeSuggestions(query: String) {
        if (query.length < 2) {
            state = state.copy(suggestions = emptyList(), showSuggestions = false)
            return
        }

        val suggestions = allProducts
            .filter { it.isAvailable }
            .mapNotNull { product ->
                val matchRanges = findMatchRanges(product.name, query)
                if (matchRanges.isNotEmpty()) {
                    SearchSuggestion(product = product, matchRanges = matchRanges)
                } else null
            }
            .take(MAX_SUGGESTIONS)

        state = state.copy(suggestions = suggestions, showSuggestions = suggestions.isNotEmpty())
    }

    fun onSearchFocusChanged(focused: Boolean) {
        state = state.copy(isSearchFocused = focused)
        if (focused && state.searchQuery.isBlank()) {
            // Mostrar historial cuando el campo esta vacio y tiene foco
            state = state.copy(showSuggestions = false)
        }
    }

    /**
     * Selecciona una sugerencia: aplica el filtro, guarda en historial
     * y oculta las sugerencias.
     */
    fun selectSuggestion(suggestion: SearchSuggestion) {
        val query = suggestion.product.name
        SearchHistoryStore.addSearch(query)
        state = state.copy(
            searchQuery = query,
            showSuggestions = false
        )
        applyFilters()
    }

    /**
     * Selecciona un termino del historial de busquedas.
     */
    fun selectHistoryItem(query: String) {
        state = state.copy(searchQuery = query, showSuggestions = false)
        applyFilters()
        computeSuggestions(query)
    }

    /**
     * Confirma la busqueda actual (al presionar enter/buscar).
     * Guarda en historial y oculta sugerencias.
     */
    fun confirmSearch() {
        val query = state.searchQuery.trim()
        if (query.length >= 2) {
            SearchHistoryStore.addSearch(query)
        }
        state = state.copy(showSuggestions = false)
    }

    fun dismissSuggestions() {
        state = state.copy(showSuggestions = false)
    }

    fun clearSearch() {
        state = state.copy(searchQuery = "", showSuggestions = false, suggestions = emptyList())
        applyFilters()
    }

    fun addToCart(product: ClientProduct) {
        ClientCartStore.add(product)
        state = state.copy(lastAddedProduct = product)
    }

    fun clearLastAddedProduct() {
        if (state.lastAddedProduct != null) {
            state = state.copy(lastAddedProduct = null)
        }
    }

    private fun applyFilters() {
        if (allProducts.isEmpty()) return

        val filtered = allProducts.filter { product ->
            val matchesCategory = state.selectedCategoryId == null ||
                product.categoryId == state.selectedCategoryId
            val matchesSearch = state.searchQuery.isBlank() ||
                product.name.contains(state.searchQuery, ignoreCase = true)
            matchesCategory && matchesSearch
        }

        state = state.copy(
            productsState = if (filtered.isEmpty()) {
                ClientProductsState.Empty
            } else {
                ClientProductsState.Loaded(filtered)
            }
        )
    }

    private suspend fun fetchProducts(businessId: String): List<ClientProduct> {
        logger.info { "Cargando productos publicados para negocio $businessId" }
        return toDoListProducts.execute(businessId).getOrThrow()
            .filter { product -> product.status == ProductStatus.Published }
            .map { product ->
                ClientProduct(
                    id = product.id ?: "",
                    name = product.name,
                    priceLabel = formatPrice(product.basePrice),
                    emoji = "\uD83D\uDECD\uFE0F",
                    unitPrice = product.basePrice,
                    categoryId = product.categoryId,
                    isAvailable = product.isAvailable,
                    isFeatured = product.isFeatured,
                    promotionPrice = product.promotionPrice
                )
            }
    }

    private suspend fun fetchCategories(businessId: String): List<CategoryItem> {
        logger.info { "Cargando categorias para negocio $businessId" }
        return toDoListCategories.execute(businessId).getOrThrow()
            .mapNotNull { category ->
                val id = category.id ?: return@mapNotNull null
                CategoryItem(id = id, name = category.name)
            }
    }

    private fun resolveBusinessId(): String {
        val sessionBusiness = SessionStore.sessionState.value.selectedBusinessId
        return (sessionBusiness ?: BuildKonfig.BUSINESS).takeIf { it.isNotBlank() }
            ?: throw IllegalStateException("Business no configurado")
    }

    companion object {
        internal const val MAX_SUGGESTIONS = 8
        internal const val DEBOUNCE_MS = 300L

        /**
         * Encuentra los rangos de match del query dentro del texto.
         * Soporta busqueda case-insensitive.
         */
        internal fun findMatchRanges(text: String, query: String): List<IntRange> {
            if (query.isBlank()) return emptyList()
            val ranges = mutableListOf<IntRange>()
            val lowerText = text.lowercase()
            val lowerQuery = query.lowercase()
            var startIndex = 0
            while (startIndex < lowerText.length) {
                val index = lowerText.indexOf(lowerQuery, startIndex)
                if (index < 0) break
                ranges.add(index until (index + query.length))
                startIndex = index + 1
            }
            return ranges
        }
    }
}

class ClientCatalogScreen : Screen(CLIENT_CATALOG_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_catalog_title

    @OptIn(FlowPreview::class)
    @Composable
    override fun screen() {
        val coroutineScope = rememberCoroutineScope()
        val viewModel: ClientCatalogViewModel = viewModel { ClientCatalogViewModel() }
        val uiState = viewModel.state
        val cartItems by ClientCartStore.items.collectAsState()
        val cartCount = cartItems.values.sumOf { it.quantity }
        val searchHistory by SearchHistoryStore.history.collectAsState()

        val title = Txt(MessageKey.client_catalog_title)
        val subtitle = Txt(MessageKey.client_catalog_subtitle)
        val searchPlaceholder = Txt(MessageKey.client_catalog_search_placeholder)
        val filterAll = Txt(MessageKey.client_catalog_filter_all)
        val emptyMessage = Txt(MessageKey.client_catalog_empty)
        val errorMessage = Txt(MessageKey.client_catalog_error)
        val retryLabel = Txt(MessageKey.client_catalog_retry)
        val addLabel = Txt(MessageKey.client_catalog_add_label)
        val addContentDescription = Txt(MessageKey.client_catalog_add_content_description)
        val outOfStockLabel = Txt(MessageKey.client_product_out_of_stock)
        val noResultsMessage = Txt(MessageKey.client_catalog_search_no_results)
        val cartContentDescription = Txt(MessageKey.client_home_cart_icon_content_description)
        val recentSearchesLabel = Txt(MessageKey.client_catalog_recent_searches)
        val clearHistoryLabel = Txt(MessageKey.client_catalog_clear_history)
        val addedToCartMessage = uiState.lastAddedProduct?.let { product ->
            Txt(MessageKey.client_catalog_added_to_cart, mapOf("product" to product.name))
        }
        val snackbarHostState = remember { SnackbarHostState() }

        // Debounce para sugerencias en tiempo real
        LaunchedEffect(Unit) {
            viewModel.loadCatalog()
        }

        LaunchedEffect(Unit) {
            snapshotFlow { viewModel.state.searchQuery }
                .debounce(ClientCatalogViewModel.DEBOUNCE_MS)
                .distinctUntilChanged()
                .collect { query ->
                    viewModel.computeSuggestions(query)
                }
        }

        LaunchedEffect(addedToCartMessage) {
            addedToCartMessage?.let { message ->
                snackbarHostState.showSnackbar(message)
                viewModel.clearLastAddedProduct()
            }
        }

        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) },
            bottomBar = {
                ClientBottomBar(
                    activeTab = ClientTab.HOME,
                    onHomeClick = { navigateClearingBackStack(CLIENT_HOME_PATH) },
                    onOrdersClick = { navigate(CLIENT_ORDERS_PATH) },
                    onNotificationsClick = { navigate(CLIENT_NOTIFICATIONS_PATH) },
                    onProfileClick = { navigate(CLIENT_PROFILE_PATH) }
                )
            }
        ) { padding ->
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(
                    horizontal = MaterialTheme.spacing.x4,
                    vertical = MaterialTheme.spacing.x2
                ),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
            ) {
                item {
                    CatalogHeader(
                        title = title,
                        subtitle = subtitle,
                        cartCount = cartCount,
                        cartContentDescription = cartContentDescription,
                        onCartClick = { navigate(CLIENT_CART_PATH) },
                        onBackClick = { goBack() }
                    )
                }

                // Barra de busqueda con focus tracking y boton clear
                item {
                    SearchField(
                        query = uiState.searchQuery,
                        placeholder = searchPlaceholder,
                        onQueryChange = { viewModel.onSearchChange(it) },
                        onFocusChange = { viewModel.onSearchFocusChanged(it) },
                        onClear = { viewModel.clearSearch() },
                        onConfirm = { viewModel.confirmSearch() }
                    )
                }

                // Sugerencias en tiempo real
                if (uiState.showSuggestions && uiState.suggestions.isNotEmpty()) {
                    item {
                        SuggestionsDropdown(
                            suggestions = uiState.suggestions,
                            searchQuery = uiState.searchQuery,
                            onSuggestionClick = { suggestion ->
                                viewModel.selectSuggestion(suggestion)
                                ClientProductSelectionStore.select(suggestion.product.id)
                                this@ClientCatalogScreen.navigate(CLIENT_PRODUCT_DETAIL_PATH)
                            }
                        )
                    }
                }

                // Historial de busquedas recientes (cuando el campo tiene foco y esta vacio)
                if (uiState.isSearchFocused && uiState.searchQuery.isBlank() && searchHistory.isNotEmpty()) {
                    item {
                        SearchHistorySection(
                            history = searchHistory,
                            title = recentSearchesLabel,
                            clearLabel = clearHistoryLabel,
                            onHistoryItemClick = { viewModel.selectHistoryItem(it) },
                            onRemoveItem = { SearchHistoryStore.removeSearch(it) },
                            onClearAll = { SearchHistoryStore.clearHistory() }
                        )
                    }
                }

                if (uiState.categories.isNotEmpty()) {
                    item {
                        LazyRow(
                            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                        ) {
                            item {
                                FilterChip(
                                    selected = uiState.selectedCategoryId == null,
                                    onClick = { viewModel.selectCategory(null) },
                                    label = { Text(filterAll) }
                                )
                            }
                            items(uiState.categories, key = { it.id }) { category ->
                                FilterChip(
                                    selected = uiState.selectedCategoryId == category.id,
                                    onClick = { viewModel.selectCategory(category.id) },
                                    label = { Text(category.name) }
                                )
                            }
                        }
                    }
                }

                when (val productsState = uiState.productsState) {
                    ClientProductsState.Loading -> {
                        item { CatalogLoading() }
                    }

                    ClientProductsState.Empty -> {
                        item {
                            val displayMessage =
                                if (uiState.searchQuery.isNotBlank() || uiState.selectedCategoryId != null) {
                                    noResultsMessage
                                } else {
                                    emptyMessage
                                }
                            CatalogStateCard(
                                message = displayMessage,
                                actionLabel = retryLabel,
                                onAction = {
                                    coroutineScope.launch { viewModel.loadCatalog() }
                                }
                            )
                        }
                    }

                    is ClientProductsState.Error -> {
                        item {
                            CatalogStateCard(
                                message = productsState.message.ifBlank { errorMessage },
                                actionLabel = retryLabel,
                                onAction = {
                                    coroutineScope.launch { viewModel.loadCatalog() }
                                }
                            )
                        }
                    }

                    is ClientProductsState.Loaded -> {
                        items(productsState.products, key = { it.id }) { product ->
                            CatalogProductCard(
                                product = product,
                                addLabel = addLabel,
                                addContentDescription = addContentDescription,
                                outOfStockLabel = outOfStockLabel,
                                onAddClick = { viewModel.addToCart(product) },
                                onCardClick = {
                                    ClientProductSelectionStore.select(product.id)
                                    this@ClientCatalogScreen.navigate(CLIENT_PRODUCT_DETAIL_PATH)
                                }
                            )
                        }
                    }
                }

                item { Spacer(modifier = Modifier.height(MaterialTheme.spacing.x8)) }
            }
        }
    }
}

// --- Composables privados ---

@Composable
private fun SearchField(
    query: String,
    placeholder: String,
    onQueryChange: (String) -> Unit,
    onFocusChange: (Boolean) -> Unit,
    onClear: () -> Unit,
    onConfirm: () -> Unit
) {
    OutlinedTextField(
        value = query,
        onValueChange = onQueryChange,
        placeholder = { Text(placeholder) },
        leadingIcon = {
            Icon(Icons.Default.Search, contentDescription = placeholder)
        },
        trailingIcon = {
            AnimatedVisibility(
                visible = query.isNotEmpty(),
                enter = fadeIn(),
                exit = fadeOut()
            ) {
                IconButton(onClick = onClear) {
                    Icon(
                        Icons.Default.Close,
                        contentDescription = null,
                        modifier = Modifier.size(20.dp)
                    )
                }
            }
        },
        singleLine = true,
        modifier = Modifier
            .fillMaxWidth()
            .onFocusChanged { focusState -> onFocusChange(focusState.isFocused) }
    )
}

@Composable
private fun SuggestionsDropdown(
    suggestions: List<SearchSuggestion>,
    searchQuery: String,
    onSuggestionClick: (SearchSuggestion) -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(
            topStart = 0.dp,
            topEnd = 0.dp,
            bottomStart = 12.dp,
            bottomEnd = 12.dp
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column {
            suggestions.forEachIndexed { index, suggestion ->
                SuggestionItem(
                    suggestion = suggestion,
                    searchQuery = searchQuery,
                    onClick = { onSuggestionClick(suggestion) }
                )
                if (index < suggestions.lastIndex) {
                    Divider(
                        modifier = Modifier.padding(horizontal = MaterialTheme.spacing.x3),
                        color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)
                    )
                }
            }
        }
    }
}

@Composable
private fun SuggestionItem(
    suggestion: SearchSuggestion,
    searchQuery: String,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(
                horizontal = MaterialTheme.spacing.x3,
                vertical = MaterialTheme.spacing.x2
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
    ) {
        Icon(
            Icons.Default.Search,
            contentDescription = null,
            modifier = Modifier.size(18.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = buildHighlightedText(suggestion.product.name, suggestion.matchRanges),
                style = MaterialTheme.typography.bodyMedium
            )
            Text(
                text = suggestion.product.priceLabel,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/**
 * Construye un AnnotatedString con las porciones que matchean el query
 * resaltadas en bold + color primario.
 */
@Composable
private fun buildHighlightedText(
    text: String,
    matchRanges: List<IntRange>
): androidx.compose.ui.text.AnnotatedString {
    val primaryColor = MaterialTheme.colorScheme.primary
    return buildAnnotatedString {
        var lastEnd = 0
        for (range in matchRanges.sortedBy { it.first }) {
            // Texto antes del match
            if (range.first > lastEnd) {
                append(text.substring(lastEnd, range.first))
            }
            // Texto matcheado con highlight
            withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = primaryColor)) {
                append(text.substring(range.first, (range.last + 1).coerceAtMost(text.length)))
            }
            lastEnd = (range.last + 1).coerceAtMost(text.length)
        }
        // Texto restante despues del ultimo match
        if (lastEnd < text.length) {
            append(text.substring(lastEnd))
        }
    }
}

@Composable
private fun SearchHistorySection(
    history: List<String>,
    title: String,
    clearLabel: String,
    onHistoryItemClick: (String) -> Unit,
    onRemoveItem: (String) -> Unit,
    onClearAll: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
    ) {
        Column(modifier = Modifier.padding(MaterialTheme.spacing.x3)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold
                )
                TextButton(onClick = onClearAll) {
                    Text(
                        text = clearLabel,
                        style = MaterialTheme.typography.labelMedium
                    )
                }
            }
            history.forEach { query ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onHistoryItemClick(query) }
                        .padding(vertical = MaterialTheme.spacing.x1),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                ) {
                    Icon(
                        Icons.Default.History,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        text = query,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.weight(1f)
                    )
                    IconButton(
                        onClick = { onRemoveItem(query) },
                        modifier = Modifier.size(24.dp)
                    ) {
                        Icon(
                            Icons.Default.Close,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CatalogHeader(
    title: String,
    subtitle: String,
    cartCount: Int,
    cartContentDescription: String,
    onCartClick: () -> Unit,
    onBackClick: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Box(contentAlignment = Alignment.TopEnd) {
            IconButton(onClick = onCartClick) {
                Icon(
                    imageVector = Icons.Default.ShoppingCart,
                    contentDescription = cartContentDescription,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(28.dp)
                )
            }
            if (cartCount > 0) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(end = 2.dp)
                        .size(18.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primary),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = cartCount.toString(),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onPrimary,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
        }
    }
}

@Composable
private fun CatalogLoading() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = MaterialTheme.spacing.x4),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically
    ) {
        CircularProgressIndicator()
    }
}

@Composable
private fun CatalogStateCard(
    message: String,
    actionLabel: String,
    onAction: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
        ) {
            Text(
                text = message,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            IntralePrimaryButton(
                text = actionLabel,
                onClick = onAction,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

@Composable
private fun CatalogProductCard(
    product: ClientProduct,
    addLabel: String,
    addContentDescription: String,
    outOfStockLabel: String,
    onAddClick: () -> Unit,
    onCardClick: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onCardClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
        ) {
            CatalogProductThumbnail(product.emoji, contentDescription = product.name)
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
            ) {
                Text(
                    text = product.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = product.priceLabel,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            if (product.isAvailable) {
                IntralePrimaryButton(
                    text = addLabel,
                    onClick = onAddClick,
                    leadingIcon = Icons.Default.ShoppingCart,
                    iconContentDescription = addContentDescription,
                    modifier = Modifier.fillMaxWidth(0.42f)
                )
            } else {
                Text(
                    text = outOfStockLabel,
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.error,
                    fontWeight = FontWeight.SemiBold
                )
            }
        }
    }
}

@Composable
private fun CatalogProductThumbnail(emoji: String, contentDescription: String) {
    Box(
        modifier = Modifier
            .size(64.dp)
            .clip(RoundedCornerShape(MaterialTheme.spacing.x2))
            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f)),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = emoji,
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.primary,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(MaterialTheme.spacing.x1)
        )
    }
}
