package ui.cp

data class InputState(
    var fieldName: String,
    var isValid: Boolean = true,
    var details: String = ""
)