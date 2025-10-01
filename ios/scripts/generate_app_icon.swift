#!/usr/bin/env swift

import Foundation
#if os(macOS)
import AppKit
#else
fputs("[Branding] ERROR: generate_app_icon.swift solo puede ejecutarse en macOS.\n", stderr)
exit(1)
#endif

struct Options {
    var brandId: String
    var outputDirectory: URL
    var brandingJSON: URL?
    var displayName: String?
    var brandName: String?
}

enum IconContent {
    case logo(CGImage)
    case placeholder(String)
}

struct BrandingPayload {
    var appName: String?
    var palettePrimary: String?
    var paletteOnPrimary: String?
    var logoURL: String?
    var logoMimeType: String?
}

struct IconSpec {
    let idiom: String
    let pointSize: Double
    let scale: Int
    let filename: String
}

let iconSpecs: [IconSpec] = [
    IconSpec(idiom: "iphone", pointSize: 20, scale: 2, filename: "AppIcon-iphone-20@2x.png"),
    IconSpec(idiom: "iphone", pointSize: 20, scale: 3, filename: "AppIcon-iphone-20@3x.png"),
    IconSpec(idiom: "iphone", pointSize: 29, scale: 2, filename: "AppIcon-iphone-29@2x.png"),
    IconSpec(idiom: "iphone", pointSize: 29, scale: 3, filename: "AppIcon-iphone-29@3x.png"),
    IconSpec(idiom: "iphone", pointSize: 40, scale: 2, filename: "AppIcon-iphone-40@2x.png"),
    IconSpec(idiom: "iphone", pointSize: 40, scale: 3, filename: "AppIcon-iphone-40@3x.png"),
    IconSpec(idiom: "iphone", pointSize: 60, scale: 2, filename: "AppIcon-iphone-60@2x.png"),
    IconSpec(idiom: "iphone", pointSize: 60, scale: 3, filename: "AppIcon-iphone-60@3x.png"),
    IconSpec(idiom: "ipad", pointSize: 20, scale: 1, filename: "AppIcon-ipad-20@1x.png"),
    IconSpec(idiom: "ipad", pointSize: 20, scale: 2, filename: "AppIcon-ipad-20@2x.png"),
    IconSpec(idiom: "ipad", pointSize: 29, scale: 1, filename: "AppIcon-ipad-29@1x.png"),
    IconSpec(idiom: "ipad", pointSize: 29, scale: 2, filename: "AppIcon-ipad-29@2x.png"),
    IconSpec(idiom: "ipad", pointSize: 40, scale: 1, filename: "AppIcon-ipad-40@1x.png"),
    IconSpec(idiom: "ipad", pointSize: 40, scale: 2, filename: "AppIcon-ipad-40@2x.png"),
    IconSpec(idiom: "ipad", pointSize: 76, scale: 1, filename: "AppIcon-ipad-76@1x.png"),
    IconSpec(idiom: "ipad", pointSize: 76, scale: 2, filename: "AppIcon-ipad-76@2x.png"),
    IconSpec(idiom: "ipad", pointSize: 83.5, scale: 2, filename: "AppIcon-ipad-83.5@2x.png"),
    IconSpec(idiom: "ios-marketing", pointSize: 1024, scale: 1, filename: "AppIcon-marketing-1024@1x.png"),
]

let maxLogoBytes = 512 * 1024
let allowedMimeTypes: Set<String> = ["image/png", "image/jpeg", "image/jpg"]

struct CLIError: Error {
    let message: String
}

func parseArguments() throws -> Options {
    var args = CommandLine.arguments.dropFirst()
    var brandId: String?
    var outputDirectory: URL?
    var brandingJSON: URL?
    var displayName: String?
    var brandName: String?

    func popValue() throws -> String {
        guard let value = args.first else {
            throw CLIError(message: "Falta un valor para el parámetro anterior")
        }
        args = args.dropFirst()
        return value
    }

    while let argument = args.first {
        args = args.dropFirst()
        switch argument {
        case "--brand-id":
            brandId = try popValue()
        case "--output":
            let path = try popValue()
            outputDirectory = URL(fileURLWithPath: path)
        case "--branding-json":
            let path = try popValue()
            brandingJSON = URL(fileURLWithPath: path)
        case "--display-name":
            displayName = try popValue()
        case "--brand-name":
            brandName = try popValue()
        default:
            throw CLIError(message: "Parámetro desconocido: " + argument)
        }
    }

    guard let finalBrandId = brandId, !finalBrandId.isEmpty else {
        throw CLIError(message: "--brand-id es obligatorio")
    }
    guard let finalOutput = outputDirectory else {
        throw CLIError(message: "--output es obligatorio")
    }

    return Options(
        brandId: finalBrandId,
        outputDirectory: finalOutput,
        brandingJSON: brandingJSON,
        displayName: displayName,
        brandName: brandName
    )
}

