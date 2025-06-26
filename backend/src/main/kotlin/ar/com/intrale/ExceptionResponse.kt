package ar.com.intrale

import io.ktor.http.HttpStatusCode

open class ExceptionResponse(val message: String = "Internal Server Error") : Response(statusCode = HttpStatusCode.InternalServerError){
}