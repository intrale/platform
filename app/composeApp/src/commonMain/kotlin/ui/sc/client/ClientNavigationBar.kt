package ui.sc.client

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.ShoppingBag
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import ui.th.spacing

enum class ClientTab {
    HOME, ORDERS, NOTIFICATIONS, PROFILE
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ClientBottomBar(
    activeTab: ClientTab,
    onHomeClick: () -> Unit,
    onOrdersClick: () -> Unit,
    onNotificationsClick: () -> Unit,
    onProfileClick: () -> Unit
) {
    val homeLabel = Txt(MessageKey.client_home_tab_home)
    val ordersLabel = Txt(MessageKey.client_home_tab_orders)
    val notificationsLabel = Txt(MessageKey.client_notifications_tab_label)
    val profileLabel = Txt(MessageKey.client_home_tab_profile)

    val notifications by ClientNotificationStore.notifications.collectAsState()
    val unreadCount = notifications.count { !it.isRead }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primary)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = MaterialTheme.spacing.x2),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically
        ) {
            ClientBottomItem(
                icon = Icons.Default.Home,
                label = homeLabel,
                selected = activeTab == ClientTab.HOME,
                onClick = onHomeClick
            )
            ClientBottomItem(
                icon = Icons.Default.ShoppingBag,
                label = ordersLabel,
                selected = activeTab == ClientTab.ORDERS,
                onClick = onOrdersClick
            )
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5),
                modifier = Modifier.clickable(onClick = onNotificationsClick)
            ) {
                val tint = if (activeTab == ClientTab.NOTIFICATIONS) MaterialTheme.colorScheme.onPrimary else Color.White.copy(alpha = 0.8f)
                BadgedBox(
                    badge = {
                        if (unreadCount > 0) {
                            Badge { Text(unreadCount.toString()) }
                        }
                    }
                ) {
                    Icon(
                        imageVector = Icons.Default.Notifications,
                        contentDescription = notificationsLabel,
                        tint = tint
                    )
                }
                Text(
                    text = notificationsLabel,
                    color = tint,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    style = MaterialTheme.typography.bodyMedium
                )
            }
            ClientBottomItem(
                icon = Icons.Default.Person,
                label = profileLabel,
                selected = activeTab == ClientTab.PROFILE,
                onClick = onProfileClick
            )
        }
    }
}

@Composable
private fun ClientBottomItem(
    icon: ImageVector,
    label: String,
    selected: Boolean,
    onClick: () -> Unit
) {
    val tint = if (selected) MaterialTheme.colorScheme.onPrimary else Color.White.copy(alpha = 0.8f)

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5),
        modifier = Modifier.clickable(onClick = onClick)
    ) {
        Icon(
            imageVector = icon,
            contentDescription = label,
            tint = tint
        )
        Text(
            text = label,
            color = tint,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            style = MaterialTheme.typography.bodyMedium
        )
    }
}