func loadBranding(from url: URL) -> BrandingPayload? {
    if !FileManager.default.fileExists(atPath: url.path) {
        return nil
    }
    guard let data = try? Data(contentsOf: url) else {
        fputs("[Branding] WARNING: No se pudo leer " + url.path + "\n", stderr)
        return nil
    }
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        fputs("[Branding] WARNING: JSON inválido en " + url.path + "\n", stderr)
        return nil
    }
    let payload = (json["payload"] as? [String: Any]) ?? [:]
    let images = (payload["images"] as? [String: Any]) ?? [:]
    let logo = (images["logo"] as? [String: Any]) ?? [:]
    let palette = (payload["palette"] as? [String: Any]) ?? [:]

    return BrandingPayload(
        appName: payload["appName"] as? String,
        palettePrimary: palette["primary"] as? String,
        paletteOnPrimary: palette["onPrimary"] as? String,
        logoURL: logo["url"] as? String,
        logoMimeType: logo["mimeType"] as? String
    )
}

func parseColor(_ value: String) -> NSColor? {
    let sanitized = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if !sanitized.hasPrefix("#") {
        return nil
    }
    let hex = String(sanitized.dropFirst())
    if hex.count == 6, let intVal = UInt32(hex, radix: 16) {
        let r = CGFloat((intVal >> 16) & 0xFF) / 255.0
        let g = CGFloat((intVal >> 8) & 0xFF) / 255.0
        let b = CGFloat(intVal & 0xFF) / 255.0
        return NSColor(calibratedRed: r, green: g, blue: b, alpha: 1.0)
    }
    if hex.count == 8, let intVal = UInt32(hex, radix: 16) {
        let a = CGFloat((intVal >> 24) & 0xFF) / 255.0
        let r = CGFloat((intVal >> 16) & 0xFF) / 255.0
        let g = CGFloat((intVal >> 8) & 0xFF) / 255.0
        let b = CGFloat(intVal & 0xFF) / 255.0
        return NSColor(calibratedRed: r, green: g, blue: b, alpha: a)
    }
    return nil
}

func stableHash(_ value: String) -> UInt32 {
    var hash: UInt32 = 2166136261
    for byte in value.utf8 {
        hash ^= UInt32(byte)
        hash = hash &* 16777619
    }
    return hash
}

func deriveColor(from seed: String) -> NSColor {
    let hash = stableHash(seed)
    let hue = CGFloat(hash % 360) / 360.0
    let saturation: CGFloat = 0.55
    let brightness: CGFloat = 0.85
    return NSColor(calibratedHue: hue, saturation: saturation, brightness: brightness, alpha: 1.0)
}

func choosePlaceholderTextColor(for background: NSColor) -> NSColor {
    guard let rgb = background.usingColorSpace(.deviceRGB) else {
        return NSColor.white
    }
    let luminance = (0.299 * rgb.redComponent + 0.587 * rgb.greenComponent + 0.114 * rgb.blueComponent)
    if luminance < 0.6 {
        return NSColor.white
    }
    return NSColor(calibratedRed: 34.0 / 255.0, green: 43.0 / 255.0, blue: 69.0 / 255.0, alpha: 1.0)
}

func computeInitials(displayName: String, fallback: String) -> String {
    let tokens = displayName.components(separatedBy: CharacterSet.whitespacesAndNewlines).filter { !$0.isEmpty }
    if !tokens.isEmpty {
        var initials = ""
        for token in tokens.prefix(2) {
            if let first = token.first {
                initials += String(first).uppercased()
            }
        }
        if !initials.isEmpty {
            return initials
        }
    }
    return String(fallback.prefix(2)).uppercased()
}

