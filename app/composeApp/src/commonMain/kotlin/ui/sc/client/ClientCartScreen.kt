package ui.sc.client

import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.th.elevations
import ui.th.spacing

const val CLIENT_CART_PATH = "/client/cart"

class ClientCartScreen : Screen(CLIENT_CART_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_cart_title

    @Composable
    override fun screen() {
        val cartItems by ClientCartStore.items.collectAsState()
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()
        var confirmClearDialog by remember { mutableStateOf(false) }
        val logger = remember { LoggerFactory.default.newLogger<ClientCartScreen>() }

        val itemsList = cartItems.values.toList()
        val subtotal = remember(itemsList) { itemsList.sumOf { it.product.unitPrice * it.quantity } }
        val shippingEstimate = 0.0
        val total = subtotal + shippingEstimate

        val title = Txt(MessageKey.client_cart_title)
        val subtitle = Txt(MessageKey.client_cart_subtitle)
        val summaryTitle = Txt(MessageKey.client_cart_summary_title)
        val subtotalLabel = Txt(MessageKey.client_cart_subtotal_label)
        val shippingLabel = Txt(MessageKey.client_cart_shipping_label)
        val totalLabel = Txt(MessageKey.client_cart_total_label)
        val continueLabel = Txt(MessageKey.client_cart_continue)
        val clearLabel = Txt(MessageKey.client_cart_clear)
        val clearConfirmation = Txt(MessageKey.client_cart_clear_confirmation)
        val clearCancel = Txt(MessageKey.client_cart_clear_cancel)
        val clearConfirmLabel = Txt(MessageKey.client_cart_clear_confirm)
        val emptyTitle = Txt(MessageKey.client_cart_empty_title)
        val emptySubtitle = Txt(MessageKey.client_cart_empty_subtitle)
        val returnHomeLabel = Txt(MessageKey.client_cart_return_home)
        val removeContentDescription = Txt(MessageKey.client_cart_remove_item)
        val increaseContentDescription = Txt(MessageKey.client_cart_increase_quantity)
        val decreaseContentDescription = Txt(MessageKey.client_cart_decrease_quantity)
        val continuePlaceholder = Txt(MessageKey.client_cart_continue_placeholder)

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            if (itemsList.isEmpty()) {
                ClientCartEmptyState(
                    title = emptyTitle,
                    subtitle = emptySubtitle,
                    actionLabel = returnHomeLabel,
                    onNavigateHome = {
                        if (!goBack()) {
                            navigate(CLIENT_HOME_PATH)
                        }
                    }
                )
            } else {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    contentPadding = PaddingValues(
                        horizontal = MaterialTheme.spacing.x4,
                        vertical = MaterialTheme.spacing.x4
                    ),
                    verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
                ) {
                    item {
                        ClientCartHeader(title = title, subtitle = subtitle)
                    }

                    items(itemsList, key = { it.product.id }) { item ->
                        ClientCartItemCard(
                            item = item,
                            removeContentDescription = removeContentDescription,
                            increaseContentDescription = increaseContentDescription,
                            decreaseContentDescription = decreaseContentDescription,
                            onIncrease = { ClientCartStore.increment(item.product.id) },
                            onDecrease = { ClientCartStore.decrement(item.product.id) },
                            onRemove = { ClientCartStore.remove(item.product.id) }
                        )
                    }

                    item {
                        ClientCartSummaryCard(
                            summaryTitle = summaryTitle,
                            subtotalLabel = subtotalLabel,
                            shippingLabel = shippingLabel,
                            totalLabel = totalLabel,
                            subtotal = subtotal,
                            shipping = shippingEstimate,
                            total = total
                        )
                    }

                    item {
                        ClientCartActions(
                            continueLabel = continueLabel,
                            clearLabel = clearLabel,
                            onContinue = {
                                logger.info { "Continuar pedido" }
                                coroutineScope.launch {
                                    snackbarHostState.showSnackbar(continuePlaceholder)
                                }
                            },
                            onClear = { confirmClearDialog = true }
                        )
                    }
                }
            }

            if (confirmClearDialog) {
                AlertDialog(
                    onDismissRequest = { confirmClearDialog = false },
                    confirmButton = {
                        TextButton(onClick = {
                            ClientCartStore.clear()
                            confirmClearDialog = false
                            coroutineScope.launch {
                                snackbarHostState.showSnackbar(emptyTitle)
                            }
                        }) {
                            Text(text = clearConfirmLabel)
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { confirmClearDialog = false }) {
                            Text(text = clearCancel)
                        }
                    },
                    title = { Text(text = clearLabel, fontWeight = FontWeight.Bold) },
                    text = { Text(text = clearConfirmation) }
                )
            }
        }
    }
}

