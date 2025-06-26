package ar.com.intrale

data class UsersConfig(
    override val businesses: Set<String>,
    override val region: String,
    val accessKeyId: String,
    val secretAccessKey: String,
    override val awsCognitoUserPoolId: String,
    override val awsCognitoClientId: String) :
                            Config (businesses = businesses,
                                    region = region,
                                    awsCognitoUserPoolId=awsCognitoUserPoolId,
                                    awsCognitoClientId=awsCognitoClientId)
