package ui.sc.client

import android.content.res.Configuration
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import ar.com.intrale.shared.client.SkipReason
import asdo.client.ClientOrderItem
import asdo.client.PriceChange
import asdo.client.RepeatOrderResult
import asdo.client.SkippedItem
import ui.th.darkScheme
import ui.th.lightScheme

/**
 * Previews Android del RepeatOrderResultDialog para validacion visual de UX
 * en los tres casos definidos en #2062:
 *   1. Caso parcial (agregados + excluidos + cambios de precio).
 *   2. Caso ninguno disponible (solo excluidos).
 *   3. Caso happy path (solo agregados, sin excluidos).
 *
 * Estos previews se renderizan en Android Studio y permiten a UX validar
 * consistencia Material3, iconografia (CheckCircle primary / Warning error),
 * tipografia, contraste, truncado de textos largos y legibilidad de motivos
 * sin necesidad de un backend con datos de prueba.
 */
private val mockAddedItems = listOf(
    ClientOrderItem(
        id = "it-1",
        name = "Empanada de carne",
        quantity = 6,
        unitPrice = 450.0,
        subtotal = 2700.0
    ),
    ClientOrderItem(
        id = "it-2",
        name = "Coca Cola 1.5L retornable",
        quantity = 1,
        unitPrice = 1200.0,
        subtotal = 1200.0
    ),
    ClientOrderItem(
        id = "it-3",
        name = "Helado artesanal tres sabores (chocolate, frutilla, dulce de leche)",
        quantity = 1,
        unitPrice = 3500.0,
        subtotal = 3500.0
    )
)

private val mockSkippedItems = listOf(
    SkippedItem(
        item = ClientOrderItem(
            id = "sk-1",
            name = "Medialunas de manteca",
            quantity = 6,
            unitPrice = 200.0,
            subtotal = 1200.0
        ),
        reason = SkipReason.OUT_OF_STOCK
    ),
    SkippedItem(
        item = ClientOrderItem(
            id = "sk-2",
            name = "Tostadas con miel artesanal de campo",
            quantity = 2,
            unitPrice = 800.0,
            subtotal = 1600.0
        ),
        reason = SkipReason.DISCONTINUED
    )
)

private val mockPriceChanges = listOf(
    PriceChange(
        item = ClientOrderItem(
            id = "pc-1",
            name = "Empanada de carne",
            quantity = 6,
            unitPrice = 450.0,
            subtotal = 2700.0
        ),
        currentPrice = 520.0,
        difference = 70.0
    )
)

private val partialResult = RepeatOrderResult(
    addedItems = mockAddedItems,
    skippedItems = mockSkippedItems,
    priceChangedItems = mockPriceChanges
)

private val noneAvailableResult = RepeatOrderResult(
    addedItems = emptyList(),
    skippedItems = mockSkippedItems,
    priceChangedItems = emptyList()
)

private val allAvailableResult = RepeatOrderResult(
    addedItems = mockAddedItems,
    skippedItems = emptyList(),
    priceChangedItems = emptyList()
)

private const val TITLE = "Resultado de repetir pedido"
private const val ADDED_LABEL = "Agregados al carrito"
private const val UNAVAILABLE_LABEL = "No disponibles"
private const val PRICE_CHANGED_LABEL = "Cambios de precio"
private const val PRICE_BEFORE_LABEL = "Antes"
private const val PRICE_NOW_LABEL = "Ahora"
private const val VIEW_CART_LABEL = "Ir al carrito"
private const val CLOSE_LABEL = "Cerrar"
private const val REASON_OUT_OF_STOCK = "Sin stock"
private const val REASON_DISCONTINUED = "Discontinuado"
private const val REASON_UNAVAILABLE = "No disponible"
private const val REASON_UNKNOWN = "No disponible"

