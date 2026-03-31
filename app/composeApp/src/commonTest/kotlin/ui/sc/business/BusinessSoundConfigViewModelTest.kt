package ui.sc.business

import asdo.business.OrderSoundConfig
import asdo.business.OrderSoundType
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class BusinessSoundConfigViewModelTest {

    private lateinit var viewModel: BusinessSoundConfigViewModel

    @BeforeTest
    fun setup() {
        BusinessOrderNotificationStore.clear()
        viewModel = BusinessSoundConfigViewModel()
    }

    @Test
    fun `estado inicial refleja configuracion default`() {
        assertTrue(viewModel.state.enabled)
        assertEquals(OrderSoundConfig().volume, viewModel.state.volume)
        assertTrue(viewModel.state.vibrationEnabled)
        assertEquals(OrderSoundType.DEFAULT, viewModel.state.soundType)
        assertFalse(viewModel.state.isMuted)
    }

    @Test
    fun `toggleEnabled cambia estado y sincroniza con store`() {
        viewModel.toggleEnabled()
        assertFalse(viewModel.state.enabled)
        assertFalse(BusinessOrderNotificationStore.config.value.enabled)

        viewModel.toggleEnabled()
        assertTrue(viewModel.state.enabled)
        assertTrue(BusinessOrderNotificationStore.config.value.enabled)
    }

    @Test
    fun `updateVolume respeta limites y sincroniza`() {
        viewModel.updateVolume(0.5f)
        assertEquals(0.5f, viewModel.state.volume)
        assertEquals(0.5f, BusinessOrderNotificationStore.config.value.volume)

        viewModel.updateVolume(2.0f)
        assertEquals(OrderSoundConfig.MAX_VOLUME, viewModel.state.volume)
    }

    @Test
    fun `selectSoundType cambia tipo y sincroniza`() {
        viewModel.selectSoundType(OrderSoundType.BELL)
        assertEquals(OrderSoundType.BELL, viewModel.state.soundType)
        assertEquals(OrderSoundType.BELL, BusinessOrderNotificationStore.config.value.soundType)
    }

    @Test
    fun `toggleVibration cambia estado`() {
        viewModel.toggleVibration()
        assertFalse(viewModel.state.vibrationEnabled)

        viewModel.toggleVibration()
        assertTrue(viewModel.state.vibrationEnabled)
    }

    @Test
    fun `toggleMute cambia estado de silencio`() {
        viewModel.toggleMute()
        assertTrue(viewModel.state.isMuted)
        assertTrue(BusinessOrderNotificationStore.config.value.isMuted)
    }
}
