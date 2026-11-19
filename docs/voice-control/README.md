# dsh-pet 语音控制改动记录

本目录记录让 **dsh-pet 支持「说一句话就驱动桌宠」** 所需的配置改动，以及配套插件
[`plugins/dsh-pet-voice/`](../../plugins/dsh-pet-voice/) 的用法。

改动分两部分：

| 部分 | 位置 | 性质 |
| --- | --- | --- |
| ① dsh-pet 的识别器配置 | `~/.dsh/dsh-pet/main-config.jsonc`（用户数据，**不在本仓库**） | 配置项修正 |
| ② 语音指令插件 | [`plugins/dsh-pet-voice/`](../../plugins/dsh-pet-voice/) | 独立插件包 |

---

## ① 为什么要改 dsh-pet 的配置

dsh-pet **0.4.9 已经内置 DeepSeek 官方 ASR 实现**（`POST https://api.deepseek.com/v1/tools/asr`），
但默认的 `speechProvider` 指向了 `dsh`——那需要另外安装 DSH 官方语音输入插件，没装时识别会失败：

```
POST /dsh-pet-7340/voice/hear  {"provider":"dsh"}
→ 200 {"ok":false,"reason":"unsupported","message":"host has no speech-to-text service"}
```

改成 `deepseek` 即可直接使用内置实现，鉴权复用 DSH 凭据里的 `DEEPSEEK_API_KEY`：

```
POST /dsh-pet-7340/voice/hear  {"provider":"deepseek"}
→ 200 {"ok":true,"text":"..."}
```

`GET /dsh-pet-7340/voice/hear-providers` 可以看到两个实现都在册：

```json
{"ok":true,"providers":[{"id":"dsh","name":"DSH 语音插件"},{"id":"deepseek","name":"DeepSeek"}]}
```

### 需要改的两个字段

编辑 `~/.dsh/dsh-pet/main-config.jsonc`：

```jsonc
{
  "speechProvider": "deepseek",              // 改这里：原来可能是 "dsh"
  "voiceName": "edge/zh-CN-XiaoyiNeural",    // 补 provider/ 前缀，见下方说明
  // ... 其余字段保持不变
}
```

**关于 `voiceName`**：这个字段必须是 `provider/音色` 形态（dsh-pet 的 `validate.ts` 里有
`VOICE_ID_PATTERN` 校验）。如果磁盘上存的是裸音色名（如 `zh-CN-XiaoyiNeural`），那么通过
`PUT /config` 保存配置时**整包校验会失败**，任何设置都存不进去——报错信息只会说
`invalid pet config: expected { pets:[...] }`，很难定位到是音色字段的问题。
补上 `edge/` 前缀即可（与 `GET /config` 返回的生效值一致，行为不变）。

### 两种改法

**改法 A：直接编辑文件**（推荐，最直接）

打开 `~/.dsh/dsh-pet/main-config.jsonc`，按上面的片段改两个字段，保存。改动即时生效，
`GET /dsh-pet-7340/config` 会立刻反映新值。

**改法 B：走 HTTP 写接口**

`PUT /dsh-pet-7340/config` 是**白名单整包重建**，不是局部更新——必须提交完整的 `pets` 数组
和所有你想保留的顶层字段，漏传的字段会从磁盘旧文件透传保留，但 `pets` 必须给全：

```bash
curl -X PUT http://127.0.0.1:<dsh端口>/dsh-pet-7340/config \
  -H 'content-type: application/json' \
  --data @main-config.jsonc
```

> 注意：`pets` 在配置里是**每个条目各自的字段**（`main` 条目 + 各文件宠物条目各有一份），
> 不是顶层字段。读配置时不要只看顶层或只看 `main`。

### 验证

```bash
# 1. 确认识别器已切换
curl http://127.0.0.1:<dsh端口>/dsh-pet-7340/config    # 看 main.speechProvider 是否为 deepseek

# 2. 确认默认识别通道可用（不传 provider，走配置里的默认值）
curl -X POST http://127.0.0.1:<dsh端口>/dsh-pet-7340/voice/hear \
  -H 'content-type: application/json' \
  -d '{"audio":"<base64 的 16kHz 单声道 PCM16 WAV>"}'
# 期望：{"ok":true,"text":"..."}
```

