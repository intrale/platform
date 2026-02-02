package ui.sc.client

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.auth.ToDoResetLoginCache
import asdo.client.ClientAddress
import asdo.client.ClientPreferences
import asdo.client.ClientProfile
import asdo.client.ClientProfileData
import asdo.client.ManageAddressAction
import asdo.client.ToDoGetClientProfile
import asdo.client.ToDoManageClientAddress
import asdo.client.ToDoUpdateClientProfile
import ar.com.intrale.strings.model.MessageKey
import io.konform.validation.Validation
import io.konform.validation.jsonschema.minLength
import io.konform.validation.jsonschema.pattern
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.inputs.InputState
import ui.sc.shared.ViewModel
import ui.session.SessionStore

data class ClientProfileForm(
    val fullName: String = "",
    val email: String = "",
    val phone: String = "",
    val language: String = "es",
    val defaultAddressId: String? = null
)

data class AddressForm(
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

data class ClientProfileUiState(
    val profileForm: ClientProfileForm = ClientProfileForm(),
    val preferences: ClientPreferences = ClientPreferences(),
    val addresses: List<ClientAddress> = emptyList(),
    val addressForm: AddressForm = AddressForm(),
    val loading: Boolean = true,
    val savingProfile: Boolean = false,
    val savingAddress: Boolean = false,
    val error: String? = null,
    val successKey: MessageKey? = null
)

class ClientProfileViewModel(
    private val getClientProfile: ToDoGetClientProfile = DIManager.di.direct.instance(),
    private val updateClientProfile: ToDoUpdateClientProfile = DIManager.di.direct.instance(),
    private val manageClientAddress: ToDoManageClientAddress = DIManager.di.direct.instance(),
    private val toDoResetLoginCache: ToDoResetLoginCache = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<ClientProfileViewModel>()

    private var profileValidation: Validation<ClientProfileForm> = buildProfileValidation()
    private var addressValidation: Validation<AddressForm> = buildAddressValidation()

    var state by mutableStateOf(ClientProfileUiState())
        private set

    init {
        initInputState()
    }

    override fun getState(): Any = state.profileForm

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(ClientProfileForm::fullName.name),
            entry(ClientProfileForm::email.name),
            entry(ClientProfileForm::phone.name),
            entry(AddressForm::label.name),
            entry(AddressForm::street.name),
            entry(AddressForm::number.name),
            entry(AddressForm::city.name),
            entry(AddressForm::postalCode.name)
        )
        validation = profileValidation as Validation<Any>
    }

    fun onNameChange(value: String) {
        state = state.copy(profileForm = state.profileForm.copy(fullName = value))
        validateProfile()
    }

    fun onEmailChange(value: String) {
        state = state.copy(profileForm = state.profileForm.copy(email = value))
        validateProfile()
    }

    fun onPhoneChange(value: String) {
        state = state.copy(profileForm = state.profileForm.copy(phone = value))
        validateProfile()
    }

    fun onLanguageChange(value: String) {
        state = state.copy(
            profileForm = state.profileForm.copy(language = value.lowercase()),
            preferences = state.preferences.copy(language = value.lowercase())
        )
    }

    fun startAddressEditing(address: ClientAddress? = null) {
        state = state.copy(
            addressForm = address?.toForm() ?: AddressForm(
                isDefault = state.addresses.isEmpty()
            ),
            successKey = null,
            error = null
        )
        validation = addressValidation as Validation<Any>
    }

    fun onAddressChange(transform: AddressForm.() -> AddressForm) {
        state = state.copy(addressForm = state.addressForm.transform())
        validateAddress()
    }

    suspend fun loadProfile() {
        logger.info { "Cargando datos de perfil de cliente" }
        state = state.copy(loading = true, error = null, successKey = null)
        getClientProfile.execute()
            .onSuccess { data -> applyProfileData(data, successKey = null) }
            .onFailure { throwable ->
                logger.error(throwable) { "No se pudo cargar el perfil" }
                state = state.copy(
                    loading = false,
                    error = throwable.message ?: "No se pudo cargar el perfil",
                    successKey = null
                )
            }
    }

    suspend fun saveProfile() {
        if (!validateProfile()) return
        val profile = ClientProfile(
            fullName = state.profileForm.fullName.trim(),
            email = state.profileForm.email.trim(),
            phone = state.profileForm.phone.takeIf { it.isNotBlank() },
            defaultAddressId = state.profileForm.defaultAddressId
        )
        val preferences = ClientPreferences(language = state.profileForm.language.ifBlank { "es" })

        state = state.copy(savingProfile = true, error = null, successKey = null)
        updateClientProfile.execute(profile, preferences)
            .onSuccess { data -> applyProfileData(data, successKey = MessageKey.client_profile_saved) }
            .onFailure { throwable ->
                logger.error(throwable) { "No se pudo guardar el perfil" }
                state = state.copy(
                    savingProfile = false,
                    error = throwable.message ?: "No se pudo guardar el perfil",
                    successKey = null
                )
            }
    }

    suspend fun saveAddress() {
        if (!validateAddress()) return
        val address = state.addressForm.toAddress()
        val action = if (state.addressForm.id == null) {
            ManageAddressAction.Create(address)
        } else {
            ManageAddressAction.Update(address)
        }

        state = state.copy(savingAddress = true, error = null, successKey = null)
        manageClientAddress.execute(action)
            .onSuccess { data ->
                applyProfileData(
                    data,
                    successKey = MessageKey.client_profile_address_saved,
                    resetAddressForm = true
                )
            }
            .onFailure { throwable ->
                logger.error(throwable) { "No se pudo guardar la dirección" }
                state = state.copy(
                    savingAddress = false,
                    error = throwable.message ?: "No se pudo guardar la dirección",
                    successKey = null
                )
            }
    }

    suspend fun deleteAddress(addressId: String) {
        state = state.copy(savingAddress = true, successKey = null, error = null)
        manageClientAddress.execute(ManageAddressAction.Delete(addressId))
            .onSuccess { data ->
                applyProfileData(data, successKey = MessageKey.client_profile_address_deleted, resetAddressForm = true)
            }
            .onFailure { throwable ->
                logger.error(throwable) { "No se pudo eliminar la dirección" }
                state = state.copy(
                    savingAddress = false,
                    error = throwable.message ?: "No se pudo eliminar la dirección",
                    successKey = null
                )
            }
    }

    suspend fun markDefault(addressId: String) {
        state = state.copy(savingAddress = true, successKey = null, error = null)
        manageClientAddress.execute(ManageAddressAction.MarkDefault(addressId))
            .onSuccess { data ->
                applyProfileData(data, successKey = MessageKey.client_profile_address_saved, resetAddressForm = true)
            }
            .onFailure { throwable ->
                logger.error(throwable) { "No se pudo actualizar la dirección predeterminada" }
                state = state.copy(
                    savingAddress = false,
                    error = throwable.message ?: "No se pudo actualizar la dirección predeterminada",
                    successKey = null
                )
            }
    }

    suspend fun logout() {
        toDoResetLoginCache.execute()
        SessionStore.clear()
    }

    private fun applyProfileData(
        data: ClientProfileData,
        successKey: MessageKey?,
        resetAddressForm: Boolean = false
    ) {
        val defaultId = data.profile.defaultAddressId
            ?: data.addresses.firstOrNull { it.isDefault }?.id
            ?: data.addresses.firstOrNull()?.id
        val updatedAddresses = data.addresses.map { address ->
            address.copy(isDefault = address.id == defaultId)
        }
        val cleanAddressForm = if (resetAddressForm) AddressForm(isDefault = updatedAddresses.isEmpty()) else state.addressForm

        state = state.copy(
            profileForm = ClientProfileForm(
                fullName = data.profile.fullName,
                email = data.profile.email,
                phone = data.profile.phone.orEmpty(),
                language = data.preferences.language,
                defaultAddressId = defaultId
            ),
            preferences = data.preferences,
            addresses = updatedAddresses,
            addressForm = cleanAddressForm,
            loading = false,
            savingProfile = false,
            savingAddress = false,
            error = null,
            successKey = successKey
        )
        validation = profileValidation as Validation<Any>
    }

    private fun ClientAddress.toForm(): AddressForm = AddressForm(
        id = id,
        label = label,
        street = street,
        number = number,
        reference = reference.orEmpty(),
        city = city,
        state = state.orEmpty(),
        postalCode = postalCode.orEmpty(),
        country = country.orEmpty(),
        isDefault = isDefault
    )

    private fun AddressForm.toAddress(): ClientAddress = ClientAddress(
        id = id,
        label = label.trim(),
        street = street.trim(),
        number = number.trim(),
        reference = reference.ifBlank { null },
        city = city.trim(),
        state = state.ifBlank { null },
        postalCode = postalCode.ifBlank { null },
        country = country.ifBlank { null },
        isDefault = isDefault
    )

    private fun buildProfileValidation(): Validation<ClientProfileForm> = Validation {
        ClientProfileForm::fullName required {
            minLength(1) hint MessageKey.form_error_required.name
        }
        ClientProfileForm::email required {
            minLength(1) hint MessageKey.form_error_required.name
            pattern(".+@.+\\..+") hint MessageKey.form_error_invalid_email.name
        }
        ClientProfileForm::language required {
            minLength(2) hint MessageKey.form_error_required.name
        }
        ClientProfileForm::phone ifPresent {
            pattern("^[+]?[-0-9 ()]{7,}$") hint MessageKey.client_profile_phone_invalid.name
        }
    }

    private fun buildAddressValidation(): Validation<AddressForm> = Validation {
        AddressForm::label required {
            minLength(1) hint MessageKey.form_error_required.name
        }
        AddressForm::street required {
            minLength(1) hint MessageKey.form_error_required.name
        }
        AddressForm::number required {
            minLength(1) hint MessageKey.form_error_required.name
        }
        AddressForm::city required {
            minLength(1) hint MessageKey.form_error_required.name
        }
        AddressForm::postalCode ifPresent {
            minLength(3) hint MessageKey.form_error_required.name
        }
    }

    private fun validateProfile(): Boolean {
        validation = profileValidation as Validation<Any>
        inputsStates.forEach { (_, inputState) ->
            inputState.value = inputState.value.copy(isValid = true, details = "")
        }
        val result = profileValidation(state.profileForm)
        result.errors.forEach { error ->
            val key = error.dataPath.substring(1)
            val mutableState = inputsStates.getOrPut(key) { mutableStateOf(InputState(key)) }
            mutableState.value = mutableState.value.copy(
                isValid = false,
                details = error.message
            )
        }
        return result.errors.isEmpty()
    }

    private fun validateAddress(): Boolean {
        validation = addressValidation as Validation<Any>
        inputsStates.forEach { (key, inputState) ->
            if (key in listOf(AddressForm::label.name, AddressForm::street.name, AddressForm::number.name, AddressForm::city.name, AddressForm::postalCode.name)) {
                inputState.value = inputState.value.copy(isValid = true, details = "")
            }
        }
        val result = addressValidation(state.addressForm)
        result.errors.forEach { error ->
            val key = error.dataPath.substring(1)
            val mutableState = inputsStates.getOrPut(key) { mutableStateOf(InputState(key)) }
            mutableState.value = mutableState.value.copy(
                isValid = false,
                details = error.message
            )
        }
        return result.errors.isEmpty()
    }
}
