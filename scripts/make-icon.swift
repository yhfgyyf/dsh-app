import AppKit
import Foundation

let directory = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
for (name, pixels) in [("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64), ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512), ("icon_512x512", 512), ("icon_512x512@2x", 1024)] {
    let size = CGFloat(pixels)
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSColor(calibratedWhite: 0.12, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: size * 0.07, y: size * 0.07, width: size * 0.86, height: size * 0.86), xRadius: size * 0.19, yRadius: size * 0.19).fill()
    let text = "dsh" as NSString
    let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size * 0.32, weight: .semibold), .foregroundColor: NSColor(calibratedWhite: 0.94, alpha: 1), .kern: -size * 0.016]
    let textSize = text.size(withAttributes: attrs)
    text.draw(at: NSPoint(x: (size - textSize.width) / 2, y: (size - textSize.height) / 2 + size * 0.01), withAttributes: attrs)
    NSColor(calibratedWhite: 0.52, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: size * 0.4, y: size * 0.24, width: size * 0.2, height: size * 0.025), xRadius: size * 0.012, yRadius: size * 0.012).fill()
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: directory + "/" + name + ".png"))
}
