package ui.sc.client

import DIManager
import ar.com.intrale.BuildKonfig
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.ShoppingBag
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.auth.CHANGE_PASSWORD_PATH
import ui.sc.auth.TWO_FACTOR_SETUP_PATH
import ui.sc.auth.TWO_FACTOR_VERIFY_PATH
import ui.sc.shared.Screen
import ui.sc.shared.ViewModel
import ui.sc.shared.navigate
import ui.th.spacing
import ui.session.SessionStore
import ui.sc.shared.HOME_PATH
import asdo.auth.ToDoResetLoginCache

const val CLIENT_HOME_PATH = "/client/home"

class ClientHomeScreen : Screen(CLIENT_HOME_PATH) {

    override val messageTitle: MessageKey = MessageKey.dashboard_title

    @Composable
    override fun screen() {
        val businessName = BuildKonfig.BUSINESS.replaceFirstChar { current ->
            if (current.isLowerCase()) current.titlecase() else current.toString()
        }
        val scrollState = rememberScrollState()
        var profileMenuExpanded by remember { mutableStateOf(false) }
        val coroutineScope = rememberCoroutineScope()
        val logger = remember { LoggerFactory.default.newLogger<ClientHomeScreen>() }
        val viewModel: ClientHomeViewModel = viewModel { ClientHomeViewModel() }

        val headerSubtitle = Txt(MessageKey.client_home_header_subtitle)
        val cartContentDescription = Txt(MessageKey.client_home_cart_icon_content_description)

        Box(modifier = Modifier.fillMaxSize()) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(scrollState)
                    .padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x4),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
            ) {
                ClientHomeHeader(
                    businessName = businessName,
                    subtitle = headerSubtitle,
                    cartContentDescription = cartContentDescription
                )
                ClientHomeBanner(businessName)
                ClientHomeFeaturedProduct()
                ClientHomeBottomBar(
                    onHomeClick = { logger.info { "Cliente seleccionó home" } },
                    onOrdersClick = { logger.info { "Cliente seleccionó pedidos" } },
                    onProfileClick = {
                        logger.info { "Abriendo menú de perfil" }
                        profileMenuExpanded = true
                    }
                )
            }

            ClientProfileMenu(
                expanded = profileMenuExpanded,
                onDismissRequest = { profileMenuExpanded = false },
                onChangePassword = {
                    profileMenuExpanded = false
                    navigate(CHANGE_PASSWORD_PATH)
                },
                onSetupTwoFactor = {
                    profileMenuExpanded = false
                    navigate(TWO_FACTOR_SETUP_PATH)
                },
                onVerifyTwoFactor = {
                    profileMenuExpanded = false
                    navigate(TWO_FACTOR_VERIFY_PATH)
                },
                onLogout = {
                    profileMenuExpanded = false
                    coroutineScope.launch {
                        try {
                            viewModel.logout()
                            navigate(HOME_PATH)
                        } catch (error: Throwable) {
                            logger.error(error) { "Error al cerrar sesión" }
                        }
                    }
                }
            )
        }
    }
}

@Composable
private fun ClientHomeHeader(
    businessName: String,
    subtitle: String,
    cartContentDescription: String
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)) {
            Text(
                text = businessName.uppercase(),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Icon(
            imageVector = Icons.Default.ShoppingCart,
            contentDescription = cartContentDescription,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(28.dp)
        )
    }
}

