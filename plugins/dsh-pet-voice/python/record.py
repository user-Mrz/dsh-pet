#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-pet-voice 的宿主侧录音器。

为什么是 Python：这台机器的麦克风真实格式是 4 声道 / 48000 Hz / 32 位浮点
（WAVE_FORMAT_EXTENSIBLE），Windows 的 waveIn 老接口只吃整数 PCM，格式协商会
"成功"但一个采样都录不到（实测 dwBytesRecorded=0）。所以必须走 WASAPI 拿原生
混音格式，再自己重采样成 DeepSeek ASR 要求的 16kHz / 单声道 / PCM16。

零第三方依赖：只用 ctypes 调 ole32 的 COM 接口。

用法：
    python record.py --out <wav路径> [--seconds 8] [--device 0]

输出（stdout，单行 JSON）：
    {"ok": true, "path": "...", "seconds": 3.2, "peak": 0.08, "frames": 51200}
    {"ok": false, "reason": "no-device|open-failed|no-data|timeout", "message": "..."}

退出码：0 成功，1 失败（失败时 stdout 仍给 JSON）。
"""

import argparse
import array
import ctypes
import ctypes.wintypes as wt
import json
import math
import os
import struct
import sys
import time
import uuid

ole32 = ctypes.WinDLL("ole32")
HRESULT = ctypes.c_long

# COM 的 HRESULT 失败判定：最高位为 1
def failed(hr):
    return (hr & 0x80000000) != 0


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", wt.DWORD),
        ("Data2", wt.WORD),
        ("Data3", wt.WORD),
        ("Data4", ctypes.c_ubyte * 8),
    ]


def guid_of(text):
    """把 '{XXXX-...}' 形式的 GUID 字符串转成 ctypes 结构（小端字节序）。"""
    u = uuid.UUID(text.strip("{}"))
    g = GUID()
    g.Data1, g.Data2, g.Data3 = u.time_low, u.time_mid, u.time_hi_version
    raw = u.bytes
    for i in range(8):
        g.Data4[i] = raw[8 + i]
    return g


CLSID_MMDeviceEnumerator = guid_of("{BCDE0395-E52F-467C-8E3D-C4579291692E}")
IID_IMMDeviceEnumerator = guid_of("{A95664D2-9614-4F35-A746-DE8DB63617E6}")
IID_IAudioClient = guid_of("{1CB9AD4C-DBFA-4C32-B178-C2F568A703B2}")
IID_IAudioCaptureClient = guid_of("{C8ADBD64-E71E-48A0-A4DE-185C395CD317}")

eCapture = 1
DEVICE_STATE_ACTIVE = 1
AUDCLNT_SHAREMODE_SHARED = 0
AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000


def vtable(obj, index):
    """取 COM 对象的第 index 个虚表槽（0..2 是 IUnknown）。"""
    return ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents[index]


def com_call(obj, index, restype, *argtypes):
    """构造一个 COM 方法调用器：第一个参数固定是接口指针。"""
    return ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(vtable(obj, index))


class WAVEFORMATEX(ctypes.Structure):
    _fields_ = [
        ("wFormatTag", wt.WORD),
        ("nChannels", wt.WORD),
        ("nSamplesPerSec", wt.DWORD),
        ("nAvgBytesPerSec", wt.DWORD),
        ("nBlockAlign", wt.WORD),
        ("wBitsPerSample", wt.WORD),
        ("cbSize", wt.WORD),
    ]


def enumerate_capture_devices():
    """列出活动录音设备，返回 [(index, id)]；失败抛 RuntimeError。"""
    ole32.CoInitialize(None)
    enumerator = ctypes.c_void_p()
    hr = ole32.CoCreateInstance(
        ctypes.byref(CLSID_MMDeviceEnumerator),
        None,
        1,  # CLSCTX_INPROC_SERVER
        ctypes.byref(IID_IMMDeviceEnumerator),
        ctypes.byref(enumerator),
    )
    if failed(hr):
        raise RuntimeError(f"CoCreateInstance failed: 0x{hr & 0xFFFFFFFF:08x}")

    collection = ctypes.c_void_p()
    enum_fn = com_call(
        enumerator, 3, HRESULT, ctypes.c_int, wt.DWORD, ctypes.POINTER(ctypes.c_void_p)
    )
    hr = enum_fn(enumerator, eCapture, DEVICE_STATE_ACTIVE, ctypes.byref(collection))
    if failed(hr):
        raise RuntimeError(f"EnumAudioEndpoints failed: 0x{hr & 0xFFFFFFFF:08x}")

    count = wt.DWORD()
    get_count = com_call(collection, 3, HRESULT, ctypes.POINTER(wt.DWORD))
    get_count(collection, ctypes.byref(count))

    devices = []
    item_fn = com_call(
        collection, 4, HRESULT, wt.DWORD, ctypes.POINTER(ctypes.c_void_p)
    )
    for i in range(count.value):
        dev = ctypes.c_void_p()
        if failed(item_fn(collection, i, ctypes.byref(dev))):
            continue
        get_id = com_call(dev, 5, HRESULT, ctypes.POINTER(ctypes.c_wchar_p))
        sid = ctypes.c_wchar_p()
        get_id(dev, ctypes.byref(sid))
        devices.append((i, sid.value or ""))
    return devices


def record(device_index, seconds, out_path):
    """
    用 WASAPI 共享模式录一段音频，重采样成 16kHz / 单声道 / PCM16 WAV。

    @returns dict：成功 {ok: True, path, seconds, peak, frames}；失败 {ok: False, reason, message}
    """
    ole32.CoInitialize(None)

    enumerator = ctypes.c_void_p()
    hr = ole32.CoCreateInstance(
        ctypes.byref(CLSID_MMDeviceEnumerator),
        None,
        1,
        ctypes.byref(IID_IMMDeviceEnumerator),
        ctypes.byref(enumerator),
    )
    if failed(hr):
        return {"ok": False, "reason": "open-failed", "message": f"enumerator 0x{hr & 0xFFFFFFFF:08x}"}

    collection = ctypes.c_void_p()
    enum_fn = com_call(
        enumerator, 3, HRESULT, ctypes.c_int, wt.DWORD, ctypes.POINTER(ctypes.c_void_p)
    )
    if failed(enum_fn(enumerator, eCapture, DEVICE_STATE_ACTIVE, ctypes.byref(collection))):
        return {"ok": False, "reason": "no-device", "message": "枚举录音设备失败"}

    count = wt.DWORD()
    com_call(collection, 3, HRESULT, ctypes.POINTER(wt.DWORD))(collection, ctypes.byref(count))
    if count.value == 0:
        return {"ok": False, "reason": "no-device", "message": "没有活动的录音设备"}
    if device_index >= count.value:
        return {
            "ok": False,
            "reason": "no-device",
            "message": f"设备序号 {device_index} 超出范围（共 {count.value} 个）",
        }

    device = ctypes.c_void_p()
    item_fn = com_call(collection, 4, HRESULT, wt.DWORD, ctypes.POINTER(ctypes.c_void_p))
    if failed(item_fn(collection, device_index, ctypes.byref(device))):
        return {"ok": False, "reason": "no-device", "message": "取设备失败"}

    audio_client = ctypes.c_void_p()
    activate = com_call(
        device, 3, HRESULT, ctypes.POINTER(GUID), wt.DWORD, ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
    )
    hr = activate(device, ctypes.byref(IID_IAudioClient), 1, None, ctypes.byref(audio_client))
    if failed(hr):
        return {"ok": False, "reason": "open-failed", "message": f"Activate 0x{hr & 0xFFFFFFFF:08x}"}

    # 拿设备原生混音格式：这台机器是 4ch/48k/float32，waveIn 的老接口协商不了
    mix_ptr = ctypes.c_void_p()
    get_mix = com_call(audio_client, 8, HRESULT, ctypes.POINTER(ctypes.c_void_p))
    hr = get_mix(audio_client, ctypes.byref(mix_ptr))
    if failed(hr):
        return {"ok": False, "reason": "open-failed", "message": f"GetMixFormat 0x{hr & 0xFFFFFFFF:08x}"}

    fmt = ctypes.cast(mix_ptr, ctypes.POINTER(WAVEFORMATEX)).contents
    channels = fmt.nChannels
    rate = fmt.nSamplesPerSec
    bits = fmt.wBitsPerSample
    block_align = fmt.nBlockAlign
    is_float = fmt.wFormatTag == 3 or (fmt.wFormatTag == 0xFFFE and bits == 32)

    if block_align <= 0 or channels <= 0 or rate <= 0:
        return {"ok": False, "reason": "open-failed", "message": f"混音格式非法：{channels}ch/{rate}Hz/{bits}bit"}

    # 缓冲给足：按秒数 + 一点余量
    duration_units = int((seconds + 1) * 10_000_000)  # 100ns
    initialize = com_call(
        audio_client, 3, HRESULT, ctypes.c_int, wt.DWORD, ctypes.c_long, ctypes.c_long,
        ctypes.c_void_p, ctypes.c_void_p,
    )
    hr = initialize(
        audio_client, AUDCLNT_SHAREMODE_SHARED, 0, duration_units, 0, mix_ptr, None
    )
    if failed(hr):
        return {"ok": False, "reason": "open-failed", "message": f"Initialize 0x{hr & 0xFFFFFFFF:08x}"}

    capture = ctypes.c_void_p()
    get_service = com_call(
        audio_client, 14, HRESULT, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)
    )
    hr = get_service(audio_client, ctypes.byref(IID_IAudioCaptureClient), ctypes.byref(capture))
    if failed(hr):
        return {"ok": False, "reason": "open-failed", "message": f"GetService 0x{hr & 0xFFFFFFFF:08x}"}

    start = com_call(audio_client, 10, HRESULT)
    if failed(start(audio_client)):
        return {"ok": False, "reason": "open-failed", "message": "Start 失败"}

    get_packet_size = com_call(
        capture, 5, HRESULT, ctypes.POINTER(ctypes.c_uint32)
    )
    get_buffer = com_call(
        capture, 3, HRESULT, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_uint32),
        ctypes.POINTER(wt.DWORD), ctypes.POINTER(wt.DWORD), ctypes.POINTER(wt.DWORD),
    )
    release_buffer = com_call(capture, 4, HRESULT, ctypes.c_uint32)

    chunks = []
    total_frames = 0
    deadline = time.time() + seconds
    # 允许最后一点尾巴：停止条件按时间，但把已经排队的包取完
    while time.time() < deadline:
        packet = ctypes.c_uint32()
        if failed(get_packet_size(capture, ctypes.byref(packet))) or packet.value == 0:
            time.sleep(0.01)
            continue
        data = ctypes.c_void_p()
        frames = ctypes.c_uint32()
        flags = wt.DWORD()
        devpos = wt.DWORD()
        qpc = wt.DWORD()
        hr = get_buffer(
            capture, ctypes.byref(data), ctypes.byref(frames), ctypes.byref(flags),
            ctypes.byref(devpos), ctypes.byref(qpc),
        )
        if failed(hr):
            break
        if frames.value:
            chunks.append(ctypes.string_at(data, frames.value * block_align))
            total_frames += frames.value
        release_buffer(capture, frames.value)

    stop = com_call(audio_client, 11, HRESULT)
    stop(audio_client)

    if total_frames == 0:
        return {
            "ok": False,
            "reason": "no-data",
            "message": "录音设备没有返回任何数据（检查麦克风是否被占用或静音）",
        }

    # 解交错 + 取第 1 声道 + 重采样到 16kHz
    pcm = b"".join(chunks)
    mono = extract_first_channel(pcm, channels, bits, is_float)
    resampled = resample_to_16k(mono, rate)
    peak = max((abs(v) for v in resampled), default=0) / 32768.0

    write_wav(out_path, resampled)
    return {
        "ok": True,
        "path": out_path,
        "seconds": round(total_frames / rate, 2),
        "peak": round(peak, 4),
        "frames": len(resampled),
        "format": f"{channels}ch/{rate}Hz/{bits}bit",
    }


def extract_first_channel(pcm, channels, bits, is_float):
    """从交错数据里取第 1 声道，转成 [-1,1] 的浮点列表。"""
    if bits == 32 and is_float:
        values = struct.unpack(f"<{len(pcm) // 4}f", pcm[: (len(pcm) // 4) * 4])
        return list(values[0::channels])
    if bits == 16:
        values = struct.unpack(f"<{len(pcm) // 2}h", pcm[: (len(pcm) // 2) * 2])
        return [v / 32768.0 for v in values[0::channels]]
    if bits == 32:
        values = struct.unpack(f"<{len(pcm) // 4}i", pcm[: (len(pcm) // 4) * 4])
        return [v / 2147483648.0 for v in values[0::channels]]
    if bits == 24:
        out = []
        step = 3 * channels
        for i in range(0, len(pcm) - step + 1, step):
            raw = pcm[i] | (pcm[i + 1] << 8) | (pcm[i + 2] << 16)
            if raw & 0x800000:
                raw -= 1 << 24
            out.append(raw / 8388608.0)
        return out
    raise RuntimeError(f"不支持的位深：{bits}（float={is_float}）")


def resample_to_16k(samples, src_rate, target=16000):
    """
    线性插值重采样到 16kHz，输出 Int16 数组。

    语音识别对音质要求不高，线性插值足够；比重新协商格式稳得多。
    """
    if src_rate == target:
        return array.array("h", (int(max(-1.0, min(1.0, v)) * 32767) for v in samples))
    n_out = int(len(samples) * target / src_rate)
    out = array.array("h")
    ratio = src_rate / target
    last = len(samples) - 1
    for i in range(n_out):
        pos = i * ratio
        left = int(pos)
        if left >= last:
            v = samples[last]
        else:
            frac = pos - left
            v = samples[left] * (1 - frac) + samples[left + 1] * frac
        if v > 1.0:
            v = 1.0
        elif v < -1.0:
            v = -1.0
        out.append(int(v * 32767))
    return out


def write_wav(path, pcm16, rate=16000, channels=1, bits=16):
    """写一个裸 PCM 的 WAV（44 字节头）。"""
    data = pcm16.tobytes()
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(b"RIFF")
        fh.write(struct.pack("<I", 36 + len(data)))
        fh.write(b"WAVE")
        fh.write(b"fmt ")
        fh.write(
            struct.pack(
                "<IHHIIHH", 16, 1, channels, rate, rate * channels * bits // 8,
                channels * bits // 8, bits,
            )
        )
        fh.write(b"data")
        fh.write(struct.pack("<I", len(data)))
        fh.write(data)


def main():
    parser = argparse.ArgumentParser(description="dsh-pet-voice 录音器")
    parser.add_argument("--out", default="", help="输出 WAV 路径（--list 时不需要）")
    parser.add_argument("--seconds", type=float, default=8.0, help="录音时长（秒）")
    parser.add_argument("--device", type=int, default=0, help="录音设备序号")
    parser.add_argument("--list", action="store_true", help="只列出设备")
    args = parser.parse_args()

    try:
        if args.list:
            devices = enumerate_capture_devices()
            print(json.dumps({"ok": True, "devices": [{"index": i, "id": s} for i, s in devices]}, ensure_ascii=False))
            return 0
        if not args.out:
            parser.error("--out 是必需的（除非用 --list）")
        seconds = max(0.5, min(args.seconds, 120.0))
        result = record(args.device, seconds, args.out)
    except Exception as exc:  # noqa: BLE001 - 任何异常都要变成可读 JSON，不能静默
        result = {"ok": False, "reason": "error", "message": f"{type(exc).__name__}: {exc}"}

    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
