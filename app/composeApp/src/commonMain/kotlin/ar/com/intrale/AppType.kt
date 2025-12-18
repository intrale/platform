package ar.com.intrale

object AppType {
    const val CLIENT = "CLIENT"
    const val BUSINESS = "BUSINESS"

    fun current(): String = BuildKonfig.APP_TYPE

    fun isClient(): Boolean = current().equals(CLIENT, ignoreCase = true)

    fun isBusiness(): Boolean = current().equals(BUSINESS, ignoreCase = true)
}
