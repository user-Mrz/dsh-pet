/**
 * dsh-pet-voice —— 宿主半侧。
 *
 * 在 dsh-pet 的右键菜单里加一项「语音控制」，点了之后：
 *
 *   宿主侧录音（Python + WASAPI，4ch/48k/float32 → 16kHz 单声道 PCM16 WAV）
 *     → 直接 POST https://api.deepseek.com/v1/tools/asr（DeepSeek 官方语音识别）
 *     → 拿回 { request_id, text, duration_ms }
 *     → 把 text 解析成一条指令
 *     → POST dsh-pet 的 /anim、/sleep、/wake、/position、/throw、/broadcast 驱动桌宠
 *
 * 全程在宿主进程里完成，不需要浏览器：麦克风、录音、识别、动作一条链。
 * 识别不经 dsh-pet 中转，直接打官方接口；鉴权用 DSH 凭据里的 DEEPSEEK_API_KEY，
 * 每次识别现取、用完即弃，不缓存、不落盘、不打日志。
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachChatControl } from './chat-control.js'

/** dsh-pet 注册在宿主上的路由段；与 dsh-pet 的 shared/constants.ts 同值。 */
const PET_ROUTE_SEGMENT = '/dsh-pet-7340'

/** DeepSeek 官方语音识别端点；整段上传、整段返回，不支持流式。 */
const DEEPSEEK_ASR_ENDPOINT = 'https://api.deepseek.com/v1/tools/asr'

/** 本插件在 dsh-pet 菜单里的 owner 标识。 */
const MENU_OWNER = 'dsh-pet-voice'

/** 菜单项文案（dsh-pet 限制 label ≤ 32 字符、禁控制字符）。 */
const MENU_LABEL = '语音控制'

/** 依赖：webServer 拼本机地址，credentials 取 DEEPSEEK_API_KEY，llm + agentDefaultModel 理解自然语言。 */
export const inject = ['webServer', 'credentials', 'llm', 'agentDefaultModel']

/** 包根目录：用来定位 python/record.py。 */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * 写一行诊断到插件目录下的 voice.log。
 *
 * 桌面模式的 DSH 没有控制台，`ctx.logger` 的输出也不容易看到；语音控制涉及
 * 子进程、网络、凭据三处外部依赖，出问题时需要一个能直接打开看的地方。
 * 只记时间、级别与消息，**不记音频内容、不记 API Key**。
 *
 * @param {'info'|'warn'|'error'} level - 级别。
 * @param {string} message - 消息正文。
 */
function writeDiagnostic(level, message) {
  try {
    mkdirSync(PACKAGE_ROOT, { recursive: true })
    appendFileSync(join(PACKAGE_ROOT, 'voice.log'), `${new Date().toISOString()} [${level}] ${message}\n`)
  } catch {
    /* 写不了就算了：诊断不该反过来影响功能 */
  }
}

/** 录音时长（秒）。 */
const RECORD_SECONDS = 8

/** 判静音的峰值阈值：低于它视为没说话，不白送一次识别。 */
const SILENCE_PEAK = 0.002

// ============================================================================
// 关键词 → 动作
// ============================================================================

/**
 * 关键词表。按顺序匹配，先命中先用。
 *
 * 具体舞种必须排在通用「舞」之前：通用词放前面会把「女仆舞」「宅舞」一并吞成同一种舞。
 * 关键词写得宽一点：语音转写会掉字、会加语气词，短词反而更容易命中。
 */
