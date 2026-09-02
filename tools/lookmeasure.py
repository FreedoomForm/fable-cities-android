"""Measure colour/lighting stats for reference/cs2_*.jpg and shots/look/ours_*.png.
Run from the repo root: python3 tools/lookmeasure.py   (see docs/LOOK_TARGET.md)
"""
import sys, os, json, glob
import numpy as np
from PIL import Image

def srgb_to_lin(c): return np.where(c<=0.04045, c/12.92, ((c+0.055)/1.055)**2.4)
def luma(a):
    l=srgb_to_lin(a); return 0.2126*l[...,0]+0.7152*l[...,1]+0.0722*l[...,2]
def rgb_to_hsv(a):
    mx=a.max(2); mn=a.min(2); d=mx-mn
    s=np.where(mx>1e-6,d/np.maximum(mx,1e-6),0.0); v=mx; h=np.zeros_like(mx)
    r,g,b=a[...,0],a[...,1],a[...,2]; m=d>1e-6
    i=m&(mx==r); h[i]=((g-b)[i]/d[i])%6
    i=m&(mx==g)&(mx!=r); h[i]=((b-r)[i]/d[i])+2
    i=m&(mx==b)&(mx!=r)&(mx!=g); h[i]=((r-g)[i]/d[i])+4
    return h*60.0,s,v
def oklab(a):
    l=srgb_to_lin(a); r,g,b=l[...,0],l[...,1],l[...,2]
    L=0.4122214708*r+0.5363325363*g+0.0514459929*b
    M=0.2119034982*r+0.6806995451*g+0.1073969566*b
    S=0.0883024619*r+0.2817188376*g+0.6299787005*b
    L_,M_,S_=np.cbrt(L),np.cbrt(M),np.cbrt(S)
    return (0.2104542553*L_+0.7936177850*M_-0.0040720468*S_,
            1.9779984951*L_-2.4285922050*M_+0.4505937099*S_,
            0.0259040371*L_+0.7827717662*M_-0.8086757660*S_)

# HUD crop boxes (fractional y0,y1) — ours has a top bar and a bottom toolbar
CROP = {'ours':(0.085,0.86), 'ui':(0.0,1.0), 'clean':(0.0,1.0)}

def load(path, crop):
    a=np.asarray(Image.open(path).convert('RGB')).astype(np.float32)/255.
    H=a.shape[0]; y0,y1=crop
    return a[int(H*y0):int(H*y1)]

def masks(a):
    h,s,v=rgb_to_hsv(a); L=luma(a); lin=srgb_to_lin(a)
    H,W=a.shape[:2]; yy=np.repeat(np.arange(H).reshape(-1,1),W,1)/H
    r,g,b=lin[...,0],lin[...,1],lin[...,2]
    sky=(yy<0.45)&(b>r*1.03)&(v>0.42)&(((h>170)&(h<265))|(s<0.10))
    water=(~sky)&(((h>165)&(h<250))&(b>=g*0.98)&(v>0.10)&(v<0.85))
    veg=(~sky)&(~water)&((h>52)&(h<162))&(s>0.16)&(v>0.05)
    asph=(~sky)&(~water)&(~veg)&(s<0.13)&(v>0.08)&(v<0.45)&(yy>0.30)
    bld=(~sky)&(~water)&(~veg)&(~asph)&(v>0.10)&(v<0.95)
    return dict(sky=sky,water=water,vegetation=veg,asphalt=asph,building=bld)

