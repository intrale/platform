package ui.sc

import DIManager
import asdo.ToDoRegisterBusiness
import asdo.ToDoReviewBusinessRegistration
import asdo.ToGetBusinesses
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.konform.validation.Validation
import io.konform.validation.jsonschema.pattern
import org.kodein.di.instance

class RegisterBusinessViewModel : ViewModel() {
    private val register: ToDoRegisterBusiness by DIManager.di.instance()
    private val review: ToDoReviewBusinessRegistration by DIManager.di.instance()
    private val getBusinesses: ToGetBusinesses by DIManager.di.instance()

    var state by mutableStateOf(UIState())
    var loading by mutableStateOf(false)
    var pending by mutableStateOf(listOf<String>())

    data class UIState(
        val name: String = "",
        val email: String = "",
        val description: String = "",
        val twoFactorCode: String = ""
    )

    override fun getState(): Any = state

    init {
        validation = Validation<UIState> {
            UIState::name required {}
            UIState::email required { pattern(".+@.+\\..+") hint "Correo inválido" }
            UIState::description required {}
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(UIState::name.name),
            entry(UIState::email.name),
            entry(UIState::description.name),
            entry(UIState::twoFactorCode.name)
        )
    }

    suspend fun register() = register.execute(state.name, state.email, state.description)

    suspend fun approve(business: String) = review.execute(business, "approved", state.twoFactorCode)

    suspend fun reject(business: String) = review.execute(business, "rejected", state.twoFactorCode)

    suspend fun loadPending() {
        getBusinesses.execute("PENDING").onSuccess { pending = it.businesses }
    }
}
