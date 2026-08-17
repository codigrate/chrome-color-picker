#!/usr/bin/env python3
"""Vector version of the Mac App Store Color Picker icon (the spectrum drop).

Same geometry as macos-color-picker/make-icon.swift, converted from that file's
y-up 1024 design space to SVG's y-down space and cropped to the drop.
"""
import colorsys, math, sys

# y-up design space: circle centre (512,430) r 210, apex (512,800) -> bbox x 302..722, y 220..800
def flip(p):           # y-up 1024 -> y-down, then shift bbox origin to 0,0
    return (p[0] - 302, (1024 - p[1]) - 224)

apex = flip((512, 800))
right = flip((722, 430))
left = flip((302, 430))
c1r, c2r = flip((602, 690)), flip((722, 560))
c1l, c2l = flip((302, 560)), flip((422, 690))
centroid = flip((512, 486))
gloss = flip((430, 640))

W, H = 420, 580
PAD = 80                      # square canvas so the logo never stretches in a square box
VB = (W + 2 * PAD, H)
OX = PAD

def n(v):
    return f"{v:.1f}".rstrip("0").rstrip(".")

def path(scale=1.0):
    """Drop outline; scale shrinks it about the spectrum centroid."""
    def s(p):
        return (centroid[0] + (p[0] - centroid[0]) * scale,
                centroid[1] + (p[1] - centroid[1]) * scale)
    a, r, l = s(apex), s(right), s(left)
    q1, q2, q3, q4 = s(c1r), s(c2r), s(c1l), s(c2l)
    rad = 210 * scale
    return (
        f"M{n(a[0])} {n(a[1])}"
        f"C{n(q1[0])} {n(q1[1])} {n(q2[0])} {n(q2[1])} {n(r[0])} {n(r[1])}"
        f"A{n(rad)} {n(rad)} 0 0 1 {n(l[0])} {n(l[1])}"
        f"C{n(q3[0])} {n(q3[1])} {n(q4[0])} {n(q4[1])} {n(a[0])} {n(a[1])}Z"
    )

drop = path()
inner = path(0.93)

STEPS = 240
RAD = 430
wedges = []
for i in range(STEPS):
    a1 = i / STEPS * 2 * math.pi
    a2 = (i + 1.6) / STEPS * 2 * math.pi
    r, g, b = colorsys.hsv_to_rgb(i / STEPS, 0.9, 1.0)
    hexc = "#%02X%02X%02X" % (round(r * 255), round(g * 255), round(b * 255))
    p1 = (centroid[0] + RAD * math.cos(a1), centroid[1] - RAD * math.sin(a1))
    p2 = (centroid[0] + RAD * math.cos(a2), centroid[1] - RAD * math.sin(a2))
    wedges.append(
        f'<path d="M{n(centroid[0])} {n(centroid[1])}L{n(p1[0])} {n(p1[1])}'
        f'L{n(p2[0])} {n(p2[1])}Z" fill="{hexc}"/>'
    )

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VB[0]} {VB[1]}" role="img" aria-label="Color Picker">
<defs>
<clipPath id="cp-clip"><path d="{inner}"/></clipPath>
<radialGradient id="cp-depth" gradientUnits="userSpaceOnUse" cx="{n(centroid[0])}" cy="{n(centroid[1])}" r="300">
<stop offset="0" stop-color="#FFFFFF" stop-opacity="0.16"/>
<stop offset="0.55" stop-color="#000000" stop-opacity="0"/>
<stop offset="1" stop-color="#000000" stop-opacity="0.16"/>
</radialGradient>
<radialGradient id="cp-gloss" gradientUnits="userSpaceOnUse" cx="{n(gloss[0])}" cy="{n(gloss[1])}" r="180">
<stop offset="0" stop-color="#FFFFFF" stop-opacity="0.55"/>
<stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
</radialGradient>
</defs>
<g transform="translate({OX} 0)">
<path d="{drop}" fill="#FFFFFF"/>
<g clip-path="url(#cp-clip)">
{''.join(wedges)}
<rect x="-40" y="-40" width="500" height="660" fill="url(#cp-depth)"/>
<rect x="-40" y="-40" width="500" height="660" fill="url(#cp-gloss)"/>
</g>
</g>
</svg>
'''

out = sys.argv[1] if len(sys.argv) > 1 else "color-picker-drop.svg"
open(out, "w").write(svg)
print("wrote", out, len(svg), "bytes")
