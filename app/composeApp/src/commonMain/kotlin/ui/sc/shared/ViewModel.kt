package ui.sc.shared

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.MutableState
import io.konform.validation.Validation
import io.konform.validation.ValidationResult
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.inputs.InputState

abstract class ViewModel: androidx.lifecycle.ViewModel(){

    private val logger = LoggerFactory.default.newLogger<ViewModel>()

    lateinit var validation : Validation<Any>
    var inputsStates by mutableStateOf(mutableMapOf<String, MutableState<InputState>>())

    abstract fun getState():Any

    fun isValid():Boolean {
        logger.debug { "Ejecutando validación" }
        val validationResult: ValidationResult<Any> = validation(getState())

        inputsStates.forEach { (_, state) ->
            state.value = state.value.copy(
                isValid = true,
                details = ""
            )
        }

        validationResult.errors.forEach {
            val key = it.dataPath.substring(1)
            val mutableState = inputsStates.getOrPut(key) { mutableStateOf(InputState(key)) }
            mutableState.value = mutableState.value.copy(
                isValid = false,
                details = it.message
            )
        }

        if (!validationResult.isValid) {
            logger.debug { "Validación fallida: ${validationResult.errors.size} errores" }
        }
        return validationResult.isValid
    }

    operator fun get(propertyName: String): InputState {
        var inputState = inputsStates[propertyName]?.value
        if (inputState == null) {
            inputState = InputState(propertyName)
            inputsStates[propertyName] = mutableStateOf(inputState)
        }
        return inputState
    }


    abstract fun initInputState()

    fun entry(key: String) = key to mutableStateOf(InputState(key))

}