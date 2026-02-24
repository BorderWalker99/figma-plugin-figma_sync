import Cocoa

let W = 660 * 2  // @2x retina
let H = 400 * 2

let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: W, pixelsHigh: H,
    bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: W * 4, bitsPerPixel: 32
)!

let ctx = NSGraphicsContext(bitmapImageRep: rep)!
NSGraphicsContext.current = ctx
let g = ctx.cgContext

// ── Background gradient ──
let gradient = CGGradient(
    colorSpace: CGColorSpaceCreateDeviceRGB(),
    colorComponents: [
        0.106, 0.106, 0.188, 1.0,  // #1B1B30
        0.051, 0.051, 0.102, 1.0   // #0D0D1A
    ],
    locations: [0.0, 1.0],
    count: 2
)!
g.drawLinearGradient(gradient,
    start: CGPoint(x: 0, y: CGFloat(H)),
    end: CGPoint(x: 0, y: 0),
    options: [])

// App icon position: (330, 210) in DMG point coords → (660, 420) in @2x pixels
// In CoreGraphics (origin bottom-left): (660, 800-420) = (660, 380)
let iconCx: CGFloat = 660
let iconCy: CGFloat = 380

// ── Subtle glow behind app icon ──
for radius in stride(from: 180.0, through: 20.0, by: -10.0) {
    let alpha = 0.018 * (1.0 - radius / 180.0)
    g.setFillColor(CGColor(red: 0.25, green: 0.83, blue: 0.41, alpha: CGFloat(alpha)))
    g.fillEllipse(in: CGRect(
        x: iconCx - CGFloat(radius),
        y: iconCy - CGFloat(radius),
        width: CGFloat(radius) * 2,
        height: CGFloat(radius) * 2
    ))
}

// ── Single curved arrow pointing directly at the app icon ──
let arrowColor = CGColor(red: 0.25, green: 0.83, blue: 0.41, alpha: 0.85)
g.setStrokeColor(arrowColor)
g.setLineWidth(5.0)
g.setLineCap(.round)

let arrowPath = CGMutablePath()
let startPt = CGPoint(x: iconCx - 300, y: iconCy + 200)
let ctrlPt  = CGPoint(x: iconCx - 180, y: iconCy - 20)
let endPt   = CGPoint(x: iconCx - 60,  y: iconCy + 30)
arrowPath.move(to: startPt)
arrowPath.addQuadCurve(to: endPt, control: ctrlPt)
g.addPath(arrowPath)
g.strokePath()

// Arrowhead
let headLen: CGFloat = 24
let t: CGFloat = 0.98
let tangentX = 2 * (1 - t) * (ctrlPt.x - startPt.x) + 2 * t * (endPt.x - ctrlPt.x)
let tangentY = 2 * (1 - t) * (ctrlPt.y - startPt.y) + 2 * t * (endPt.y - ctrlPt.y)
let angle = atan2(tangentY, tangentX)
let spread: CGFloat = .pi / 5.5

for a in [angle + .pi - spread, angle + .pi + spread] {
    let hx = endPt.x + headLen * cos(a)
    let hy = endPt.y + headLen * sin(a)
    g.move(to: endPt)
    g.addLine(to: CGPoint(x: hx, y: hy))
}
g.strokePath()

// ── Text rendering ──
func drawText(_ text: String, font: NSFont, color: NSColor, center: CGPoint) {
    let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: color
    ]
    let str = NSAttributedString(string: text, attributes: attrs)
    let size = str.size()
    let rect = CGRect(
        x: center.x - size.width / 2,
        y: center.y - size.height / 2,
        width: size.width,
        height: size.height
    )
    str.draw(in: rect)
}

// "双击安装" - main title above the icon
let titleFont = NSFont(name: "PingFangSC-Semibold", size: 52) ?? NSFont.boldSystemFont(ofSize: 52)
drawText("双击安装",
    font: titleFont,
    color: NSColor.white,
    center: CGPoint(x: CGFloat(W) / 2, y: CGFloat(H) - 120))

// English subtitle
let subFont = NSFont(name: "PingFangSC-Regular", size: 26) ?? NSFont.systemFont(ofSize: 26)
drawText("Double click to install",
    font: subFont,
    color: NSColor(red: 0.67, green: 0.67, blue: 0.80, alpha: 1.0),
    center: CGPoint(x: CGFloat(W) / 2, y: CGFloat(H) - 185))

// Bottom hint — accurate instructions for all macOS versions
let hintFont = NSFont(name: "PingFangSC-Regular", size: 19) ?? NSFont.systemFont(ofSize: 19)
drawText("首次打开如被拦截 → 系统设置 → 隐私与安全性 → 仍要打开",
    font: hintFont,
    color: NSColor(red: 0.45, green: 0.45, blue: 0.55, alpha: 1.0),
    center: CGPoint(x: CGFloat(W) / 2, y: 50))

// ── Save ──
NSGraphicsContext.current = nil
let pngData = rep.representation(using: .png, properties: [:])!
let outPath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "background.png"
try! pngData.write(to: URL(fileURLWithPath: outPath))
print("Created \(outPath) (\(W)x\(H))")
