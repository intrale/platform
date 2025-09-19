package ui.sc.business

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Assignment
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material.icons.filled.FactCheck
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Store
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.stringResource
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.Button
import ui.cp.menu.MainMenuItem
import ui.cp.menu.MenuState
import ui.cp.menu.SemiCircularHamburgerMenu
import ui.rs.Res
import ui.th.spacing
import ui.sc.auth.CHANGE_PASSWORD_PATH
import ui.sc.auth.TWO_FACTOR_SETUP_PATH
import ui.sc.auth.TWO_FACTOR_VERIFY_PATH
import ui.sc.shared.BUTTONS_PREVIEW_PATH
import ui.sc.shared.HOME_PATH
import ui.sc.shared.Screen
import ui.sc.signup.REGISTER_SALER_PATH

const val DASHBOARD_PATH = "/dashboard"
private const val ENABLE_SEMI_CIRCULAR_MENU = true

class DashboardScreen : Screen(DASHBOARD_PATH, Res.string.dashboard) {

    private val logger = LoggerFactory.default.newLogger<DashboardScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando Dashboard" }
        ScreenContent()
    }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun ScreenContent(viewModel: DashboardViewModel = viewModel { DashboardViewModel() }) {
        val coroutineScope = rememberCoroutineScope()
        val menuItems = rememberDashboardMenuItems(viewModel, coroutineScope)
        val currentUserRole: String? = null
        // TODO: Integrar el rol real del usuario cuando esté disponible en la sesión.
        val visibleItems = remember(menuItems, currentUserRole) {
            menuItems.filter { item ->
                item.requiredRoles.isEmpty() || currentUserRole?.let { role -> role in item.requiredRoles } == true
            }
        }
        val dashboardTitle = stringResource(Res.string.dashboard)

        if (ENABLE_SEMI_CIRCULAR_MENU) {
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

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun DashboardMenuWithSemiCircle(
        items: List<MainMenuItem>,
        title: String,
    ) {
        val openDescription = stringResource(Res.string.semi_circular_menu_open)
        val closeDescription = stringResource(Res.string.semi_circular_menu_close)
        val hint = stringResource(Res.string.dashboard_menu_hint)

        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(MaterialTheme.spacing.x3)
        ) {
            Column(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = MaterialTheme.spacing.x6)
                    .fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.headlineMedium,
                    textAlign = TextAlign.Center
                )
                Text(
                    text = hint,
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center
                )
            }

            SemiCircularHamburgerMenu(
                items = items,
                collapsedContentDescription = openDescription,
                expandedContentDescription = closeDescription,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(MaterialTheme.spacing.x2),
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

    @OptIn(ExperimentalResourceApi::class)
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

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun rememberDashboardMenuItems(
        viewModel: DashboardViewModel,
        coroutineScope: CoroutineScope
    ): List<MainMenuItem> {
        val buttonsPreviewLabel = stringResource(Res.string.buttons_preview)
        val changePasswordLabel = stringResource(Res.string.change_password)
        val setupTwoFactorLabel = stringResource(Res.string.two_factor_setup)
        val verifyTwoFactorLabel = stringResource(Res.string.two_factor_verify)
        val registerBusinessLabel = stringResource(Res.string.register_business)
        val requestJoinLabel = stringResource(Res.string.request_join_business)
        val reviewBusinessLabel = stringResource(Res.string.review_business)
        val reviewJoinLabel = stringResource(Res.string.review_join_business)
        val registerSalerLabel = stringResource(Res.string.register_saler)
        val logoutLabel = stringResource(Res.string.logout)

        return remember(
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
            viewModel,
            coroutineScope
        ) {
            listOf(
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
                                navigate(HOME_PATH)
                            } catch (e: Throwable) {
                                logger.error(e) { "Error durante logout" }
                            }
                        }
                    }
                )
            )
        }
    }
}