音频格式是硬要求：**16 位 PCM WAV 或 Ogg Opus**，单声道或双声道（双声道只识别左声道），
单请求最长 120 秒、最大 8 MiB。传 MP3 会被拒绝：

```
400 Unsupported audio format: expected 16-bit PCM WAV or Ogg Opus
```

---

## ② 语音指令插件

`dsh-pet` 自带的 `/voice/hear` 只把语音**转成文字填进输入框**，没有「语音 → 宠物动作」这一层。
[`plugins/dsh-pet-voice/`](../../plugins/dsh-pet-voice/) 补上这一层：

```
右键桌宠 →「语音控制」
  → 宿主侧 WASAPI 录音（4ch/48k/float32 → 16kHz 单声道 PCM16 WAV）
  → 直接 POST https://api.deepseek.com/v1/tools/asr（DeepSeek 官方语音识别）
  → 拿回 { request_id, text, duration_ms }
  → 解析成指令
  → POST /anim、/sleep、/wake、/position、/throw 驱动桌宠
```

**识别直接打官方接口，不经 dsh-pet 中转。** 鉴权用 DSH 凭据里的 `DEEPSEEK_API_KEY`，
经 `ctx.credentials` 每次现取、用完即弃，不缓存、不落盘、不进日志。

**录音在宿主侧，不在浏览器。** 宠物活在 dsh-pet 的桌面 Electron 窗口里，那个窗口加载的是
dsh-pet 自己的页面，配套插件的代码不在里面；而浏览器录音要求页面处于焦点、需要用户手势、
还要麦克风权限——右键点的是桌面窗口，不是网页。宿主侧录音绕开全部这些问题。

安装与用法见该目录的 [`README.md`](../../plugins/dsh-pet-voice/README.md)。

---

## ③ 实测记录

在本机（Windows，dsh-pet 0.4.9，desktop profile，Python 3.13）实测通过：

| 项目 | 结果 |
| --- | --- |
| `POST /v1/tools/asr` 直连（带 `DEEPSEEK_API_KEY`） | `200`，密钥有效 |
| `/voice/hear` + `provider=deepseek` | `200 {"ok":true}` |
| `/voice/hear` + `provider=dsh` | `200 {"ok":false,"reason":"unsupported"}`（改动前的问题） |
| `/menu/item` 注册 + `/state` 可见 | `200 {"ok":true}`，菜单里出现「语音控制」 |
| `/menu/click` → `/menu/events` | 点击投递成功，轮询取到 `{"语音控制":"main"}` |
| Python WASAPI 录音 | 8 秒采到 384000 帧（4ch/48k），重采样为 16k 单声道 |
| 录音 WAV → ASR | `200`，返回真实转写文本 |
| 端到端：点菜单 → 录音 → 识别 → 桌宠反应 | **通过**，桌宠先弹「我在听…」，识别后按结果弹气泡 |
| 指令解析（18 条用例） | 全部命中预期动作 |

### 排查过程中值得记下的几个坑

1. **`pets` 不在顶层**——它在每个条目（`main`、文件宠物）各自的配置里。
   按 `cfg.pets` 读会拿到 `undefined`。
2. **`PUT /config` 是整包白名单重建**——不是 PATCH。提交不完整或某个字段形态非法
   （例如裸音色名）会导致整包 `400`，报错信息只提 `pets`，不指出真正出错的字段。
3. **`waveIn` 录不到这台机器的麦克风**——设备能打开、`waveInStart` 返回成功，但
   `dwBytesRecorded = 0`、`waveInGetPosition = 0`。原因是麦克风原生格式是
   **4 声道 / 48000 Hz / 32 位浮点**（`WAVE_FORMAT_EXTENSIBLE`），`waveIn` 只吃整数 PCM，
   格式协商"成功"却出不了数据。必须走 WASAPI 的 `IAudioClient::GetMixFormat` 拿原生格式。
4. **`fetch` 的 GET 不能带 body**——`Request with GET/HEAD method cannot have body` 会直接抛。
   统一封装的请求函数必须按方法区分，否则 GET 长轮询永远失败、菜单点击收不到。
5. **Cordis 的 `ctx` 不能随意赋值**——`ctx.disposed = true` 会报
   `cannot set property "disposed" without provide`，生命周期标记要用闭包变量。
