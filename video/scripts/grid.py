# Draws a 100px grid (app CSS px) over a screenshot, for placing callouts: python3 scripts/grid.py name...
import sys
from PIL import Image, ImageDraw
for name in sys.argv[1:]:
    src = name if name.endswith('.png') else f'public/shots/{name}.png'
    im = Image.open(src).convert('RGB').resize((1440, 900))
    d = ImageDraw.Draw(im)
    for x in range(0, 1440, 100):
        d.line([(x, 0), (x, 900)], fill=(0, 150, 255), width=1)
        d.text((x + 2, 2), str(x), fill=(0, 90, 200))
    for y in range(0, 900, 100):
        d.line([(0, y), (1440, y)], fill=(255, 0, 120), width=1)
        d.text((2, y + 2), str(y), fill=(200, 0, 90))
    im.save(f'/private/tmp/claude-501/-Users-naim-Desktop-Inline/3c54fe52-5f27-45cb-a0c3-0edc35dc8048/scratchpad/g-{name.split("/")[-1].replace(".png","")}.png')
