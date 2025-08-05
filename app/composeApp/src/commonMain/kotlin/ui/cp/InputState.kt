package ui.cp

import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

data class InputState(
    var fieldName: String,
    private var _isValid: Boolean = true,
    private var _details: String = "",
) {
    private val logger = LoggerFactory.default.newLogger("ui.cp", "InputState")

    var isValid: Boolean
        get() = _isValid
        set(value) {
            logger.info { "isValid para $fieldName: $_isValid -> $value" }
            _isValid = value
        }

    var details: String
        get() = _details
        set(value) {
            logger.info { "details para $fieldName: $value" }
            _details = value
        }
}
