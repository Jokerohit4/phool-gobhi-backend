"""Original SVG schematics for remaining catalogue movements, plus GIF/JPG exports.

These are explicitly labelled pose references, not filmed or interpolated motion.
Geometry is authored from exercise definitions, not traced from third-party artwork.
The SVG sources are retained and every exported frame is available for review.
"""
import copy
import hashlib
import html
import json
import math
from pathlib import Path
import re
import tempfile
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT.parents[1] / 'docs/exercise-dev'
ART = ROOT / 'prisma/sources/phool-gobhi-pose-art'
CACHE = Path(tempfile.gettempdir()) / 'exercise-pose-references'
OUTPUT = CACHE / 'pose-references'
FONT = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 16)
SMALL = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 12)


class Canvas:
    def __init__(self):
        self.image = Image.new('RGB', (360, 400), '#f5f9f8')
        self.draw = ImageDraw.Draw(self.image)
        self.svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="360" height="400" viewBox="0 0 360 400">', '<rect width="360" height="400" fill="#f5f9f8"/>']

    def line(self, points, color='#285d58', width=3):
        points = [(int(x), int(y + 36)) for x, y in points]
        self.draw.line(points, fill=color, width=width, joint='curve')
        self.svg.append('<polyline points="' + ' '.join(f'{x},{y}' for x, y in points) + f'" fill="none" stroke="{color}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"/>')

    def circle(self, center, radius, fill='#d4e7e2', outline='#285d58', width=2):
        x, y = center[0], center[1] + 36
        self.draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=fill, outline=outline, width=width)
        self.svg.append(f'<circle cx="{x}" cy="{y}" r="{radius}" fill="{fill or "none"}" stroke="{outline or "none"}" stroke-width="{width}"/>')

    def rect(self, box, fill='#d9e2e1', outline='#647b78', width=2):
        x1, y1, x2, y2 = box
        self.draw.rectangle((x1,y1+36,x2,y2+36),fill=fill,outline=outline,width=width)
        self.svg.append(f'<rect x="{x1}" y="{y1+36}" width="{x2-x1}" height="{y2-y1}" fill="{fill}" stroke="{outline}" stroke-width="{width}"/>')

    def polygon(self, points, fill='#c1ddd5', outline='#285d58'):
        shifted = [(x,y+36) for x,y in points]
        self.draw.polygon(shifted,fill=fill,outline=outline)
        self.svg.append('<polygon points="'+' '.join(f'{x},{y}' for x,y in shifted)+f'" fill="{fill}" stroke="{outline}" stroke-width="2"/>')

    def label(self, value, y=5, large=False):
        self.draw.text((10,y),value,fill='#174b40',font=FONT if large else SMALL)
        self.svg.append(f'<text x="10" y="{y+14}" fill="#174b40" font-family="Arial,sans-serif" font-size="{16 if large else 12}">{html.escape(value)}</text>')

    def finish(self):
        return '\n'.join(self.svg + ['</svg>']) + '\n'


def front():
    return dict(head=(180,95),neck=(180,115),sl=(155,130),sr=(205,130),el=(145,180),er=(215,180),wl=(142,232),wr=(218,232),hl=(163,215),hr=(197,215),kl=(160,270),kr=(200,270),al=(155,325),ar=(205,325),tl=(140,330),tr=(220,330))


def side():
    return dict(head=(195,95),neck=(195,115),sl=(187,130),sr=(200,130),el=(185,180),er=(205,180),wl=(182,232),wr=(208,232),hl=(188,215),hr=(200,215),kl=(190,270),kr=(202,270),al=(190,325),ar=(202,325),tl=(213,330),tr=(225,330))


def change(pose, **positions):
    result = copy.deepcopy(pose); result.update(positions); return result


def shift(pose, dx=0, dy=0):
    return {key:(x+dx,y+dy) for key,(x,y) in pose.items()}


def person(canvas, pose):
    p = pose
    for a,b,c in [('hr','kr','ar'),('sr','er','wr'),('hl','kl','al'),('sl','el','wl')]:
        canvas.line([p[a],p[b],p[c]],'#4f8580' if a.endswith('r') else '#285d58',9)
        canvas.circle(p[b],4,fill='#d4e7e2',outline='#285d58',width=1)
    canvas.polygon([p['sl'],p['sr'],p['hr'],p['hl']])
    canvas.line([p['neck'],p['sl']],width=6);canvas.line([p['neck'],p['sr']],width=6)
    canvas.line([p['neck'],p['head']],width=7)
    canvas.circle(p['head'],14)
    canvas.line([p['al'],p['tl']],width=7);canvas.line([p['ar'],p['tr']],width=7)
    for hand in ['wl','wr']:canvas.circle(p[hand],4,fill='#d4e7e2',outline='#285d58',width=1)


def dumbbell(c, point):
    x,y=point;c.line([(x-13,y),(x+13,y)],'#3d4648',4)
    c.rect((x-17,y-8,x-10,y+8),'#647174','#3d4648');c.rect((x+10,y-8,x+17,y+8),'#647174','#3d4648')


