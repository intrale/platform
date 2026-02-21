package ui.sc.client

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ar.com.intrale.strings.model.MessageKey
import ar.com.intrale.strings.resolveMessage
import asdo.client.ClientAddress
import asdo.client.ManageAddressAction
import asdo.client.ToDoManageClientAddress
import io.konform.validation.Validation
import io.konform.validation.jsonschema.minLength
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

enum class AddressFormMode { Create, Edit }

data class AddressFormUiState(
    val id: String? = null,
    val label: String = "",
    val street: String = "",
    val number: String = "",
    val reference: String = "",
    val city: String = "",
    val state: String = "",
    val postalCode: String = "",
    val country: String = "",
    val isDefault: Boolean = false
)

class AddressFormViewModel(
    private val manageAddress: ToDoManageClientAddress = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<AddressFormViewModel>()

    var uiState by mutableStateOf(AddressFormUiState())
    var loading by mutableStateOf(false)
    var mode by mutableStateOf(AddressFormMode.Create)
        private set
    var errorMessage by mutableStateOf<String?>(null)
        private set

    override fun getState(): Any = uiState

    init {
        validation = Validation<AddressFormUiState> {
            AddressFormUiState::label required {
                minLength(1) hint resolveMessage(MessageKey.form_error_required)
            }
            AddressFormUiState::street required {
                minLength(1) hint resolveMessage(MessageKey.form_error_required)
            }
            AddressFormUiState::number required {
                minLength(1) hint resolveMessage(MessageKey.form_error_required)
            }
            AddressFormUiState::city required {
                minLength(1) hint resolveMessage(MessageKey.form_error_required)
            }
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(AddressFormUiState::label.name),
            entry(AddressFormUiState::street.name),
            entry(AddressFormUiState::number.name),
            entry(AddressFormUiState::reference.name),
            entry(AddressFormUiState::city.name),
            entry(AddressFormUiState::state.name),
            entry(AddressFormUiState::postalCode.name),
            entry(AddressFormUiState::country.name)
        )
    }

    fun applyDraft(draft: AddressDraft?) {
        uiState = if (draft == null) {
            AddressFormUiState()
        } else {
            AddressFormUiState(
                id = draft.id,
                label = draft.label,
                street = draft.street,
                number = draft.number,
                reference = draft.reference,
                city = draft.city,
                state = draft.state,
                postalCode = draft.postalCode,
                country = draft.country,
                isDefault = draft.isDefault
            )
        }
        mode = if (uiState.id == null) AddressFormMode.Create else AddressFormMode.Edit
        errorMessage = null
    }

    suspend fun save(): Result<ClientAddress> {
        if (!isValid()) {
            errorMessage = resolveMessage(MessageKey.form_error_required)
            return Result.failure(IllegalStateException(errorMessage))
        }
        val address = ClientAddress(
            id = uiState.id,
            label = uiState.label.trim(),
            street = uiState.street.trim(),
            number = uiState.number.trim(),
            reference = uiState.reference.ifBlank { null },
            city = uiState.city.trim(),
            state = uiState.state.ifBlank { null },
            postalCode = uiState.postalCode.ifBlank { null },
            country = uiState.country.ifBlank { null },
            isDefault = uiState.isDefault
        )
        val action = if (uiState.id == null) {
            ManageAddressAction.Create(address)
        } else {
            ManageAddressAction.Update(address)
        }
        return manageAddress.execute(action)
            .map { profileData ->
                val saved = profileData.addresses.firstOrNull { it.id != null && it.id == uiState.id }
                    ?: profileData.addresses.lastOrNull()
                    ?: address
                uiState = uiState.copy(
                    id = saved.id,
                    label = saved.label,
                    street = saved.street,
                    number = saved.number,
                    reference = saved.reference.orEmpty(),
                    city = saved.city,
                    state = saved.state.orEmpty(),
                    postalCode = saved.postalCode.orEmpty(),
                    country = saved.country.orEmpty(),
                    isDefault = saved.isDefault
                )
                mode = AddressFormMode.Edit
                saved
            }
            .onFailure { error ->
                logger.error(error) { "No se pudo guardar la dirección" }
                errorMessage = error.message
            }
    }
}
