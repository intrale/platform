package ui.sc.client

import DIManager
import ar.com.intrale.BuildKonfig
import ar.com.intrale.strings.model.MessageKey
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Login
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.viewmodel.compose.viewModel
import asdo.auth.ToDoCheckPreviousLogin
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.auth.LOGIN_PATH
import ui.sc.shared.HOME_PATH
import ui.sc.shared.Screen
import ui.sc.shared.ViewModel
import ui.sc.signup.SELECT_SIGNUP_PROFILE_PATH
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.spacing

const val CLIENT_ENTRY_PATH = "/client/entry"
private const val CLIENT_APP_TYPE = "CLIENT"

enum class ClientEntryStatus { Loading, Welcome, NavigateClientHome, NavigateClassic, StoreUnavailable }

data class ClientEntryState(
    val businessName: String = BuildKonfig.BUSINESS,
    val businessActive: Boolean = true,
    val status: ClientEntryStatus = ClientEntryStatus.Loading
) {
    val formattedBusinessName: String
        get() = businessName.replaceFirstChar { current ->
            if (current.isLowerCase()) current.titlecase() else current.toString()
        }
}

class ClientEntryViewModel : ViewModel() {

    private val toDoCheckPreviousLogin: ToDoCheckPreviousLogin by DIManager.di.instance()
    private val logger = LoggerFactory.default.newLogger<ClientEntryViewModel>()

    var state by mutableStateOf(ClientEntryState())
        private set

    override fun getState(): Any = state
    override fun initInputState() { /* No-op: no inputs in entry point */ }

    suspend fun resolveEntry(appType: String = BuildKonfig.APP_TYPE) {
        logger.info { "Resolviendo entry con APP_TYPE=$appType" }

        if (!appType.equals(CLIENT_APP_TYPE, ignoreCase = true)) {
            state = state.copy(status = ClientEntryStatus.NavigateClassic)
            return
        }

        if (!state.businessActive) {
            state = state.copy(status = ClientEntryStatus.StoreUnavailable)
            return
        }

        val hasPreviousSession = toDoCheckPreviousLogin.execute()
        logger.info { "Resultado sesión previa: $hasPreviousSession" }
        if (hasPreviousSession) {
            SessionStore.updateRole(UserRole.Client)
        }

        state = state.copy(
            status = if (hasPreviousSession) {
                ClientEntryStatus.NavigateClientHome
            } else {
                ClientEntryStatus.Welcome
            }
        )
    }
}

class ClientEntryScreen : Screen(CLIENT_ENTRY_PATH) {

    override val messageTitle: MessageKey = MessageKey.home_title

    @Composable
    override fun screen() {
        val logger = remember { LoggerFactory.default.newLogger<ClientEntryScreen>() }
        val viewModel: ClientEntryViewModel = viewModel { ClientEntryViewModel() }
        val state = viewModel.state

        LaunchedEffect(Unit) {
            logger.info { "Evaluando entrypoint para APP_TYPE=${BuildKonfig.APP_TYPE}" }
            viewModel.resolveEntry()
        }

        LaunchedEffect(state.status) {
            when (state.status) {
                ClientEntryStatus.NavigateClassic -> navigate(HOME_PATH)
                ClientEntryStatus.NavigateClientHome -> navigate(CLIENT_HOME_PATH)
                else -> Unit
            }
        }

        when (state.status) {
            ClientEntryStatus.Loading -> ClientEntryLoading()
            ClientEntryStatus.Welcome -> ClientWelcomeContent(state.formattedBusinessName)
            ClientEntryStatus.StoreUnavailable -> ClientStoreUnavailable(state.formattedBusinessName)
            ClientEntryStatus.NavigateClassic, ClientEntryStatus.NavigateClientHome -> Unit
        }
    }
}

@Composable
private fun ClientEntryLoading() {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        CircularProgressIndicator()
    }
}

@Composable
private fun ClientWelcomeContent(businessName: String) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x6),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
    ) {
        item {
            Text(
                text = businessName,
                style = MaterialTheme.typography.headlineLarge,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
            )
        }
        item {
            Text(
                text = "Bienvenido a la tienda",
                style = MaterialTheme.typography.headlineMedium,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
            )
        }
        item {
            Text(
                text = "Ingresá para usar la aplicación",
                style = MaterialTheme.typography.bodyLarge,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
            )
        }
        item { Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2)) }
        item {
            IntralePrimaryButton(
                text = "REGISTRARME",
                onClick = { navigate(SELECT_SIGNUP_PROFILE_PATH) },
                modifier = Modifier.fillMaxWidth(),
                leadingIcon = Icons.Filled.PersonAdd,
                iconContentDescription = "Crear cuenta"
            )
        }
        item {
            IntralePrimaryButton(
                text = "YA TENGO CUENTA",
                onClick = { navigate(LOGIN_PATH) },
                modifier = Modifier.fillMaxWidth(),
                leadingIcon = Icons.Filled.Login,
                iconContentDescription = "Iniciar sesión"
            )
        }
        item {
            Text(
                text = "Tu cuenta se puede usar en otras tiendas de la plataforma.",
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

@Composable
private fun ClientStoreUnavailable(businessName: String) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x6),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(
            text = businessName,
            style = MaterialTheme.typography.headlineLarge,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))
        Text(
            text = "La tienda no está disponible por el momento.",
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))
        Text(
            text = "Volvé a intentarlo más tarde.",
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x4))
        IntralePrimaryButton(
            text = "No es posible registrarse ahora",
            onClick = {},
            modifier = Modifier.fillMaxWidth(),
            enabled = false,
            leadingIcon = Icons.Filled.Lock,
            iconContentDescription = "Tienda cerrada"
        )
    }
}