def kettlebell(c, point):
    x,y=point;c.circle((x,y+11),10,'#6b7e83','#354c52');c.circle((x,y+1),6,None,'#354c52',3)


def ground(c):c.line([(15,334),(345,334)],'#a3b7b1',2)
def bench(c):c.rect((60,225,225,236));c.line([(80,236),(80,332)],'#647b78',5);c.line([(205,236),(205,332)],'#647b78',5)
def wall(c):c.rect((280,35,291,334),'#e4ece8','#a3b7b1')
def step(c):c.rect((130,285,260,334),'#d5e3df','#647b78')


def supine():
    return dict(head=(65,275),neck=(85,280),sl=(105,278),sr=(110,285),el=(120,225),er=(135,225),wl=(125,172),wr=(140,172),hl=(195,280),hr=(205,287),kl=(235,215),kr=(255,282),al=(285,215),ar=(315,285),tl=(298,217),tr=(330,285))


def squat():
    return change(front(),head=(180,155),neck=(180,175),sl=(155,190),sr=(205,190),hl=(155,266),hr=(205,266),kl=(125,275),kr=(235,275),al=(135,325),ar=(225,325),tl=(120,330),tr=(240,330),el=(140,225),er=(220,225),wl=(170,210),wr=(190,210))


def lunge():
    return change(side(),head=(195,145),neck=(195,165),sl=(187,180),sr=(200,180),hl=(188,250),hr=(200,250),kl=(140,315),kr=(257,275),al=(100,305),ar=(257,325),tl=(115,330),tr=(282,330),el=(175,220),er=(220,220),wl=(165,263),wr=(230,263))


def seated():
    return change(side(),head=(160,135),neck=(160,155),sl=(153,170),sr=(166,170),hl=(155,265),hr=(168,265),kl=(228,290),kr=(240,296),al=(300,295),ar=(312,301),tl=(300,275),tr=(312,281),el=(195,200),er=(205,207),wl=(230,240),wr=(242,247))


def quad():
    return dict(head=(90,180),neck=(110,190),sl=(130,200),sr=(143,205),el=(125,250),er=(147,255),wl=(120,300),wr=(150,305),hl=(225,205),hr=(238,210),kl=(225,295),kr=(238,300),al=(290,305),ar=(303,310),tl=(302,308),tr=(315,313))


def frame(pose, cue, props=None, hands=None):
    return {'pose':pose,'cue':cue,'props':props or [],'hands':hands or {}}


def walking(cycle=0, running=False):
    p=side()
    if not running:
        legs=[((165,265),(120,320),(140,328)),((220,265),(260,320),(280,328))]
    else:
        legs=[((150,250),(105,230),(122,237)),((245,230),(280,282),(301,285))]
    if cycle:legs.reverse()
    p.update(kl=legs[0][0],al=legs[0][1],tl=legs[0][2],kr=legs[1][0],ar=legs[1][1],tr=legs[1][2])
    p.update(el=(155 if cycle else 225,165),wl=(125 if cycle else 255,145),er=(225 if cycle else 155,165),wr=(255 if cycle else 125,145))
    return p