const KEYWORD_RULES = [
  // —— 睡眠 ——
  { keys: ['睡觉', '睡吧', '去睡', '睡一会', '睡一会儿', '晚安', '休息吧', '歇一会'], action: 'sleep' },
  { keys: ['醒来', '醒醒', '起床', '别睡', '起来吧', '别睡了'], action: 'wake' },
  // —— 位置与抛掷 ——
  { keys: ['扔出去', '扔了', '抛出去', '甩出去', '飞出去', '扔飞'], action: 'throw' },
  { keys: ['到左边', '去左边', '左边'], action: 'position', x: 0.2, y: 0.65 },
  { keys: ['到右边', '去右边', '右边'], action: 'position', x: 0.8, y: 0.65 },
  { keys: ['到中间', '去中间', '中间', '回来'], action: 'position', x: 0.5, y: 0.65 },
  { keys: ['上去', '到上面', '上面'], action: 'position', x: 0.5, y: 0.25 },
  { keys: ['下来', '到下面', '下面'], action: 'position', x: 0.5, y: 0.8 },
  // —— 动画 ——
  { keys: ['女仆舞', '优雅的舞', '优雅舞'], anim: '优雅女仆舞' },
  { keys: ['宅舞', '可爱舞'], anim: '可爱宅舞' },
  { keys: ['跳舞', '跳个舞', '跳一支舞', '舞'], anim: '轻快摇摆舞' },
  { keys: ['魔方'], anim: '原地专心玩魔方' },
  { keys: ['伸懒腰', '懒腰'], anim: '超大伸懒腰' },
  { keys: ['打哈欠', '哈欠'], anim: '哈欠连天' },
  { keys: ['吃白饭', '白饭', '吃饭'], anim: '吃白饭' },
  { keys: ['零食'], anim: '大口吃零食' },
  { keys: ['吃西瓜', '西瓜'], anim: '吃西瓜' },
  { keys: ['火锅'], anim: '涮火锅' },
  { keys: ['冰淇淋', '冰激凌'], anim: '吃冰淇淋融化' },
  { keys: ['喝咖啡', '咖啡'], anim: '吃早餐' },
  { keys: ['刷牙'], anim: '晨间刷牙' },
  { keys: ['照镜子', '镜子'], anim: '照镜子' },
  { keys: ['写代码', '代码'], anim: '写代码' },
  { keys: ['撸猫', '猫'], anim: '撸猫' },
  { keys: ['烟花'], anim: '放烟花' },
  { keys: ['红包'], anim: '收红包' },
  { keys: ['堆雪人', '雪人'], anim: '堆雪人' },
  { keys: ['放风筝', '风筝'], anim: '放风筝' },
  { keys: ['荡秋千', '秋千'], anim: '荡秋千' },
  { keys: ['踢毽子', '毽子'], anim: '踢毽子' },
  { keys: ['魔术', '变鸽子'], anim: '变鸽子' },
  { keys: ['小提琴', '拉琴'], anim: '小提琴演奏' },
  { keys: ['吹笛子', '笛子'], anim: '吹笛子' },
  { keys: ['水枪'], anim: '玩水枪' },
  { keys: ['吹气球', '气球'], anim: '吹气球' },
  { keys: ['被吓一跳', '吓一跳', '吓我'], anim: '被吓一跳' },
  { keys: ['生气', '气死了'], anim: '玩游戏气急败坏' },
  { keys: ['拍地', '尾巴'], anim: '用鲸鱼尾巴拍打地面' },
  { keys: ['转圈', '旋转'], anim: '小幅度原地360度旋转展示' },
  { keys: ['偷吃'], anim: '偷吃零食被抓住' },
  { keys: ['睡觉觉', '小憩', '眯一会'], anim: '原地小憩沉眠' },
]

/**
 * 把一句转写文本解析成一条指令。
 *
 * 两级匹配：关键词表 → 配置里的动画名（原样包含）→ 没命中。
 *
 * @param {string} text - 识别出来的文字。
 * @param {readonly string[]} animNames - 该宠物配置里全部可播动画名。
 * @returns {{kind: string, anim?: string, x?: number, y?: number, text?: string}}
 */
export function parseCommand(text, animNames) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw === '') return { kind: 'none', text: '' }
  // 转写会带上标点与语气词；先去掉，让关键词更容易命中
  const clean = raw.replace(/[\s，。！？、,.!?~～…]+/g, '')
  const names = Array.isArray(animNames) ? animNames : []

  for (const rule of KEYWORD_RULES) {
    if (!rule.keys.some((key) => clean.includes(key))) continue
    if (rule.anim !== undefined) {
      // 关键词指向的动画必须真的在该宠物配置里，否则不假装播得出来
      if (names.length > 0 && !names.includes(rule.anim)) continue
      return { kind: 'anim', anim: rule.anim }
    }
    if (rule.action === 'position') return { kind: 'position', x: rule.x, y: rule.y }
    return { kind: rule.action }
  }

  const hit = names.find((name) => typeof name === 'string' && name !== '' && clean.includes(name))
  if (hit !== undefined) return { kind: 'anim', anim: hit }
  return { kind: 'none', text: raw }
}

