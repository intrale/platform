package ui.sc.business

import asdo.business.ToDoGetFonts
import asdo.business.ToDoUpdateFonts
import ext.business.FontsDTO
import ext.business.FontsRequest
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class FakeGetFonts(
    private val result: Result<FontsDTO> = Result.success(FontsDTO(fonts = emptyMap()))
) : ToDoGetFonts {
    override suspend fun execute(businessId: String): Result<FontsDTO> = result
}

private class FakeUpdateFonts(
    private val result: Result<FontsDTO> = Result.success(FontsDTO(fonts = emptyMap()))
) : ToDoUpdateFonts {
    var lastRequest: FontsRequest? = null
    override suspend fun execute(businessId: String, request: FontsRequest): Result<FontsDTO> {
        lastRequest = request
        return result
    }
}

class TypographyViewModelTest {

    @Test
    fun `loadFonts actualiza el estado con las fuentes del backend`() = runTest {
        val expectedFonts = mapOf(
            "title" to "Roboto-Bold",
            "subtitle" to "OpenSans-Regular",
            "body" to "Lato-Regular",
            "button" to "Poppins-Medium"
        )
        val fakeGet = FakeGetFonts(Result.success(FontsDTO(fonts = expectedFonts)))
        val viewModel = TypographyViewModel(fakeGet, FakeUpdateFonts())

        viewModel.loadFonts("biz-1")

        assertFalse(viewModel.loading)
        assertEquals("Roboto-Bold", viewModel.uiState.titleFont)
        assertEquals("OpenSans-Regular", viewModel.uiState.subtitleFont)
        assertEquals("Lato-Regular", viewModel.uiState.bodyFont)
        assertEquals("Poppins-Medium", viewModel.uiState.buttonFont)
        assertNull(viewModel.errorMessage)
    }

    @Test
    fun `loadFonts con error establece errorMessage`() = runTest {
        val fakeGet = FakeGetFonts(Result.failure(RuntimeException("Error de red")))
        val viewModel = TypographyViewModel(fakeGet, FakeUpdateFonts())

        viewModel.loadFonts("biz-1")

        assertFalse(viewModel.loading)
        assertEquals("Error de red", viewModel.errorMessage)
    }

    @Test
    fun `loadFonts con businessId vacio no ejecuta llamada`() = runTest {
        var called = false
        val fakeGet = object : ToDoGetFonts {
            override suspend fun execute(businessId: String): Result<FontsDTO> {
                called = true
                return Result.success(FontsDTO())
            }
        }
        val viewModel = TypographyViewModel(fakeGet, FakeUpdateFonts())
        viewModel.loadFonts("")
        assertFalse(called)
    }

    @Test
    fun `saveFonts envia correctamente el mapa de fuentes`() = runTest {
        val fakeUpdate = FakeUpdateFonts(
            Result.success(FontsDTO(fonts = mapOf("title" to "Roboto-Bold")))
        )
        val viewModel = TypographyViewModel(FakeGetFonts(), fakeUpdate)
        viewModel.updateTitleFont("Roboto-Bold")
        viewModel.updateBodyFont("Lato-Regular")

        val result = viewModel.saveFonts("biz-1")

        assertTrue(result.isSuccess)
        assertFalse(viewModel.saving)
        assertEquals("Roboto-Bold", fakeUpdate.lastRequest?.fonts?.get("title"))
        assertEquals("Lato-Regular", fakeUpdate.lastRequest?.fonts?.get("body"))
        assertNull(fakeUpdate.lastRequest?.fonts?.get("subtitle"))
    }

    @Test
    fun `saveFonts con businessId vacio retorna failure`() = runTest {
        val viewModel = TypographyViewModel(FakeGetFonts(), FakeUpdateFonts())
        val result = viewModel.saveFonts("")
        assertTrue(result.isFailure)
    }

    @Test
    fun `saveFonts con error establece errorMessage`() = runTest {
        val fakeUpdate = FakeUpdateFonts(Result.failure(RuntimeException("Error al guardar")))
        val viewModel = TypographyViewModel(FakeGetFonts(), fakeUpdate)
        viewModel.updateTitleFont("Roboto-Bold")

        val result = viewModel.saveFonts("biz-1")

        assertTrue(result.isFailure)
        assertFalse(viewModel.saving)
        assertEquals("Error al guardar", viewModel.errorMessage)
    }

    @Test
    fun `updateTitleFont actualiza solo el titleFont`() = runTest {
        val viewModel = TypographyViewModel(FakeGetFonts(), FakeUpdateFonts())
        viewModel.updateTitleFont("Montserrat-Bold")
        assertEquals("Montserrat-Bold", viewModel.uiState.titleFont)
        assertEquals("", viewModel.uiState.subtitleFont)
        assertEquals("", viewModel.uiState.bodyFont)
        assertEquals("", viewModel.uiState.buttonFont)
    }

    @Test
    fun `saveFonts solo incluye fuentes no vacias en el request`() = runTest {
        val fakeUpdate = FakeUpdateFonts(Result.success(FontsDTO()))
        val viewModel = TypographyViewModel(FakeGetFonts(), fakeUpdate)
        viewModel.updateTitleFont("Roboto-Bold")

        viewModel.saveFonts("biz-1")

        val fonts = fakeUpdate.lastRequest?.fonts ?: emptyMap()
        assertTrue(fonts.containsKey("title"))
        assertFalse(fonts.containsKey("subtitle"))
        assertFalse(fonts.containsKey("body"))
        assertFalse(fonts.containsKey("button"))
    }
}
