package ar.com.intrale

import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.testing.*
import org.kodein.di.DI
import org.kodein.di.bind
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.di.ktor.di
import org.kodein.di.singleton
import org.slf4j.LoggerFactory
import kotlin.test.Test
import kotlin.test.assertEquals

class HealthFunctionalTest {

    @Test
    fun healthEndpointWorks() = testApplication {
        val module = DI.Module("test") {
            bind<org.slf4j.Logger>() with singleton { LoggerFactory.getLogger("test") }
            bind<Config>() with singleton { Config(setOf("biz"), "us-east-1", "pool", "client") }
        }
        application {
            di { import(module) }
            healthRoute()
        }
        val response = client.get("/health")
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("{\"status\":\"UP\"}", response.bodyAsText())
    }
}
