package ui.sc.client

import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import kotlinx.coroutines.launch
import ui.sc.client.ClientBottomBar
import ui.sc.client.ClientTab
import ui.sc.shared.Screen
import ui.th.spacing

const val CLIENT_ORDERS_PATH = "/client/orders"

class ClientOrdersScreen : Screen(CLIENT_ORDERS_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_orders_title

    @Composable
    override fun screen() {
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()
        val emptyMessage = Txt(MessageKey.client_orders_empty)
        val viewCatalogLabel = Txt(MessageKey.client_home_view_catalog)
        val ordersTitle = Txt(MessageKey.client_orders_title)

        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) },
            bottomBar = {
                ClientBottomBar(
                    activeTab = ClientTab.ORDERS,
                    onHomeClick = { navigate(CLIENT_HOME_PATH) },
                    onOrdersClick = {},
                    onProfileClick = { navigate(CLIENT_PROFILE_PATH) }
                )
            }
        ) { padding ->
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = MaterialTheme.spacing.x4),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3),
                contentPadding = PaddingValues(vertical = MaterialTheme.spacing.x4)
            ) {
                item {
                    Text(
                        text = ordersTitle,
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold
                    )
                }
                item {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.surfaceVariant
                        )
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(MaterialTheme.spacing.x4),
                            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
                            horizontalAlignment = Alignment.CenterHorizontally
                        ) {
                            Text(
                                text = emptyMessage,
                                textAlign = TextAlign.Center,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            TextButton(onClick = {
                                coroutineScope.launch { navigate(CLIENT_HOME_PATH) }
                            }) {
                                Text(viewCatalogLabel)
                            }
                        }
                    }
                }
            }
        }
    }
}
