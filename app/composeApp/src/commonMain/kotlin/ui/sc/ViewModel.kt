package ui.sc

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.konform.validation.Validation
import io.konform.validation.ValidationResult
import ui.cp.InputState

abstract class ViewModel: androidx.lifecycle.ViewModel(){

    //var logger = LoggerFactory.default.newLogger(Logger.Tag("ui.cp", "ViewModel"))

    lateinit var validation : Validation<Any>
    var inputsStates by mutableStateOf(mutableMapOf<String, InputState>())

    abstract fun getState():Any

    fun isValid():Boolean {

        var validationResult: ValidationResult<Any> = validation(getState())

        //TODO: review what do we do with the last inputsStates
        // reset all is an option
        initInputState()

        validationResult.errors.forEach {
            var inputState:InputState = this[it.dataPath.substring(1)]
            inputState.isValid = false
            inputState.details = it.message
        }
        return validationResult.isValid
    }

    operator fun  get(propertyName: String):InputState {
        //logger.info { "get value with string" }
        var inputState: InputState? = inputsStates[propertyName]
        if (inputState==null){
            inputState = InputState(propertyName)
            inputsStates[propertyName] = inputState
        }
        return inputState
    }

    abstract fun initInputState()

    fun entry(key: String) = key to InputState(key)


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