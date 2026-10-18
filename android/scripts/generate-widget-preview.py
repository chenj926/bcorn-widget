#!/usr/bin/env python3
"""Bundled synthetic picker preview; actual widget navigation is native RemoteViews."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
root = Path(__file__).resolve().parents[1]
im = Image.new('RGB', (700, 980), '#F4F7FB')
d = ImageDraw.Draw(im)
font_path = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
bold_path = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
def text(x, y, value, size=16, fill='#20354A', bold=False, anchor=None):
    d.text((x, y), value, font=ImageFont.truetype(bold_path if bold else font_path, size), fill=fill, anchor=anchor)
text(302, 23, '10/12–10/18', 24, bold=True, anchor='mt')
text(302, 66, '今天', 22, '#526B88', anchor='mt')
text(60, 28, '‹', 46, anchor='mt'); text(640, 28, '›', 46, anchor='mt')
text(544, 38, '切换日', 22, anchor='mt')
left, top, bottom, col = 62, 150, 934, 89
for i, day in enumerate(['一 12', '二 13', '三 14', '四 15', '五 16', '六 17', '日 18']):
    text(left+i*col+col/2, 115, day, 17, anchor='mt')
    d.line((left+i*col, top, left+i*col, bottom), fill='#DDE5EF', width=1)
for hour in range(9, 18):
    y=top+(hour-9)*(bottom-top)/8
    d.line((left,y,686,y), fill='#DDE5EF', width=1)
    text(16,y-10,str(hour),14,'#687B90')
def block(day, start, end, title, room, color, accent):
    x=left+day*col+3; y=top+(start-9)*(bottom-top)/8; end_y=top+(end-9)*(bottom-top)/8
    d.rounded_rectangle((x,y,x+col-6,end_y-3),radius=5,fill=color)
    d.rectangle((x,y+3,x+3,end_y-6),fill=accent)
    text(x+7,y+9,title,18,bold=True)
    if end_y-y>40:text(x+7,y+33,room,19,bold=True)
block(0,9,11,'ABC101','AB204','#E0EAF6','#397AB4')
block(1,12,14,'DEF202','CD105','#E0F0E8','#48866C')
block(2,10,12,'GHI303','EF301','#F7EBD7','#B28544')
block(3,14,16,'JKL404','GH112','#ECE3F6','#9270B5')
block(4,11,12.5,'MNO505','JK202','#E1EEF2','#5B8C9E')
block(6,13,14.5,'周末事项','LM104','#F4E3EB','#B54C7A')
text(12,954,'示例 · 添加后显示你的本地数据',16,'#66778A')
out=root/'app/src/main/res/drawable-nodpi/widget_preview.png'
im.save(out,optimize=True)
print(out)