func cgImage(from image: NSImage) -> CGImage? {
    var rect = CGRect(origin: .zero, size: image.size)
    return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

func createBaseImage(background: NSColor, content: IconContent) throws -> NSImage {
    let size = NSSize(width: 1024, height: 1024)
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: Int(size.width),
        pixelsHigh: Int(size.height),
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        throw CLIError(message: "No se pudo crear el buffer de ícono base")
    }
    bitmap.size = size

    NSGraphicsContext.saveGraphicsState()
    guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        NSGraphicsContext.restoreGraphicsState()
        throw CLIError(message: "No se pudo inicializar el contexto gráfico")
    }
    NSGraphicsContext.current = context
    context.cgContext.interpolationQuality = .high
    context.cgContext.setShouldAntialias(true)

    background.setFill()
    NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()

    switch content {
    case .logo(let cgImage):
        let logoWidth = CGFloat(cgImage.width)
        let logoHeight = CGFloat(cgImage.height)
        let maxContent = size.width * 0.76
        let scale = min(maxContent / logoWidth, maxContent / logoHeight)
        let targetWidth = max(1.0, logoWidth * scale)
        let targetHeight = max(1.0, logoHeight * scale)
        let originX = (size.width - targetWidth) / 2.0
        let originY = (size.height - targetHeight) / 2.0
        let rect = CGRect(x: originX, y: originY, width: targetWidth, height: targetHeight)
        context.cgContext.draw(cgImage, in: rect)
    case .placeholder(let text):
        let textColor = choosePlaceholderTextColor(for: background)
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let fontSize = size.width * 0.48
        let font = NSFont.systemFont(ofSize: fontSize, weight: .bold)
        let attributes: [NSAttributedString.Key: Any] = [
            .foregroundColor: textColor,
            .font: font,
            .paragraphStyle: paragraph,
        ]
        let attributed = NSAttributedString(string: text, attributes: attributes)
        let textSize = attributed.size()
        let rect = NSRect(
            x: (size.width - textSize.width) / 2.0,
            y: (size.height - textSize.height) / 2.0,
            width: textSize.width,
            height: textSize.height
        )
        attributed.draw(in: rect)
    }

    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()

    let image = NSImage(size: size)
    image.addRepresentation(bitmap)
    return image
}

func resize(image: NSImage, toPixels pixels: Int) throws -> NSImage {
    let size = NSSize(width: pixels, height: pixels)
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixels,
        pixelsHigh: pixels,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        throw CLIError(message: "No se pudo crear el buffer para redimensionar a " + String(pixels) + " px")
    }
    bitmap.size = size

    NSGraphicsContext.saveGraphicsState()
    guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        NSGraphicsContext.restoreGraphicsState()
        throw CLIError(message: "No se pudo inicializar el contexto para redimensionar")
    }
    NSGraphicsContext.current = context
    context.cgContext.interpolationQuality = .high

    let rect = NSRect(origin: .zero, size: size)
    image.draw(in: rect, from: NSRect(origin: .zero, size: image.size), operation: .copy, fraction: 1.0)

    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()

    let result = NSImage(size: size)
    result.addRepresentation(bitmap)
    return result
}

func writePNG(_ image: NSImage, to url: URL) throws {
    guard let tiff = image.tiffRepresentation else {
        throw CLIError(message: "No se pudo obtener representación TIFF para " + url.lastPathComponent)
    }
    guard let rep = NSBitmapImageRep(data: tiff) else {
        throw CLIError(message: "No se pudo crear representación bitmap para " + url.lastPathComponent)
    }
    guard let png = rep.representation(using: .png, properties: [:]) else {
        throw CLIError(message: "No se pudo serializar PNG para " + url.lastPathComponent)
    }
    try png.write(to: url)
}

func sanitizeURL(_ raw: String) -> URL? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
        return nil
    }
    if let url = URL(string: trimmed), url.scheme != nil {
        return url
    }
    return URL(fileURLWithPath: trimmed)
}

func downloadLogo(from url: URL, declaredMime: String?) -> (data: Data, mime: String)? {
    if url.isFileURL {
        guard let data = try? Data(contentsOf: url, options: [.mappedIfSafe]) else {
            fputs("[Branding] WARNING: No se pudo leer el logo local en " + url.path + "\n", stderr)
            return nil
        }
        let mime = declaredMime?.lowercased() ?? "image/png"
        return (data, mime)
    }

    let semaphore = DispatchSemaphore(value: 0)
    var result: (data: Data, mime: String)?
    var failure: String?

    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 10
    config.timeoutIntervalForResource = 10
    let session = URLSession(configuration: config)
    var request = URLRequest(url: url)
    request.setValue("IntraleBranding/1.0", forHTTPHeaderField: "User-Agent")

    let task = session.dataTask(with: request) { data, response, error in
        defer { semaphore.signal() }
        if let error = error {
            failure = error.localizedDescription
            return
        }
        guard let http = response as? HTTPURLResponse else {
            failure = "Respuesta inválida"
            return
        }
        if !(200...299).contains(http.statusCode) {
            failure = "HTTP " + String(http.statusCode)
            return
        }
        guard let data = data else {
            failure = "Sin cuerpo de respuesta"
            return
        }
        if data.count > maxLogoBytes {
            failure = "El logo supera los " + String(maxLogoBytes / 1024) + " KB permitidos"
            return
        }
        let contentTypeHeader = http.value(forHTTPHeaderField: "Content-Type")?.lowercased()
        var contentType: String? = nil
        if let header = contentTypeHeader {
            contentType = header.split(separator: ";").first.map { String($0) }
        }
        let mime = declaredMime?.lowercased() ?? contentType ?? "image/png"
        result = (data, mime)
    }
    task.resume()
    semaphore.wait()
    session.invalidateAndCancel()

    if let failure = failure {
        fputs("[Branding] WARNING: No se pudo descargar el logo desde " + url.absoluteString + ". " + failure + "\n", stderr)
        return nil
    }

    return result
}

