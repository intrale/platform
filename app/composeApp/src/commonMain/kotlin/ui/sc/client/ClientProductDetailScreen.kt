package ui.sc.client

import DIManager
import ar.com.intrale.BuildKonfig
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.business.ToGetProduct
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import ext.business.ProductDTO
import org.kodein.di.instance
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.sc.shared.ViewModel
import ui.session.SessionStore
import ui.th.spacing
import ui.util.formatPrice

class ClientProductDetailScreen : Screen(CLIENT_PRODUCT_DETAIL_PATH) {

    @Composable
    override fun screen() {
        val viewModel: ClientProductDetailViewModel = androidx.lifecycle.viewmodel.compose.viewModel { ClientProductDetailViewModel() }
        val selectedProductId by ClientProductSelectionStore.productId.collectAsState()
        val state = viewModel.state
        val snackbarHostState = remember { SnackbarHostState() }

        LaunchedEffect(selectedProductId) {
            val productId = selectedProductId
            if (productId.isNullOrBlank()) {
                snackbarHostState.showSnackbar(Txt(MessageKey.client_product_detail_error))
            } else {
                viewModel.load(productId)
            }
        }

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(MaterialTheme.spacing.x4)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                ) {
                    IconButton(onClick = {
                        if (!goBack()) navigate(CLIENT_HOME_PATH)
                    }) {
                        Icon(Icons.Default.ArrowBack, contentDescription = Txt(MessageKey.app_back_button))
                    }
                    Text(
                        text = state.product?.name ?: Txt(MessageKey.client_product_detail_title),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold
                    )
                }

                when {
                    state.loading -> Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) { CircularProgressIndicator() }
                    state.error != null -> Text(text = state.error, color = MaterialTheme.colorScheme.error)
                    state.product != null -> ProductDetailContent(
                        product = state.product,
                        quantity = state.quantity,
                        alreadyInCart = state.alreadyInCart,
                        onDecrease = { viewModel.decrease() },
                        onIncrease = { viewModel.increase() },
                        onAddOrUpdate = { viewModel.applyQuantity() }
                    )
                }
            }
        }
    }
}

data class ClientProductDetailState(
    val loading: Boolean = true,
    val product: ProductDTO? = null,
    val quantity: Int = 1,
    val alreadyInCart: Boolean = false,
    val error: String? = null
)

class ClientProductDetailViewModel : ViewModel() {

    private val toGetProduct: ToGetProduct by DIManager.di.instance()

    var state by mutableStateOf(ClientProductDetailState())
        private set

    override fun getState(): Any = state
    override fun initInputState() = Unit

    suspend fun load(productId: String) {
        state = state.copy(loading = true, error = null)
        val businessId = SessionStore.sessionState.value.selectedBusinessId ?: BuildKonfig.BUSINESS
        toGetProduct.execute(businessId, productId)
            .onSuccess { product ->
                val currentQuantity = ClientCartStore.quantityOf(productId)
                state = state.copy(
                    loading = false,
                    product = product,
                    quantity = if (currentQuantity > 0) currentQuantity else 1,
                    alreadyInCart = currentQuantity > 0
                )
            }
            .onFailure { err ->
                state = state.copy(loading = false, error = err.message ?: Txt(MessageKey.client_product_detail_error))
            }
    }

    fun increase() {
        state = state.copy(quantity = state.quantity + 1)
    }

    fun decrease() {
        state = state.copy(quantity = (state.quantity - 1).coerceAtLeast(1))
    }

    fun applyQuantity() {
        val product = state.product ?: return
        val cartProduct = ClientProduct(
            id = product.id.orEmpty(),
            name = product.name,
            priceLabel = formatPrice(product.basePrice),
            emoji = "🛍️",
            unitPrice = product.basePrice
        )
        ClientCartStore.setQuantity(cartProduct, state.quantity)
        state = state.copy(alreadyInCart = true)
    }
}

@Composable
private fun ProductDetailContent(
    product: ProductDTO,
    quantity: Int,
    alreadyInCart: Boolean,
    onDecrease: () -> Unit,
    onIncrease: () -> Unit,
    onAddOrUpdate: () -> Unit
) {
    val description = product.description ?: product.shortDescription ?: Txt(MessageKey.client_product_detail_description_fallback)
    val stockValue = product.stock?.toString() ?: Txt(MessageKey.client_product_detail_stock_unknown)
    val stockLabel = Txt(MessageKey.client_product_detail_stock, mapOf("stock" to stockValue))
    val unitLabel = Txt(MessageKey.client_product_detail_unit, mapOf("unit" to product.unit))
    val quantityLabel = Txt(MessageKey.client_product_detail_quantity)
    val addLabel = if (alreadyInCart) {
        Txt(MessageKey.client_product_detail_update_cart)
    } else {
        Txt(MessageKey.client_product_detail_add_to_cart)
    }

    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .size(160.dp)
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f), RoundedCornerShape(12.dp)),
                contentAlignment = Alignment.Center
            ) {
                Icon(Icons.Default.Image, contentDescription = product.name, tint = MaterialTheme.colorScheme.primary)
            }

            Text(text = product.name, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(text = description, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Start)
            Text(text = formatPrice(product.basePrice, product.unit), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(text = unitLabel, style = MaterialTheme.typography.bodyMedium)
            Text(text = stockLabel, style = MaterialTheme.typography.bodyMedium)

            if (alreadyInCart) {
                Text(text = Txt(MessageKey.client_product_detail_already_in_cart), color = MaterialTheme.colorScheme.primary)
            }

            Text(text = quantityLabel, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)) {
                IconButton(onClick = onDecrease) { Icon(Icons.Default.Remove, contentDescription = Txt(MessageKey.client_product_detail_decrease_quantity)) }
                Text(text = quantity.toString(), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                IconButton(onClick = onIncrease) { Icon(Icons.Default.Add, contentDescription = Txt(MessageKey.client_product_detail_increase_quantity)) }
            }

            IntralePrimaryButton(
                text = addLabel,
                onClick = onAddOrUpdate,
                leadingIcon = Icons.Default.ShoppingCart,
                iconContentDescription = addLabel,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}
