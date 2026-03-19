package ar.com.intrale

// --- Auth ---
import ar.com.intrale.shared.auth.LoginRequest as SharedLoginRequest
import ar.com.intrale.shared.auth.SignUpRequest as SharedSignUpRequest
import ar.com.intrale.shared.auth.ConfirmSignUpRequest as SharedConfirmSignUpRequest
import ar.com.intrale.shared.auth.PasswordRecoveryRequest as SharedPasswordRecoveryRequest
import ar.com.intrale.shared.auth.ConfirmPasswordRecoveryRequest as SharedConfirmPasswordRecoveryRequest
import ar.com.intrale.shared.auth.ChangePasswordRequest as SharedChangePasswordRequest
import ar.com.intrale.shared.auth.TwoFactorVerifyRequest as SharedTwoFactorVerifyRequest
import ar.com.intrale.shared.auth.RegisterSalerRequest as SharedRegisterSalerRequest

// --- Business ---
import ar.com.intrale.shared.business.BusinessDTO as SharedBusinessDTO
import ar.com.intrale.shared.business.SearchBusinessesRequest as SharedSearchBusinessesRequest
import ar.com.intrale.shared.business.RegisterBusinessRequest as SharedRegisterBusinessRequest
import ar.com.intrale.shared.business.ReviewBusinessRegistrationRequest as SharedReviewBusinessRegistrationRequest
import ar.com.intrale.shared.business.ReviewJoinBusinessRequest as SharedReviewJoinBusinessRequest
import ar.com.intrale.shared.business.RequestJoinBusinessRequest as SharedRequestJoinBusinessRequest
import ar.com.intrale.shared.business.ConfigAutoAcceptDeliveriesRequest as SharedConfigAutoAcceptDeliveriesRequest
import ar.com.intrale.shared.business.AssignProfileRequest as SharedAssignProfileRequest
import ar.com.intrale.shared.business.FontsRequest as SharedFontsRequest
import ar.com.intrale.shared.business.CategoryRequest as SharedCategoryRequest
import ar.com.intrale.shared.business.CategoryDTO as SharedCategoryDTO
import ar.com.intrale.shared.business.BusinessOrderDTO as SharedBusinessOrderDTO

// --- Client ---
import ar.com.intrale.shared.client.ClientProfileDTO as SharedClientProfileDTO
import ar.com.intrale.shared.client.ClientAddressDTO as SharedClientAddressDTO
import ar.com.intrale.shared.client.ClientPreferencesDTO as SharedClientPreferencesDTO
import ar.com.intrale.shared.client.ClientProfileUpdateRequest as SharedClientProfileUpdateRequest
import ar.com.intrale.shared.client.ClientOrderRequest as SharedClientOrderRequest
import ar.com.intrale.shared.client.ClientOrderItemDTO as SharedClientOrderItemDTO
import ar.com.intrale.shared.client.ClientOrderDTO as SharedClientOrderDTO
import ar.com.intrale.shared.client.ClientOrderStatusEventDTO as SharedClientOrderStatusEventDTO

// --- Delivery ---
import ar.com.intrale.shared.delivery.DeliveryVehicleDTO as SharedDeliveryVehicleDTO
import ar.com.intrale.shared.delivery.DeliveryZoneDTO as SharedDeliveryZoneDTO
import ar.com.intrale.shared.delivery.DeliveryProfileDTO as SharedDeliveryProfileDTO
import ar.com.intrale.shared.delivery.DeliveryProfileUpdateRequest as SharedDeliveryProfileUpdateRequest
import ar.com.intrale.shared.delivery.DeliveryAvailabilitySlotDTO as SharedDeliveryAvailabilitySlotDTO
import ar.com.intrale.shared.delivery.DeliveryAvailabilityDTO as SharedDeliveryAvailabilityDTO
import ar.com.intrale.shared.delivery.DeliveryOrderItemDTO as SharedDeliveryOrderItemDTO
import ar.com.intrale.shared.delivery.DeliveryOrderDTO as SharedDeliveryOrderDTO
import ar.com.intrale.shared.delivery.DeliveryOrderStatusUpdateRequest as SharedDeliveryOrderStatusUpdateRequest
import ar.com.intrale.shared.delivery.DeliveryStateChangeRequest as SharedDeliveryStateChangeRequest

// Type aliases para mantener naming del backend y minimizar cambios en archivos existentes.

// Auth
typealias SignInRequest = SharedLoginRequest
typealias SignUpRequest = SharedSignUpRequest
typealias ConfirmSignUpRequest = SharedConfirmSignUpRequest
typealias PasswordRecoveryRequest = SharedPasswordRecoveryRequest
typealias ConfirmPasswordRecoveryRequest = SharedConfirmPasswordRecoveryRequest
typealias ChangePasswordRequest = SharedChangePasswordRequest
typealias TwoFactorVerifyRequest = SharedTwoFactorVerifyRequest
typealias RegisterSalerRequest = SharedRegisterSalerRequest

// Business
typealias BusinessDTO = SharedBusinessDTO
typealias SearchBusinessesRequest = SharedSearchBusinessesRequest
typealias RegisterBusinessRequest = SharedRegisterBusinessRequest
typealias ReviewBusinessRegistrationRequest = SharedReviewBusinessRegistrationRequest
typealias ReviewJoinBusinessRequest = SharedReviewJoinBusinessRequest
typealias RequestJoinBusinessRequest = SharedRequestJoinBusinessRequest
typealias ConfigAutoAcceptDeliveriesRequest = SharedConfigAutoAcceptDeliveriesRequest
typealias AssignProfileRequest = SharedAssignProfileRequest
typealias BusinessFontsRequest = SharedFontsRequest
typealias CategoryRequest = SharedCategoryRequest
typealias CategoryPayload = SharedCategoryDTO
typealias BusinessOrderPayload = SharedBusinessOrderDTO

// Client
typealias ClientProfilePayload = SharedClientProfileDTO
typealias ClientAddressPayload = SharedClientAddressDTO
typealias ClientPreferencesPayload = SharedClientPreferencesDTO
typealias ClientProfileUpdateRequest = SharedClientProfileUpdateRequest
typealias ClientOrderRequest = SharedClientOrderRequest
typealias ClientOrderItemPayload = SharedClientOrderItemDTO
typealias ClientOrderPayload = SharedClientOrderDTO
typealias ClientOrderStatusEventDTO = SharedClientOrderStatusEventDTO

// Delivery
typealias DeliveryVehiclePayload = SharedDeliveryVehicleDTO
typealias DeliveryZonePayload = SharedDeliveryZoneDTO
typealias DeliveryProfilePayload = SharedDeliveryProfileDTO
typealias DeliveryProfileUpdateRequest = SharedDeliveryProfileUpdateRequest
typealias DeliveryAvailabilitySlotPayload = SharedDeliveryAvailabilitySlotDTO
typealias DeliveryAvailabilityPayload = SharedDeliveryAvailabilityDTO
typealias DeliveryOrderItemPayload = SharedDeliveryOrderItemDTO
typealias DeliveryOrderPayload = SharedDeliveryOrderDTO
typealias DeliveryOrderStatusUpdateRequest = SharedDeliveryOrderStatusUpdateRequest
typealias DeliveryStateChangeRequest = SharedDeliveryStateChangeRequest
