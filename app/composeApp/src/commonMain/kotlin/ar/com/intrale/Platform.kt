package ar.com.intrale

interface Platform {
    val name: String
}

expect fun getPlatform(): Platform