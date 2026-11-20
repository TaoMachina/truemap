"""Composes the README GIF from the frames record.mjs saves: camera moves, a moving cursor, captions and an end card.
Usage: python scripts/demo/compose.py [out.gif]   (default: docs/images/demo.gif)"""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
FR = HERE / '.work' / 'frames'
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'docs' / 'images' / 'demo.gif'
VW, VH = 1440, 900            # viewport in CSS px; sources are 2x
OW = 1200                     # output width
OH = round(OW * VH / VW)      # 750
BAND = 56
FONTS = str(ROOT / 'kit' / 'fonts')
CAP = ImageFont.truetype(FONTS + '/instrument-sans-latin-600-normal.woff2', 26)
SMALL = ImageFont.truetype(FONTS + '/instrument-sans-latin-500-normal.woff2', 17)
INK, PAPER, MUTED, BLUE = (24, 25, 29), (255, 255, 255), (150, 152, 160), (36, 83, 196)
MOVE = 0.06                   # seconds per motion frame

CAPTIONS = {
    1: 'A map of your code, in your repo.',
    2: 'Ask, and it explains on a page.',
    3: 'Each step links back to the map.',
    4: 'Ask for a change\u2026',
    5: '\u2026and the agent draws its plan first.',
    6: 'You approve.',
    7: 'Built. The map shows what changed.',
    8: 'One click to the diff.',
}
FULL = (0, 0, VW, VH)
def rect(x0, y0, w):           # a view with the output's aspect ratio
    return (x0, y0, w, w * VH / VW)
COMPOSER = rect(1010, 620, 430)
DRAFT = rect(10, 48, 1010)
MAP = rect(70, 55, 780)
DIFF = rect(930, 95, 510)
PANEL_TOP = rect(1000, 44, 440)

meta = json.loads((FR / 'frames.json').read_text())
src = {m['file'][3:-4] if not m['file'].endswith('-type.png') else m['file'][:-4]: m for m in meta}
cache = {}
def img(name):
    if name not in cache:
        m = next(x for x in meta if x['file'][:-4].endswith(name) or x['file'][:-4] == name)
        cache[name] = Image.open(FR / m['file']).convert('RGB')
    return cache[name]
def click_of(name):
    return next(x for x in meta if x['file'][:-4].endswith(name))['click']
types = lambda beat: [x['file'][:-4] for x in meta if x['file'].endswith(f'-{beat}-type.png')]

def cursor(d, x, y, s=1.0):
    pts = [(0, 0), (0, 21), (5.5, 16), (9.5, 24.5), (13, 23), (9.2, 14.8), (16, 14.8)]
    pts = [(x + px * s, y + py * s) for px, py in pts]
    d.polygon(pts, fill=(20, 20, 24), outline=(255, 255, 255))
    d.line(pts + [pts[0]], fill=(255, 255, 255), width=2)

def view(name, r, beat, cur=None, press=0.0, blend=None):
    """Render one output frame: crop the 2x source to view r (CSS px), add caption band, cursor and click ring."""
    x, y, w, h = r
    s = img(name)
    if blend:
        s = Image.blend(s, img(blend[0]), blend[1])
    crop = s.crop((round(x * 2), round(y * 2), round((x + w) * 2), round((y + h) * 2))).resize((OW, OH), Image.LANCZOS)
    out = Image.new('RGB', (OW, OH + BAND), INK)
    out.paste(crop, (0, BAND))
    d = ImageDraw.Draw(out)
    d.text((28, BAND / 2), CAPTIONS[beat], font=CAP, fill=PAPER, anchor='lm')
    d.text((OW - 28, BAND / 2), 'truemap', font=SMALL, fill=MUTED, anchor='rm')
    if cur:
        cx, cy = (cur[0] - x) * OW / w, (cur[1] - y) * OH / h + BAND
        if press:
            rr = 14 + 10 * press
            d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), outline=BLUE, width=4)
        cursor(d, cx, cy, 1.15)
    return out

ease = lambda t: t * t * (3 - 2 * t)
lerp = lambda a, b, t: tuple(p + (q - p) * t for p, q in zip(a, b))
seq = []
def hold(frame, secs): seq.append((frame, secs))
def zoom(name, a, b, beat, n=7, cur=None):
    for k in range(1, n + 1):
        hold(view(name, lerp(a, b, ease(k / n)), beat, cur), MOVE)
def glide(name, r, beat, p0, p1, n=9):
    for k in range(1, n + 1):
        hold(view(name, r, beat, lerp(p0, p1, ease(k / n))), MOVE)
    for pr in (0.3, 0.7, 1.0):
        hold(view(name, r, beat, p1, press=pr), MOVE)
def fade(a, b, r, beat, cur=None, n=3):
    for k in range(1, n + 1):
        hold(view(a, r, beat, cur, blend=(b, k / (n + 1))), MOVE)

# 1. the map, as you see it
hold(view('map', FULL, 1), 1.3)
zoom('map', FULL, MAP, 1, n=6)
hold(view('map', MAP, 1), 1.4)
# 2. ask: typing in the panel, then the draft page
zoom('map', MAP, FULL, 2, n=6)
hold(view('map', FULL, 2), 0.3)
zoom('map', FULL, COMPOSER, 2, n=7)
for t in types(2):
    hold(view(t, COMPOSER, 2), 0.09)
