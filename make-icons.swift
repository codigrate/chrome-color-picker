import AppKit

// Extension icons, drawn from the SAME drop as the Mac App Store app
// (macos-color-picker/make-icon.swift). One design across both products.
//
//   images/icon{16,48,128}.png — toolbar / extensions page icon
//   images/icon-1024.png       — master render
//   store/store-icon-128.png   — Chrome Web Store listing icon
//
// Run: swift make-icons.swift

func color(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> CGColor {
    CGColor(srgbRed: r, green: g, blue: b, alpha: a)
}

// Teardrop in the original 1024 design space: circle centre (512,430) r=210, apex (512,800).
// Bounding box is therefore x 302…722, y 220…800.
let dropBox = CGRect(x: 302, y: 220, width: 420, height: 580)

func dropPath() -> CGPath {
    let p = CGMutablePath()
    let cx = 512.0, cyc = 430.0, r = 210.0, apex = 800.0
    p.move(to: CGPoint(x: cx, y: apex))
    p.addCurve(to: CGPoint(x: cx + r, y: cyc),
               control1: CGPoint(x: cx + 90, y: apex - 110), control2: CGPoint(x: cx + r, y: cyc + 130))
    p.addArc(center: CGPoint(x: cx, y: cyc), radius: r, startAngle: 0, endAngle: .pi, clockwise: true)
    p.addCurve(to: CGPoint(x: cx, y: apex),
               control1: CGPoint(x: cx - r, y: cyc + 130), control2: CGPoint(x: cx - 90, y: apex - 110))
    p.closeSubpath()
    return p
}

/// Draws the spectrum drop, scaled so its bounding box fills `inset` of a 1024 canvas.
/// `squircle` adds the light macOS-style tile behind it.
func drawDrop(_ cg: CGContext, fill: Double, squircle: Bool) {
    if squircle {
        let bodyRect = CGRect(x: 40, y: 40, width: 944, height: 944)
        let body = CGPath(roundedRect: bodyRect, cornerWidth: 212, cornerHeight: 212, transform: nil)
        cg.saveGState()
        cg.addPath(body); cg.clip()
        let bg = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                            colors: [color(1, 1, 1), color(0.90, 0.93, 0.97)] as CFArray,
                            locations: [0, 1])!
        cg.drawLinearGradient(bg, start: CGPoint(x: 0, y: 984), end: CGPoint(x: 0, y: 40), options: [])
        cg.restoreGState()
    }

    // Scale the drop so its height covers `fill` of the canvas, centred.
    let s = 1024 * fill / dropBox.height
    let tx = 512 - 512 * s
    let ty = (1024 - dropBox.height * s) / 2 - dropBox.minY * s
    cg.saveGState()
    cg.translateBy(x: tx, y: ty)
    cg.scaleBy(x: s, y: s)

    let drop = dropPath()

    // White base + soft shadow (the thin rim + lift).
    cg.saveGState()
    cg.setShadow(offset: CGSize(width: 0, height: -14), blur: 30, color: color(0.10, 0.16, 0.28, 0.30))
    cg.addPath(drop); cg.setFillColor(color(1, 1, 1)); cg.fillPath()
    cg.restoreGState()

    // Spectrum fill, inset ~7% so a thin white rim shows.
    let centroid = CGPoint(x: 512, y: 486)
    var inset = CGAffineTransform.identity
        .translatedBy(x: centroid.x, y: centroid.y).scaledBy(x: 0.93, y: 0.93)
        .translatedBy(x: -centroid.x, y: -centroid.y)
    let innerDrop = drop.copy(using: &inset)!

    cg.saveGState()
    cg.addPath(innerDrop); cg.clip()
    let rad = 430.0, steps = 720
    for i in 0..<steps {
        let a1 = Double(i) / Double(steps) * 2 * .pi
        let a2 = Double(i + 2) / Double(steps) * 2 * .pi
        let ns = NSColor(hue: CGFloat(Double(i) / Double(steps)), saturation: 0.9, brightness: 1, alpha: 1)
        let wedge = CGMutablePath()
        wedge.move(to: centroid)
        wedge.addLine(to: CGPoint(x: centroid.x + rad * cos(a1), y: centroid.y + rad * sin(a1)))
        wedge.addLine(to: CGPoint(x: centroid.x + rad * cos(a2), y: centroid.y + rad * sin(a2)))
        wedge.closeSubpath()
        cg.addPath(wedge); cg.setFillColor(ns.cgColor); cg.fillPath()
    }
    let depth = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                           colors: [color(1, 1, 1, 0.16), color(0, 0, 0, 0), color(0, 0, 0, 0.16)] as CFArray,
                           locations: [0, 0.55, 1])!
    cg.addPath(innerDrop); cg.clip()
    cg.drawRadialGradient(depth, startCenter: centroid, startRadius: 0,
                          endCenter: centroid, endRadius: 300, options: [])
    cg.restoreGState()

    // Gloss highlight, upper-left of the drop.
    cg.saveGState()
    cg.addPath(innerDrop); cg.clip()
    let gloss = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                           colors: [color(1, 1, 1, 0.55), color(1, 1, 1, 0)] as CFArray, locations: [0, 1])!
    cg.drawRadialGradient(gloss, startCenter: CGPoint(x: 430, y: 640), startRadius: 0,
                          endCenter: CGPoint(x: 430, y: 640), endRadius: 180, options: [])
    cg.restoreGState()

    cg.restoreGState()
}

func render(fill: Double, squircle: Bool, to path: String) {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    let ctx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ctx
    ctx.cgContext.interpolationQuality = .high
    drawDrop(ctx.cgContext, fill: fill, squircle: squircle)
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
    print("wrote \(path)")
}

render(fill: 0.88, squircle: false, to: "images/icon-1024.png")   // toolbar icon master
render(fill: 0.74, squircle: false, to: "store/store-icon-1024.png") // Web Store listing (padded)