@Preview(
    name = "Repetir pedido - Caso parcial (Light)",
    showBackground = true,
    backgroundColor = 0xFFFFFFFF,
    widthDp = 380,
    heightDp = 720
)
@Composable
private fun RepeatOrderDialogPartialLightPreview() {
    MaterialTheme(colorScheme = lightScheme) {
        RepeatOrderResultDialog(
            result = partialResult,
            title = TITLE,
            priceChangedLabel = PRICE_CHANGED_LABEL,
            priceBeforeLabel = PRICE_BEFORE_LABEL,
            priceNowLabel = PRICE_NOW_LABEL,
            itemsUnavailableLabel = UNAVAILABLE_LABEL,
            addedLabel = ADDED_LABEL,
            viewCartLabel = VIEW_CART_LABEL,
            closeLabel = CLOSE_LABEL,
            reasonOutOfStock = REASON_OUT_OF_STOCK,
            reasonDiscontinued = REASON_DISCONTINUED,
            reasonUnavailable = REASON_UNAVAILABLE,
            reasonUnknown = REASON_UNKNOWN,
            onViewCart = {},
            onDismiss = {}
        )
    }
}

@Preview(
    name = "Repetir pedido - Caso parcial (Dark)",
    showBackground = true,
    backgroundColor = 0xFF111318,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    widthDp = 380,
    heightDp = 720
)
@Composable
private fun RepeatOrderDialogPartialDarkPreview() {
    MaterialTheme(colorScheme = darkScheme) {
        RepeatOrderResultDialog(
            result = partialResult,
            title = TITLE,
            priceChangedLabel = PRICE_CHANGED_LABEL,
            priceBeforeLabel = PRICE_BEFORE_LABEL,
            priceNowLabel = PRICE_NOW_LABEL,
            itemsUnavailableLabel = UNAVAILABLE_LABEL,
            addedLabel = ADDED_LABEL,
            viewCartLabel = VIEW_CART_LABEL,
            closeLabel = CLOSE_LABEL,
            reasonOutOfStock = REASON_OUT_OF_STOCK,
            reasonDiscontinued = REASON_DISCONTINUED,
            reasonUnavailable = REASON_UNAVAILABLE,
            reasonUnknown = REASON_UNKNOWN,
            onViewCart = {},
            onDismiss = {}
        )
    }
}

@Preview(
    name = "Repetir pedido - Ninguno disponible (Light)",
    showBackground = true,
    backgroundColor = 0xFFFFFFFF,
    widthDp = 380,
    heightDp = 560
)
@Composable
private fun RepeatOrderDialogNoneAvailableLightPreview() {
    MaterialTheme(colorScheme = lightScheme) {
        RepeatOrderResultDialog(
            result = noneAvailableResult,
            title = TITLE,
            priceChangedLabel = PRICE_CHANGED_LABEL,
            priceBeforeLabel = PRICE_BEFORE_LABEL,
            priceNowLabel = PRICE_NOW_LABEL,
            itemsUnavailableLabel = UNAVAILABLE_LABEL,
            addedLabel = ADDED_LABEL,
            viewCartLabel = VIEW_CART_LABEL,
            closeLabel = CLOSE_LABEL,
            reasonOutOfStock = REASON_OUT_OF_STOCK,
            reasonDiscontinued = REASON_DISCONTINUED,
            reasonUnavailable = REASON_UNAVAILABLE,
            reasonUnknown = REASON_UNKNOWN,
            onViewCart = {},
            onDismiss = {}
        )
    }
}

@Preview(
    name = "Repetir pedido - Todos agregados (Light)",
    showBackground = true,
    backgroundColor = 0xFFFFFFFF,
    widthDp = 380,
    heightDp = 560
)
@Composable
private fun RepeatOrderDialogAllAddedLightPreview() {
    MaterialTheme(colorScheme = lightScheme) {
        RepeatOrderResultDialog(
            result = allAvailableResult,
            title = TITLE,
            priceChangedLabel = PRICE_CHANGED_LABEL,
            priceBeforeLabel = PRICE_BEFORE_LABEL,
            priceNowLabel = PRICE_NOW_LABEL,
            itemsUnavailableLabel = UNAVAILABLE_LABEL,
            addedLabel = ADDED_LABEL,
            viewCartLabel = VIEW_CART_LABEL,
            closeLabel = CLOSE_LABEL,
            reasonOutOfStock = REASON_OUT_OF_STOCK,
            reasonDiscontinued = REASON_DISCONTINUED,
            reasonUnavailable = REASON_UNAVAILABLE,
            reasonUnknown = REASON_UNKNOWN,
            onViewCart = {},
            onDismiss = {}
        )
    }
}
