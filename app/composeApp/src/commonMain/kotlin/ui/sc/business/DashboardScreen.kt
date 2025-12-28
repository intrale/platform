@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package ui.sc.business

import ar.com.intrale.appconfig.AppRuntimeConfig
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Assignment
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material.icons.filled.FactCheck
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Store
import androidx.compose.material.icons.filled.ShoppingBag
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.Button
import ui.cp.menu.Corner
import ui.cp.menu.MainMenuItem
import ui.cp.menu.MenuState
import ui.cp.menu.SemiCircularHamburgerMenu
import ui.sc.auth.CHANGE_PASSWORD_PATH
import ui.sc.auth.TWO_FACTOR_SETUP_PATH
import ui.sc.auth.TWO_FACTOR_VERIFY_PATH
import ui.sc.business.PERSONALIZATION_PATH
import ui.sc.shared.BUTTONS_PREVIEW_PATH
import ui.sc.shared.HOME_PATH
import ui.sc.shared.Screen
import ui.sc.signup.REGISTER_SALER_PATH
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.spacing

const val DASHBOARD_PATH = "/dashboard"

// Mantener en `false` mientras se validan recursos corruptos. Una vez que `App.animationsEnabled`
// pasa a `true` tras el primer frame, el kill-switch del router permite reactivar animaciones sin
// tocar esta constante.
private const val DASHBOARD_ANIMATIONS_ENABLED = false

class DashboardScreen : Screen(DASHBOARD_PATH) {

    override val messageTitle: MessageKey = MessageKey.dashboard_title

    private val logger = LoggerFactory.default.newLogger<DashboardScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando Dashboard" }
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(viewModel: DashboardViewModel = viewModel { DashboardViewModel() }) {
        val coroutineScope = rememberCoroutineScope()
        val sessionStateState = SessionStore.sessionState.collectAsState()
        val sessionState = sessionStateState.value
        val menuItems = rememberDashboardMenuItems(viewModel, coroutineScope)
        val currentUserRole = sessionState.role?.rawValue
        val hasSelectedBusiness = sessionState.selectedBusinessId?.isNotBlank() == true
        val visibleItems = remember(menuItems, currentUserRole, hasSelectedBusiness) {
            menuItems.filter { item ->
                val roleAllowed = item.requiredRoles.isEmpty() ||
                    currentUserRole?.let { role -> role in item.requiredRoles } == true
                val businessRequirementMet = !item.requiresBusinessSelection || hasSelectedBusiness
                roleAllowed && businessRequirementMet
            }
        }
        val dashboardTitle = Txt(MessageKey.dashboard_title)

        if (DASHBOARD_ANIMATIONS_ENABLED) {
            DashboardMenuWithSemiCircle(
                items = visibleItems,
                title = dashboardTitle
            )
        } else {
            LegacyDashboardLayout(
                items = visibleItems,
                title = dashboardTitle
            )
        }
    }

    @Composable
    private fun DashboardMenuWithSemiCircle(
        items: List<MainMenuItem>,
        title: String,
    ) {
        val openDescription = Txt(MessageKey.dashboard_menu_open_description)
        val closeDescription = Txt(MessageKey.dashboard_menu_close_description)
        val longPressHint = Txt(MessageKey.dashboard_menu_long_press_hint)
        val hint = Txt(MessageKey.dashboard_menu_hint)
        val statusBarPadding = WindowInsets.statusBars.asPaddingValues()

        Box(modifier = Modifier.fillMaxSize()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(statusBarPadding)
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalAlignment = Alignment.Start
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.headlineLarge,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = hint,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.fillMaxWidth()
                )
            }

