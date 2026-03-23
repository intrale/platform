package ui.sc.client

import DIManager
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.client.CreateOrderItemData
import asdo.client.CreateOrderResult
import asdo.client.ToDoCreateOrder
import kotlinx.coroutines.launch
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.th.elevations
import ui.th.spacing
import ui.util.formatPrice

const val CLIENT_CHECKOUT_PATH = "/client/checkout"

class ClientCheckoutScreen : Screen(CLIENT_CHECKOUT_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_checkout_title

    @Composable
    override fun screen() {
        val logger = remember { LoggerFactory.default.newLogger<ClientCheckoutScreen>() }
        val cartItems by ClientCartStore.items.collectAsState()
        val selectedAddressId by ClientCartStore.selectedAddressId.collectAsState()
        val selectedPaymentMethodId by ClientCartStore.selectedPaymentMethodId.collectAsState()

        val doCreateOrder: ToDoCreateOrder = remember { DIManager.di.direct.instance() }

        var isLoading by remember { mutableStateOf(false) }
        var orderResult by remember { mutableStateOf<CreateOrderResult?>(null) }
        var errorMessage by remember { mutableStateOf<String?>(null) }

        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()

        val title = Txt(MessageKey.client_checkout_title)
        val subtitle = Txt(MessageKey.client_checkout_subtitle)
        val orderSummaryTitle = Txt(MessageKey.client_checkout_order_summary_title)
        val addressLabel = Txt(MessageKey.client_checkout_address_label)
        val addressNone = Txt(MessageKey.client_checkout_address_none)
        val paymentLabel = Txt(MessageKey.client_checkout_payment_label)
        val paymentNone = Txt(MessageKey.client_checkout_payment_none)
        val subtotalLabel = Txt(MessageKey.client_checkout_subtotal_label)
        val shippingLabel = Txt(MessageKey.client_checkout_shipping_label)
        val totalLabel = Txt(MessageKey.client_checkout_total_label)
        val confirmButton = Txt(MessageKey.client_checkout_confirm_button)
        val confirmingLabel = Txt(MessageKey.client_checkout_confirming)
        val successTitle = Txt(MessageKey.client_checkout_success_title)
        val successSubtitle = Txt(MessageKey.client_checkout_success_subtitle)
        val successOrderLabel = Txt(MessageKey.client_checkout_success_order_label)
        val successViewOrders = Txt(MessageKey.client_checkout_success_view_orders)
        val successGoHome = Txt(MessageKey.client_checkout_success_go_home)
        val noItemsError = Txt(MessageKey.client_checkout_error_no_items)

        LaunchedEffect(errorMessage) {
            errorMessage?.let { msg ->
                snackbarHostState.showSnackbar(msg)
            }
        }

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            if (orderResult != null) {
                CheckoutSuccessContent(
                    result = orderResult!!,
                    successTitle = successTitle,
                    successSubtitle = successSubtitle,
                    successOrderLabel = successOrderLabel,
                    successViewOrders = successViewOrders,
                    successGoHome = successGoHome,
                    modifier = Modifier.padding(padding),
                    onViewOrders = { navigate(CLIENT_ORDERS_PATH) },
                    onGoHome = { navigateClearingBackStack(CLIENT_HOME_PATH) }
                )
            } else if (cartItems.isEmpty()) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .padding(MaterialTheme.spacing.x4),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center
                ) {
                    Text(
                        text = noItemsError,
                        style = MaterialTheme.typography.bodyLarge,
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(modifier = Modifier.height(MaterialTheme.spacing.x3))
                    IntralePrimaryButton(
                        text = Txt(MessageKey.client_cart_return_home),
                        onClick = { navigateClearingBackStack(CLIENT_HOME_PATH) },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            } else {
                val itemsList = cartItems.values.toList()
                val subtotal = itemsList.sumOf { it.product.unitPrice * it.quantity }
                val shippingEstimate = 0.0
                val total = subtotal + shippingEstimate

                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    contentPadding = PaddingValues(
                        horizontal = MaterialTheme.spacing.x4,
                        vertical = MaterialTheme.spacing.x2
                    ),
                    verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
                ) {
                    item {
                        Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1_5)) {
                            Text(
                                text = title,
                                style = MaterialTheme.typography.headlineMedium,
                                fontWeight = FontWeight.Bold
                            )
                            Text(
                                text = subtitle,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }

                    item {
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                            elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
                        ) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(MaterialTheme.spacing.x3),
                                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                            ) {
                                Text(
                                    text = orderSummaryTitle,
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold
                                )
                            }
                        }
                    }

                    items(itemsList, key = { it.product.id }) { item ->
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                            elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(MaterialTheme.spacing.x3),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.weight(1f)
                                ) {
                                    Text(
                                        text = item.product.emoji,
                                        style = MaterialTheme.typography.titleLarge
                                    )
                                    Column {
                                        Text(
                                            text = item.product.name,
                                            style = MaterialTheme.typography.bodyLarge,
                                            fontWeight = FontWeight.SemiBold
                                        )
                                        Text(
                                            text = "x${item.quantity}",
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant
                                        )
                                    }
                                }
                                Text(
                                    text = formatPrice(item.product.unitPrice * item.quantity),
                                    style = MaterialTheme.typography.bodyLarge,
                                    fontWeight = FontWeight.SemiBold
                                )
                            }
                        }
                    }

                    item {
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                            elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
                        ) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(MaterialTheme.spacing.x3),
                                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                            ) {
                                Text(
                                    text = addressLabel,
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold
                                )
                                Text(
                                    text = selectedAddressId ?: addressNone,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = if (selectedAddressId != null)
                                        MaterialTheme.colorScheme.onSurface
                                    else
                                        MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }

                    item {
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                            elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
                        ) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(MaterialTheme.spacing.x3),
                                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                            ) {
                                Text(
                                    text = paymentLabel,
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold
                                )
                                Text(
                                    text = selectedPaymentMethodId ?: paymentNone,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = if (selectedPaymentMethodId != null)
                                        MaterialTheme.colorScheme.onSurface
                                    else
                                        MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }

                    item {
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                            elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
                        ) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(MaterialTheme.spacing.x3),
                                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                            ) {
                                CheckoutSummaryRow(label = subtotalLabel, value = formatPrice(subtotal))
                                CheckoutSummaryRow(label = shippingLabel, value = formatPrice(shippingEstimate))
                                Divider()
                                CheckoutSummaryRow(label = totalLabel, value = formatPrice(total), emphasize = true)
                            }
                        }
                    }

                    item {
                        Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)) {
                            if (isLoading) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.Center,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    CircularProgressIndicator()
                                    Spacer(modifier = Modifier.height(MaterialTheme.spacing.x1))
                                    Text(
                                        text = confirmingLabel,
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            } else {
                                IntralePrimaryButton(
                                    text = confirmButton,
                                    enabled = !isLoading,
                                    onClick = {
                                        coroutineScope.launch {
                                            logger.info { "Confirmando pedido" }
                                            isLoading = true
                                            errorMessage = null
                                            doCreateOrder.execute(
                                                items = itemsList.map { item ->
                                                    CreateOrderItemData(
                                                        productId = item.product.id,
                                                        productName = item.product.name,
                                                        quantity = item.quantity,
                                                        unitPrice = item.product.unitPrice
                                                    )
                                                },
                                                addressId = selectedAddressId ?: "",
                                                paymentMethodId = selectedPaymentMethodId ?: ""
                                            ).onSuccess { result ->
                                                logger.info { "Pedido confirmado: ${result.orderId}" }
                                                ClientCartStore.clear()
                                                orderResult = result
                                            }.onFailure { e ->
                                                logger.error(e) { "Error al confirmar pedido" }
                                                errorMessage = e.message ?: "Error al confirmar pedido"
                                            }
                                            isLoading = false
                                        }
                                    },
                                    modifier = Modifier.fillMaxWidth()
                                )
                            }
                        }
                    }

                    item {
                        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x3))
                    }
                }
            }
        }
    }
}

