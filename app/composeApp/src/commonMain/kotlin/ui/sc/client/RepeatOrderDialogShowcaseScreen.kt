package ui.sc.client

import ar.com.intrale.strings.model.MessageKey
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import ar.com.intrale.shared.client.SkipReason
import asdo.client.ClientOrderItem
import asdo.client.PriceChange
import asdo.client.RepeatOrderResult
import asdo.client.SkippedItem
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.Screen
import ui.th.spacing

const val REPEAT_ORDER_DIALOG_SHOWCASE_PATH = "/demo/repeat-order-dialog"

/**
 * Pantalla de showcase/QA para el RepeatOrderResultDialog (#2062).
 *
 * Motivacion: el diálogo solo se muestra cuando un cliente con historial
 * de pedidos con productos no disponibles ejecuta "Repetir pedido". Ese
 * escenario requiere datos especificos en backend que no siempre estan
 * disponibles en el ambiente QA, bloqueando la captura de evidencia
 * visual/video del feature.
 *
 * Esta pantalla permite a QA navegar al path /demo/repeat-order-dialog
 * (via intent / adb / deeplink) y disparar el diálogo en sus tres estados
 * con datos mock, habilitando la captura de video del componente
 * funcionando sin dependencia del backend.
 *
 * No esta linkeada desde la UI del usuario final — sigue el mismo patron
 * que ButtonsPreviewScreen (/demo/buttons).
 */
class RepeatOrderDialogShowcaseScreen : Screen(REPEAT_ORDER_DIALOG_SHOWCASE_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_orders_detail_repeat_title

    private val logger = LoggerFactory.default.newLogger<RepeatOrderDialogShowcaseScreen>()

    @Composable
    override fun screen() {
        ShowcaseContent()
    }

    @Composable
    private fun ShowcaseContent() {
        var activeResult by remember { mutableStateOf<RepeatOrderResult?>(null) }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(
                    horizontal = MaterialTheme.spacing.x3,
                    vertical = MaterialTheme.spacing.x4
                ),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                text = "Showcase: dialogo repetir pedido",
                style = MaterialTheme.typography.headlineSmall,
                textAlign = TextAlign.Center
            )
            Text(
                text = "Pantalla para QA — captura de video del dialogo en sus 3 estados sin dependencia de backend.",
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center
            )

            Button(
                onClick = {
                    logger.info { "Showcase: abrir caso parcial" }
                    activeResult = partialCase()
                }
            ) {
                Text("Caso parcial (agregados + excluidos + cambio de precio)")
            }

            Button(
                onClick = {
                    logger.info { "Showcase: abrir caso ninguno disponible" }
                    activeResult = noneAvailableCase()
                }
            ) {
                Text("Ninguno disponible (solo excluidos)")
            }

            OutlinedButton(
                onClick = {
                    logger.info { "Showcase: abrir caso todos agregados" }
                    activeResult = allAvailableCase()
                }
            ) {
                Text("Todos agregados (happy path)")
            }
        }

        activeResult?.let { result ->
            RepeatOrderResultDialog(
                result = result,
                title = "Resultado de repetir pedido",
                priceChangedLabel = "Cambios de precio",
                priceBeforeLabel = "Antes",
                priceNowLabel = "Ahora",
                itemsUnavailableLabel = "No disponibles",
                addedLabel = "Agregados al carrito",
                viewCartLabel = "Ir al carrito",
                closeLabel = "Cerrar",
                reasonOutOfStock = "Sin stock",
                reasonDiscontinued = "Discontinuado",
                reasonUnavailable = "No disponible",
                reasonUnknown = "No disponible",
                onViewCart = {
                    logger.info { "Showcase: navegar al carrito (simulado)" }
                    activeResult = null
                },
                onDismiss = {
                    logger.info { "Showcase: cerrar dialogo" }
                    activeResult = null
                }
            )
        }
    }

    private fun partialCase(): RepeatOrderResult = RepeatOrderResult(
        addedItems = listOf(
            ClientOrderItem(
                id = "demo-1",
                name = "Empanada de carne",
                quantity = 6,
                unitPrice = 450.0,
                subtotal = 2700.0
            ),
            ClientOrderItem(
                id = "demo-2",
                name = "Coca Cola 1.5L retornable",
                quantity = 1,
                unitPrice = 1200.0,
                subtotal = 1200.0
            )
        ),
        skippedItems = listOf(
            SkippedItem(
                item = ClientOrderItem(
                    id = "demo-3",
                    name = "Medialunas de manteca",
                    quantity = 6,
                    unitPrice = 200.0,
                    subtotal = 1200.0
                ),
                reason = SkipReason.OUT_OF_STOCK
            ),
            SkippedItem(
                item = ClientOrderItem(
                    id = "demo-4",
                    name = "Tostadas con miel artesanal",
                    quantity = 2,
                    unitPrice = 800.0,
                    subtotal = 1600.0
                ),
                reason = SkipReason.DISCONTINUED
            )
        ),
        priceChangedItems = listOf(
            PriceChange(
                item = ClientOrderItem(
                    id = "demo-1",
                    name = "Empanada de carne",
                    quantity = 6,
                    unitPrice = 450.0,
                    subtotal = 2700.0
                ),
                currentPrice = 520.0,
                difference = 70.0
            )
        )
    )

    private fun noneAvailableCase(): RepeatOrderResult = RepeatOrderResult(
        addedItems = emptyList(),
        skippedItems = listOf(
            SkippedItem(
                item = ClientOrderItem(
                    id = "demo-5",
                    name = "Medialunas de manteca",
                    quantity = 6,
                    unitPrice = 200.0,
                    subtotal = 1200.0
                ),
                reason = SkipReason.OUT_OF_STOCK
            ),
            SkippedItem(
                item = ClientOrderItem(
                    id = "demo-6",
                    name = "Helado artesanal",
                    quantity = 1,
                    unitPrice = 3500.0,
                    subtotal = 3500.0
                ),
                reason = SkipReason.DISCONTINUED
            ),
            SkippedItem(
                item = ClientOrderItem(
                    id = "demo-7",
                    name = "Cafe con leche",
                    quantity = 2,
                    unitPrice = 1100.0,
                    subtotal = 2200.0
                ),
                reason = SkipReason.UNAVAILABLE
            )
        ),
        priceChangedItems = emptyList()
    )

    private fun allAvailableCase(): RepeatOrderResult = RepeatOrderResult(
        addedItems = listOf(
            ClientOrderItem(
                id = "demo-8",
                name = "Empanada de carne",
                quantity = 6,
                unitPrice = 450.0,
                subtotal = 2700.0
            ),
            ClientOrderItem(
                id = "demo-9",
                name = "Coca Cola 1.5L retornable",
                quantity = 1,
                unitPrice = 1200.0,
                subtotal = 1200.0
            ),
            ClientOrderItem(
                id = "demo-10",
                name = "Helado artesanal",
                quantity = 1,
                unitPrice = 3500.0,
                subtotal = 3500.0
            )
        ),
        skippedItems = emptyList(),
        priceChangedItems = emptyList()
    )
}
