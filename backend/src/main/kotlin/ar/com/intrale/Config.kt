package ar.com.intrale

abstract class Config(
    open val region: String,
    open val awsCognitoUserPoolId: String,
    open val awsCognitoClientId: String
) {
    abstract fun businesses(): Set<String>
}
