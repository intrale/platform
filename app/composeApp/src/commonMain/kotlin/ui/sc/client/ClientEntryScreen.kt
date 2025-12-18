package ui.sc.client

import DIManager
import ar.com.intrale.AppType
import ar.com.intrale.BuildKonfig
import ar.com.intrale.strings.Txt
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
import ui.sc.signup.SIGNUP_PATH
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.spacing

const val CLIENT_ENTRY_PATH = "/client/entry"

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

    suspend fun resolveEntry(appType: String = AppType.current()) {
        logger.info { "Resolviendo entry con APP_TYPE=$appType" }

        if (!appType.equals(AppType.CLIENT, ignoreCase = true)) {
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
            logger.info { "Evaluando entrypoint para APP_TYPE=${AppType.current()}" }
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
            ClientEntryStatus.Welcome -> ClientWelcomeContent(
                businessName = state.formattedBusinessName,
                onNavigate = ::navigate
            )
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
private fun ClientWelcomeContent(
    businessName: String,
    onNavigate: (String) -> Unit
) {
    val welcomeTitle = Txt(MessageKey.client_entry_welcome_title)
    val welcomeSubtitle = Txt(MessageKey.client_entry_welcome_subtitle)
    val registerLabel = Txt(MessageKey.client_entry_register_button)
    val loginLabel = Txt(MessageKey.client_entry_login_button)
    val accountInfo = Txt(MessageKey.client_entry_account_info)
    val registerDescription = Txt(MessageKey.client_entry_register_content_description)
    val loginDescription = Txt(MessageKey.client_entry_login_content_description)

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x3),
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
                text = welcomeTitle,
                style = MaterialTheme.typography.headlineMedium,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
            )
        }
        item {
            Text(
                text = welcomeSubtitle,
                style = MaterialTheme.typography.bodyLarge,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
            )
        }
        item { Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2)) }
        item {
            IntralePrimaryButton(
                text = registerLabel,
                onClick = { onNavigate(SIGNUP_PATH) },
                modifier = Modifier.fillMaxWidth(),
                leadingIcon = Icons.Filled.PersonAdd,
                iconContentDescription = registerDescription
            )
        }
        item {
            IntralePrimaryButton(
                text = loginLabel,
                onClick = { onNavigate(LOGIN_PATH) },
                modifier = Modifier.fillMaxWidth(),
                leadingIcon = Icons.Filled.Login,
                iconContentDescription = loginDescription
            )
        }
        item {
            Text(
                text = accountInfo,
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

@Composable
private fun ClientStoreUnavailable(businessName: String) {
    val unavailableMessage = Txt(MessageKey.client_entry_store_unavailable_message)
    val unavailableSecondary = Txt(MessageKey.client_entry_store_unavailable_secondary)
    val disabledCta = Txt(MessageKey.client_entry_store_unavailable_cta)
    val disabledDescription = Txt(MessageKey.client_entry_store_unavailable_content_description)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x3),
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
            text = unavailableMessage,
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))
        Text(
            text = unavailableSecondary,
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(modifier = Modifier.height(MaterialTheme.spacing.x4))
        IntralePrimaryButton(
            text = disabledCta,
            onClick = {},
            modifier = Modifier.fillMaxWidth(),
            enabled = false,
            leadingIcon = Icons.Filled.Lock,
            iconContentDescription = disabledDescription
        )
    }
}