@Composable
private fun ClientHomeBanner(businessName: String) {
    val deliveryTitle = Txt(MessageKey.client_home_delivery_title)
    val deliveryDescription = Txt(
        MessageKey.client_home_delivery_description,
        mapOf("business" to businessName)
    )

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
        ) {
            Box(
                modifier = Modifier
                    .size(56.dp)
                    .clip(CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = Icons.Default.ShoppingBag,
                    contentDescription = deliveryTitle,
                    tint = MaterialTheme.colorScheme.primary
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)) {
                Text(
                    text = deliveryTitle,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    text = deliveryDescription,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun ClientHomeFeaturedProduct() {
    val featuredTitle = Txt(MessageKey.client_home_featured_title)
    val featuredName = Txt(MessageKey.client_home_featured_name)
    val featuredPrice = Txt(MessageKey.client_home_featured_price)
    val addLabel = Txt(MessageKey.client_home_add_label)
    val addContentDescription = Txt(MessageKey.client_home_add_content_description)

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Text(
                text = featuredTitle,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)) {
                        Text(
                            text = featuredName,
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.Medium
                        )
                        Text(
                            text = featuredPrice,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    IntralePrimaryButton(
                        text = addLabel,
                        onClick = {},
                        leadingIcon = Icons.Default.ShoppingCart,
                        iconContentDescription = addContentDescription,
                        modifier = Modifier
                            .fillMaxWidth(0.4f)
                    )
            }
        }
    }
}

@Composable
private fun ClientHomeBottomBar(
    onHomeClick: () -> Unit,
    onOrdersClick: () -> Unit,
    onProfileClick: () -> Unit
) {
    val homeLabel = Txt(MessageKey.client_home_tab_home)
    val ordersLabel = Txt(MessageKey.client_home_tab_orders)
    val profileLabel = Txt(MessageKey.client_home_tab_profile)

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
            ClientHomeBottomItem(icon = Icons.Default.Home, label = homeLabel, onClick = onHomeClick)
            ClientHomeBottomItem(icon = Icons.Default.ShoppingBag, label = ordersLabel, onClick = onOrdersClick)
            ClientHomeBottomItem(icon = Icons.Default.Person, label = profileLabel, onClick = onProfileClick)
        }
    }
}

@Composable
private fun ClientHomeBottomItem(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
        modifier = Modifier.clickable(onClick = onClick)
    ) {
        Icon(
            imageVector = icon,
            contentDescription = label,
            tint = Color.White
        )
        Text(
            text = label,
            color = Color.White,
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.bodyMedium
        )
    }
}

@Composable
private fun ClientProfileMenu(
    expanded: Boolean,
    onDismissRequest: () -> Unit,
    onChangePassword: () -> Unit,
    onSetupTwoFactor: () -> Unit,
    onVerifyTwoFactor: () -> Unit,
    onLogout: () -> Unit
) {
    val changePasswordLabel = Txt(MessageKey.dashboard_menu_change_password)
    val setupTwoFactorLabel = Txt(MessageKey.dashboard_menu_setup_two_factor)
    val verifyTwoFactorLabel = Txt(MessageKey.dashboard_menu_verify_two_factor)
    val logoutLabel = Txt(MessageKey.dashboard_menu_logout)

    Box(modifier = Modifier.fillMaxSize()) {
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = onDismissRequest,
            modifier = Modifier.align(Alignment.BottomEnd)
        ) {
            DropdownMenuItem(
                text = { Text(text = changePasswordLabel) },
                onClick = onChangePassword
            )
            DropdownMenuItem(
                text = { Text(text = setupTwoFactorLabel) },
                onClick = onSetupTwoFactor
            )
            DropdownMenuItem(
                text = { Text(text = verifyTwoFactorLabel) },
                onClick = onVerifyTwoFactor
            )
            DropdownMenuItem(
                text = { Text(text = logoutLabel) },
                onClick = onLogout
            )
        }
    }
}

class ClientHomeViewModel : ViewModel() {

    private val toDoResetLoginCache: ToDoResetLoginCache by DIManager.di.instance()

    private val logger = LoggerFactory.default.newLogger<ClientHomeViewModel>()

    override fun getState(): Any = Unit

    override fun initInputState() { /* No-op */ }

    suspend fun logout() {
        logger.info { "Ejecutando logout desde cliente" }
        try {
            toDoResetLoginCache.execute()
            SessionStore.clear()
        } catch (e: Throwable) {
            logger.error(e) { "Error al ejecutar logout" }
            throw e
        }
    }
}

