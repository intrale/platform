package ar.com.intrale

import io.mockk.justRun
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import io.mockk.verify
import kotlin.test.Test

class UsersApplicationTest {
    @Test
    fun `main inicia la aplicacion`() {
        mockkStatic("ar.com.intrale.ApplicationKt")
        justRun { start(appModule) }

        main()

        verify(exactly = 1) { start(appModule) }
        unmockkStatic("ar.com.intrale.ApplicationKt")
    }
}
