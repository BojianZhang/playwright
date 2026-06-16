#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 本地缺口认读(纯 Python,零依赖)—— 给 z.ai 阿里云拼图滑块算缺口位置
#
# 文件定位：GLM/0.0.1/selenium-e2e/common/gap_detect.py
#
# 为什么不用 CapSolver:CapSolver 对 z.ai 油画风拼图精度只 ~50%,还时常给几何不可能的垃圾值。
# 为什么这个能站住脚:用真机存下的 ~20 张真图离线标定 —— 阿里云缺口(slot)是把拼图形状【去色+提亮】
#   叠在背景上的,所以缺口内部【饱和度显著低于周围 + 略亮 + 左缘有暗边】。这三个信号在所有【确认通过】
#   的图上一致出现(尤其饱和度落差 -21~-51,极稳),而油画背景到处是高饱和/边缘 —— 故饱和度落差最具判别力。
#
# detect_gap(piece_b64, bg_b64) → (gap_native_x, confidence) 或 None。
#   gap_native_x = 缺口左缘在【背景原图像素】里的 x(=拼图块要滑的距离,块从左缘 x≈0 起步);
#   confidence   = 峰值/次峰(隔开>块宽),越大越可信;调用方可按阈值决定是否信本地、是否与 CapSolver 交叉验证。
# 纯标准库(zlib/struct),不引入 numpy/Pillow,保持精简安装。仅支持 8-bit 非隔行 PNG(z.ai 实测就是)。
# ═══════════════════════════════════════════════════════════════════════

import base64
import struct
import sys
import zlib


def _png_decode(b64):
    """极简 PNG 解码(8-bit,truecolor/+alpha/灰度,非隔行)→ (w, h, channels, bytes(raw RGBA-ish))。
    只为本地缺口认读够用;遇到不支持的格式(调色板/16bit/隔行)返回 None,调用方回退 CapSolver。"""
    try:
        if isinstance(b64, str):
            i = b64.find("base64,")
            if i >= 0:
                b64 = b64[i + 7:]
            data = base64.b64decode(b64)
        else:
            data = b64
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            return None
        pos = 8
        w = h = bitd = colt = None
        idat = bytearray()
        while pos + 8 <= len(data):
            ln = struct.unpack(">I", data[pos:pos + 4])[0]
            typ = data[pos + 4:pos + 8]
            chunk = data[pos + 8:pos + 8 + ln]
            pos += 12 + ln  # len + type + data + crc
            if typ == b"IHDR":
                w, h, bitd, colt, comp, filt, interlace = struct.unpack(">IIBBBBB", chunk[:13])
                if bitd != 8 or interlace != 0 or colt not in (0, 2, 6):
                    return None  # 只支持 8bit 非隔行 灰度(0)/RGB(2)/RGBA(6)
            elif typ == b"IDAT":
                idat += chunk
            elif typ == b"IEND":
                break
        if w is None:
            return None
        ch = {0: 1, 2: 3, 6: 4}[colt]
        raw = zlib.decompress(bytes(idat))
        stride = w * ch
        out = bytearray(h * stride)
        prev = bytearray(stride)
        p = 0
        for y in range(h):
            ft = raw[p]; p += 1
            line = bytearray(raw[p:p + stride]); p += stride
            if ft == 1:      # Sub
                for x in range(ch, stride):
                    line[x] = (line[x] + line[x - ch]) & 255
            elif ft == 2:    # Up
                for x in range(stride):
                    line[x] = (line[x] + prev[x]) & 255
            elif ft == 3:    # Average
                for x in range(stride):
                    a = line[x - ch] if x >= ch else 0
                    line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
            elif ft == 4:    # Paeth
                for x in range(stride):
                    a = line[x - ch] if x >= ch else 0
                    b = prev[x]
                    c = prev[x - ch] if x >= ch else 0
                    pp = a + b - c
                    pa = abs(pp - a); pb = abs(pp - b); pc = abs(pp - c)
                    pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                    line[x] = (line[x] + pr) & 255
            out[y * stride:(y + 1) * stride] = line
            prev = line
        return w, h, ch, bytes(out)
    except Exception:
        return None


