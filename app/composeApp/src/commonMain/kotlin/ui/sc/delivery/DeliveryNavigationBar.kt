package ui.sc.delivery

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Person
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
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import ui.th.spacing

enum class DeliveryTab { HOME, ORDERS, PROFILE }

@Composable
fun DeliveryBottomBar(
    activeTab: DeliveryTab,
    onHomeClick: () -> Unit,
    onOrdersClick: () -> Unit,
    onProfileClick: () -> Unit
) {
    val homeLabel = Txt(MessageKey.delivery_tab_home)
    val ordersLabel = Txt(MessageKey.delivery_tab_orders)
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
            style = MaterialTheme.typography.bodyMedium
        )
    }
}
