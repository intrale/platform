package ui.sc.client

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.client.ClientAddress
import asdo.client.ManageAddressAction
import asdo.client.ToDoGetClientProfile
import asdo.client.ToDoManageClientAddress
import io.konform.validation.Validation
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

enum class AddressListStatus { Idle, Loading, Loaded, Empty, Error }

data class AddressListItem(
    val id: String,
    val label: String,
    val street: String,
    val number: String,
    val reference: String?,
    val city: String,
    val state: String?,
    val postalCode: String?,
    val country: String?,
    val isDefault: Boolean
)

data class AddressListUiState(
    val status: AddressListStatus = AddressListStatus.Idle,
    val items: List<AddressListItem> = emptyList(),
    val errorMessage: String? = null,
    val deletingAddressId: String? = null
)

class AddressListViewModel(
    private val getClientProfile: ToDoGetClientProfile = DIManager.di.direct.instance(),
    private val manageAddress: ToDoManageClientAddress = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<AddressListViewModel>()

    var state by mutableStateOf(AddressListUiState())
        private set

    override fun getState(): Any = state

    init {
        validation = Validation<AddressListUiState> { } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf()
    }

    suspend fun loadAddresses() {
        state = state.copy(
            status = AddressListStatus.Loading,
            errorMessage = null
        )
        getClientProfile.execute()
            .onSuccess { profileData ->
                val mapped = profileData.addresses.mapNotNull { it.toItem() }
                state = state.copy(
                    status = if (mapped.isEmpty()) AddressListStatus.Empty else AddressListStatus.Loaded,
                    items = mapped,
                    errorMessage = null
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al cargar direcciones" }
                state = state.copy(
                    status = AddressListStatus.Error,
                    errorMessage = error.message ?: ""
                )
            }
    }

    suspend fun deleteAddress(addressId: String): Result<Unit> {
        state = state.copy(deletingAddressId = addressId)
        val result = manageAddress.execute(ManageAddressAction.Delete(addressId))
        state = state.copy(deletingAddressId = null)
        result.onSuccess {
            state = state.copy(items = state.items.filterNot { it.id == addressId })
            if (state.items.isEmpty()) {
                state = state.copy(status = AddressListStatus.Empty)
            }
        }.onFailure { error ->
            logger.error(error) { "No se pudo eliminar la dirección $addressId" }
            state = state.copy(errorMessage = error.message)
        }
        return result.map { }
    }

    fun clearError() {
        if (state.errorMessage != null) {
            state = state.copy(errorMessage = null)
        }
    }

    fun toDraft(item: AddressListItem): AddressDraft =
        AddressDraft(
            id = item.id,
            label = item.label,
            street = item.street,
            number = item.number,
            reference = item.reference.orEmpty(),
            city = item.city,
            state = item.state.orEmpty(),
            postalCode = item.postalCode.orEmpty(),
            country = item.country.orEmpty(),
            isDefault = item.isDefault
        )

    private fun ClientAddress.toItem(): AddressListItem? {
        val addressId = id ?: return null
        return AddressListItem(
            id = addressId,
            label = label,
            street = street,
            number = number,
            reference = reference,
            city = city,
            state = state,
            postalCode = postalCode,
            country = country,
            isDefault = isDefault
        )
    }
}
