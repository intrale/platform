package ui.sc.client

import DIManager
import ar.com.intrale.BuildKonfig
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.business.ToDoListCategories
import asdo.business.ToDoListProducts
import androidx.compose.foundation.background
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
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import ext.business.CategoryDTO
import ext.business.ProductDTO
import ext.business.ProductStatus
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
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

data class ClientCatalogUiState(
    val productsState: ClientProductsState = ClientProductsState.Loading,
    val categories: List<CategoryItem> = emptyList(),
    val selectedCategoryId: String? = null,
    val searchQuery: String = "",
    val lastAddedProduct: ClientProduct? = null
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

    fun onSearchChange(query: String) {
        state = state.copy(searchQuery = query)
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
                    emoji = "🛍️",
                    unitPrice = product.basePrice,
                    categoryId = product.categoryId
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
}

class ClientCatalogScreen : Screen(CLIENT_CATALOG_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_catalog_title

    @Composable
    override fun screen() {
        val coroutineScope = rememberCoroutineScope()
        val viewModel: ClientCatalogViewModel = viewModel { ClientCatalogViewModel() }
        val uiState = viewModel.state
        val cartItems by ClientCartStore.items.collectAsState()
        val cartCount = cartItems.values.sumOf { it.quantity }

        val title = Txt(MessageKey.client_catalog_title)
        val subtitle = Txt(MessageKey.client_catalog_subtitle)
        val searchPlaceholder = Txt(MessageKey.client_catalog_search_placeholder)
        val filterAll = Txt(MessageKey.client_catalog_filter_all)
        val emptyMessage = Txt(MessageKey.client_catalog_empty)
        val errorMessage = Txt(MessageKey.client_catalog_error)
        val retryLabel = Txt(MessageKey.client_catalog_retry)
        val addLabel = Txt(MessageKey.client_catalog_add_label)
        val addContentDescription = Txt(MessageKey.client_catalog_add_content_description)
        val noResultsMessage = Txt(MessageKey.client_catalog_search_no_results)
        val cartContentDescription = Txt(MessageKey.client_home_cart_icon_content_description)
        val addedToCartMessage = uiState.lastAddedProduct?.let { product ->
            Txt(MessageKey.client_catalog_added_to_cart, mapOf("product" to product.name))
        }
        val snackbarHostState = remember { SnackbarHostState() }

        LaunchedEffect(Unit) {
            viewModel.loadCatalog()
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

                item {
                    OutlinedTextField(
                        value = uiState.searchQuery,
                        onValueChange = { viewModel.onSearchChange(it) },
                        placeholder = { Text(searchPlaceholder) },
                        leadingIcon = {
                            Icon(Icons.Default.Search, contentDescription = searchPlaceholder)
                        },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
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
                                onAddClick = { viewModel.addToCart(product) }
                            )
                        }
                    }
                }

                item { Spacer(modifier = Modifier.height(MaterialTheme.spacing.x8)) }
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
    onAddClick: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
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
            IntralePrimaryButton(
                text = addLabel,
                onClick = onAddClick,
                leadingIcon = Icons.Default.ShoppingCart,
                iconContentDescription = addContentDescription,
                modifier = Modifier.fillMaxWidth(0.42f)
            )
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
