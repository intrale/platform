package ui.sc

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.stringResource
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.Button
import ui.rs.Res
import ui.rs.buttons_preview
import ui.rs.change_password
import ui.rs.dashboard
import ui.rs.logout
import ui.rs.register_business
import ui.rs.register_saler
import ui.rs.request_join_business
import ui.rs.review_business
import ui.rs.review_join_business
import ui.rs.two_factor_setup
import ui.rs.two_factor_verify
import ui.th.spacing

const val DASHBOARD_PATH = "/dashboard"

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
                text = stringResource(Res.string.dashboard),
                style = MaterialTheme.typography.headlineMedium
            )

            Spacer(modifier = Modifier.height(MaterialTheme.spacing.x1))

            Button(
                label = stringResource(Res.string.buttons_preview),
                onClick = {
                    logger.info { "Navegando a $BUTTONS_PREVIEW_PATH" }
                    navigate(BUTTONS_PREVIEW_PATH)
                }
            )

            Button(
                label = stringResource(Res.string.change_password),
                onClick = {
                    logger.info { "Navegando a $CHANGE_PASSWORD_PATH" }
                    navigate(CHANGE_PASSWORD_PATH)
                }
            )

            Button(
                label = stringResource(Res.string.two_factor_setup),
                onClick = {
                    logger.info { "Navegando a $TWO_FACTOR_SETUP_PATH" }
                    navigate(TWO_FACTOR_SETUP_PATH)
                }
            )

            Button(
                label = stringResource(Res.string.two_factor_verify),
                onClick = {
                    logger.info { "Navegando a $TWO_FACTOR_VERIFY_PATH" }
                    navigate(TWO_FACTOR_VERIFY_PATH)
                }
            )

            Button(
                label = stringResource(Res.string.register_business),
                onClick = {
                    logger.info { "Navegando a $REGISTER_NEW_BUSINESS_PATH" }
                    navigate(REGISTER_NEW_BUSINESS_PATH)
                }
            )

            Button(
                label = stringResource(Res.string.request_join_business),
                onClick = {
                    logger.info { "Navegando a $REQUEST_JOIN_BUSINESS_PATH" }
                    navigate(REQUEST_JOIN_BUSINESS_PATH)
                }
            )

            Button(
                label = stringResource(Res.string.review_business),
                onClick = {
                    logger.info { "Navegando a $REVIEW_BUSINESS_PATH" }
                    navigate(REVIEW_BUSINESS_PATH)
                }
            )

            Button(
                label = stringResource(Res.string.review_join_business),
                onClick = {
                    logger.info { "Navegando a $REVIEW_JOIN_BUSINESS_PATH" }
                    navigate(REVIEW_JOIN_BUSINESS_PATH)
                }
            )

            Button(
                label = stringResource(Res.string.register_saler),
                onClick = {
                    logger.info { "Navegando a $REGISTER_SALER_PATH" }
                    navigate(REGISTER_SALER_PATH)
                }
            )

            Button(
                label = stringResource(Res.string.logout),
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
        }
    }
}
