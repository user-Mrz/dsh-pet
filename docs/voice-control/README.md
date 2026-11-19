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
按住话筒说话
  → 采集 16kHz / 单声道 / PCM16 WAV
  → POST /dsh-pet-7340/voice/hear（provider=deepseek）
  → 解析成指令
  → POST /anim、/sleep、/wake、/position、/throw、/broadcast 驱动桌宠
```

安装与用法见该目录的 [`README.md`](../../plugins/dsh-pet-voice/README.md)。

---

## ③ 实测记录

在本机（Windows，dsh-pet 0.4.9，desktop profile）实测通过：

| 项目 | 结果 |
| --- | --- |
| `POST /v1/tools/asr` 直连（带 `DEEPSEEK_API_KEY`） | `200`，密钥有效 |
| `/voice/hear` + `provider=deepseek` | `200 {"ok":true}` |
| `/voice/hear` + `provider=dsh` | `200 {"ok":false,"reason":"unsupported"}`（改动前的问题） |
| 插件产出的 16kHz 单声道 PCM16 WAV | 被 ASR 接受（`200`） |
| MP3 输入 | `400 Unsupported audio format`（符合官方限制） |
| `/anim` `/sleep` `/wake` `/position` `/throw` `/broadcast` | 全部 `200 ok:true` |
| 指令解析（26 条用例） | 全部命中预期动作 |

**未验证**：真实人声的完整闭环。测试机上 Windows SAPI 合成语音会挂起（`Speak` 不返回），
无法生成中文语音样本，所以「识别文字 → 驱动宠物」这段是用模拟文字验证的，
录音与识别两段各自单独验证过。建议安装后按住话筒说一句「跳个舞」自行确认。

### 排查过程中值得记下的两个坑

1. **`pets` 不在顶层**——它在每个条目（`main`、文件宠物）各自的配置里。
   按 `cfg.pets` 读会拿到 `undefined`。
2. **`PUT /config` 是整包白名单重建**——不是 PATCH。提交不完整或某个字段形态非法
   （例如裸音色名）会导致整包 `400`，报错信息只提 `pets`，不指出真正出错的字段。
