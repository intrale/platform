package ui.sc.client

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.ShoppingBag
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import ext.client.ClientNotificationsLocalStore
import ui.th.spacing

enum class ClientTab {
    HOME, ORDERS, NOTIFICATIONS, PROFILE
}

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
    val notificationsLabel = Txt(MessageKey.client_notifications_tab)
    val profileLabel = Txt(MessageKey.client_home_tab_profile)

    val notifications by ClientNotificationsLocalStore.notifications.collectAsState()
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
            ClientBottomItemWithBadge(
                icon = Icons.Default.Notifications,
                label = notificationsLabel,
                selected = activeTab == ClientTab.NOTIFICATIONS,
                badgeCount = unreadCount,
                onClick = onNotificationsClick
            )
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
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.bodyMedium
        )
    }
}

@Composable
private fun ClientBottomItemWithBadge(
    icon: ImageVector,
    label: String,
    selected: Boolean,
    badgeCount: Int,
    onClick: () -> Unit
) {
    val tint = if (selected) MaterialTheme.colorScheme.onPrimary else Color.White.copy(alpha = 0.8f)

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5),
        modifier = Modifier.clickable(onClick = onClick)
    ) {
        Box {
            Icon(
                imageVector = icon,
                contentDescription = label,
                tint = tint
            )
            if (badgeCount > 0) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .size(16.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.error),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = if (badgeCount > 9) "9+" else badgeCount.toString(),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onError
                    )
                }
            }
        }
        Text(
            text = label,
            color = tint,
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.bodyMedium
        )
    }
}
