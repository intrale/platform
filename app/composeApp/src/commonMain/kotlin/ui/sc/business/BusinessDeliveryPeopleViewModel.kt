package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.business.BusinessDeliveryPerson
import asdo.business.BusinessDeliveryPersonStatus
import asdo.business.ToDoInviteDeliveryPerson
import asdo.business.ToDoListBusinessDeliveryPeople
import asdo.business.ToDoToggleDeliveryPersonStatus
import io.konform.validation.Validation
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

enum class BusinessDeliveryPeopleStatus { Idle, Loading, Loaded, Empty, Error, MissingBusiness }

data class BusinessDeliveryPeopleUiState(
    val status: BusinessDeliveryPeopleStatus = BusinessDeliveryPeopleStatus.Idle,
    val people: List<BusinessDeliveryPerson> = emptyList(),
    val errorMessage: String? = null,
    val togglingEmail: String? = null,
    val showInviteDialog: Boolean = false,
    val inviteEmail: String = "",
    val inviteError: String? = null,
    val inviting: Boolean = false
)

class BusinessDeliveryPeopleViewModel(
    private val listDeliveryPeople: ToDoListBusinessDeliveryPeople = DIManager.di.direct.instance(),
    private val toggleStatus: ToDoToggleDeliveryPersonStatus = DIManager.di.direct.instance(),
    private val invitePerson: ToDoInviteDeliveryPerson = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<BusinessDeliveryPeopleViewModel>()
    private var currentBusinessId: String? = null

    var state by mutableStateOf(BusinessDeliveryPeopleUiState())
        private set

    override fun getState(): Any = state

    init {
        validation = Validation<BusinessDeliveryPeopleUiState> { } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf()
    }

    suspend fun load(businessId: String?) {
        if (businessId.isNullOrBlank()) {
            state = state.copy(
                status = BusinessDeliveryPeopleStatus.MissingBusiness,
                people = emptyList(),
                errorMessage = null
            )
            return
        }
        currentBusinessId = businessId
        state = state.copy(status = BusinessDeliveryPeopleStatus.Loading, errorMessage = null)
        listDeliveryPeople.execute(businessId)
            .onSuccess { list ->
                state = state.copy(
                    status = if (list.isEmpty()) BusinessDeliveryPeopleStatus.Empty else BusinessDeliveryPeopleStatus.Loaded,
                    people = list,
                    errorMessage = null
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al cargar repartidores" }
                state = state.copy(
                    status = BusinessDeliveryPeopleStatus.Error,
                    errorMessage = error.message ?: ""
                )
            }
    }

    suspend fun refresh() {
        load(currentBusinessId)
    }

    suspend fun toggle(email: String, currentStatus: BusinessDeliveryPersonStatus): Result<Unit> {
        val businessId = currentBusinessId
            ?: return Result.failure(IllegalStateException("No hay negocio seleccionado"))
        val newStatus = if (currentStatus == BusinessDeliveryPersonStatus.ACTIVE) {
            BusinessDeliveryPersonStatus.INACTIVE
        } else {
            BusinessDeliveryPersonStatus.ACTIVE
        }
        state = state.copy(togglingEmail = email)
        val result = toggleStatus.execute(businessId, email, newStatus)
        state = state.copy(togglingEmail = null)
        result.onSuccess { updated ->
            state = state.copy(
                people = state.people.map { person ->
                    if (person.email == email) person.copy(status = updated.status) else person
                }
            )
        }.onFailure { error ->
            logger.error(error) { "No se pudo cambiar estado del repartidor $email" }
            state = state.copy(errorMessage = error.message)
        }
        return result.map { }
    }

    fun showInviteDialog() {
        state = state.copy(showInviteDialog = true, inviteEmail = "", inviteError = null)
    }

    fun dismissInviteDialog() {
        state = state.copy(showInviteDialog = false, inviteEmail = "", inviteError = null)
    }

    fun updateInviteEmail(email: String) {
        state = state.copy(inviteEmail = email, inviteError = null)
    }

    suspend fun invite(): Result<String> {
        val businessId = currentBusinessId
            ?: return Result.failure(IllegalStateException("No hay negocio seleccionado"))
        val email = state.inviteEmail.trim()
        if (email.isBlank()) {
            state = state.copy(inviteError = "El email es requerido")
            return Result.failure(IllegalArgumentException("Email requerido"))
        }
        state = state.copy(inviting = true, inviteError = null)
        val result = invitePerson.execute(businessId, email)
        state = state.copy(inviting = false)
        result.onSuccess {
            state = state.copy(showInviteDialog = false, inviteEmail = "")
            load(businessId)
        }.onFailure { error ->
            state = state.copy(inviteError = error.message)
        }
        return result
    }

    fun clearError() {
        if (state.errorMessage != null) state = state.copy(errorMessage = null)
    }
}