@Composable
private fun CheckoutSummaryRow(label: String, value: String, emphasize: Boolean = false) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = label,
            style = if (emphasize) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyMedium,
            fontWeight = if (emphasize) FontWeight.Bold else FontWeight.Normal
        )
        Text(
            text = value,
            style = if (emphasize) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyMedium,
            fontWeight = if (emphasize) FontWeight.Bold else FontWeight.Normal
        )
    }
}

@Composable
private fun CheckoutSuccessContent(
    result: CreateOrderResult,
    successTitle: String,
    successSubtitle: String,
    successOrderLabel: String,
    successViewOrders: String,
    successGoHome: String,
    modifier: Modifier = Modifier,
    onViewOrders: () -> Unit,
    onGoHome: () -> Unit
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x5),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(
            text = "✓",
            style = MaterialTheme.typography.displayLarge,
            color = MaterialTheme.colorScheme.primary,
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x3))
        Text(
            text = successTitle,
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x1_5))
        Text(
            text = successSubtitle,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x3))
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x3),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
            ) {
                Text(
                    text = successOrderLabel,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer
                )
                Text(
                    text = result.shortCode.ifBlank { result.publicId.ifBlank { result.orderId } },
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                    textAlign = TextAlign.Center
                )
            }
        }
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x4))
        IntralePrimaryButton(
            text = successViewOrders,
            onClick = onViewOrders,
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))
        IntralePrimaryButton(
            text = successGoHome,
            onClick = onGoHome,
            modifier = Modifier.fillMaxWidth()
        )
    }
}