            SemiCircularHamburgerMenu(
                items = items,
                collapsedContentDescription = openDescription,
                expandedContentDescription = closeDescription,
                anchorCorner = Corner.TopLeft,
                windowInsets = WindowInsets.statusBars,
                modifier = Modifier
                    .padding(statusBarPadding)
                    .padding(start = 12.dp, top = 8.dp)
                    .align(Alignment.TopStart)
                    .zIndex(10f),
                onBack = { goBack() },
                collapsedLongPressHint = longPressHint,
                onStateChange = { state ->
                    when (state) {
                        MenuState.Expanding -> logger.info { "SemiCircularHamburgerMenu abriendo" }
                        MenuState.Expanded -> logger.info { "SemiCircularHamburgerMenu expandido" }
                        MenuState.Collapsing -> logger.info { "SemiCircularHamburgerMenu cerrando" }
                        MenuState.Collapsed -> logger.info { "SemiCircularHamburgerMenu colapsado" }
                    }
                },
                onItemSelected = { item ->
                    logger.info { "SemiCircularHamburgerMenu item seleccionado: ${item.id}" }
                }
            )
        }
    }

    @Composable
    private fun LegacyDashboardLayout(
        items: List<MainMenuItem>,
        title: String
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(
                    horizontal = MaterialTheme.spacing.x3,
                    vertical = MaterialTheme.spacing.x4
                )
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.headlineMedium
            )

            Spacer(modifier = Modifier.height(MaterialTheme.spacing.x1))

            items.forEach { item ->
                Button(
                    label = item.label,
                    onClick = item.onClick
                )
            }
        }
    }

    @Composable
    private fun rememberDashboardMenuItems(
        viewModel: DashboardViewModel,
        coroutineScope: CoroutineScope
    ): List<MainMenuItem> {
        val backLabel = Txt(MessageKey.app_back_button)
        val buttonsPreviewLabel = Txt(MessageKey.dashboard_menu_buttons_preview)
        val changePasswordLabel = Txt(MessageKey.dashboard_menu_change_password)
        val setupTwoFactorLabel = Txt(MessageKey.dashboard_menu_setup_two_factor)
        val verifyTwoFactorLabel = Txt(MessageKey.dashboard_menu_verify_two_factor)
        val registerBusinessLabel = Txt(MessageKey.register_business)
        val personalizationLabel = Txt(MessageKey.dashboard_menu_personalization)
        val requestJoinLabel = Txt(MessageKey.dashboard_menu_request_join_business)
        val reviewBusinessLabel = Txt(MessageKey.dashboard_menu_review_business_requests)
        val reviewJoinLabel = Txt(MessageKey.dashboard_menu_review_join_requests)
        val registerSalerLabel = Txt(MessageKey.dashboard_menu_register_saler)
        val logoutLabel = Txt(MessageKey.dashboard_menu_logout)
        val businessProductsLabel = Txt(MessageKey.dashboard_menu_business_products)

        return remember(
            backLabel,
            buttonsPreviewLabel,
            changePasswordLabel,
            setupTwoFactorLabel,
            verifyTwoFactorLabel,
            registerBusinessLabel,
            requestJoinLabel,
            reviewBusinessLabel,
            reviewJoinLabel,
            registerSalerLabel,
            logoutLabel,
            personalizationLabel,
            businessProductsLabel,
            viewModel,
            coroutineScope
        ) {
            listOf(
                MainMenuItem(
                    id = "volver",
                    label = backLabel,
                    icon = Icons.AutoMirrored.Filled.ArrowBack,
                    onClick = {
                        logger.info { "Solicitando volver atrás" }
                        val navigated = goBack()
                        if (!navigated) {
                            val target = defaultLandingRoute()
                            logger.info { "No fue posible navegar hacia atrás, regresando a $target" }
                            navigate(target)
                        }
                    }
                ),
                MainMenuItem(
                    id = "demo_botones",
                    label = buttonsPreviewLabel,
                    icon = Icons.Default.AutoAwesome,
                    onClick = {
                        logger.info { "Navegando a $BUTTONS_PREVIEW_PATH" }
                        navigate(BUTTONS_PREVIEW_PATH)
                    }
                ),
                MainMenuItem(
                    id = "cambiar_password",
                    label = changePasswordLabel,
                    icon = Icons.Default.Lock,
                    onClick = {
                        logger.info { "Navegando a $CHANGE_PASSWORD_PATH" }
                        navigate(CHANGE_PASSWORD_PATH)
                    }
                ),
                MainMenuItem(
                    id = "setup_2fa",
                    label = setupTwoFactorLabel,
                    icon = Icons.Default.Security,
                    onClick = {
                        logger.info { "Navegando a $TWO_FACTOR_SETUP_PATH" }
                        navigate(TWO_FACTOR_SETUP_PATH)
                    }
                ),
                MainMenuItem(
                    id = "verify_2fa",
                    label = verifyTwoFactorLabel,
                    icon = Icons.Default.VerifiedUser,
                    onClick = {
                        logger.info { "Navegando a $TWO_FACTOR_VERIFY_PATH" }
                        navigate(TWO_FACTOR_VERIFY_PATH)
                    }
                ),
                MainMenuItem(
                    id = "registrar_negocio",
                    label = registerBusinessLabel,
                    icon = Icons.Default.Store,
                    onClick = {
                        logger.info { "Navegando a $REGISTER_NEW_BUSINESS_PATH" }
                        navigate(REGISTER_NEW_BUSINESS_PATH)
                    }
                ),
                MainMenuItem(
                    id = "personalizacion",
                    label = personalizationLabel,
                    icon = Icons.Default.Palette,
                    requiredRoles = setOf(
                        UserRole.BusinessAdmin.rawValue,
                        UserRole.PlatformAdmin.rawValue,
                    ),
                    requiresBusinessSelection = true,
                    onClick = {
                        logger.info { "Navegando a $PERSONALIZATION_PATH" }
                        navigate(PERSONALIZATION_PATH)
                    }
                ),
                MainMenuItem(
                    id = "productos_negocio",
                    label = businessProductsLabel,
                    icon = Icons.Default.ShoppingBag,
                    requiredRoles = setOf(
                        UserRole.BusinessAdmin.rawValue,
                        UserRole.PlatformAdmin.rawValue,
                    ),
                    requiresBusinessSelection = true,
                    onClick = {
                        logger.info { "Navegando a $BUSINESS_PRODUCTS_PATH" }
                        navigate(BUSINESS_PRODUCTS_PATH)
                    }
                ),
                MainMenuItem(
                    id = "solicitar_union",
                    label = requestJoinLabel,
                    icon = Icons.Default.Link,
                    onClick = {
                        logger.info { "Navegando a $REQUEST_JOIN_BUSINESS_PATH" }
                        navigate(REQUEST_JOIN_BUSINESS_PATH)
                    }
                ),
                MainMenuItem(
                    id = "revisar_negocio_pend",
                    label = reviewBusinessLabel,
                    icon = Icons.Default.Assignment,
                    onClick = {
                        logger.info { "Navegando a $REVIEW_BUSINESS_PATH" }
                        navigate(REVIEW_BUSINESS_PATH)
                    }
                ),
                MainMenuItem(
                    id = "revisar_union",
                    label = reviewJoinLabel,
                    icon = Icons.Default.FactCheck,
                    onClick = {
                        logger.info { "Navegando a $REVIEW_JOIN_BUSINESS_PATH" }
                        navigate(REVIEW_JOIN_BUSINESS_PATH)
                    }
                ),
                MainMenuItem(
                    id = "registrar_vendedor",
                    label = registerSalerLabel,
                    icon = Icons.Default.PersonAdd,
                    onClick = {
                        logger.info { "Navegando a $REGISTER_SALER_PATH" }
                        navigate(REGISTER_SALER_PATH)
                    }
                ),
                MainMenuItem(
                    id = "salir",
                    label = logoutLabel,
                    icon = Icons.Default.ExitToApp,
                    onClick = {
                        coroutineScope.launch {
                            logger.info { "Solicitando logout" }
                            try {
                                viewModel.logout()
                                logger.info { "Logout exitoso" }
                                navigate(defaultLandingRoute())
                            } catch (e: Throwable) {
                                logger.error(e) { "Error durante logout" }
                            }
                        }
                    }
                )
            )
        }
    }

    private fun defaultLandingRoute(): String =
        if (AppRuntimeConfig.isBusiness) BUSINESS_ONBOARDING_PATH else HOME_PATH
}
