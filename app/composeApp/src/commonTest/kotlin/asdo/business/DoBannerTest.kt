package asdo.business

import ar.com.intrale.shared.business.BannerDTO
import ar.com.intrale.shared.business.BannerRequest
import ext.business.CommBannerService
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val sampleBanner = BannerDTO(
    id = "b-1",
    businessId = "biz-1",
    title = "Envio gratis",
    text = "Por compras mayores",
    imageUrl = "https://cdn.example.com/envio.png",
    position = "home",
    active = true
)

private val sampleBanners = listOf(sampleBanner)

// region DoListBanners

class DoListBannersTest {

    private fun fakeService(result: Result<List<BannerDTO>>) = object : CommBannerService {
        override suspend fun listBanners(businessId: String) = result
        override suspend fun createBanner(
            businessId: String,
            request: BannerRequest
        ): Result<BannerDTO> = Result.failure(NotImplementedError())

        override suspend fun updateBanner(
            businessId: String,
            bannerId: String,
            request: BannerRequest
        ): Result<BannerDTO> = Result.failure(NotImplementedError())

        override suspend fun toggleBanner(
            businessId: String,
            bannerId: String,
            active: Boolean
        ): Result<BannerDTO> = Result.failure(NotImplementedError())
    }

    @Test
    fun `listado exitoso retorna banners`() = runTest {
        val sut = DoListBanners(fakeService(Result.success(sampleBanners)))

        val result = sut.execute("biz-1")

        assertTrue(result.isSuccess)
        assertEquals(1, result.getOrThrow().size)
        assertEquals("Envio gratis", result.getOrThrow()[0].title)
    }

    @Test
    fun `listado fallido retorna error`() = runTest {
        val sut = DoListBanners(fakeService(Result.failure(RuntimeException("network error"))))

        val result = sut.execute("biz-1")

        assertTrue(result.isFailure)
    }
}

// endregion

// region DoCreateBanner

class DoCreateBannerTest {

    private fun fakeService(result: Result<BannerDTO>) = object : CommBannerService {
        override suspend fun listBanners(businessId: String): Result<List<BannerDTO>> =
            Result.failure(NotImplementedError())

        override suspend fun createBanner(
            businessId: String,
            request: BannerRequest
        ) = result

        override suspend fun updateBanner(
            businessId: String,
            bannerId: String,
            request: BannerRequest
        ): Result<BannerDTO> = Result.failure(NotImplementedError())

        override suspend fun toggleBanner(
            businessId: String,
            bannerId: String,
            active: Boolean
        ): Result<BannerDTO> = Result.failure(NotImplementedError())
    }

    @Test
    fun `creacion exitosa retorna banner creado`() = runTest {
        val sut = DoCreateBanner(fakeService(Result.success(sampleBanner)))

        val request = BannerRequest(
            title = "Envio gratis",
            text = "Por compras mayores",
            imageUrl = "https://cdn.example.com/envio.png",
            position = "home",
            active = true
        )
        val result = sut.execute("biz-1", request)

        assertTrue(result.isSuccess)
        assertEquals("Envio gratis", result.getOrThrow().title)
    }

    @Test
    fun `creacion fallida retorna error`() = runTest {
        val sut = DoCreateBanner(fakeService(Result.failure(RuntimeException("server error"))))

        val request = BannerRequest(title = "Test")
        val result = sut.execute("biz-1", request)

        assertTrue(result.isFailure)
    }
}

// endregion

// region DoUpdateBanner

class DoUpdateBannerTest {

    private fun fakeService(result: Result<BannerDTO>) = object : CommBannerService {
        override suspend fun listBanners(businessId: String): Result<List<BannerDTO>> =
            Result.failure(NotImplementedError())

        override suspend fun createBanner(
            businessId: String,
            request: BannerRequest
        ): Result<BannerDTO> = Result.failure(NotImplementedError())

        override suspend fun updateBanner(
            businessId: String,
            bannerId: String,
            request: BannerRequest
        ) = result

        override suspend fun toggleBanner(
            businessId: String,
            bannerId: String,
            active: Boolean
        ): Result<BannerDTO> = Result.failure(NotImplementedError())
    }

    @Test
    fun `actualizacion exitosa retorna banner actualizado`() = runTest {
        val updated = sampleBanner.copy(title = "Promo nueva")
        val sut = DoUpdateBanner(fakeService(Result.success(updated)))

        val request = BannerRequest(title = "Promo nueva")
        val result = sut.execute("biz-1", "b-1", request)

        assertTrue(result.isSuccess)
        assertEquals("Promo nueva", result.getOrThrow().title)
    }

    @Test
    fun `actualizacion fallida retorna error`() = runTest {
        val sut = DoUpdateBanner(fakeService(Result.failure(RuntimeException("error"))))

        val request = BannerRequest(title = "Test")
        val result = sut.execute("biz-1", "b-1", request)

        assertTrue(result.isFailure)
    }
}

// endregion

// region DoToggleBanner

class DoToggleBannerTest {

    private fun fakeService(result: Result<BannerDTO>) = object : CommBannerService {
        override suspend fun listBanners(businessId: String): Result<List<BannerDTO>> =
            Result.failure(NotImplementedError())

        override suspend fun createBanner(
            businessId: String,
            request: BannerRequest
        ): Result<BannerDTO> = Result.failure(NotImplementedError())

        override suspend fun updateBanner(
            businessId: String,
            bannerId: String,
            request: BannerRequest
        ): Result<BannerDTO> = Result.failure(NotImplementedError())

        override suspend fun toggleBanner(
            businessId: String,
            bannerId: String,
            active: Boolean
        ) = result
    }

    @Test
    fun `toggle exitoso retorna banner con nuevo estado`() = runTest {
        val toggled = sampleBanner.copy(active = false)
        val sut = DoToggleBanner(fakeService(Result.success(toggled)))

        val result = sut.execute("biz-1", "b-1", false)

        assertTrue(result.isSuccess)
        assertEquals(false, result.getOrThrow().active)
    }

    @Test
    fun `toggle fallido retorna error`() = runTest {
        val sut = DoToggleBanner(fakeService(Result.failure(RuntimeException("error"))))

        val result = sut.execute("biz-1", "b-1", false)

        assertTrue(result.isFailure)
    }
}

// endregion
