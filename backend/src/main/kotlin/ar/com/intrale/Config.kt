package ar.com.intrale

open class Config(
    open val businesses: Set<String>,
    open val region: String,
    open val awsCognitoUserPoolId: String,
    open val awsCognitoClientId: String)
