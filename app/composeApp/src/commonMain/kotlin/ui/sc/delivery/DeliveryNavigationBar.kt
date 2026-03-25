package ui.sc.delivery

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Badge
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import ui.th.spacing

enum class DeliveryTab { HOME, ORDERS, NOTIFICATIONS, PROFILE }

@Composable
fun DeliveryBottomBar(
    activeTab: DeliveryTab,
    onHomeClick: () -> Unit,
    onOrdersClick: () -> Unit,
    onNotificationsClick: () -> Unit = {},
    onProfileClick: () -> Unit,
    notificationBadgeCount: Int = DeliveryNotificationStore.unreadCount
) {
    val homeLabel = Txt(MessageKey.delivery_tab_home)
    val ordersLabel = Txt(MessageKey.delivery_tab_orders)
    val notificationsLabel = Txt(MessageKey.delivery_tab_notifications)
    val profileLabel = Txt(MessageKey.delivery_tab_profile)

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
            DeliveryBottomItem(
                icon = Icons.Default.Home,
                label = homeLabel,
                selected = activeTab == DeliveryTab.HOME,
                onClick = onHomeClick
            )
            DeliveryBottomItem(
                icon = Icons.Default.List,
                label = ordersLabel,
                selected = activeTab == DeliveryTab.ORDERS,
                onClick = onOrdersClick
            )
            DeliveryBottomItem(
                icon = Icons.Default.Notifications,
                label = notificationsLabel,
                selected = activeTab == DeliveryTab.NOTIFICATIONS,
                onClick = onNotificationsClick,
                badgeCount = notificationBadgeCount
            )
            DeliveryBottomItem(
                icon = Icons.Default.Person,
                label = profileLabel,
                selected = activeTab == DeliveryTab.PROFILE,
                onClick = onProfileClick
            )
        }
    }
}

@Composable
private fun DeliveryBottomItem(
    icon: ImageVector,
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    badgeCount: Int = 0
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
                Badge(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .offset(x = 6.dp, y = (-4).dp)
                        .size(16.dp),
                    containerColor = MaterialTheme.colorScheme.error,
                    contentColor = MaterialTheme.colorScheme.onError
                ) {
                    Text(
                        text = if (badgeCount > 99) "99+" else badgeCount.toString(),
                        style = MaterialTheme.typography.labelSmall
                    )
                }
            }
        }
        Text(
            text = label,
            color = tint,
            style = MaterialTheme.typography.bodyMedium
        )
    }
}