@Composable
private fun ClientCartHeader(title: String, subtitle: String) {
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

@Composable
private fun ClientCartItemCard(
    item: ClientCartItem,
    removeContentDescription: String,
    increaseContentDescription: String,
    decreaseContentDescription: String,
    onIncrease: () -> Unit,
    onDecrease: () -> Unit,
    onRemove: () -> Unit
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
            CartProductThumbnail(emoji = item.product.emoji, contentDescription = item.product.name)
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
            ) {
                Text(
                    text = item.product.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = item.product.priceLabel,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = Txt(
                        MessageKey.client_cart_item_subtotal,
                        mapOf("amount" to formatPrice(item.product.unitPrice * item.quantity))
                    ),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold
                )
            }
            Column(
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
                ) {
                    IconButton(
                        onClick = onDecrease,
                        enabled = item.quantity > 1,
                        modifier = Modifier.size(34.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.Remove,
                            contentDescription = decreaseContentDescription
                        )
                    }
                    Text(
                        text = item.quantity.toString(),
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Bold
                    )
                    IconButton(
                        onClick = onIncrease,
                        modifier = Modifier.size(34.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.Add,
                            contentDescription = increaseContentDescription
                        )
                    }
                }
                IconButton(onClick = onRemove) {
                    Icon(
                        imageVector = Icons.Default.Delete,
                        contentDescription = removeContentDescription,
                        tint = MaterialTheme.colorScheme.error
                    )
                }
            }
        }
    }
}

@Composable
private fun ClientCartSummaryCard(
    summaryTitle: String,
    subtotalLabel: String,
    shippingLabel: String,
    totalLabel: String,
    subtotal: Double,
    shipping: Double,
    total: Double
) {
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
                text = summaryTitle,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            SummaryRow(label = subtotalLabel, value = formatPrice(subtotal))
            SummaryRow(label = shippingLabel, value = formatPrice(shipping))
            Divider()
            SummaryRow(
                label = totalLabel,
                value = formatPrice(total),
                emphasize = true
            )
        }
    }
}

@Composable
private fun SummaryRow(label: String, value: String, emphasize: Boolean = false) {
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
private fun ClientCartActions(
    continueLabel: String,
    clearLabel: String,
    onContinue: () -> Unit,
    onClear: () -> Unit
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
    ) {
        IntralePrimaryButton(
            text = continueLabel,
            onClick = onContinue,
            modifier = Modifier.fillMaxWidth()
        )
        TextButton(onClick = onClear, modifier = Modifier.align(Alignment.CenterHorizontally)) {
            Text(
                text = clearLabel,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.SemiBold
            )
        }
    }
}

@Composable
private fun ClientCartEmptyState(
    title: String,
    subtitle: String,
    actionLabel: String,
    onNavigateHome: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x5),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Box(
            modifier = Modifier
                .size(96.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.1f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.Default.ShoppingCart,
                contentDescription = title,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(42.dp)
            )
        }
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x3))
        Text(
            text = title,
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x1))
        Text(
            text = subtitle,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x3))
        IntralePrimaryButton(
            text = actionLabel,
            onClick = onNavigateHome,
            modifier = Modifier.fillMaxWidth()
        )
    }
}

@Composable
private fun CartProductThumbnail(emoji: String, contentDescription: String) {
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

private fun formatPrice(amount: Double): String = "$${"%.2f".format(amount)}"
