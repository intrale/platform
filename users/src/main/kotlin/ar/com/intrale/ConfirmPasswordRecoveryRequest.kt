package ar.com.intrale

data class ConfirmPasswordRecoveryRequest(val email:String, val code:String, val password:String)