def build_specs():
    specs={}
    def add(name,frames,definition):specs[name]={'frames':frames,'definition':definition}
    for name in ['Running','Jogging']:
        passing=change(side(),kl=(185,270),al=(185,325),tl=(205,330),kr=(230,265),ar=(195,250),tr=(175,250))
        add(name,[frame(walking(0,True),'Alternate arm and leg positions'),frame(passing,'Pass the support foot under the body'),frame(walking(1,True),'Keep the torso tall')],'Alternating running gait with a passing position and flight phase; no machine or external load.')
    add('Brisk Walking',[frame(walking(0),'Step forward; opposite arm swings'),frame(walking(1),'Keep one foot in contact with ground')],'Brisk overground walking; alternating heel-to-toe steps, upright torso.')
    add('March in Place',[frame(side(),'Stand tall'),frame(change(side(),kr=(260,213),ar=(260,270),tr=(282,274)),'Raise one knee; stay in place'),frame(side(),'Return the foot to the floor'),frame(change(side(),kl=(250,213),al=(250,270),tl=(272,274)),'Alternate knees')],'Unloaded in-place march with alternating hip flexion and a planted support foot.')
    add('Standing Knee Drive',[frame(side(),'Stand tall with a stable support leg'),frame(change(side(),kr=(260,213),ar=(260,270),tr=(282,274)),'Drive the knee up; control the return')],'Standing unloaded knee drive to approximately hip height; torso remains upright.')
    add('High Knees',[frame(change(side(),kr=(255,205),ar=(255,265),tr=(277,270),kl=(170,280),al=(145,225),tl=(128,225)),'Drive one knee toward hip height'),frame(side(),'Return beneath the hips'),frame(change(side(),kl=(250,205),al=(250,265),tl=(272,270),kr=(175,280),ar=(150,225),tr=(133,225)),'Alternate knees in place')],'In-place high-knee running, unlike a travelling drill. No dumbbells.')
    p=side();q=change(p,kr=(220,275),ar=(173,238),tr=(155,235))
    add('Butt Kick',[frame(q,'Bring one heel toward the glute'),frame(change(p,kl=(178,275),al=(220,238),tl=(238,235)),'Alternate heels in place')],'In-place alternating heel-to-glute running drill; knees remain beneath the hips.')
    p=change(front(),al=(145,315),ar=(215,325),tl=(128,320),tr=(231,330));q=change(p,al=(145,325),ar=(215,315),tl=(128,330),tr=(231,320))
    add('Fast Feet',[frame(p,'Use short, quick steps in place'),frame(q,'Alternate foot contacts; soft knees')],'Quick short alternating steps in place without an agility ladder or travelling.')
    for name in ['Reverse Lunge','Step-Back Lunge']:
        add(name,[frame(side(),'Stand with feet hip-width apart'),frame(lunge(),'Step back; lower both knees'),frame(side(),'Return to standing')],'Unloaded reverse lunge, front foot planted, front knee over ankle and rear knee lowered under control.')
    p=front();q=change(p,sl=(155,125),sr=(205,125),el=(115,80),er=(245,80),wl=(150,25),wr=(210,25),al=(105,325),ar=(255,325),tl=(90,330),tr=(270,330))
    q=change(q,al=(155,325),tl=(140,330))
    r=change(q,al=(105,325),ar=(205,325),tl=(90,330),tr=(220,330))
    add('Step Jack',[frame(p,'Stand with arms down'),frame(q,'Step right; raise arms overhead'),frame(p,'Return with both feet grounded'),frame(r,'Step left; raise arms overhead')],'Low-impact step jack; one foot remains fixed in each side step and no jumping phase is shown.')
    p=change(front(),head=(145,120),neck=(145,140),sl=(120,155),sr=(170,155),hl=(128,235),hr=(162,235),kl=(120,285),kr=(195,290),al=(105,325),ar=(200,325),tl=(90,330),tr=(215,330),el=(170,195),er=(210,210),wl=(210,220),wr=(245,220))
    p=change(p,kr=(175,285),ar=(105,320),tr=(98,325))
    q={k:(360-x,y) for k,(x,y) in p.items()}
    add('Low-Impact Skater',[frame(p,'Step to one side; tap the other foot behind'),frame(q,'Step to the other side; no leap')],'Low-impact side-to-side skater steps with a rear toe tap and soft support knee.')
    p=front();q=change(p,al=(105,325),ar=(200,325),tl=(90,330),tr=(217,330),el=(115,140),wl=(85,115),er=(230,160),wr=(250,145))
    r=change(p,al=(160,325),ar=(255,325),tl=(143,330),tr=(272,330),el=(130,160),wl=(110,145),er=(245,140),wr=(275,115))
    add('Aerobic Dance',[frame(q,'Step-touch example: step left'),frame(p,'Bring feet together'),frame(r,'Step-touch example: step right')],'Example low-impact aerobic step-touch sequence; generic dance activity, not a prescribed choreography.')
    p=side();q=change(p,kr=(210,240),ar=(225,283),tr=(248,285));r=shift(p,dx=25,dy=-49)
    for name in ['Step-up','Step Aerobics']:
        add(name,[frame(q,'Place one foot on a stable step',[('step',)]),frame(r,'Step up under control',[('step',)]),frame(q,'Step down under control',[('step',)])],'Basic unloaded step-up on a stable low platform; no dumbbells or extra knee-drive phase.')
    for name in ['Cycling','Outdoor Cycling']:
        frames=[]
        for phase in [0,1]:
            p=dict(head=(205,110),neck=(195,130),sl=(180,145),sr=(192,150),el=(210,180),er=(217,187),wl=(235,193),wr=(240,198),hl=(140,210),hr=(150,213),kl=(195,235),kr=(180,252),al=(185,298),ar=(155,260),tl=(204,300),tr=(174,262))
            if phase:p=change(p,kl=(177,250),kr=(200,235),al=(155,260),ar=(185,298),tl=(174,262),tr=(204,300))
            frames.append(frame(p,'Pedal smoothly; keep hands on the bars',[('bicycle',)]))
        add(name,frames,'Ordinary bicycle riding, with two wheels and alternating pedal positions; no stationary trainer.')
    add('Hiking',[frame(walking(0),'Take a stable uphill step',[('pack',)]),frame(walking(1),'Alternate steps; stay balanced',[('pack',)])],'Overground hiking gait, illustrated with a small pack; no stair machine.')
    p=dict(head=(80,175),neck=(100,180),sl=(115,175),sr=(115,190),hl=(215,180),hr=(215,195),el=(65,150),er=(165,205),wl=(20,145),wr=(215,205),kl=(265,185),kr=(265,205),al=(320,185),ar=(320,218),tl=(336,185),tr=(336,218))
    q=change(p,el=(165,155),er=(65,200),wl=(215,155),wr=(20,205),kl=(265,200),kr=(265,185),al=(320,215),ar=(320,185),tl=(336,215),tr=(336,185))
    add('Swimming',[frame(p,'Freestyle example: reach and pull',[('water',)]),frame(q,'Alternate arms with a light kick',[('water',)])],'Example freestyle swim with alternating reaching and pulling arms; no exercise machine.')
    p=change(front(),al=(140,325),ar=(235,325),tl=(125,330),tr=(250,330),el=(135,135),er=(230,150),wl=(160,105),wr=(210,110))
    q=change(p,el=(100,120),wl=(45,115));r=change(p,er=(260,120),wr=(315,115))
    add('Shadow Boxing',[frame(p,'Keep both hands in guard'),frame(q,'Extend a controlled lead-hand punch'),frame(r,'Return to guard; alternate punches')],'Unloaded shadow boxing, with punches returning to guard; no bag or partner.')
    p=change(side(),sl=(190,120),sr=(200,125),el=(170,165),er=(225,165),wl=(180,205),wr=(230,205))
    q=change(p,wl=(206,125))
    add('Bayesian Cable Curl',[frame(p,'Start with the working arm behind the torso',[('cable',(55,290),'wl')]),frame(q,'Curl while keeping the upper arm back',[('cable',(55,290),'wl')])],'Facing away from a low pulley, curl a single supinated handle with the upper arm held behind the torso.')
    p=change(front(),el=(130,125),wl=(145,90),wr=(218,230));q=change(p,el=(147,75),wl=(153,20))
    add('Single-Arm Cable Shoulder Press',[frame(p,'Rack one cable handle at shoulder height',[('cable',(70,310),'wl')]),frame(q,'Press that arm overhead',[('cable',(70,310),'wl')])],'Single-arm low-cable shoulder press, other arm unloaded; no second cable handle.')
    p=change(front(),sr=(213,130),er=(270,155),wr=(292,180),head=(195,95),neck=(195,115),hl=(178,215),hr=(212,215),kl=(173,270),kr=(207,270),al=(165,325),ar=(200,325),tl=(150,330),tr=(215,330),el=(155,180),wl=(145,230))
    q=change(p,el=(120,138),wl=(72,143))
    add('Leaning Lateral Raise',[frame(p,'Hold a support; let the weight hang',[('post',),('db','wl')]),frame(q,'Raise the working arm toward shoulder height',[('post',),('db','wl')])],'Supported leaning single-arm dumbbell lateral raise; support hand is on a fixed post.')
    p=change(front(),el=(120,115),er=(240,115),wl=(120,65),wr=(240,65));q=change(p,el=(140,75),er=(220,75),wl=(155,20),wr=(205,20))
    add('Wall Angel',[frame(p,'Back to wall; start in a W position',[('backwall',)]),frame(q,'Slide arms upward without arching the back',[('backwall',)])],'Back-to-wall W-to-Y arm movement, unloaded, with neutral ribs and pelvis.')
    p=change(side(),head=(235,95),neck=(235,115),sl=(230,130),sr=(240,130),el=(270,150),er=(276,155),wl=(275,105),wr=(280,110),hl=(230,215),hr=(240,215),kl=(230,270),kr=(242,270),al=(230,325),ar=(242,325),tl=(253,330),tr=(265,330))
    q=change(p,el=(270,100),er=(276,105),wl=(275,45),wr=(280,50))
    add('Wall Slide',[frame(p,'Face wall; support the forearms',[('wall',)]),frame(q,'Slide forearms upward; keep ribs down',[('wall',)])],'Forearm wall slide facing the wall; distinct from a back-to-wall angel.')
    p=dict(head=(70,230),neck=(90,235),sl=(110,235),sr=(112,248),hl=(205,240),hr=(207,253),kl=(265,245),kr=(267,258),al=(320,245),ar=(322,258),tl=(335,245),tr=(337,258),el=(145,270),er=(145,290),wl=(180,285),wr=(180,310))
    q=change(p,el=(110,190),er=(112,290),wl=(110,145),wr=(112,330))
    add('Prone T Raise',[frame(p,'Top view: lie prone; arms relaxed',[('topview',)]),frame(q,'Top view: raise unloaded arms into a T',[('topview',)])],'Top-down diagram of a bodyweight prone T raise on the floor, no dumbbells or bench.')
    p=seated();p=change(p,hl=(150,260),hr=(163,266),kl=(230,280),kr=(230,290),al=(300,290),ar=(300,300),tl=(313,290),tr=(313,300),el=(125,220),er=(140,225),wl=(95,270),wr=(110,275))
    q=change(p,kl=(205,235),kr=(205,245),al=(245,255),ar=(245,265),tl=(258,255),tr=(258,265))
    add('Seated Knee Tuck',[frame(p,'Sit supported; extend the legs',[('seat',)]),frame(q,'Bring knees toward the torso',[('seat',)])],'Seated supported knee tuck with hips on a seat, not a hanging or parallel-bar exercise.')
    p=change(supine(),el=(120,215),er=(140,215),wl=(125,160),wr=(140,160));q=change(p,kl=(255,282),kr=(235,215),al=(315,285),ar=(285,215),tl=(330,285),tr=(298,217))
    add('Dumbbell Dead Bug',[frame(p,'Hold the weight above the chest',[('mat',),('db','wl')]),frame(q,'Alternate legs; keep the trunk supported',[('mat',),('db','wl')])],'Supine weighted dead bug variation: dumbbell held above chest, legs alternate without lumbar movement.')
    p=change(front(),head=(180,155),neck=(180,175),sl=(155,190),sr=(205,190),hl=(163,260),hr=(197,260),kl=(140,280),kr=(220,280),al=(145,325),ar=(215,325),tl=(130,330),tr=(230,330),el=(132,205),er=(228,205),wl=(155,170),wr=(205,170))
    q=change(front(),el=(130,145),er=(230,145),wl=(155,110),wr=(205,110));r=change(front(),el=(150,75),er=(210,75),wl=(155,20),wr=(205,20))
    add('Dumbbell Thruster',[frame(p,'Squat with dumbbells at the shoulders',hands={'wl':'db','wr':'db'}),frame(q,'Drive up through the legs',hands={'wl':'db','wr':'db'}),frame(r,'Finish with the weights overhead',hands={'wl':'db','wr':'db'})],'Two-dumbbell front squat flowing into an overhead press, with a tall finish.')
    p=change(quad(),head=(90,303),neck=(110,310),sl=(125,314),sr=(138,320),el=(100,315),er=(160,320),wl=(120,326),wr=(150,326),hl=(225,314),hr=(238,320),kl=(270,320),kr=(280,326),al=(315,325),ar=(325,330),tl=(330,328),tr=(340,333))
    q=change(squat(),el=(140,270),er=(220,270),wl=(145,320),wr=(215,320));r=change(front(),el=(145,75),er=(215,75),wl=(150,20),wr=(210,20))
    add('Dumbbell Devil Press',[frame(p,'Lower between the dumbbells',hands={'wl':'db','wr':'db'}),frame(q,'Bring the feet in; hinge to lift',hands={'wl':'db','wr':'db'}),frame(r,'Stand tall with both weights overhead',hands={'wl':'db','wr':'db'})],'Dumbbell burpee into a double-dumbbell overhead finish; staged reference positions, not filmed motion.')
    carry0=change(walking(0),el=(180,180),wl=(175,235));carry1=change(walking(1),el=(180,180),wl=(175,235))
    add('Suitcase Carry',[frame(carry0,'Carry one weight at the side',hands={'wl':'db'}),frame(change(side(),el=(180,180),wl=(175,235)),'Pass the feet without tilting',hands={'wl':'db'}),frame(carry1,'Walk without leaning toward the load',hands={'wl':'db'})],'Unilateral dumbbell carry with the loaded arm hanging at the side; opposite hand free.')
    p=change(front(),el=(142,150),er=(218,150),wl=(170,160),wr=(190,160));q=change(p,el=(155,145),er=(205,145),wl=(170,115),wr=(190,115));r=change(p,el=(145,75),er=(215,75),wl=(170,40),wr=(190,40))
    beside=change(p,el=(205,80),er=(240,110),wl=(215,65),wr=(230,65))
    add('Kettlebell Halo with Overhead Extension',[frame(p,'Hold the bell by the horns',props=[('kbcenter',(180,160))]),frame(beside,'Guide the bell beside the head',props=[('kbcenter',(222,65))]),frame(q,'Bring the bell behind the head',props=[('kbcenter',(180,115))]),frame(r,'Extend the elbows overhead',props=[('kbcenter',(180,40))])],'Kettlebell halo followed by a two-handed overhead triceps extension, using a single bell.')

    # Remaining static references and apparatus-specific movements.
    p=change(side(),head=(205,100),neck=(195,122),sl=(185,140),sr=(198,145),hl=(165,225),hr=(178,230),kl=(145,275),kr=(245,325),al=(165,325),ar=(285,325),tl=(185,330),tr=(285,302),el=(185,205),er=(195,212),wl=(195,267),wr=(205,274))
    q=change(p,head=(245,178),neck=(225,188),sl=(208,199),sr=(220,205),el=(235,250),er=(245,257),wl=(265,300),wr=(275,307))
    add('Standing Hamstring Stretch',[frame(p,'Place one heel forward; soften the other knee'),frame(q,'Hinge from the hips toward the straight leg')],'Unloaded standing hamstring stretch with the front heel down and toes raised; no strap.')
    p=change(side(),head=(185,95),neck=(177,115),sl=(170,130),sr=(183,130),hl=(197,215),hr=(210,215),kl=(230,270),kr=(242,270),al=(250,325),ar=(262,325),tl=(280,330),tr=(292,330),el=(180,180),er=(197,180),wl=(195,230),wr=(212,230))
    q=change(p,tl=(278,310),tr=(290,310))
    add('Tibialis Raise',[frame(p,'Lean against support; heels stay down',[('supportwall',)]),frame(q,'Lift the toes toward the shins',[('supportwall',)])],'Supported tibialis raise by ankle dorsiflexion with heels planted; no calf raise.')
    p=dict(head=(145,125),neck=(150,145),sl=(145,160),sr=(158,165),el=(190,170),er=(200,177),wl=(230,195),wr=(240,202),hl=(150,235),hr=(163,240),kl=(115,315),kr=(238,260),al=(65,325),ar=(238,325),tl=(52,330),tr=(260,330))
    q=change(p,kr=(255,260))
    add('Ankle Mobility Rock',[frame(p,'Half-kneel with the front heel planted'),frame(q,'Rock the knee forward; heel stays down')],'Half-kneeling ankle dorsiflexion rock; the front heel and toes stay in contact with the floor.')
    p=change(quad(),head=(95,173),neck=(112,185),wl=(118,300),el=(125,250),wr=(92,155),er=(150,213))
    q=change(p,er=(155,130),wr=(94,155),sl=(128,198),sr=(145,205))
    add('Thoracic Rotation',[frame(p,'On hands and knees; hand behind the head'),frame(q,'Rotate the upper back; open the elbow')],'Quadruped thoracic-rotation example; pelvis stable and one hand remains on the floor.')
    p=change(side(),el=(235,145),wl=(280,160),er=(245,170),wr=(293,164));q=change(p,wr=(293,180))
    add('Wrist Flexor Stretch',[frame(p,'Extend the arm; turn the palm upward',[('wristdetail',0)]),frame(q,'Gently draw the fingers back',[('wristdetail',1)])],'Straight-arm wrist-flexor stretch with the palm up and a gentle opposite-hand finger pull.')
    p=supine();p=change(p,kl=(205,220),kr=(245,215),al=(235,238),ar=(245,310),tl=(252,240),tr=(265,315),el=(160,250),er=(175,255),wl=(225,240),wr=(237,245))
    q=change(p,kr=(235,205),ar=(260,270),tr=(280,275),kl=(190,210),al=(230,225),tl=(247,227),wl=(217,225),wr=(230,230))
    add('Figure Four Stretch',[frame(p,'Cross one ankle over the opposite thigh',[('mat',)]),frame(q,'Support the thigh; draw the legs toward you',[('mat',)])],'Supine figure-four glute stretch, with the crossed knee opening outward and hands supporting the uncrossed thigh.')
    p=change(supine(),head=(70,295),neck=(90,300),sl=(110,300),sr=(115,308),hl=(210,305),hr=(215,311),el=(65,280),er=(70,288),wl=(15,280),wr=(20,288),kl=(265,305),kr=(270,311),al=(320,305),ar=(325,311),tl=(335,305),tr=(340,311))
    q=change(p,head=(100,245),neck=(115,260),sl=(130,270),sr=(135,278),el=(85,220),er=(90,228),wl=(40,200),wr=(45,208),kl=(265,285),kr=(270,291),al=(315,265),ar=(320,271),tl=(330,265),tr=(335,271))
    add('Hollow Hold',[frame(p,'Lie supported with the arms overhead',[('mat',)]),frame(q,'Lift shoulders and legs; keep the low back down',[('mat',)])],'Hollow-body hold setup and final position: shoulders and straight legs raised, lower back remains on the mat.')
    deep=change(squat(),head=(180,170),neck=(180,190),sl=(155,205),sr=(205,205),hl=(155,285),hr=(205,285),kl=(115,265),kr=(245,265),el=(140,235),er=(220,235),wl=(170,225),wr=(190,225))
    add('Deep Squat Hold',[frame(front(),'Start with a comfortable stable stance'),frame(deep,'Lower the hips below knee height; hold')],'Unloaded deep squat hold, illustrated from standing into the bottom position.')
    p=dict(head=(210,150),neck=(195,165),sl=(185,180),sr=(198,185),hl=(135,235),hr=(148,240),kl=(125,310),kr=(138,315),al=(70,325),ar=(83,330),tl=(55,328),tr=(68,333),el=(220,220),er=(233,225),wl=(255,243),wr=(268,248))
    q=change(p,head=(250,205),neck=(237,220),sl=(225,230),sr=(238,235),hl=(170,270),hr=(183,275),el=(265,230),er=(278,235),wl=(295,243),wr=(308,248))
    add('Stability Ball Rollout',[frame(p,'Kneel with forearms on the ball',[('ball',(265,285),42)]),frame(q,'Roll forward while keeping the trunk braced',[('ball',(305,285),42)])],'Kneeling stability-ball rollout with forearms supported on the ball, hips and shoulders travelling forward together; ball size remains fixed.')
    p=change(seated(),head=(150,160),neck=(160,178),sl=(165,190),sr=(180,195),hl=(200,265),hr=(215,270),kl=(260,275),kr=(270,285),al=(285,325),ar=(300,325),tl=(300,330),tr=(315,330),el=(140,225),er=(158,228),wl=(115,245),wr=(135,245))
    q=change(p,el=(220,223),er=(238,228),wl=(255,245),wr=(275,245))
    add('Medicine Ball Russian Twist',[frame(p,'Lean back with feet supported; turn left',[('medball',(125,245))]),frame(q,'Rotate the torso and ball to the other side',[('medball',(265,245))])],'Seated medicine-ball Russian twist with a braced reclined torso and supported feet.')
    p=dict(head=(65,200),neck=(85,205),sl=(105,210),sr=(115,218),hl=(205,220),hr=(215,228),kl=(260,250),kr=(272,257),al=(260,325),ar=(272,325),tl=(282,330),tr=(294,330),el=(125,165),er=(140,165),wl=(145,130),wr=(162,130))
    q=change(p,el=(110,160),er=(128,160),wl=(112,105),wr=(128,105))
    add('Dumbbell Squeeze Press',[frame(p,'Keep the dumbbells pressed together',[('bench',)],{'wl':'db','wr':'db'}),frame(q,'Press upward while maintaining the squeeze',[('bench',)],{'wl':'db','wr':'db'})],'Flat-bench dumbbell squeeze press: the pair stays together throughout the press; no standing Svend press.')
    p=dict(head=(265,100),neck=(257,120),sl=(245,135),sr=(258,140),hl=(250,225),hr=(263,230),kl=(205,260),kr=(220,265),al=(190,325),ar=(205,325),tl=(170,330),tr=(185,330),el=(190,160),er=(202,167),wl=(140,185),wr=(152,192))
    q=change(p,el=(280,175),er=(292,182),wl=(220,200),wr=(232,207))
    add('Machine Low Row',[frame(p,'Sit supported and grasp the low handles',[('rowmachine',)]),frame(q,'Pull toward the lower ribs',[('rowmachine',)])],'Seated low-handle rowing machine with a fixed seat and resistance stack; elbows travel behind the torso.')
    p=dict(head=(105,185),neck=(125,195),sl=(140,205),sr=(150,213),hl=(220,280),hr=(230,285),kl=(280,235),kr=(292,242),al=(280,325),ar=(292,325),tl=(305,330),tr=(317,330),el=(180,235),er=(193,242),wl=(220,270),wr=(230,278))
    q=change(p,hl=(220,225),hr=(230,232),el=(180,213),er=(193,220),wl=(220,225),wr=(230,232))
    add('Machine Hip Thrust',[frame(p,'Upper back supported; lap pad secured',[('hipmachine',)]),frame(q,'Drive through the feet and extend the hips',[('hipmachine',)])],'Purpose-built hip-thrust machine with a bench/back support, hip pad and resistance lever; feet remain planted.')
    p=quad();cat=change(p,head=(95,200),neck=(110,200),sl=(130,205),sr=(143,210),hl=(225,192),hr=(238,197))
    child=change(p,head=(105,280),neck=(125,275),sl=(145,270),sr=(158,275),hl=(235,275),hr=(248,280),el=(100,285),er=(113,290),wl=(55,300),wr=(68,305))
    add('Yoga Flow',[frame(p,'Example gentle flow: hands and knees'),frame(cat,'Round the upper back gently',[('roundedspine',)]),frame(child,'Sit the hips back into child pose')],'Example gentle cat-to-child mobility flow; explicitly presented as an example rather than a complete yoga programme.')
    return specs


