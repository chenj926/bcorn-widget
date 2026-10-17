#!/usr/bin/env python3
"""Generate the bundled, explicitly synthetic picker preview (Pillow + Noto CJK)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
root = Path(__file__).resolve().parents[1]
im = Image.new('RGB', (700, 980), '#F4F7FB')
d = ImageDraw.Draw(im)
font_path = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
bold_path = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
def text(x, y, value, size=20, fill='#20354A', bold=False):
    d.text((x, y), value, font=ImageFont.truetype(bold_path if bold else font_path, size), fill=fill)
text(28, 22, 'bcorn · 本周课表', 32, bold=True)
text(28, 72, '示例预览 · 添加后显示你的本地课表', 19, '#586B7E')
left, top, bottom, col = 56, 154, 868, 122
for i, day in enumerate(['一', '二', '三', '四', '五']):
    text(left+i*col+43, 113, day, 21)
    d.line((left+i*col, top, left+i*col, bottom), fill='#DDE5EF', width=2)
for h in range(9, 18):
    y=top+(h-9)*(bottom-top)/8
    d.line((left,y,666,y), fill='#DDE5EF', width=2)
    text(15,y-14,str(h),17,'#687B90')
def block(day, start, end, title, detail, room, color, accent):
    x=left+day*col+3;y=top+(start-9)*(bottom-top)/8;end_y=top+(end-9)*(bottom-top)/8
    d.rounded_rectangle((x,y,x+col-7,end_y-4),radius=8,fill=color)
    d.rounded_rectangle((x,y+4,x+4,end_y-8),radius=2,fill=accent)
    text(x+10,y+12,title,21,bold=True)
    if end_y-y>80:text(x+10,y+45,detail,16)
    if end_y-y>125:text(x+10,y+71,room,16,'#586B7E')
block(0,9,11,'课程 A','09:00–11:00','示例教室','#DDEBFA','#397AB4')
block(1,12,14,'课程 B','12:00–14:00','示例教室','#DCEFE6','#48866C')
block(2,10,12,'课程 C','10:00–12:00','示例教室','#F7EBD7','#B28544')
block(3,14,16,'课程 D','14:00–16:00','示例教室','#ECE3F6','#9270B5')
block(4,11,12.5,'个人事项','单次 / 每周','','#E1EEF2','#5B8C9E')
text(28,896,'本地保存 · 关闭应用仍可查看',22)
text(28,932,'点按打开课表 · 桌面长按调整大小',18,'#586B7E')
out=root/'app/src/main/res/drawable-nodpi/widget_preview.png';out.parent.mkdir(parents=True,exist_ok=True)
im.save(out,optimize=True)
print(out)