hold(view(types(2)[-1], COMPOSER, 2), 0.45)
fade(types(2)[-1], 'working', COMPOSER, 2)
zoom('working', COMPOSER, PANEL_TOP, 2, n=7)
hold(view('working', PANEL_TOP, 2), 1.3)
zoom('working', PANEL_TOP, FULL, 2, n=6)
hold(view('working', FULL, 2), 0.3)
fade('working', 'draft', FULL, 2)
hold(view('draft', FULL, 2), 0.7)
zoom('draft', FULL, DRAFT, 2)
hold(view('draft', DRAFT, 2), 3.0)
# 3. a step's link opens the map with that box lit
link = click_of('link-before')
glide('link-before', DRAFT, 3, (link['x'] + 160, link['y'] + 110), (link['x'], link['y']))
fade('link-before', 'linked', DRAFT, 3, cur=(link['x'], link['y']))
zoom('linked', DRAFT, MAP, 3, n=6)
hold(view('linked', MAP, 3), 2.0)
# 4. ask for a change
zoom('linked', MAP, FULL, 4, n=6)
hold(view('linked', FULL, 4), 0.3)
zoom('linked', FULL, COMPOSER, 4, n=7)
for t in types(4):
    hold(view(t, COMPOSER, 4), 0.09)
hold(view(types(4)[-1], COMPOSER, 4), 0.5)
zoom(types(4)[-1], COMPOSER, FULL, 4, n=6)
# 5. the plan, drawn on the map (the map is laid out again: cut, then move in)
hold(view('plan', FULL, 5), 0.9)
zoom('plan', FULL, MAP, 5)
hold(view('plan', MAP, 5), 2.6)
# 6. approve
ap = click_of('approve-before')
glide('approve-before', MAP, 6, (ap['x'] + 170, ap['y'] + 120), (ap['x'], ap['y']))
hold(view('approve-before', MAP, 6, (ap['x'], ap['y']), press=1.0), 0.35)
# 7. built: the new box lands where the plan drew it, with what changed
fade('approve-before', 'changes', MAP, 7, n=4)
hold(view('changes', MAP, 7), 2.0)
zoom('changes', MAP, FULL, 7)
hold(view('changes', FULL, 7), 1.4)
# 8. one click to the diff
row = click_of('row-before')
glide('row-before', FULL, 8, (row['x'] - 260, row['y'] - 200), (row['x'], row['y']))
fade('row-before', 'diff', FULL, 8, cur=(row['x'], row['y']))
zoom('diff', FULL, DIFF, 8)
hold(view('diff', DIFF, 8), 3.2)

# end card
def end_card():
    c = Image.new('RGB', (OW, OH + BAND), INK)
    d = ImageDraw.Draw(c)
    big = ImageFont.truetype(FONTS + '/instrument-sans-latin-600-normal.woff2', 64)
    mid = ImageFont.truetype(FONTS + '/instrument-sans-latin-500-normal.woff2', 30)
    mono = ImageFont.truetype(FONTS + '/commit-mono-latin-400-normal.woff2', 24)
    cx, cy = OW / 2, (OH + BAND) / 2
    word_w = d.textlength('truemap', font=big)
    mx = cx - (word_w + 70) / 2
    s = 3.0; ox, oy = mx, cy - 120
    tri = [(ox + 10 * s, oy + 2.2 * s), (ox + 15.6 * s, oy + 17.6 * s), (ox + 10 * s, oy + 14.4 * s), (ox + 4.4 * s, oy + 17.6 * s)]
    d.polygon(tri, fill=PAPER)
    d.polygon([(ox + 10 * s, oy + 2.2 * s), (ox + 10 * s, oy + 14.4 * s), (ox + 4.4 * s, oy + 17.6 * s)], fill=(88, 128, 230))
    d.text((mx + 70, cy - 92), 'truemap', font=big, fill=PAPER, anchor='lm')
    d.text((cx, cy - 6), 'A map of your code that your agent keeps true.', font=mid, fill=(220, 222, 228), anchor='mm')
    cmd = 'npx skills add TaoMachina/truemap --skill truemap'
    tw = d.textlength(cmd, font=mono)
    d.rounded_rectangle((cx - tw / 2 - 24, cy + 52, cx + tw / 2 + 24, cy + 108), radius=12, fill=(40, 42, 48), outline=(70, 72, 80))
    d.text((cx, cy + 80), cmd, font=mono, fill=PAPER, anchor='mm')
    return c
card = end_card()
last = seq[-1][0]
for k in (0.25, 0.5, 0.75):
    hold(Image.blend(last, card, k), MOVE)
hold(card, 2.8)

frames = [f for f, _ in seq]
durs = [max(20, round(t * 1000)) for _, t in seq]
idx = [i for i, (_, t) in enumerate(seq) if t >= 0.7]  # every held frame shapes the palette
sample = Image.new('RGB', (OW, frames[0].height * len(idx)))
for k, i in enumerate(idx):
    sample.paste(frames[i], (0, frames[0].height * k))
pal = sample.quantize(colors=200, method=Image.Quantize.MEDIANCUT)
q = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
q[0].save(OUT, save_all=True, append_images=q[1:], duration=durs, loop=0, optimize=True, disposal=1)
print(OUT, f'{OUT.stat().st_size / 1e6:.2f} MB', len(q), 'frames', f'{sum(durs) / 1000:.1f}s', f'{OW}x{OH + BAND}')
