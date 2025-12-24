package ui.sc.delivery

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.auth.ToDoResetLoginCache
import asdo.delivery.DeliveryProfile
import asdo.delivery.DeliveryProfileData
import asdo.delivery.DeliveryVehicle
import asdo.delivery.ToDoGetDeliveryProfile
import asdo.delivery.ToDoUpdateDeliveryProfile
import ar.com.intrale.strings.model.MessageKey
import io.konform.validation.Validation
import io.konform.validation.jsonschema.ifPresent
import io.konform.validation.jsonschema.minLength
import io.konform.validation.jsonschema.pattern
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.inputs.InputState
import ui.sc.shared.ViewModel
import ui.session.SessionStore

data class DeliveryProfileForm(
    val fullName: String = "",
    val email: String = "",
    val phone: String = "",
    val vehicleType: String = "",
    val vehicleModel: String = "",
    val vehiclePlate: String = ""
)

data class DeliveryProfileUiState(
    val form: DeliveryProfileForm = DeliveryProfileForm(),
    val zones: List<asdo.delivery.DeliveryZone> = emptyList(),
    val loading: Boolean = true,
    val saving: Boolean = false,
    val error: String? = null,
    val successKey: MessageKey? = null
)

class DeliveryProfileViewModel(
    private val getDeliveryProfile: ToDoGetDeliveryProfile = DIManager.di.direct.instance(),
    private val updateDeliveryProfile: ToDoUpdateDeliveryProfile = DIManager.di.direct.instance(),
    private val toDoResetLoginCache: ToDoResetLoginCache = DIManager.di.direct.instance()
) : ViewModel() {

    private val logger = LoggerFactory.default.newLogger<DeliveryProfileViewModel>()
    private val profileValidation: Validation<DeliveryProfileForm> = buildProfileValidation()

    var state by mutableStateOf(DeliveryProfileUiState())
        private set

    init {
        initInputState()
    }

    override fun getState(): Any = state.form

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(DeliveryProfileForm::fullName.name),
            entry(DeliveryProfileForm::email.name),
            entry(DeliveryProfileForm::phone.name),
            entry(DeliveryProfileForm::vehicleType.name),
            entry(DeliveryProfileForm::vehicleModel.name),
            entry(DeliveryProfileForm::vehiclePlate.name)
        )
        validation = profileValidation as Validation<Any>
    }

    fun onNameChange(value: String) {
        state = state.copy(form = state.form.copy(fullName = value))
        validateProfile()
    }

    fun onEmailChange(value: String) {
        state = state.copy(form = state.form.copy(email = value))
        validateProfile()
    }

    fun onPhoneChange(value: String) {
        state = state.copy(form = state.form.copy(phone = value))
        validateProfile()
    }

    fun onVehicleTypeChange(value: String) {
        state = state.copy(form = state.form.copy(vehicleType = value))
    }

    fun onVehicleModelChange(value: String) {
        state = state.copy(form = state.form.copy(vehicleModel = value))
    }

    fun onVehiclePlateChange(value: String) {
        state = state.copy(form = state.form.copy(vehiclePlate = value))
    }

    suspend fun loadProfile() {
        logger.info { "[Delivery][Perfil] Cargando datos" }
        state = state.copy(loading = true, error = null, successKey = null)
        getDeliveryProfile.execute()
            .onSuccess { data -> applyProfileData(data) }
            .onFailure { throwable ->
                logger.error(throwable) { "[Delivery][Perfil] Error al cargar datos" }
                state = state.copy(
                    loading = false,
                    error = throwable.message ?: "No se pudo cargar el perfil",
                    successKey = null
                )
            }
    }

    suspend fun saveProfile() {
        if (!validateProfile()) return

        val profile = DeliveryProfile(
            fullName = state.form.fullName.trim(),
            email = state.form.email.trim(),
            phone = state.form.phone.ifBlank { null },
            vehicle = DeliveryVehicle(
                type = state.form.vehicleType.trim(),
                model = state.form.vehicleModel.trim(),
                plate = state.form.vehiclePlate.ifBlank { null }
            )
        )

        state = state.copy(saving = true, error = null, successKey = null)
        updateDeliveryProfile.execute(profile)
            .onSuccess { data -> applyProfileData(data, MessageKey.delivery_profile_saved) }
            .onFailure { throwable ->
                logger.error(throwable) { "[Delivery][Perfil] Error al guardar" }
                state = state.copy(
                    saving = false,
                    error = throwable.message ?: "No se pudo guardar el perfil",
                    successKey = null
                )
            }
    }

    suspend fun logout() {
        toDoResetLoginCache.execute()
        SessionStore.clear()
    }

    private fun applyProfileData(data: DeliveryProfileData, successKey: MessageKey? = null) {
        state = state.copy(
            form = DeliveryProfileForm(
                fullName = data.profile.fullName,
                email = data.profile.email,
                phone = data.profile.phone.orEmpty(),
                vehicleType = data.profile.vehicle.type,
                vehicleModel = data.profile.vehicle.model,
                vehiclePlate = data.profile.vehicle.plate.orEmpty()
            ),
            zones = data.zones,
            loading = false,
            saving = false,
            error = null,
            successKey = successKey
        )
        validation = profileValidation as Validation<Any>
    }

    private fun buildProfileValidation(): Validation<DeliveryProfileForm> = Validation {
        DeliveryProfileForm::fullName required {
            minLength(1) hint MessageKey.form_error_required.name
        }
        DeliveryProfileForm::email required {
            minLength(1) hint MessageKey.form_error_required.name
            pattern(".+@.+\\..+") hint MessageKey.form_error_invalid_email.name
        }
        DeliveryProfileForm::phone ifPresent {
            pattern("^[+]?[-0-9 ()]{7,}$") hint MessageKey.client_profile_phone_invalid.name
        }
    }

    private fun validateProfile(): Boolean {
        validation = profileValidation as Validation<Any>
        inputsStates.forEach { (_, inputState) ->
            inputState.value = inputState.value.copy(isValid = true, details = "")
        }
        val result = profileValidation(state.form)
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
