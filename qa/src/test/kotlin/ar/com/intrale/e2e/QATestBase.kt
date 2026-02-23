package ar.com.intrale.e2e

import com.microsoft.playwright.APIRequest
import com.microsoft.playwright.APIRequestContext
import com.microsoft.playwright.Playwright
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Clase base para tests E2E.
 * Provee contexto Playwright (API request), URLs del entorno y directorio de recordings.
 */
abstract class QATestBase {

    companion object {
        val logger: Logger = LoggerFactory.getLogger("ar.com.intrale.e2e")

        lateinit var playwright: Playwright
        lateinit var apiContext: APIRequestContext
        lateinit var recordingsDir: Path

        val baseUrl: String
            get() = System.getenv("QA_BASE_URL") ?: "http://localhost:8080"

        @JvmStatic
        @BeforeAll
        fun setupPlaywright() {
            recordingsDir = Paths.get(
                System.getenv("RECORDINGS_DIR")
                    ?: Paths.get("qa", "recordings").toAbsolutePath().toString()
            )
            Files.createDirectories(recordingsDir)

            logger.info("Iniciando Playwright — baseUrl=$baseUrl, recordings=$recordingsDir")

            playwright = Playwright.create()
            apiContext = playwright.request().newContext(
                APIRequest.NewContextOptions()
                    .setBaseURL(baseUrl)
            )
        }

        @JvmStatic
        @AfterAll
        fun teardownPlaywright() {
            logger.info("Cerrando Playwright")
            if (::apiContext.isInitialized) apiContext.dispose()
            if (::playwright.isInitialized) playwright.close()
        }
    }
}
