package ui.sc.delivery

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.auth.ToDoResetLoginCache
import asdo.delivery.DeliveryAvailabilityBlock
import asdo.delivery.DeliveryAvailabilityConfig
import asdo.delivery.DeliveryAvailabilityMode
import asdo.delivery.DeliveryAvailabilitySlot
import asdo.delivery.DeliveryProfile
import asdo.delivery.DeliveryProfileData
import asdo.delivery.DeliveryVehicle
import asdo.delivery.ToDoGetDeliveryProfile
import asdo.delivery.ToDoUpdateDeliveryProfile
import asdo.delivery.ToDoGetDeliveryAvailability
import asdo.delivery.ToDoUpdateDeliveryAvailability
import ar.com.intrale.strings.model.MessageKey
import io.konform.validation.Validation
import io.konform.validation.onEach
import io.konform.validation.jsonschema.minLength
import io.konform.validation.jsonschema.pattern
import kotlinx.datetime.DayOfWeek
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

private val blockDefaultRanges: Map<DeliveryAvailabilityBlock, Pair<String, String>> = mapOf(
    DeliveryAvailabilityBlock.MORNING to ("06:00" to "12:00"),
    DeliveryAvailabilityBlock.AFTERNOON to ("12:00" to "18:00"),
    DeliveryAvailabilityBlock.NIGHT to ("18:00" to "23:00")
)

internal const val AVAILABILITY_TIMEZONE_KEY = "availability.timezone"
internal const val AVAILABILITY_GENERAL_KEY = "availability.general"

internal fun availabilityKey(dayOfWeek: DayOfWeek, field: String): String =
    "availability.${dayOfWeek.name.lowercase()}.$field"

data class DeliveryAvailabilitySlotForm(
    val dayOfWeek: DayOfWeek,
    val enabled: Boolean = false,
    val mode: DeliveryAvailabilityMode = DeliveryAvailabilityMode.BLOCK,
    val block: DeliveryAvailabilityBlock = DeliveryAvailabilityBlock.MORNING,
    val start: String = blockDefaultRanges[DeliveryAvailabilityBlock.MORNING]?.first.orEmpty(),
    val end: String = blockDefaultRanges[DeliveryAvailabilityBlock.MORNING]?.second.orEmpty()
)

data class DeliveryAvailabilityForm(
    val timezone: String = "UTC",
    val slots: List<DeliveryAvailabilitySlotForm> = DayOfWeek.entries.map { day ->
        DeliveryAvailabilitySlotForm(dayOfWeek = day)
    }
)

data class DeliveryProfileUiState(
    val form: DeliveryProfileForm = DeliveryProfileForm(),
    val zones: List<asdo.delivery.DeliveryZone> = emptyList(),
    val availability: DeliveryAvailabilityForm = DeliveryAvailabilityForm(),
    val loading: Boolean = true,
    val saving: Boolean = false,
    val error: String? = null,
    val successKey: MessageKey? = null,
    val availabilityErrorKey: String? = null
)

