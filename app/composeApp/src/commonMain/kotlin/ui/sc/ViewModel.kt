package ui.sc

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.konform.validation.Validation
import io.konform.validation.ValidationResult
import ui.cp.InputState
import androidx.compose.runtime.MutableState

abstract class ViewModel: androidx.lifecycle.ViewModel(){

    //var logger = LoggerFactory.default.newLogger(Logger.Tag("ui.cp", "ViewModel"))

    lateinit var validation : Validation<Any>
    var inputsStates by mutableStateOf(mutableMapOf<String, MutableState<InputState>>())

    abstract fun getState():Any

    fun isValid():Boolean {

        val validationResult: ValidationResult<Any> = validation(getState())

        initInputState()

        validationResult.errors.forEach {
            val key = it.dataPath.substring(1)
            val current = inputsStates[key]?.value ?: InputState(key)
            inputsStates[key] = mutableStateOf(current.copy(
                isValid = false,
                details = it.message
            ))
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


   /* operator fun  get(property: KMutableProperty1<Any, MutableState<Any>>):InputState{
        //logger.info { "get value with property" }
        return  get(property.name)
    }*/


    /*
        operator fun  invoke(property: KMutableProperty1<ViewModel, MutableState<Any>>):Any{
            logger.info { "invoke get value" }
            return property.get(this)
        }

        operator fun  invoke(property: KMutableProperty1<ViewModel, MutableState<Any>>, value: Any){
            logger.info { "invoke set value" }
            //property.setValue(this, property, value)
        }*/



}