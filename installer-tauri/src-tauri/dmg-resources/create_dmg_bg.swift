import Cocoa

let W = 660
let H = 400

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
        0.106, 0.106, 0.188, 1.0,
        0.051, 0.051, 0.102, 1.0
    ],
    locations: [0.0, 1.0],
    count: 2
)!
g.drawLinearGradient(gradient,
    start: CGPoint(x: 0, y: CGFloat(H)),
    end: CGPoint(x: 0, y: 0),
    options: [])

let cx = CGFloat(W) / 2
let iconCgY: CGFloat = 225

// ── Subtle green glow behind icon ──
for r in stride(from: 60.0, through: 10.0, by: -4.0) {
    let a = 0.022 * (1.0 - r / 60.0)
    g.setFillColor(CGColor(red: 0.25, green: 0.83, blue: 0.41, alpha: CGFloat(a)))
    g.fillEllipse(in: CGRect(x: cx - CGFloat(r), y: iconCgY - CGFloat(r),
                              width: CGFloat(r) * 2, height: CGFloat(r) * 2))
}

// ── Small bright halo behind label text ──
// Moved up and made smaller per feedback
let labelCgY: CGFloat = 149
for r in stride(from: 35.0, through: 1.0, by: -1.0) {
    let t = 1.0 - r / 35.0
    let a = 0.15 * t * t * t
    g.setFillColor(CGColor(red: 0.8, green: 0.8, blue: 0.88, alpha: CGFloat(a)))
    let w = CGFloat(r) * 9.8
    let h = CGFloat(r) * 2.0
    g.fillEllipse(in: CGRect(x: cx - w / 2, y: labelCgY - h / 2, width: w, height: h))
}

// ── Text ──
func drawText(_ text: String, font: NSFont, color: NSColor, center: CGPoint) {
    let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
    let s = NSAttributedString(string: text, attributes: attrs)
    let sz = s.size()
    s.draw(in: CGRect(x: center.x - sz.width / 2, y: center.y - sz.height / 2,
                       width: sz.width, height: sz.height))
}

// "双击安装" — moved up 16px from previous
let titleFont = NSFont(name: "PingFangSC-Semibold", size: 20) ?? NSFont.boldSystemFont(ofSize: 20)
drawText("双击安装", font: titleFont, color: .white,
    center: CGPoint(x: cx, y: iconCgY + 81))

let subFont = NSFont(name: "PingFangSC-Regular", size: 11) ?? NSFont.systemFont(ofSize: 11)
drawText("Double click to install", font: subFont,
    color: NSColor(red: 0.67, green: 0.67, blue: 0.80, alpha: 0.8),
    center: CGPoint(x: cx, y: iconCgY + 60))

// Bottom hint
let hintFont = NSFont(name: "PingFangSC-Regular", size: 10) ?? NSFont.systemFont(ofSize: 10)
drawText("首次打开如被拦截 → 系统设置 → 隐私与安全性 → 仍要打开",
    font: hintFont,
    color: NSColor(red: 0.45, green: 0.45, blue: 0.55, alpha: 1.0),
    center: CGPoint(x: cx, y: 20))

// ── Save ──
NSGraphicsContext.current = nil
let png = rep.representation(using: .png, properties: [:])!
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "background.png"
try! png.write(to: URL(fileURLWithPath: out))
print("Created \(out) (\(W)x\(H))")