def detect_gap(piece_b64, bg_b64):
    """返回 (gap_native_x, confidence) 或 None。算法见文件头。纯整数运算,零依赖。"""
    bg = _png_decode(bg_b64)
    pc = _png_decode(piece_b64)
    if not bg or not pc:
        return None
    bw, bh, bch, bd = bg
    pw, ph, pch, pd = pc
    if bw < 60 or pw < 10 or pch < 4:   # 块必须有 alpha(RGBA)才能定形状/行带
        return None

    # ① 拼图块实体(alpha>128)的【行范围 y0..y1 / 列范围 xmin..xmax / 实体宽 jw】+ 掩码内的【块灰度】
    y0 = y1 = -1; xmin = pw; xmax = 0
    for y in range(ph):
        rowop = False
        base = y * pw * pch
        for x in range(pw):
            if pd[base + x * pch + 3] > 128:
                rowop = True
                if x < xmin: xmin = x
                if x > xmax: xmax = x
        if rowop:
            if y0 < 0: y0 = y
            y1 = y
    if y0 < 0 or xmax <= xmin:
        return None
    jw = xmax - xmin + 1
    if y1 >= bh:
        y1 = bh - 1
    if y0 > y1:
        return None
    nrows = y1 - y0 + 1

    # ② 一次遍历块行带:背景逐列均灰 cb/均饱和 cs(饱和度法用)+ 背景行带灰度 bgray(NCC 用);
    #    同时取块在 bbox 内的掩码灰度向量 pv(NCC 模板)。
    cb = [0.0] * bw; cs = [0.0] * bw
    bgray = [[0.0] * bw for _ in range(nrows)]
    for ri, y in enumerate(range(y0, y1 + 1)):
        row = y * bw * bch
        gr = bgray[ri]
        for x in range(bw):
            o = row + x * bch
            r = bd[o]; g = bd[o + 1] if bch >= 3 else bd[o]; b = bd[o + 2] if bch >= 3 else bd[o]
            gv = 0.299 * r + 0.587 * g + 0.114 * b
            gr[x] = gv
            cb[x] += gv
            cs[x] += (max(r, g, b) - min(r, g, b))
    for x in range(bw):
        cb[x] /= nrows; cs[x] /= nrows

    # 块模板:bbox 内掩码像素的 (相对行 ri, 相对列 dj) 偏移 + 灰度值;均值化 + 范数(NCC 用)。
    # ★每 2 个掩码像素取 1(stride2):NCC 是数百点的相关,半采样结果几乎不变,但纯 Python 内循环减半 →
    #   高并发(多线程)下少占 GIL ~一半(NCC 是 CPU 活、持 GIL 会挡住其它线程的 Python)。
    offs = []; pvals = []; _cnt = 0
    for ri, y in enumerate(range(y0, y1 + 1)):
        pbase = y * pw * pch
        for x in range(xmin, xmax + 1):
            if pd[pbase + x * pch + 3] > 128:
                if _cnt % 2 == 0:
                    px = pd[pbase + x * pch]; pg = pd[pbase + x * pch + 1] if pch >= 3 else px; pb = pd[pbase + x * pch + 2] if pch >= 3 else px
                    offs.append((ri, x - xmin))
                    pvals.append(0.299 * px + 0.587 * pg + 0.114 * pb)
                _cnt += 1
    npx = len(pvals)
    pv = None; pnorm = 1.0
    if npx >= 30:
        pm = sum(pvals) / npx
        pv = [v - pm for v in pvals]
        pnorm = (sum(v * v for v in pv)) ** 0.5 or 1.0

    def mean(a, i, j):
        i = max(0, i); j = min(bw, j)
        return (sum(a[i:j]) / (j - i)) if j > i else 0.0

    lo = int(jw * 0.85); hi = bw - jw
    if hi <= lo:
        # 搜索区间坍塌(块宽 jw 相对背景 bw 过大,或图被截断/缩放)→ 本地认读放弃(调用方回退 CapSolver)。
        # ★不静默:打一行 stderr 便于复盘"本地为何没出缺口"(GAP-004;不改校准好的 0.85*jw 下界,那属滑块精度域需真机验)。
        try: sys.stderr.write("[gap_detect] 搜索区间坍塌 jw=%d bw=%d (lo=%d>=hi=%d) → 放弃本地认读,回退\n" % (jw, bw, lo, hi))
        except Exception: pass
        return None

    # ③ 饱和度法:缺口内部去色(饱和度落差,主)+ 略亮 + 左缘暗边
    sat_best = -1; sat_s = -1e18; sat_scores = []
    for x in range(lo, hi):
        i_sat = mean(cs, x, x + jw); l_sat = mean(cs, x - jw, x)
        i_br = mean(cb, x, x + jw); l_br = mean(cb, x - jw, x)
        dip = mean(cb, x - 3, x) - cb[x]
        s = 2.0 * (l_sat - i_sat) + 1.0 * (i_br - l_br) + 1.5 * (dip if dip > 0 else 0.0)
        sat_scores.append((x, s))
        if s > sat_s:
            sat_s = s; sat_best = x
    sat = None
    if sat_best >= 0:
        sec = max((s for xx, s in sat_scores if abs(xx - sat_best) > jw), default=-1e18)
        sat_conf = (sat_s / sec) if sec > 1e-6 else (3.0 if sat_s > 0 else 0.0)
        sat = (sat_best, round(sat_conf, 2))

    # ④ NCC 内容匹配(块=从缺口处切下来的真实纹理,与缺口处变暗的纹理对得上;亮度归一→场景无关,雪/云/雾骗不了):
    #    对每个候选 x,把块掩码灰度与背景窗口灰度做归一化互相关,峰=真缺口;峰高+与次峰落差大=可信。
    ncc = None
    if pv is not None:
        ncc_best = -1; ncc_peak = -2.0; ncc_scores = []
        for x in range(lo, hi):
            wv = [bgray[ri][x + dj] for (ri, dj) in offs]
            wm = sum(wv) / npx
            num = 0.0; wn = 0.0
            for k in range(npx):
                d = wv[k] - wm
                num += pv[k] * d
                wn += d * d
            wn = wn ** 0.5 or 1.0
            v = num / (pnorm * wn)
            ncc_scores.append((x, v))
            if v > ncc_peak:
                ncc_peak = v; ncc_best = x
        if ncc_best >= 0:
            sec = max((v for xx, v in ncc_scores if abs(xx - ncc_best) > jw), default=-1.0)
            ncc = (ncc_best, round(ncc_peak, 3), round(ncc_peak - sec, 3))

    if sat is None and ncc is None:
        return None
    return {"sat": sat, "ncc": ncc, "jig_w": jw, "bg_natW": bw}


__all__ = ["detect_gap"]
