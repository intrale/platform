package ui.cp.inputs

import ar.com.intrale.strings.model.MessageKey

data class InputState(
    var fieldName: String,
    var isValid: Boolean = true,
    var details: String = "",
    var messageKey: MessageKey? = null,
    var messageParams: Map<String, String> = emptyMap(),
)
