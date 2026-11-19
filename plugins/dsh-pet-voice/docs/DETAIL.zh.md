![Voice-controlled pet](preview.svg)

# 语音控制桌宠

右键点桌宠 → 「语音控制」→ 说一句话，桌宠照着做。

## 怎么用

1. 确认 **dsh-pet** 已安装并启用（桌宠要真的在桌面上）。
2. **右键点桌宠**，菜单最后面的「更多」里有 **语音控制**。
3. 点它，桌宠弹一句「我在听…」，开始录音 **8 秒**。
4. 说完它把这句话变成动作，并弹气泡告诉你它理解成了什么。

录音在宿主侧完成，**不需要开着 DSH 网页**，也不需要按任何额外的按钮。

## 会听懂什么

| 你说 | 桌宠做什么 |
| --- | --- |
| 跳个舞 / 女仆舞 / 宅舞 | 播对应舞蹈 |
| 睡吧 / 晚安 / 去睡 | 睡下 |
| 醒醒 / 起床 | 醒来 |
| 到左边 / 到右边 / 回来 / 上去 / 下来 | 走到对应位置 |
| 扔出去 / 甩出去 | 被甩飞 |
| 吃白饭 / 吃西瓜 / 涮火锅 / 吃零食 | 播对应吃东西动画 |
| 魔方 / 撸猫 / 放烟花 / 堆雪人 / 收红包 | 播对应动画 |

也可以直接说**动作的完整名字**（「原地专心玩魔方」「涮火锅」「悠闲哼歌」）——插件先按关键词匹配，没命中再把整句话与配置里的动画名做包含匹配。

认不出来时桌宠会弹「没听懂」并把原话一起带出来，这样你能看出是**识别错了**还是**没匹配上关键词**。

## 为什么录音在宿主侧

宠物活在 dsh-pet 的桌面 Electron 窗口里，那个窗口加载的是 dsh-pet 自己的页面，本插件的代码不在里面。而浏览器录音要求页面处于焦点、需要用户手势、还要麦克风权限——右键点的是桌面窗口，不是网页。

宿主侧录音绕开全部这些问题：点完菜单直接录，与页面是否打开无关。

## 为什么用 Python

这台机器的麦克风原生格式是 **4 声道 / 48000 Hz / 32 位浮点**（`WAVE_FORMAT_EXTENSIBLE`）。Windows 的 `waveIn` 老接口只吃整数 PCM，协商会「成功」但一个采样都录不到（实测 `dwBytesRecorded = 0`、`waveInGetPosition = 0`）。

所以必须走 WASAPI 拿原生混音格式，再自己重采样成 ASR 要求的 16 kHz / 单声道 / PCM16。Node 没有现成的 Windows 音频库，而 Python 用 `ctypes` 调 COM 就行，**零第三方依赖**。

## 语音识别走哪条路

识别用的是 DeepSeek 官方语音识别接口 `POST https://api.deepseek.com/v1/tools/asr`，由 **dsh-pet 内置的实现**发起：

- 音频：16 kHz / 单声道 / 16 位 PCM 的 WAV，一次请求发完整段，返回完整转写文本；
- 鉴权：DSH 凭据里的 `DEEPSEEK_API_KEY`，由 dsh-pet 解析；
- 本插件只把音频 POST 给本机的 dsh-pet 路由 `/dsh-pet-7340/voice/hear`（`provider=deepseek`），只接收文字。

**本插件不读取、不保存、不转发任何 API Key。**

## 配置

Python 解释器路径可用环境变量 `DSH_PET_VOICE_PYTHON` 覆盖。不设时自动探测：

- Windows：`C:\python\python.exe` → `C:\Python313\python.exe` → `C:\Python312\python.exe` → PATH 上的 `python`
- 其它：`/usr/bin/python3` → `/usr/local/bin/python3` → `/opt/homebrew/bin/python3` → PATH 上的 `python3`

## 限制

- 需要 **dsh-pet 0.4.9 或更新**：`/menu/item` 与 `/anim`、`/sleep`、`/position` 等动作端点都是它提供的。
- 需要 `DEEPSEEK_API_KEY` 已配置，否则识别返回 `unsupported`，桌宠提示「宿主没开语音识别」。
- 需要本机有 **Python 3**（实测 3.13）。
- 单次录音固定 8 秒（脚本支持 0.5–120 秒，改 `RECORD_SECONDS` 即可）。
- 识别按音频时长计费，费用记在你的 DeepSeek 账号上。
- 录制的是默认录音设备（WASAPI 序号 0）。