// ============================================================================
// 桌宠 HTTP
// ============================================================================

/**
 * 请求 dsh-pet 的一个端点。
 *
 * @param {string} base - 本机地址 + 路由前缀。
 * @param {string} path - 带查询串的路径。
 * @param {object} [options] - method / body / timeoutMs。
 * @returns {Promise<any>} 解析后的 JSON；失败给 null。
 */
async function petFetch(base, path, options = {}) {
  const method = options.method ?? 'POST'
  // GET 不能带 body：fetch 会直接抛 "Request with GET/HEAD method cannot have body"。
  // 只有真的要给 body 时才拼请求体与 content-type。
  const hasBody = method !== 'GET' && method !== 'HEAD'
  try {
    const res = await fetch(base + path, {
      method,
      headers: hasBody ? { 'content-type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(options.body ?? {}) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    })
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

/**
 * 让模型把一句话理解成一条指令。
 *
 * 关键词表只能覆盖「恰好说到那几个词」的说法；实测里用户说的常常是
 * 「有些工具啊，我问一下他用了哪些工具」这种自然句子，关键词一个都不中。
 * 所以先试关键词（快、免费、确定），没命中再问模型。
 *
 * 模型只负责从给定清单里挑一个动作名并给出参数，不能凭空发明动画——
 * 清单就是该宠物配置里真实存在的那些，挑不到就回 null，由调用方提示「没听懂」。
 *
 * @param {any} ctx - 宿主上下文。
 * @param {string} text - 识别出来的文字。
 * @param {readonly string[]} animNames - 该宠物可播的全部动画名。
 * @returns {Promise<{kind: string, anim?: string, x?: number, y?: number} | null>}
 */
async function interpretWithModel(ctx, text, animNames) {
  const llm = ctx.llm
  if (!llm || typeof llm.stream !== 'function') return null
  const selection = ctx.agentDefaultModel?.currentSelection?.()
  if (!selection || !selection.provider || !selection.model) return null

  // 动作清单：模型只能从这里面挑，避免它编出播不出来的名字
  const actions = animNames.length > 0 ? animNames.join('、') : '（无可用动画）'
  const system =
    '你是一个指令解析器。把用户说的话解析成对桌面宠物的一个动作。\n' +
    '只能输出一行 JSON，不要解释、不要 markdown 代码块。\n' +
    '可用动作（动画名必须原样取自下列清单）：\n' +
    actions +
    '\n\n可用控制动作（不在动画清单里，直接写这些名字）：\n' +
    'sleep（睡觉）、wake（醒来）、throw（被扔出去）、move-left（去左边）、move-right（去右边）、move-center（回中间）、move-up（去上面）、move-down（去下面）\n\n' +
    '输出格式：\n' +
    '{"kind":"anim","anim":"<清单里的动画名>"}  或  {"kind":"control","action":"sleep"}\n' +
    '如果这句话与宠物动作无关（比如在聊工作、讨论工具、随口说话），输出 {"kind":"none"}。\n' +
    '判断要保守：拿不准就输出 none，不要硬凑一个动作。'

  let out = ''
  try {
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      system,
      temperature: 0,
      signal: AbortSignal.timeout(20_000),
    })
    for await (const chunk of stream) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      if (chunk && chunk.type === 'finish') break
    }
  } catch (error) {
    writeDiagnostic('warn', `模型解析失败：${error && error.message ? error.message : String(error)}`)
    return null
  }

  // 从回复里抠出第一个 JSON 对象（模型可能带多余文字或代码块围栏）
  const match = /\{[\s\S]*?\}/.exec(out)
  if (!match) {
    writeDiagnostic('warn', `模型没有给出 JSON：${out.slice(0, 120)}`)
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(match[0])
  } catch {
    writeDiagnostic('warn', `模型 JSON 解析失败：${match[0].slice(0, 120)}`)
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  if (parsed.kind === 'none') return null

  if (parsed.kind === 'anim') {
    const anim = typeof parsed.anim === 'string' ? parsed.anim : ''
    // 必须真实存在于配置里：模型编出来的名字播不了
    if (anim === '' || (animNames.length > 0 && !animNames.includes(anim))) {
      writeDiagnostic('warn', `模型给了不存在的动画：${anim}`)
      return null
    }
    return { kind: 'anim', anim }
  }

  if (parsed.kind === 'control') {
    const action = typeof parsed.action === 'string' ? parsed.action : ''
    if (action === 'sleep' || action === 'wake' || action === 'throw') return { kind: action }
    if (action === 'move-left') return { kind: 'position', x: 0.2, y: 0.65 }
    if (action === 'move-right') return { kind: 'position', x: 0.8, y: 0.65 }
    if (action === 'move-center') return { kind: 'position', x: 0.5, y: 0.65 }
    if (action === 'move-up') return { kind: 'position', x: 0.5, y: 0.25 }
    if (action === 'move-down') return { kind: 'position', x: 0.5, y: 0.8 }
  }
  return null
}

/**
 * 读 dsh-pet 配置：拿到第一只宠物与全部动画名。
 *
 * 成品配置是「条目 → 该条目的配置」，`pets` 在每个条目里，不是顶层字段。
 *
 * @param {string} base - 本机地址 + 路由前缀。
 * @returns {Promise<{petId: string, animNames: string[]} | null>}
 */
async function loadPetInfo(base) {
  const cfg = await petFetch(base, '/config', { method: 'GET' })
  if (!cfg || typeof cfg !== 'object') return null
  let petId = ''
  const names = []
  for (const conf of Object.values(cfg)) {
    if (!conf || typeof conf !== 'object') continue
    if (petId === '' && Array.isArray(conf.pets)) {
      const first = conf.pets.find((p) => p && typeof p === 'object' && typeof p.id === 'string' && p.id !== '')
      if (first) petId = first.id
    }
    const animations = conf.animations
    if (animations && Array.isArray(animations.categories)) {
      for (const category of animations.categories) {
        const actions = category && Array.isArray(category.actions) ? category.actions : []
        for (const name of actions) {
          if (typeof name === 'string' && name !== '' && !names.includes(name)) names.push(name)
        }
      }
    }
  }
  if (petId === '') return null
  return { petId, animNames: names }
}

/**
 * 执行一条指令。
 *
 * @param {string} base - 本机地址 + 路由前缀。
 * @param {object} command - parseCommand 的结果。
 * @param {{petId: string}} pet - 宠物信息。
 * @returns {Promise<{ok: boolean, text: string}>}
 */
async function runCommand(base, command, pet) {
  // surface=any：不看显示端，任何 display 下都通过 dsh-pet 的对齐校验
  const q = `?pet=${encodeURIComponent(pet.petId)}&surface=any`
  if (command.kind === 'anim') {
    const r = await petFetch(base, `/anim${q}`, { body: { name: command.anim } })
    if (r && r.ok === true) return { ok: true, text: `好呀～${command.anim}` }
    return { ok: false, text: `做不到：${(r && r.message) || '没播出来'}` }
  }
  if (command.kind === 'sleep') {
    const r = await petFetch(base, `/sleep${q}`)
    if (r && r.ok === true) return { ok: true, text: '那我睡啦～' }
    return { ok: false, text: `做不到：${(r && r.message) || '睡不着'}` }
  }
  if (command.kind === 'wake') {
    const r = await petFetch(base, `/wake${q}`)
    if (r && r.ok === true) return { ok: true, text: '我醒啦！' }
    return { ok: false, text: `做不到：${(r && r.message) || '叫不醒'}` }
  }
  if (command.kind === 'throw') {
    const r = await petFetch(base, `/throw${q}`, { body: { angle: -60, power: 1 } })
    if (r && r.ok === true) return { ok: true, text: '哇啊啊——' }
    return { ok: false, text: `做不到：${(r && r.message) || '扔不动'}` }
  }
  if (command.kind === 'position') {
    const r = await petFetch(base, `/position${q}`, { body: { x: command.x, y: command.y, mode: 'spring' } })
    if (r && r.ok === true) return { ok: true, text: '来啦～' }
    return { ok: false, text: `做不到：${(r && r.message) || '走不过去'}` }
  }
  return { ok: false, text: '没听懂，再说一次？' }
}

/**
 * 直接把音频发给 DeepSeek 官方语音识别。
 *
 * 对应文档 https://api-docs.deepseek.com/zh-cn/guides/asr：
 *   POST https://api.deepseek.com/v1/tools/asr
 *   multipart/form-data，`file` 字段放音频；返回 { request_id, text, duration_ms }。
 *
 * 只收 16 位 PCM WAV 或 Ogg Opus；我们的录音器产出的就是 16kHz 单声道 PCM16 WAV。
 * 鉴权用 DSH 凭据里的 DEEPSEEK_API_KEY——本插件每次现取，不缓存、不落盘、不打日志。
 *
 * @param {string} apiKey - DeepSeek API Key。
 * @param {Uint8Array} audio - WAV 字节。
 * @param {AbortSignal} [signal] - 超时/取消信号。
 * @returns {Promise<{ok: true, text: string, durationMs: number} | {ok: false, reason: string, message: string}>}
 */
async function transcribeWithDeepSeek(apiKey, audio, signal) {
  const form = new FormData()
  // 官方按文件内容判断格式，这里的 MIME 只影响服务端选路
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav')
  try {
    const res = await fetch(DEEPSEEK_ASR_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: signal ?? AbortSignal.timeout(45_000),
    })
    const raw = await res.text()
    let body = null
    try {
      body = JSON.parse(raw)
    } catch {
      /* 非 JSON：下面按状态码报 */
    }
    if (!res.ok) {
      // 官方错误体是 { error: { message, type, code } }
      const detail =
        body && body.error && typeof body.error.message === 'string' ? body.error.message : raw.slice(0, 200)
      return { ok: false, reason: `http-${res.status}`, message: detail }
    }
    if (!body || typeof body.text !== 'string') {
      return { ok: false, reason: 'invalid-body', message: '识别响应里没有 text 字段' }
    }
    return {
      ok: true,
      text: body.text,
      durationMs: typeof body.duration_ms === 'number' ? body.duration_ms : 0,
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    return { ok: false, reason: 'network', message }
  }
}

/**
 * 读 DEEPSEEK_API_KEY。
 *
 * 每次识别现取，改配置不必重启；取不到就是没配，不猜、不读别的来源。
 *
 * `ctx.credentials.resolve` 收的是一个「凭据引用」——它在运行时就是一个环境变量名
 * 字符串（`credentialRef()` 只做校验与类型标记）。所以这里直接传裸字符串，
 * 不 import `@deepseek-ai/dsh-credentials`：那个包只在 DSH 安装目录里，
 * 工作区里的插件解析不到，import 会让整个模块加载失败。
 *
 * @param {any} ctx - 宿主上下文。
 * @returns {Promise<string | undefined>}
 */
async function resolveDeepseekKey(ctx) {
  try {
    const resolved = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
    return resolved && typeof resolved.value === 'string' && resolved.value !== '' ? resolved.value : undefined
  } catch {
    return undefined
  }
}

/**
 * 让桌宠弹一句话（投喂，不生成）。
 *
 * @param {string} base - 本机地址 + 路由前缀。
 * @param {string} text - 要显示的文字。
 * @param {{petId: string}} pet - 宠物信息。
 */
async function sayToPet(base, text, pet) {
  const q = `?pet=${encodeURIComponent(pet.petId)}&surface=any`
  await petFetch(base, `/broadcast${q}`, { body: { text, duration: 5000, anim: false } })
}

// ============================================================================
// 录音
// ============================================================================

/**
 * 找 Python 解释器。
 *
 * 优先用环境变量 DSH_PET_VOICE_PYTHON（给不想改 patch 的用户一个逃生口），
 * 其次探测常见绝对路径，最后退回裸命令名交给 PATH。
 *
 * @returns {string} 要交给 spawn 的可执行文件（可能是绝对路径或裸命令名）。
 */
function resolvePython() {
  const fromEnv = process.env.DSH_PET_VOICE_PYTHON
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const absolute =
    process.platform === 'win32'
      ? ['C:\\python\\python.exe', 'C:\\Python313\\python.exe', 'C:\\Python312\\python.exe']
      : ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3']
  for (const candidate of absolute) {
    if (existsSync(candidate)) return candidate
  }
  // 都找不到就交给 PATH：spawn 报 ENOENT 时由 runRecorder 转成可读失败，不在这里猜
  return process.platform === 'win32' ? 'python' : 'python3'
}

/**
 * 跑录音脚本。
 *
 * 子进程的 stdout 是单行 JSON；失败也回 JSON，不靠退出码判断内容。
 *
 * @param {string} python - Python 解释器。
 * @param {string} script - record.py 路径。
 * @param {string} outPath - 输出 WAV 路径。
 * @param {number} seconds - 录音时长。
 * @param {number} timeoutMs - 进程超时。
 * @returns {Promise<{ok: boolean, path?: string, peak?: number, reason?: string, message?: string}>}
 */
function runRecorder(python, script, outPath, seconds, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let child
    try {
      child = spawn(python, [script, '--out', outPath, '--seconds', String(seconds)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ ok: false, reason: 'spawn-failed', message: String(error && error.message ? error.message : error) })
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
      finish({ ok: false, reason: 'timeout', message: `录音脚本超过 ${Math.round(timeoutMs / 1000)} 秒没有结束` })
    }, timeoutMs)
    timer.unref?.()

    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ ok: false, reason: 'spawn-failed', message: String(error && error.message ? error.message : error) })
    })

    child.on('close', () => {
      clearTimeout(timer)
      // 脚本约定：最后一行是 JSON。stderr 只在完全没有 JSON 时用来报错。
      const lines = stdout.trim().split(/\r?\n/).filter((l) => l.trim() !== '')
      const last = lines.length > 0 ? lines[lines.length - 1] : ''
      try {
        finish(JSON.parse(last))
      } catch {
        finish({
          ok: false,
          reason: 'bad-output',
          message: (stderr.trim() || stdout.trim() || '录音脚本没有输出可解析的 JSON').slice(0, 300),
        })
      }
    })
  })
}