def go(path, crop):
    a=load(path,crop)
    h,s,v=rgb_to_hsv(a); L=luma(a); Lo,A,B=oklab(a); C=np.sqrt(A*A+B*B)
    H,W=a.shape[:2]; yy=np.repeat(np.arange(H).reshape(-1,1),W,1)/H
    o=dict(file=os.path.basename(path))
    o['sat_mean']=float(s.mean()); o['sat_p10'],o['sat_p50'],o['sat_p90']=[float(x) for x in np.percentile(s,[10,50,90])]
    o['lum_mean']=float(L.mean()); o['lum_p10'],o['lum_p50'],o['lum_p90']=[float(x) for x in np.percentile(L,[10,50,90])]
    o['okL_mean']=float(Lo.mean()); o['C_mean']=float(C.mean()); o['C_p90']=float(np.percentile(C,90))
    q1,q3=np.percentile(L,[25,75]); o['shadow_ratio']=float(L[L>=q3].mean()/max(L[L<=q1].mean(),1e-5))
    # MATCHED-LIGHTNESS chroma: only pixels 0.35<okL<0.75 -> "how colourful is a normally-lit surface"
    ml=(Lo>0.35)&(Lo<0.75)
    o['C_matched']=float(C[ml].mean()) if ml.sum()>2000 else None
    o['sat_matched']=float(s[ml].mean()) if ml.sum()>2000 else None
    o['ml_frac']=float(ml.mean())
    # ground (below 45%) — skips sky
    g=yy>0.45
    Lg=L[g]; q1g,q3g=np.percentile(Lg,[25,75])
    o['ground_shadow_ratio']=float(Lg[Lg>=q3g].mean()/max(Lg[Lg<=q1g].mean(),1e-5))
    o['ground_lum']=float(Lg.mean()); o['ground_C']=float(C[g].mean()); o['ground_sat']=float(s[g].mean())
    lit=g&(L>=q3g); sh=g&(L<=q1g)
    lin=srgb_to_lin(a); bcr=(lin[...,2]+1e-4)/(lin[...,0]+1e-4)
    o['lit_BoverR']=float(np.median(bcr[lit])); o['shadow_BoverR']=float(np.median(bcr[sh]))
    o['BoverR_ratio']=o['shadow_BoverR']/max(o['lit_BoverR'],1e-6)
    o['lit_hue']=float(np.median(h[lit])); o['shadow_hue']=float(np.median(h[sh]))
    o['lit_sat']=float(s[lit].mean()); o['shadow_sat']=float(s[sh].mean())
    o['shadow_over_lit_sat']=o['shadow_sat']/max(o['lit_sat'],1e-6)
    # atmospheric: far = top third of NON-SKY pixels; near = bottom third
    M=masks(a); nonsky=~M['sky']
    for nm,(y0,y1) in [('far',(0,1/3.)),('mid',(1/3.,2/3.)),('near',(2/3.,1.))]:
        m=nonsky&(yy>=y0)&(yy<y1)
        if m.sum()<2000: o[f'C_{nm}']=None; o[f'sat_{nm}']=None; o[f'lum_{nm}']=None; continue
        o[f'C_{nm}']=float(C[m].mean()); o[f'sat_{nm}']=float(s[m].mean()); o[f'lum_{nm}']=float(L[m].mean())
    if o.get('C_far'): 
        o['atmos_C_near_over_far']=o['C_near']/o['C_far']
        o['atmos_sat_near_over_far']=o['sat_near']/o['sat_far']
        o['atmos_lum_far_over_near']=o['lum_far']/max(o['lum_near'],1e-6)
    o['surf']={}
    for k,m in M.items():
        n=int(m.sum())
        if n<1500: o['surf'][k]=None; continue
        o['surf'][k]=dict(frac=n/(H*W), hue=float(np.median(h[m])), sat=float(s[m].mean()),
                          C=float(C[m].mean()), lum=float(L[m].mean()), okL=float(Lo[m].mean()))
    return o

if __name__=='__main__':
    res=[]
    for p in sorted(glob.glob('reference/cs2_*.jpg')):
        n=os.path.basename(p)
        crop=(0.0,0.93) if n in ('cs2_01.jpg','cs2_03.jpg','cs2_05.jpg','cs2_07.jpg') else (0.0,1.0)
        r=go(p,crop); r['set']='ref'; res.append(r)
    for p in sorted(glob.glob('shots/look/ours_*.png')):
        r=go(p,(0.085,0.86)); r['set']='ours'; res.append(r)
    out = os.environ.get('LOOK_OUT', 'shots/look/measure.json')
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    json.dump(res, open(out, 'w'), indent=1)
    print('wrote', out, '-', len(res), 'frames')