def draw_props(c, props, p):
    for prop in props:
        kind=prop[0]
        if kind=='wall':wall(c)
        elif kind=='supportwall':c.rect((157,60,167,334),'#e4ece8','#a3b7b1')
        elif kind=='post':c.rect((291,70,300,334))
        elif kind=='backwall':c.rect((110,50,250,335),'#ecf0ed','#b7c9c1')
        elif kind=='step':step(c)
        elif kind=='seat':c.rect((75,271,180,280));c.line([(90,280),(90,332)]);c.line([(165,280),(165,332)])
        elif kind=='mat':c.rect((35,303,335,310),'#d9eae4','#a4c2b6')
        elif kind=='db':dumbbell(c,p[prop[1]])
        elif kind=='kbcenter':kettlebell(c,prop[1])
        elif kind=='cable':
            anchor=prop[1];c.rect((anchor[0]-8,230,anchor[0]+8,330));c.circle(anchor,8,'#e3ebe8','#647b78');c.line([anchor,p[prop[2]]],'#738c86',2)
        elif kind=='pack':c.rect((145,142,169,205),'#91aaa2','#446e62')
        elif kind=='water':
            for y in [235,255,275]:c.line([(20,y),(90,y-4),(160,y),(230,y-4),(340,y)],'#8dbbc9',2)
        elif kind=='bicycle':
            c.circle((75,285),43,None,'#718c83',3);c.circle((275,285),43,None,'#718c83',3)
            c.line([(75,285),(145,220),(180,285),(75,285),(235,215),(275,285)],'#718c83',4)
            c.line([(145,220),(145,205),(125,205)],'#718c83',4);c.line([(235,215),(230,195),(247,190)],'#718c83',4)
        elif kind=='ball':c.circle(prop[1],prop[2],'#e1eaf2','#708799',3)
        elif kind=='medball':c.circle(prop[1],16,'#b0c8d5','#496779',3)
        elif kind=='bench':bench(c)
        elif kind=='rowmachine':
            c.rect((45,175,92,315));c.rect((225,230,290,240));c.line([(255,240),(255,332)],'#647b78',5);c.circle((110,193),8,None,'#647b78');c.line([(110,193),p['wl']],'#647b78',2)
        elif kind=='hipmachine':
            c.rect((120,215,170,227));c.line([(135,227),(135,330)],'#647b78',5);c.line([(75,315),(225,p['hl'][1])],'#647b78',6);c.circle((95,310),17,'#bccdc7','#647b78',3);c.rect((p['hl'][0]-20,p['hl'][1]-8,p['hl'][0]+24,p['hl'][1]+3),'#a3bbb2','#647b78')
        elif kind=='wristdetail':
            c.rect((12,240,115,315),'#edf4f1','#a3b7b1');c.line([(25,270),(70,270)],'#285d58',7);c.line([(70,270),(95,290 if prop[1] else 270)],'#285d58',5)


