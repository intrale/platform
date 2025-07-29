package ui.sc

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.DoLoginResult
import asdo.ToDoCheckPreviousLogin
import asdo.ToDoLogin
import io.konform.validation.Validation
import io.konform.validation.jsonschema.minLength
import org.kodein.di.instance

class LoginViewModel : ViewModel() {

    private val todoLogin: ToDoLogin by DIManager.di.instance()
    private val toDoCheckPreviousLogin: ToDoCheckPreviousLogin by DIManager.di.instance()

    // data state initialize
    var state by mutableStateOf(LoginUIState())
    var loading by mutableStateOf(false)
    var changePasswordRequired by mutableStateOf(false)

    data class LoginUIState (
        val user: String = "",
        val password: String = "",
        val newPassword: String = "",
        val name: String = "",
        val familyName: String = ""
    )
    override fun getState(): Any  = state

    // inputs and validations initialize
    init {
        setupValidation()
        initInputState()

   }

    fun setupValidation() {
        validation = Validation<LoginUIState> {
            //TODO: Externalizar mensajes
            LoginUIState::user required {
                minLength(8) hint "Debe contener al menos 8 caracteres."
            }
            LoginUIState::password required {
                minLength(8) hint "Debe contener al menos 8 caracteres."
            }
            if (changePasswordRequired) {
                LoginUIState::newPassword required {
                    minLength(8) hint "Debe contener al menos 8 caracteres."
                }
                LoginUIState::name required {}
                LoginUIState::familyName required {}
            }
        } as Validation<Any>
    }
   override fun initInputState() {
       inputsStates = mutableMapOf(
            entry(LoginUIState::user.name),
            entry(LoginUIState::password.name)
       )
       if (changePasswordRequired) {
            inputsStates[LoginUIState::newPassword.name] = mutableStateOf(InputState(LoginUIState::newPassword.name))
            inputsStates[LoginUIState::name.name] = mutableStateOf(InputState(LoginUIState::name.name))
            inputsStates[LoginUIState::familyName.name] = mutableStateOf(InputState(LoginUIState::familyName.name))
       }
    }

    // Features
    suspend fun login(): Result<DoLoginResult> {
        setupValidation()
        return todoLogin.execute(
            user = state.user,
            password = state.password,
            newPassword = if (changePasswordRequired) state.newPassword else null,
            name = if (changePasswordRequired) state.name else null,
            familyName = if (changePasswordRequired) state.familyName else null
        )
    }

    suspend fun  previousLogin(): Boolean = toDoCheckPreviousLogin.execute()

}


