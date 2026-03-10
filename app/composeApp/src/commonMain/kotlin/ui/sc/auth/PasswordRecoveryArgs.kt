package ui.sc.auth

/**
 * Almacena argumentos de navegación entre PasswordRecoveryScreen y ConfirmPasswordRecoveryScreen.
 * Se limpia automáticamente al leer el email en ConfirmPasswordRecoveryViewModel.
 */
object PasswordRecoveryArgs {
    var email: String = ""
}
