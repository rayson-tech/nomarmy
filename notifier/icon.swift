// Draws notifier/nomarmy-icon.png: swift notifier/icon.swift notifier/nomarmy-icon.png
import AppKit
// nomArmy's robot (the "o" in the wordmark) on a macOS app-icon tile.
let size: CGFloat = 1024
let navy = NSColor(srgbRed: 0x0A/255, green: 0x20/255, blue: 0x30/255, alpha: 1)
let green = NSColor(srgbRed: 0x5B/255, green: 0xBC/255, blue: 0x6B/255, alpha: 1)
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
// Tile: Apple's icon grid, 824 of 1024 with a 185 corner radius.
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
NSGraphicsContext.current!.cgContext.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: NSColor.black.withAlphaComponent(0.25).cgColor)
NSColor.white.setFill(); NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185).fill()
NSGraphicsContext.current!.cgContext.setShadow(offset: .zero, blur: 0, color: nil)
// Head: a thick ring, centered a little low to leave room for the antenna.
let cx: CGFloat = 512, cy: CGFloat = 470, r: CGFloat = 250, ring: CGFloat = 58
navy.setStroke()
let head = NSBezierPath(ovalIn: NSRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r)); head.lineWidth = ring; head.stroke()
// Antenna: a stalk and a ball.
navy.setFill()
NSBezierPath(roundedRect: NSRect(x: cx - 18, y: cy + r, width: 36, height: 95), xRadius: 18, yRadius: 18).fill()
NSBezierPath(ovalIn: NSRect(x: cx - 48, y: cy + r + 75, width: 96, height: 96)).fill()
// Visor.
let visor = NSRect(x: cx - 175, y: cy - 95, width: 350, height: 190)
NSBezierPath(roundedRect: visor, xRadius: 95, yRadius: 95).fill()
// Eyes: happy upward arcs.
green.setStroke()
for ex in [cx - 82, cx + 82] {
  let eye = NSBezierPath(); eye.lineWidth = 30; eye.lineCapStyle = .round
  eye.appendArc(withCenter: NSPoint(x: ex, y: cy - 22), radius: 44, startAngle: 160, endAngle: 20, clockwise: true)
  eye.stroke()
}
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