def main():
    ART.mkdir(parents=True,exist_ok=True);OUTPUT.mkdir(parents=True,exist_ok=True)
    catalogue={row['name']:row for row in json.loads((ROOT/'prisma/exerciseCatalogue.json').read_text(encoding='utf-8'))}
    remaining=json.loads((REPORTS/'pose-gif-candidates.json').read_text(encoding='utf-8'))
    wanted={row['name'] for row in remaining}
    specs=build_specs();rendered={};review=[]
    for name,spec in specs.items():
        if name not in wanted:continue
        slug=re.sub('[^a-z0-9]+','-',name.lower()).strip('-')
        frames=[];svg_urls=[];svg_hashes=[];source_files=[]
        for index,f in enumerate(spec['frames'],1):
            c=Canvas()
            if not any(prop[0]=='topview' for prop in f['props']):ground(c)
            draw_props(c,f['props'],f['pose']);person(c,f['pose'])
            # Weights held in front of the torso must remain visible.
            for prop in f['props']:
                if prop[0]=='kbcenter':kettlebell(c,prop[1])
                elif prop[0]=='medball':c.circle(prop[1],16,'#b0c8d5','#496779',3)
                elif prop[0]=='wristdetail':c.line([f['pose']['wl'],(300,180 if prop[1] else 160)],'#285d58',4)
                elif prop[0]=='roundedspine':c.line([(130,205),(155,183),(188,181),(225,192)],'#285d58',5)
            for hand,weight in f['hands'].items():
                (dumbbell if weight=='db' else kettlebell)(c,f['pose'][hand])
            c.label(f'SCHEMATIC / POSE {index} OF {len(spec["frames"])}',5,True)
            c.label(f['cue'],23);c.label('Phool Gobhi / Illustrated pose reference',381)
            svg=c.finish();path=ART/f'{slug}-{index}.svg';path.write_text(svg,encoding='utf-8')
            digest=hashlib.sha256(path.read_bytes()).hexdigest()
            svg_urls.append('https://storage.googleapis.com/phool-gobhi-exercise-media-dev/pose-references/'+digest+'.svg')
            svg_hashes.append(digest);source_files.append(str(path))
            (OUTPUT/(digest+'.svg')).write_bytes(path.read_bytes())
            frames.append(c.image)
        temp=CACHE/'original-current.gif';frames[0].save(temp,save_all=True,append_images=frames[1:],duration=1500,loop=0,optimize=False)
        digest=hashlib.sha256(temp.read_bytes()).hexdigest();target=OUTPUT/(digest+'.gif');temp.replace(target)
        preview=CACHE/'original-preview.jpg';frames[0].save(preview,quality=92)
        preview_hash=hashlib.sha256(preview.read_bytes()).hexdigest();preview.replace(OUTPUT/(preview_hash+'.jpg'))
        rendered[name]={'equipment':catalogue[name]['equipment'],'kind':'schematic_pose_sequence',
            'gifUrl':'https://storage.googleapis.com/phool-gobhi-exercise-media-dev/pose-references/'+target.name,
            'previewImageUrl':'https://storage.googleapis.com/phool-gobhi-exercise-media-dev/pose-references/'+preview_hash+'.jpg',
            'previewImageSha256':preview_hash,'attribution':'Phool Gobhi original schematic pose reference. Illustrations show selected exercise positions.',
            'sourceUrl':svg_urls[0],'sourceImageUrls':svg_urls,'sourceImageSha256':svg_hashes,
            'sourceVectorFiles':source_files,'licenseUrl':None,'rights':'phool_gobhi_original',
            'assetSha256':digest,'frameCount':len(frames),'frameDurationMs':1500,
            'labels':'Schematic pose reference; phase cue on every frame','userApprovedPoseSequences':True,
            'reviewStatus':'pending_visual_review','reviewReason':spec['definition']}
        review.append((name,frames))
    for batch,start in enumerate(range(0,len(review),8),1):
        rows=review[start:start+8];columns=max(len(frames) for _,frames in rows);sheet=Image.new('RGB',(360*columns,len(rows)*215),'white');draw=ImageDraw.Draw(sheet)
        for i,(name,frames) in enumerate(rows):
            draw.text((5,i*215+2),name,fill='black')
            for j,image in enumerate(frames):sheet.paste(ImageOps.contain(image,(340,190)),(j*360,i*215+20))
        sheet.save(REPORTS/'reference-review'/f'original-poses-{batch}.jpg')
    (CACHE/'original-pending-manifest.json').write_text(json.dumps(rendered,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'originalSchematicExercises':len(rendered),'pendingVisualReview':True,'notCoveredByTheseSpecs':sorted(wanted-set(rendered))}))


if __name__=='__main__':main()
