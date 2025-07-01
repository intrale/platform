package ui.sc

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
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
    data class LoginUIState (
        val user: String = "",
        val password: String = ""
    )
    override fun getState(): Any  = state

    // inputs and validations initialize
    init {
        validation = Validation<LoginUIState> {

            LoginUIState::user required {
                minLength(8) hint "Debe contener al menos 8 caracteres."
            }
            LoginUIState::password required {
                minLength(8) hint "Debe contener al menos 8 caracteres."
            }

        } as Validation<Any>

        initInputState()

   }
   override fun initInputState() {
       inputsStates = mutableMapOf(
                            entry(LoginUIState::user.name),
                            entry(LoginUIState::password.name))
    }

    // Features
    suspend fun login(): String =
        todoLogin.execute(
            user = state.user,
            password = state.password
        )

    suspend fun  previousLogin(): Boolean = toDoCheckPreviousLogin.execute()

}