// ============================================================================
// 一次完整的「点菜单 → 说话 → 桌宠动起来」
// ============================================================================

/**
 * 录一段音，送去识别，执行指令，最后用气泡告诉用户结果。
 *
 * @param {object} deps - { base, python, log }。
 * @param {string} petId - 触发这次操作的是哪只宠物（菜单点击带回来的）。
 */
async function handleVoiceCommand(deps, petId) {
  const { base, python, log, ctx } = deps
  const pet = await loadPetInfo(base)
  if (pet === null) {
    log('warn', '读不到 dsh-pet 配置，无法驱动桌宠')
    return
  }
  const target = petId !== '' ? { petId } : pet

  // 先给个反馈：让用户知道开始录了，不用干等
  await sayToPet(base, '我在听…', target)

  const tmpDir = join(PACKAGE_ROOT, '.tmp')
  mkdirSync(tmpDir, { recursive: true })
  const outPath = join(tmpDir, `rec-${Date.now()}.wav`)

  try {
    const script = join(PACKAGE_ROOT, 'python', 'record.py')
    if (!existsSync(script)) {
      log('warn', `找不到录音脚本：${script}`)
      await sayToPet(base, '录音脚本不见了', target)
      return
    }

    const rec = await runRecorder(python, script, outPath, RECORD_SECONDS, (RECORD_SECONDS + 15) * 1000)
    if (rec.ok !== true) {
      writeDiagnostic('warn', `录音失败：${rec.reason} ${rec.message ?? ''}`)
      log('warn', `录音失败：${rec.reason} ${rec.message ?? ''}`)
      await sayToPet(base, '麦克风没打开：' + (rec.message || rec.reason || '未知原因').slice(0, 40), target)
      return
    }
    if (typeof rec.peak === 'number' && rec.peak < SILENCE_PEAK) {
      await sayToPet(base, '没听到声音，检查一下麦克风', target)
      return
    }
    if (!existsSync(outPath) || statSync(outPath).size <= 44) {
      await sayToPet(base, '没录到声音', target)
      return
    }

    // 识别：直接把音频发给 DeepSeek 官方 ASR（不经 dsh-pet 中转）
    const apiKey = await resolveDeepseekKey(ctx)
    if (apiKey === undefined) {
      await sayToPet(base, '没配 DEEPSEEK_API_KEY，认不了语音', target)
      log('warn', '没有 DEEPSEEK_API_KEY，无法识别')
      return
    }
    const audio = readFileSync(outPath)
    const heard = await transcribeWithDeepSeek(apiKey, audio)
    if (heard.ok !== true) {
      const detail = heard.message || '未知原因'
      if (heard.reason === 'http-401' || heard.reason === 'http-403') {
        await sayToPet(base, 'API Key 无效或没权限', target)
      } else if (heard.reason === 'http-400') {
        await sayToPet(base, '音频格式不对：' + detail.slice(0, 30), target)
      } else if (heard.reason === 'http-413') {
        await sayToPet(base, '录音太大了', target)
      } else if (heard.reason === 'http-429') {
        await sayToPet(base, '请求太频繁，等一下再试', target)
      } else if (heard.reason === 'http-503' || heard.reason === 'http-504') {
        await sayToPet(base, '识别服务忙，稍后再试', target)
      } else {
        await sayToPet(base, '识别失败：' + detail.slice(0, 30), target)
      }
      writeDiagnostic('warn', `识别失败：${heard.reason} ${detail}`)
      log('warn', `识别失败：${heard.reason} ${detail}`)
      return
    }
    const text = heard.text.trim()
    // 识别结果进诊断日志：出问题时能看出是「听错了」还是「没匹配上关键词」
    writeDiagnostic('info', `识别到「${text}」`)
    if (text === '') {
      await sayToPet(base, '没听清，再说一次', target)
      return
    }

    log('info', `识别到「${text}」`)
    // 一级：关键词表（快、免费、结果确定）
    let command = parseCommand(text, pet.animNames)
    let via = 'keyword'
    if (command.kind === 'none') {
      // 二级：让模型理解意图。关键词表只能覆盖「恰好说到那几个词」的说法，
      // 而实测里用户常说的是自然句子，一个关键词都不中。
      await sayToPet(base, '想一下…', target)
      const interpreted = await interpretWithModel(ctx, text, pet.animNames)
      if (interpreted !== null) {
        command = interpreted
        via = 'model'
      }
    }
    if (command.kind === 'none') {
      writeDiagnostic('info', `没听懂（关键词与模型都没命中）：「${text}」`)
      await sayToPet(base, '没听懂「' + text.slice(0, 12) + '」', target)
      return
    }
    writeDiagnostic('info', `执行指令（${via}）：${JSON.stringify(command)}`)
    const result = await runCommand(base, command, target)
    await sayToPet(base, result.text, target)
  } catch (error) {
    writeDiagnostic('error', error && error.stack ? error.stack : String(error))
    log('warn', `语音控制出错：${error && error.message ? error.message : String(error)}`)
    await sayToPet(base, '出错了，看日志', target).catch(() => {})
  } finally {
    // 录音文件是一次性的：用完就删，别在插件目录里堆
    try {
      rmSync(outPath, { force: true })
    } catch {
      /* 删不掉就留着，不影响功能 */
    }
  }
}

