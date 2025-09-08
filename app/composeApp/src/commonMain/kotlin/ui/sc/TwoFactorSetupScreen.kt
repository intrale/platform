package ui.sc

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.rs.Res
import ui.rs.two_factor_setup

const val TWO_FACTOR_SETUP_PATH = "/twoFactorSetup"

class TwoFactorSetupScreen : Screen(TWO_FACTOR_SETUP_PATH, Res.string.two_factor_setup) {

    private val logger = LoggerFactory.default.newLogger<TwoFactorSetupScreen>()

    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl(viewModel: TwoFactorSetupViewModel = viewModel { TwoFactorSetupViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }
        val uriHandler = LocalUriHandler.current
        val clipboardManager = LocalClipboardManager.current

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
                    .verticalScroll(rememberScrollState()),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                if (viewModel.state.showQr) {
                    Text("QR pendiente")
                    Text(viewModel.state.issuerAccount)
                    Text(viewModel.state.secretMasked)
                    Button(onClick = { clipboardManager.setText(AnnotatedString(viewModel.copySecret())) }) {
                        Text("Copiar clave")
                    }
                    Button(onClick = { clipboardManager.setText(AnnotatedString(viewModel.copyLink())) }) {
                        Text("Copiar enlace")
                    }
                    Button(onClick = {
                        uriHandler.openUri("https://play.google.com/store/search?q=authenticator")
                    }) {
                        Text("Buscar autenticador")
                    }
                    Button(onClick = { uriHandler.openUri(viewModel.copyLink()) }) {
                        Text("Compartir")
                    }
                }
            }
        }
    }
}

