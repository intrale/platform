package ui.sc.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.th.spacing

const val TWO_FACTOR_SETUP_PATH = "/twoFactorSetup"

class TwoFactorSetupScreen : Screen(TWO_FACTOR_SETUP_PATH) {

    override val messageTitle: MessageKey = MessageKey.dashboard_menu_setup_two_factor

    private val logger = LoggerFactory.default.newLogger<TwoFactorSetupScreen>()

    @Composable
    override fun screen() { screenImpl() }

    @Composable
    private fun screenImpl(viewModel: TwoFactorSetupViewModel = viewModel { TwoFactorSetupViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }
        val uriHandler = LocalUriHandler.current
        val clipboardManager = LocalClipboardManager.current

        val loadingText = Txt(MessageKey.two_factor_setup_loading)
        val manualTitle = Txt(MessageKey.two_factor_setup_manual_title)
        val manualInstructions = Txt(MessageKey.two_factor_setup_manual_instructions)
        val step1 = Txt(MessageKey.two_factor_setup_manual_step1)
        val step2 = Txt(MessageKey.two_factor_setup_manual_step2)
        val step3 = Txt(MessageKey.two_factor_setup_manual_step3)
        val accountLabel = Txt(MessageKey.two_factor_setup_account_label)
        val secretLabel = Txt(MessageKey.two_factor_setup_secret_label)
        val copySecretLabel = Txt(MessageKey.two_factor_setup_copy_secret)
        val copyLinkLabel = Txt(MessageKey.two_factor_setup_copy_link)
        val findAuthenticatorLabel = Txt(MessageKey.two_factor_setup_find_authenticator)
        val appOpenedTitle = Txt(MessageKey.two_factor_setup_app_opened_title)
        val appOpenedInstructions = Txt(MessageKey.two_factor_setup_app_opened_instructions)
        val goVerifyLabel = Txt(MessageKey.two_factor_setup_go_verify)

        LaunchedEffect(Unit) {
            logger.debug { "Invocando setup de 2FA" }
            callService(
                coroutineScope = coroutine,
                snackbarHostState = snackbarHostState,
                setLoading = { viewModel.loading = it },
                serviceCall = { viewModel.setup() },
                onSuccess = { result -> viewModel.onOtpAuthUri(result.otpAuthUri) }
            )
        }

        LaunchedEffect(viewModel.state.otpAuthUri) {
            val uri = viewModel.state.otpAuthUri
            if (uri.isNotEmpty() && !viewModel.state.deepLinkTried) {
                try {
                    uriHandler.openUri(uri)
                    viewModel.onDeepLinkResult(true)
                } catch (e: Throwable) {
                    viewModel.onDeepLinkResult(false)
                }
            }
        }

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            Column(
                Modifier
                    .padding(padding)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(
                        horizontal = MaterialTheme.spacing.x3,
                        vertical = MaterialTheme.spacing.x4
                    ),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
            ) {
                when {
                    viewModel.loading -> {
                        CircularProgressIndicator()
                        Text(loadingText)
                    }
                    viewModel.state.showQr -> {
                        Text(
                            text = manualTitle,
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = manualInstructions,
                            style = MaterialTheme.typography.bodyMedium
                        )
                        Text(
                            text = step1,
                            style = MaterialTheme.typography.bodyMedium
                        )
                        Text(
                            text = step2,
                            style = MaterialTheme.typography.bodyMedium
                        )
                        Text(
                            text = step3,
                            style = MaterialTheme.typography.bodyMedium
                        )
                        Text(
                            text = "$accountLabel ${viewModel.state.issuerAccount}",
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.SemiBold
                        )
                        Text(
                            text = "$secretLabel ${viewModel.state.secretMasked}",
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.SemiBold
                        )
                        Button(
                            onClick = { clipboardManager.setText(AnnotatedString(viewModel.copySecret())) },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(copySecretLabel)
                        }
                        OutlinedButton(
                            onClick = { clipboardManager.setText(AnnotatedString(viewModel.copyLink())) },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(copyLinkLabel)
                        }
                        OutlinedButton(
                            onClick = {
                                try {
                                    uriHandler.openUri("https://play.google.com/store/search?q=authenticator")
                                } catch (e: Throwable) {
                                    logger.error(e) { "No fue posible abrir la aplicación de autenticación" }
                                    coroutine.launch {
                                        snackbarHostState.showSnackbar(findAuthenticatorLabel)
                                    }
                                }
                            },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(findAuthenticatorLabel)
                        }
                        Button(
                            onClick = { navigate(TWO_FACTOR_VERIFY_PATH) },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(goVerifyLabel)
                        }
                    }
                    viewModel.state.deepLinkTried -> {
                        Text(
                            text = appOpenedTitle,
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = appOpenedInstructions,
                            style = MaterialTheme.typography.bodyMedium
                        )
                        Button(
                            onClick = { navigate(TWO_FACTOR_VERIFY_PATH) },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(goVerifyLabel)
                        }
                    }
                }
            }
        }
    }
}