// ============================================================================
// 插件主体
// ============================================================================

/**
 * 插件主体。
 *
 * @param {any} ctx - DSH 宿主上下文。
 * @param {object} [config] - 插件配置。
 */
export function apply(ctx, config = {}) {
  const log = (level, message) => {
    const line = `[dsh-pet-voice] ${message}`
    if (level === 'warn') ctx.logger?.warn?.(line)
    else ctx.logger?.info?.(line)
  }

  let origin = ''
  try {
    origin = ctx.webServer.getOrigin()
  } catch {
    log('warn', '拿不到本机监听地址，语音控制不可用')
    return
  }
  const base = origin + PET_ROUTE_SEGMENT

  const python = resolvePython()

  /** 当前是否有一次录音正在进行：避免连点菜单叠好几次录音。 */
  let busy = false

  /**
   * 插件是否已卸载。
   *
   * 不能挂到 ctx 上（Cordis 的 ctx 只允许声明过的属性），所以用一个闭包变量，
   * 由 ctx.effect 的清理函数置位。
   */
  let stopped = false

  // 注册右键菜单：target=desktop（宠物在桌面窗口里），label 唯一所以会平铺在「更多」下
  const registerMenu = async () => {
    const r = await petFetch(base, '/menu/item', {
      body: { owner: MENU_OWNER, labels: [MENU_LABEL], target: 'desktop' },
    })
    if (!r || r.ok !== true) {
      log('warn', `右键菜单注册失败：${(r && r.message) || 'dsh-pet 可能没装或没启用'}`)
      return false
    }
    log('info', `右键菜单已注册（${MENU_LABEL}）`)
    return true
  }

  // 轮询点击事件。dsh-pet 的 /menu/events 支持长轮询（最多 10 秒），所以这里可以一直挂着。
  const pollLoop = async () => {
    let registered = await registerMenu()
    let backoffMs = 2000
    while (!stopped) {
      if (!registered) {
        await new Promise((r) => setTimeout(r, backoffMs))
        backoffMs = Math.min(backoffMs * 2, 30_000)
        registered = await registerMenu()
        continue
      }
      backoffMs = 2000
      const r = await petFetch(base, `/menu/events?owner=${encodeURIComponent(MENU_OWNER)}&wait=10000`, {
        method: 'GET',
        timeoutMs: 15_000,
      })
      if (!r || r.ok !== true) {
        // unknown-owner：dsh-pet 重启过，注册表清空了，重新注册
        if (r && r.reason === 'unknown-owner') {
          registered = false
          continue
        }
        await new Promise((res) => setTimeout(res, 2000))
        continue
      }
      const events = r.events && typeof r.events === 'object' ? r.events : {}
      for (const [label, petId] of Object.entries(events)) {
        if (label !== MENU_LABEL || typeof petId !== 'string' || petId === '') continue
        if (busy) {
          log('info', '上一次录音还没结束，忽略这次点击')
          continue
        }
        busy = true
        void handleVoiceCommand({ base, python, log, ctx }, petId)
          .catch((error) => log('warn', `处理失败：${error && error.message ? error.message : String(error)}`))
          .finally(() => {
            busy = false
          })
      }
    }
  }

  ctx.effect(
    () => {
      stopped = false
      void pollLoop()
      // 对话控制：说「晚安」会睡下、「去右边」会走过去。
      // 与语音控制互补——语音是按住说话，对话是打字聊天，两条路都能驱动桌宠。
      const chatLog = (level, message) => {
        writeDiagnostic(level, message)
        log(level, message)
      }
      const chat = attachChatControl({ ctx, base, fetchJson: petFetch, log: chatLog })
      const disposeChat = chat && typeof chat === 'object' && typeof chat.dispose === 'function' ? chat.dispose : null
      return () => {
        stopped = true
        if (disposeChat !== null) {
          try {
            disposeChat()
          } catch {
            /* 已经注销过 */
          }
        }
        // 注销菜单，别在 dsh-pet 里留下点不到的僵尸项
        void petFetch(base, `/menu/item?owner=${encodeURIComponent(MENU_OWNER)}`, { method: 'DELETE' })
      }
    },
    'dsh-pet-voice: menu + recorder + chat control',
  )
}