class DeliveryProfileViewModel(
    private val getDeliveryProfile: ToDoGetDeliveryProfile = DIManager.di.direct.instance(),
    private val updateDeliveryProfile: ToDoUpdateDeliveryProfile = DIManager.di.direct.instance(),
    private val getDeliveryAvailability: ToDoGetDeliveryAvailability = DIManager.di.direct.instance(),
    private val updateDeliveryAvailability: ToDoUpdateDeliveryAvailability = DIManager.di.direct.instance(),
    private val toDoResetLoginCache: ToDoResetLoginCache = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<DeliveryProfileViewModel>()
    private val profileValidation: Validation<DeliveryProfileForm> = buildProfileValidation()
    private val availabilityValidation: Validation<DeliveryAvailabilityForm> = buildAvailabilityValidation()

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
            entry(DeliveryProfileForm::vehiclePlate.name),
            entry(AVAILABILITY_TIMEZONE_KEY),
            entry(AVAILABILITY_GENERAL_KEY)
        )
        DayOfWeek.entries.forEach { day ->
            inputsStates[availabilityKey(day, "start")] = mutableStateOf(InputState(availabilityKey(day, "start")))
            inputsStates[availabilityKey(day, "end")] = mutableStateOf(InputState(availabilityKey(day, "end")))
        }
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

    fun onTimezoneChange(value: String) {
        state = state.copy(
            availability = state.availability.copy(timezone = value),
            availabilityErrorKey = null
        )
    }

    fun onToggleDay(dayOfWeek: DayOfWeek, enabled: Boolean) {
        updateSlot(dayOfWeek) { slot ->
            val defaults = blockDefaultRanges[slot.block] ?: ("06:00" to "12:00")
            slot.copy(
                enabled = enabled,
                start = defaults.first,
                end = defaults.second
            )
        }
    }

    fun onBlockSelected(dayOfWeek: DayOfWeek, block: DeliveryAvailabilityBlock) {
        val range = blockDefaultRanges[block] ?: ("06:00" to "12:00")
        updateSlot(dayOfWeek) { slot ->
            slot.copy(
                enabled = true,
                mode = DeliveryAvailabilityMode.BLOCK,
                block = block,
                start = range.first,
                end = range.second
            )
        }
    }

    fun onCustomSelected(dayOfWeek: DayOfWeek) {
        updateSlot(dayOfWeek) { slot ->
            slot.copy(
                enabled = true,
                mode = DeliveryAvailabilityMode.CUSTOM
            )
        }
    }

    fun onCustomStartChange(dayOfWeek: DayOfWeek, value: String) {
        updateSlot(dayOfWeek) { slot -> slot.copy(start = value) }
    }

    fun onCustomEndChange(dayOfWeek: DayOfWeek, value: String) {
        updateSlot(dayOfWeek) { slot -> slot.copy(end = value) }
    }

    suspend fun loadProfile() {
        logger.info { "[Delivery][Perfil] Cargando datos" }
        state = state.copy(loading = true, error = null, successKey = null, availabilityErrorKey = null)

        val availabilityResult = getDeliveryAvailability.execute()
        val profileResult = getDeliveryProfile.execute()

        profileResult
            .onSuccess { data -> applyProfileData(data, keepLoading = true) }
            .onFailure { throwable ->
                logger.error(throwable) { "[Delivery][Perfil] Error al cargar datos" }
                state = state.copy(
                    loading = false,
                    error = throwable.message ?: "No se pudo cargar el perfil",
                    successKey = null
                )
                return
            }

        availabilityResult
            .onSuccess { applyAvailabilityData(it, keepLoading = true) }
            .onFailure { throwable ->
                logger.error(throwable) { "[Delivery][Perfil] Error al cargar disponibilidad" }
                state = state.copy(
                    availability = state.availability.copy(timezone = state.availability.timezone.ifBlank { "UTC" }),
                    error = throwable.message ?: "No se pudo cargar la disponibilidad",
                    availabilityErrorKey = null
                )
            }

        state = state.copy(loading = false)
    }

    suspend fun saveProfile() {
        val isProfileValid = validateProfile()
        val isAvailabilityValid = validateAvailability()
        if (!isProfileValid || !isAvailabilityValid) return

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
        val profileResult = updateDeliveryProfile.execute(profile)
        val availabilityResult = updateDeliveryAvailability.execute(state.availability.toDomain())

        profileResult.onFailure { throwable ->
            logger.error(throwable) { "[Delivery][Perfil] Error al guardar" }
            state = state.copy(
                saving = false,
                error = throwable.message ?: "No se pudo guardar el perfil",
                successKey = null
            )
            return
        }

        availabilityResult.onFailure { throwable ->
            logger.error(throwable) { "[Delivery][Disponibilidad] Error al guardar" }
            state = state.copy(
                saving = false,
                error = throwable.message ?: "No se pudo guardar la disponibilidad",
                successKey = null
            )
            return
        }

        applyProfileData(profileResult.getOrThrow())
        applyAvailabilityData(availabilityResult.getOrThrow())
        state = state.copy(successKey = MessageKey.delivery_availability_saved, saving = false)
    }

    suspend fun logout() {
        toDoResetLoginCache.execute()
        SessionStore.clear()
    }

    private fun applyProfileData(
        data: DeliveryProfileData,
        successKey: MessageKey? = null,
        keepLoading: Boolean = false
    ) {
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
            loading = if (keepLoading) state.loading else false,
            saving = false,
            error = null,
            successKey = successKey
        )
        validation = profileValidation as Validation<Any>
    }

    private fun applyAvailabilityData(
        config: DeliveryAvailabilityConfig?,
        keepLoading: Boolean = false
    ) {
        state = state.copy(
            availability = config?.toForm() ?: DeliveryAvailabilityForm(),
            availabilityErrorKey = null,
            loading = if (keepLoading) state.loading else false,
            saving = false
        )
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

    private fun buildAvailabilityValidation(): Validation<DeliveryAvailabilityForm> = Validation {
        DeliveryAvailabilityForm::timezone required {
            minLength(1) hint MessageKey.delivery_availability_error_timezone_required.name
        }
        DeliveryAvailabilityForm::slots {
            addConstraint(MessageKey.delivery_availability_error_no_days.name) { slots ->
                slots.any { it.enabled }
            }
        }
        DeliveryAvailabilityForm::slots onEach {
            addConstraint(MessageKey.delivery_availability_error_block_required.name) { slot ->
                !slot.enabled || slot.mode != DeliveryAvailabilityMode.BLOCK || slot.block != null
            }
            addConstraint(MessageKey.delivery_availability_error_custom_range_missing.name) { slot ->
                when {
                    !slot.enabled -> true
                    slot.mode == DeliveryAvailabilityMode.BLOCK -> true
                    slot.start.isNotBlank() && slot.end.isNotBlank() -> true
                    else -> false
                }
            }
            DeliveryAvailabilitySlotForm::start {
                addConstraint(MessageKey.delivery_availability_error_invalid_time.name) { value ->
                    value.isBlank() || value.matches(Regex("^\\d{2}:\\d{2}$"))
                }
            }
            DeliveryAvailabilitySlotForm::end {
                addConstraint(MessageKey.delivery_availability_error_invalid_time.name) { value ->
                    value.isBlank() || value.matches(Regex("^\\d{2}:\\d{2}$"))
                }
            }
            addConstraint(MessageKey.delivery_availability_error_end_before_start.name) { slot ->
                if (!slot.enabled) {
                    true
                } else {
                    val (startMinutes, endMinutes) = slot.effectiveTimes()
                    startMinutes != null && endMinutes != null && startMinutes < endMinutes
                }
            }
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

    private fun validateAvailability(): Boolean {
        validation = availabilityValidation as Validation<Any>
        inputsStates
            .filterKeys { it.startsWith("availability") }
            .forEach { (_, inputState) ->
                inputState.value = inputState.value.copy(isValid = true, details = "")
            }
        val result = availabilityValidation(state.availability)
        var availabilityErrorKey: String? = null
        result.errors.forEach { error ->
            val key = error.dataPath.toAvailabilityInputKey()
            if (key == AVAILABILITY_GENERAL_KEY || key.isBlank()) {
                availabilityErrorKey = error.message
            } else {
                val mutableState = inputsStates.getOrPut(key) { mutableStateOf(InputState(key)) }
                mutableState.value = mutableState.value.copy(
                    isValid = false,
                    details = error.message
                )
            }
        }
        state = state.copy(availabilityErrorKey = availabilityErrorKey)
        return result.errors.isEmpty()
    }

    private fun updateSlot(dayOfWeek: DayOfWeek, updater: (DeliveryAvailabilitySlotForm) -> DeliveryAvailabilitySlotForm) {
        val updatedSlots = state.availability.slots.map { slot ->
            if (slot.dayOfWeek == dayOfWeek) updater(slot) else slot
        }
        state = state.copy(availability = state.availability.copy(slots = updatedSlots))
    }

    private fun DeliveryAvailabilityForm.toDomain(): DeliveryAvailabilityConfig = DeliveryAvailabilityConfig(
        timezone = timezone.trim(),
        slots = slots.filter { it.enabled }.map { slot ->
            val defaultTimes = blockDefaultRanges[slot.block] ?: ("06:00" to "12:00")
            val (start, end) = if (slot.mode == DeliveryAvailabilityMode.BLOCK) {
                defaultTimes
            } else {
                slot.start to slot.end
            }
            DeliveryAvailabilitySlot(
                dayOfWeek = slot.dayOfWeek,
                mode = slot.mode,
                block = if (slot.mode == DeliveryAvailabilityMode.BLOCK) slot.block else null,
                start = start,
                end = end
            )
        }
    )

    private fun DeliveryAvailabilityConfig.toForm(): DeliveryAvailabilityForm {
        val slotsByDay = slots.associateBy { it.dayOfWeek }
        val mappedSlots = DayOfWeek.entries.map { day ->
            val slot = slotsByDay[day]
            if (slot != null) {
                val (start, end) = slot.resolveTimes()
                DeliveryAvailabilitySlotForm(
                    dayOfWeek = day,
                    enabled = true,
                    mode = slot.mode,
                    block = slot.block ?: DeliveryAvailabilityBlock.MORNING,
                    start = start,
                    end = end
                )
            } else {
                DeliveryAvailabilitySlotForm(dayOfWeek = day)
            }
        }
        return DeliveryAvailabilityForm(
            timezone = timezone.ifBlank { "UTC" },
            slots = mappedSlots
        )
    }

    private fun DeliveryAvailabilitySlotForm.effectiveTimes(): Pair<Int?, Int?> {
        val defaultTimes = blockDefaultRanges[block]
        val startValue = if (mode == DeliveryAvailabilityMode.BLOCK) defaultTimes?.first else start
        val endValue = if (mode == DeliveryAvailabilityMode.BLOCK) defaultTimes?.second else end
        return startValue.toMinutes() to endValue.toMinutes()
    }

    private fun DeliveryAvailabilitySlot.resolveTimes(): Pair<String, String> {
        val defaultTimes = blockDefaultRanges[block ?: DeliveryAvailabilityBlock.MORNING] ?: ("06:00" to "12:00")
        return if (mode == DeliveryAvailabilityMode.BLOCK) {
            defaultTimes
        } else {
            (start ?: defaultTimes.first) to (end ?: defaultTimes.second)
        }
    }

    private fun String?.toMinutes(): Int? = this
        ?.takeIf { it.matches(Regex("^\\d{2}:\\d{2}$")) }
        ?.split(":")
        ?.let { parts ->
            val hours = parts.getOrNull(0)?.toIntOrNull()
            val minutes = parts.getOrNull(1)?.toIntOrNull()
            if (hours == null || minutes == null) null else hours * 60 + minutes
        }

    private fun String.toAvailabilityInputKey(): String {
        val cleanPath = removePrefix("/")
        if (cleanPath.startsWith("slots[")) {
            val index = cleanPath.substringAfter("slots[").substringBefore("]").toIntOrNull()
                ?: return AVAILABILITY_GENERAL_KEY
            val field = cleanPath.substringAfter("]/", "")
            if (field.isBlank()) return AVAILABILITY_GENERAL_KEY
            val day = DayOfWeek.entries.getOrNull(index) ?: return AVAILABILITY_GENERAL_KEY
            return availabilityKey(day, field)
        }
        return when (cleanPath) {
            "timezone" -> AVAILABILITY_TIMEZONE_KEY
            "slots" -> AVAILABILITY_GENERAL_KEY
            else -> cleanPath
        }
    }
}