func isSupportedMime(_ mime: String?) -> Bool {
    guard let mime = mime?.lowercased() else {
        return true
    }
    if mime == "image/svg+xml" {
        return false
    }
    return allowedMimeTypes.contains(mime)
}

func generateContentsJSON(for specs: [IconSpec]) throws -> Data {
    var images: [[String: Any]] = []
    for spec in specs {
        let sizeString = String(format: "%g", spec.pointSize)
        images.append([
            "idiom": spec.idiom,
            "size": sizeString + "x" + sizeString,
            "scale": String(spec.scale) + "x",
            "filename": spec.filename,
        ])
    }
    let payload: [String: Any] = [
        "images": images,
        "info": [
            "version": 1,
            "author": "xcode",
        ],
    ]
    return try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
}

func ensureDirectory(_ url: URL) throws {
    if FileManager.default.fileExists(atPath: url.path) {
        try FileManager.default.removeItem(at: url)
    }
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: nil)
}

func main() -> Int32 {
    do {
        let options = try parseArguments()
        let branding = options.brandingJSON.flatMap(loadBranding)

        let displayName = options.displayName?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            ?? branding?.appName?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            ?? options.brandName?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            ?? options.brandId

        let logoURL = branding?.logoURL.flatMap(sanitizeURL)
        let logoMime = branding?.logoMimeType?.lowercased()

        var placeholderReason: String? = nil
        var logoImage: CGImage? = nil

        if let url = logoURL {
            if let mime = logoMime, mime == "image/svg+xml" {
                placeholderReason = "El logo es SVG y no se puede rasterizar automáticamente."
            } else if !isSupportedMime(logoMime) {
                let mimeDesc = logoMime ?? "desconocido"
                placeholderReason = "El MIME type " + mimeDesc + " no está permitido."
            } else if let download = downloadLogo(from: url, declaredMime: logoMime) {
                let effectiveMime = download.mime.lowercased()
                if !allowedMimeTypes.contains(effectiveMime) {
                    placeholderReason = "El MIME type " + effectiveMime + " no está permitido."
                } else if download.data.count > maxLogoBytes {
                    placeholderReason = "El logo supera los " + String(maxLogoBytes / 1024) + " KB permitidos."
                } else if let image = NSImage(data: download.data), let cg = cgImage(from: image) {
                    logoImage = cg
                } else {
                    placeholderReason = "No se pudo decodificar el logo remoto."
                }
            }
        } else {
            placeholderReason = "No se encontró referencia de logo en el branding."
        }

        let baseColor: NSColor
        if let primary = branding?.palettePrimary, let parsed = parseColor(primary) {
            baseColor = parsed
        } else {
            let seedBase = displayName.nonEmpty ?? options.brandId
            let suffix = (logoImage == nil) ? "placeholder" : "logo"
            baseColor = deriveColor(from: seedBase + suffix)
        }

        let content: IconContent
        if let logo = logoImage {
            content = .logo(logo)
            if let url = logoURL {
                print("[Branding] Ícono generado con logo remoto: " + url.absoluteString)
            }
        } else {
            let initials = computeInitials(displayName: displayName, fallback: options.brandId)
            content = .placeholder(initials)
            if let reason = placeholderReason {
                fputs("[Branding] WARNING: Se usará placeholder para el ícono de " + options.brandId + ". " + reason + "\n", stderr)
            }
        }

        try ensureDirectory(options.outputDirectory)

        let baseImage = try createBaseImage(background: baseColor, content: content)

        for spec in iconSpecs {
            let pixels = Int(round(spec.pointSize * Double(spec.scale)))
            let resized = try resize(image: baseImage, toPixels: pixels)
            let targetURL = options.outputDirectory.appendingPathComponent(spec.filename)
            try writePNG(resized, to: targetURL)
            print("[Branding] Ícono generado: " + spec.filename + " (" + String(pixels) + "x" + String(pixels) + ")")
        }

        let contentsData = try generateContentsJSON(for: iconSpecs)
        let contentsURL = options.outputDirectory.appendingPathComponent("Contents.json")
        try contentsData.write(to: contentsURL)
        print("[Branding] Contents.json actualizado en " + contentsURL.path)

        return 0
    } catch let error as CLIError {
        fputs("[Branding] ERROR: " + error.message + "\n", stderr)
        return 1
    } catch {
        fputs("[Branding] ERROR: " + error.localizedDescription + "\n", stderr)
        return 1
    }
}

extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

exit(main())
