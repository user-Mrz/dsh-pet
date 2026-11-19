/**
 * dsh-pet-voice —— 浏览器半侧。
 *
 * 在对话输入框工具栏放一个话筒按钮，把「说一句话」变成「桌宠做一个动作」：
 *
 *   按住按钮说话
 *     → 采集 16kHz / 单声道 / PCM16 的 WAV（与 dsh-pet 的识别入口同一份格式口径）
 *     → POST dsh-pet 的 /voice/hear（provider=deepseek，走 DeepSeek 官方 ASR）
 *     → 把转写出来的文字解析成一条指令
 *     → POST dsh-pet 的 /anim、/sleep、/wake、/position、/throw、/broadcast 驱动桌宠
 *
 * 不保存、不转发任何密钥：鉴权在 dsh-pet 里完成，本插件只发音频、只收文字。
 * 不接管页面、不改别人的 DOM：只在 conversation.input.right 这一个格子里渲染自己的按钮。
 */

/** dsh-pet 注册的路由段；与 dsh-pet 的 shared/constants.ts 同值。 */
const PET_ROUTE_SEGMENT = '/dsh-pet-7340'

/** 采集参数：与 dsh-pet 的识别 provider 校验口径一致。 */
const SAMPLE_RATE = 16000
/** 每块采集的样本数：1024 样本 @16kHz = 64ms。 */
const BLOCK_SAMPLES = 1024
/** 单次录音上限（ms）：官方 ASR 单请求上限 120 秒，留出余量。 */
const MAX_RECORD_MS = 100_000
/** 短于它的录音按误触处理（ms）。 */
const MIN_RECORD_MS = 300
/** 判静音的峰值阈值（0..1）。 */
const SILENCE_PEAK = 0.002
/** 等识别结果的上限（ms）。 */
const HEAR_TIMEOUT_MS = 40_000
/** 松手后等最后一块音频落袋（ms）。 */
const TAIL_SETTLE_MS = 80

/**
 * 从文档基准地址取出挂载前缀。
 *
 * 反代把 UI 挂在子路径下时，请求要带同一段前缀；非 http(s) 一律按无前缀处理。
 *
 * @param {string | undefined} baseURI - document.baseURI。
 * @returns {string} 去掉尾部斜杠的目录部分。
 */
function mountPrefixOf(baseURI) {
  if (baseURI === undefined || baseURI === '') return ''
  try {
    const url = new URL(baseURI)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.pathname.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

/** dsh-pet 的请求前缀（浏览器侧，含挂载前缀）。 */
const PET_BASE = mountPrefixOf(typeof document === 'undefined' ? undefined : document.baseURI) + PET_ROUTE_SEGMENT

// ============================================================================
// 音频：采集 → PCM16 → WAV
// ============================================================================

/**
 * 浮点采样转 16 位整型：超范围先夹紧，负半轴按 32768 缩放。
 *
 * @param {Float32Array} samples - Web Audio 给的 [-1,1] 浮点采样。
 * @returns {Int16Array} 可写进 WAV 的 16 位采样。
 */
function floatToPcm16(samples) {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i]
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  return out
}

/**
 * 量峰值：静音判定只关心「有没有声音进来」。
 *
 * @param {Int16Array} pcm - 16 位采样。
 * @returns {number} 峰值归一到 0..1。
 */
function peakOf(pcm) {
  let peak = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] < 0 ? -pcm[i] : pcm[i]
    if (v > peak) peak = v
  }
  return peak / 0x8000
}

/**
 * 拼一个裸 PCM 的 WAV：44 字节头 + 采样数据。
 *
 * @param {Int16Array} pcm - 16 位采样。
 * @param {number} sampleRate - 采样率。
 * @returns {Uint8Array} 完整 WAV 字节。
 */
function encodeWave(pcm, sampleRate = SAMPLE_RATE) {
  const dataBytes = pcm.length * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true)
  return bytes
}

/**
 * 字节转 base64（不带 data: 前缀）。
 *
 * 分段转换：一次性展开几十万字节会撑爆参数栈。
 *
 * @param {Uint8Array} bytes - 原始字节。
 * @returns {string} 规范 base64。
 */
function toBase64(bytes) {
  const CHUNK = 8192
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, bytes.length)
    for (let i = offset; i < end; i++) binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/** 浏览器能不能录音；非安全上下文下 mediaDevices 根本不存在。 */
function canRecord() {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'
}

/**
 * 开一次录音。
 *
 * 用 AudioContext({ sampleRate: 16000 }) 让浏览器自己做重采样；ScriptProcessor 虽已标记废弃，
 * 但它不需要额外的 worklet 模块文件。
 *
 * @returns {Promise<{elapsedMs: () => number, stop: () => Promise<{wave: Uint8Array, peak: number} | null>, cancel: () => void}>}
 */
async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
  const source = ctx.createMediaStreamSource(stream)
  const processor = ctx.createScriptProcessor(BLOCK_SAMPLES, 1, 1)
  const chunks = []
  const maxSamples = Math.floor((MAX_RECORD_MS / 1000) * SAMPLE_RATE)
  let frames = 0
  let closed = false

  processor.onaudioprocess = (event) => {
    if (frames >= maxSamples) return
    const samples = event.inputBuffer.getChannelData(0)
    const room = maxSamples - frames
    const take = samples.length > room ? samples.subarray(0, room) : samples
    // 必须复制：inputBuffer 的底层数组每帧复用
    chunks.push(new Float32Array(take))
    frames += take.length
  }
  source.connect(processor)
  processor.connect(ctx.destination)
  await ctx.resume()

  const teardown = () => {
    if (closed) return
    closed = true
    processor.onaudioprocess = null
    try {
      source.disconnect()
      processor.disconnect()
    } catch {
      /* 已经断开 */
    }
    for (const track of stream.getTracks()) track.stop()
    void ctx.close()
  }

  return {
    elapsedMs: () => (frames / SAMPLE_RATE) * 1000,
    async stop() {
      await new Promise((resolve) => setTimeout(resolve, TAIL_SETTLE_MS))
      teardown()
      if (frames === 0) return null
      const all = new Float32Array(frames)
      let offset = 0
      for (const chunk of chunks) {
        all.set(chunk, offset)
        offset += chunk.length
      }
      const pcm = floatToPcm16(all)
      return { wave: encodeWave(pcm), peak: peakOf(pcm) }
    },
    cancel: teardown,
  }
}

// ============================================================================
// 指令解析：一句话 → 一条动作
// ============================================================================

/**
 * 关键词 → 动作。按顺序匹配，先命中先用。
 *
 * `action` 是桌宠路由的动作；`anim` 是动画名。两者只给一个。
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
  // —— 常见动画 ——
  // 具体舞种必须排在通用「舞」之前：关键词表是先命中先用，
  // 通用词放前面会把「女仆舞」「宅舞」一并吞成同一种舞。
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
  { keys: ['跳舞毯', '吹气球', '气球'], anim: '吹气球' },
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
 * 三级匹配：关键词表 → 配置里的动画名（原样包含）→ 没命中。
 * 桌宠动画名本身就很口语（「原地专心玩魔方」「涮火锅」），所以原样包含这一级能覆盖大部分说法。
 *
 * @param {string} text - 识别出来的文字。
 * @param {readonly string[]} animNames - 该宠物配置里全部可播动画名。
 * @returns {{kind: 'anim', anim: string} | {kind: 'sleep'} | {kind: 'wake'} | {kind: 'throw'} |
 *   {kind: 'position', x: number, y: number} | {kind: 'none', text: string}}
 */
function parseCommand(text, animNames) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw === '') return { kind: 'none', text: '' }
  // 转写会带上句号、逗号、语气词；先去掉标点与空白，让关键词更容易命中
  const clean = raw.replace(/[\s，。！？、,.!?~～…]+/g, '')
  const names = Array.isArray(animNames) ? animNames : []

  // 一级：关键词表（长词优先，靠规则顺序保证）
  for (const rule of KEYWORD_RULES) {
    if (!rule.keys.some((key) => clean.includes(key))) continue
    if (rule.anim !== undefined) {
      // 关键词指向的动画必须真的在该宠物配置里，否则不假装播得出来
      if (names.length > 0 && !names.includes(rule.anim)) continue
      return { kind: 'anim', anim: rule.anim }
    }
    if (rule.action === 'sleep') return { kind: 'sleep' }
    if (rule.action === 'wake') return { kind: 'wake' }
    if (rule.action === 'throw') return { kind: 'throw' }
    if (rule.action === 'position') return { kind: 'position', x: rule.x, y: rule.y }
  }

  // 二级：动画名原样包含（用户直接说了完整动作名）
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
 * @param {string} path - 带查询串的路径，如 `/anim?pet=main&surface=any`。
 * @param {object} [options] - `method` 与 `body`。
 * @returns {Promise<any>} 解析后的 JSON；网络失败或非 JSON 给 null。
 */
async function petFetch(path, options = {}) {
  try {
    const res = await fetch(PET_BASE + path, {
      method: options.method ?? 'POST',
      headers: { 'content-type': 'application/json' },
      body: options.body === undefined ? JSON.stringify({}) : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    })
    const body = await res.json().catch(() => null)
    return body
  } catch {
    return null
  }
}

/**
 * 读 dsh-pet 的配置：拿到宠物 id、以及可播动画名。
 *
 * 成品配置的形状是「条目 → 该条目的配置」：`main` 是用户主配置，其余键是文件宠物
 * （`pet/<名>-config.json`）。每份条目配置里各有一个 `pets` 数组，宠物 id 只在数组元素上。
 * 所以要遍历全部条目去找，不能只看顶层或只看 main。
 *
 * @returns {Promise<{petId: string, surface: string, display: string, animNames: string[]} | null>}
 */
async function loadPetInfo() {
  const cfg = await petFetch('/config', { method: 'GET' })
  if (!cfg || typeof cfg !== 'object') return null

  let petId = ''
  let display = ''
  const names = []
  // 条目按 Object.values 顺序遍历：main 在前（readAllConfig 先放 main），与 dsh-pet 自己的
  // flattenPetList 同序，所以默认挑到的就是主配置里的第一只。
  for (const conf of Object.values(cfg)) {
    if (!conf || typeof conf !== 'object') continue
    if (petId === '' && Array.isArray(conf.pets)) {
      const first = conf.pets.find((p) => p && typeof p === 'object' && typeof p.id === 'string' && p.id !== '')
      if (first) {
        petId = first.id
        display = typeof first.display === 'string' ? first.display : ''
      }
    }
    // 动画池按条目取：同一只宠物只认自己条目的 animations
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
  // surface=any 在任何 display 下都通过 dsh-pet 的对齐校验（见其 surface.ts 的 displayCovers）
  return { petId, surface: 'any', display, animNames: names }
}

/**
 * 执行一条解析出来的指令。
 *
 * @param {{kind: string, anim?: string, x?: number, y?: number}} command - 解析结果。
 * @param {{petId: string, surface: string}} pet - 宠物信息。
 * @returns {Promise<{ok: boolean, text: string}>} 给用户看的一句话。
 */
async function runCommand(command, pet) {
  const q = `?pet=${encodeURIComponent(pet.petId)}&surface=${encodeURIComponent(pet.surface)}`
  if (command.kind === 'anim') {
    const r = await petFetch(`/anim${q}`, { body: { name: command.anim } })
    if (r && r.ok === true) return { ok: true, text: `好呀～${command.anim}` }
    const msg = r && typeof r.message === 'string' ? r.message : '没播出来'
    return { ok: false, text: `做不到：${msg}` }
  }
  if (command.kind === 'sleep') {
    const r = await petFetch(`/sleep${q}`)
    if (r && r.ok === true) return { ok: true, text: '那我睡啦～' }
    const msg = r && typeof r.message === 'string' ? r.message : '睡不着'
    return { ok: false, text: `做不到：${msg}` }
  }
  if (command.kind === 'wake') {
    const r = await petFetch(`/wake${q}`)
    if (r && r.ok === true) return { ok: true, text: '我醒啦！' }
    const msg = r && typeof r.message === 'string' ? r.message : '叫不醒'
    return { ok: false, text: `做不到：${msg}` }
  }
  if (command.kind === 'throw') {
    const r = await petFetch(`/throw${q}`, { body: { angle: -60, power: 1 } })
    if (r && r.ok === true) return { ok: true, text: '哇啊啊——' }
    const msg = r && typeof r.message === 'string' ? r.message : '扔不动'
    return { ok: false, text: `做不到：${msg}` }
  }
  if (command.kind === 'position') {
    const r = await petFetch(`/position${q}`, { body: { x: command.x, y: command.y, mode: 'spring' } })
    if (r && r.ok === true) return { ok: true, text: '来啦～' }
    const msg = r && typeof r.message === 'string' ? r.message : '走不过去'
    return { ok: false, text: `做不到：${msg}` }
  }
  return { ok: false, text: '没听懂，再说一次？' }
}

/**
 * 让桌宠弹一句话（不生成，直接投喂）。
 *
 * @param {string} text - 要显示的文字。
 * @param {{petId: string, surface: string}} pet - 宠物信息。
 */
async function sayToPet(text, pet) {
  const q = `?pet=${encodeURIComponent(pet.petId)}&surface=${encodeURIComponent(pet.surface)}`
  await petFetch(`/broadcast${q}`, { body: { text, duration: 4000, anim: false } })
}

// ============================================================================
// 一次完整的「说完 → 桌宠动起来」
// ============================================================================

/**
 * 把一段录音送去识别并执行。
 *
 * @param {{wave: Uint8Array, peak: number}} clip - 录好的音频。
 * @param {(phase: string, detail?: string) => void} onPhase - 阶段回调。
 * @returns {Promise<{ok: boolean, text: string}>}
 */
async function transcribeAndRun(clip, onPhase) {
  if (clip.peak < SILENCE_PEAK) return { ok: false, text: '没听到声音，检查一下麦克风' }

  onPhase('transcribing')
  let body
  try {
    const res = await fetch(PET_BASE + '/voice/hear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio: toBase64(clip.wave), provider: 'deepseek' }),
      signal: AbortSignal.timeout(HEAR_TIMEOUT_MS),
    })
    body = await res.json().catch(() => null)
  } catch (e) {
    return { ok: false, text: '识别请求失败：' + (e instanceof Error ? e.message : String(e)) }
  }
  if (!body || typeof body !== 'object') return { ok: false, text: '识别响应不是 JSON' }
  if (body.ok !== true) {
    const reason = typeof body.reason === 'string' ? body.reason : 'generate-error'
    const msg = typeof body.message === 'string' ? body.message : ''
    if (reason === 'unsupported') return { ok: false, text: '宿主没开语音识别（检查 DEEPSEEK_API_KEY）' }
    if (reason === 'bad-request') return { ok: false, text: '音频没通过校验：' + msg }
    return { ok: false, text: '识别失败：' + (msg || '未知原因') }
  }
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (text === '') return { ok: false, text: '没听清，再说一次' }

  onPhase('acting', text)
  const pet = await loadPetInfo()
  if (pet === null) return { ok: false, text: '没找到 dsh-pet 的配置，桌宠可能没启用' }

  const command = parseCommand(text, pet.animNames)
  const result = await runCommand(command, pet)
  // 把结果说出来：用户需要知道这句话被理解成了什么
  if (command.kind === 'none') {
    await sayToPet('没听懂「' + text.slice(0, 12) + '」，试试说「跳舞」「睡觉」「吃白饭」', pet)
    return { ok: false, text: '没听懂：' + text }
  }
  await sayToPet(result.text, pet)
  return result
}

// ============================================================================
// 界面
// ============================================================================

/** 语音按钮的四种状态。 */
const PHASE_LABEL = {
  idle: '按住说话',
  starting: '正在打开麦克风…',
  recording: '录音中，松开结束',
  transcribing: '识别中…',
  acting: '执行中…',
}

/**
 * 浏览器半侧的插件主体。
 *
 * @param {any} ctx - 浏览器侧 Cordis 上下文。
 * @param {any} React - 模块表提供的 React。
 * @returns {{apply: Function, inject: string[], name: string}}
 */
function makeFactory(ctxApi, React) {
  const h = React.createElement
  const { useEffect, useRef, useState, useCallback } = React

  /**
   * 话筒按钮组件。
   *
   * 自己管住麦克风与定时器：卸载时一定 cancel，避免麦克风一直开着。
   */
  function VoiceButton() {
    const [phase, setPhase] = useState('idle')
    const [hint, setHint] = useState('')
    const recorderRef = useRef(null)
    const releasedRef = useRef(false)
    const timerRef = useRef(0)
    const mountedRef = useRef(true)
    // 阶段与提示用 ref 镜像一份：pointerup 的回调闭包拿不到最新的 state
    const phaseRef = useRef('idle')

    const setPhaseSafe = useCallback((next) => {
      phaseRef.current = next
      if (mountedRef.current) setPhase(next)
    }, [])

    useEffect(() => {
      mountedRef.current = true
      return () => {
        mountedRef.current = false
        window.clearInterval(timerRef.current)
        if (recorderRef.current) {
          recorderRef.current.cancel()
          recorderRef.current = null
        }
      }
    }, [])

    /** 收尾：停采集 → 判误触 → 送识别 → 执行 → 显示结果。 */
    const finish = useCallback(async () => {
      const recorder = recorderRef.current
      if (!recorder) return
      recorderRef.current = null
      window.clearInterval(timerRef.current)

      if (recorder.elapsedMs() < MIN_RECORD_MS) {
        recorder.cancel()
        setPhaseSafe('idle')
        if (mountedRef.current) setHint('')
        return
      }

      setPhaseSafe('transcribing')
      try {
        const clip = await recorder.stop()
        if (clip === null) {
          setPhaseSafe('idle')
          if (mountedRef.current) setHint('没录到声音')
          return
        }
        const result = await transcribeAndRun(clip, (next, detail) => {
          setPhaseSafe(next)
          if (detail && mountedRef.current) setHint(detail)
        })
        if (mountedRef.current) setHint(result.text)
      } catch (e) {
        if (mountedRef.current) setHint('录音出错：' + (e instanceof Error ? e.message : String(e)))
      } finally {
        setPhaseSafe('idle')
      }
    }, [setPhaseSafe])

    /** 开录。 */
    const start = useCallback(async () => {
      if (phaseRef.current !== 'idle') return
      if (!canRecord()) {
        setHint('当前地址不支持录音：用 https 或 localhost 打开才有麦克风')
        return
      }
      setPhaseSafe('starting')
      releasedRef.current = false
      if (mountedRef.current) setHint('')
      try {
        recorderRef.current = await startRecording()
      } catch (e) {
        setPhaseSafe('idle')
        if (mountedRef.current) setHint('打不开麦克风：' + (e instanceof Error ? e.message : String(e)))
        return
      }
      if (releasedRef.current) {
        void finish()
        return
      }
      setPhaseSafe('recording')
      timerRef.current = window.setInterval(() => {
        const rec = recorderRef.current
        if (!rec) return
        if (rec.elapsedMs() >= MAX_RECORD_MS) void finish()
      }, 250)
    }, [finish, setPhaseSafe])

    const onPointerDown = useCallback(
      (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          /* 指针已经不在了 */
        }
        void start()
      },
      [start],
    )

    const onRelease = useCallback(() => {
      if (phaseRef.current === 'starting') {
        releasedRef.current = true
        return
      }
      if (phaseRef.current === 'recording') void finish()
    }, [finish])

    const recording = phase === 'recording' || phase === 'starting'
    const busy = phase === 'transcribing' || phase === 'acting'
    const title = hint || PHASE_LABEL[phase] || PHASE_LABEL.idle

    return h(
      'button',
      {
        type: 'button',
        title,
        'aria-label': '语音控制桌宠',
        'aria-pressed': recording,
        disabled: busy,
        onPointerDown,
        onPointerUp: onRelease,
        onPointerCancel: onRelease,
        onContextMenu: (e) => e.preventDefault(),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          height: 28,
          minWidth: 28,
          padding: recording ? '0 10px' : '0 6px',
          border: 'none',
          borderRadius: 8,
          background: recording ? 'var(--dsw-alias-fill-danger, #e5484d)' : 'transparent',
          color: recording ? '#fff' : busy ? 'var(--dsw-alias-text-secondary, #8b8b8b)' : 'currentColor',
          cursor: busy ? 'progress' : 'pointer',
          font: 'inherit',
          fontSize: 12,
          lineHeight: 1,
          transition: 'background 120ms ease, padding 120ms ease',
          // 录音时给一个明确的视觉信号：不靠文字也能看出「正在听」
          boxShadow: recording ? '0 0 0 3px rgba(229,72,77,0.22)' : 'none',
        },
      },
      h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        h('rect', { x: 9, y: 2, width: 6, height: 12, rx: 3 }),
        h('path', { d: 'M5 10v1a7 7 0 0 0 14 0v-1' }),
        h('line', { x1: 12, y1: 19, x2: 12, y2: 22 }),
      ),
      recording ? h('span', { style: { whiteSpace: 'nowrap' } }, '松开结束') : null,
    )
  }

  return {
    name: 'dsh-pet-voice',
    inject: ['slots'],
    apply(clientCtx) {
      clientCtx.effect(
        () =>
          clientCtx.slots.inject('conversation.input.right', () => {
            try {
              return clientCtx.slots.register(
                {
                  name: 'conversation.input.right',
                  id: 'dsh-pet-voice-mic',
                  order: 6,
                  label: () => '语音控制桌宠',
                },
                VoiceButton,
              )
            } catch (error) {
              // 注册被拒不能把整个插槽拖垮：降级成一行日志
              console.error('[dsh-pet-voice] 话筒按钮注册失败：', error)
              return () => {}
            }
          }),
        'dsh-pet-voice: composer mic',
      )
    },
  }
}

// ============================================================================
// 模块注册
// ============================================================================

window.__ModuleLoader__.load({
  id: 'dsh-pet-voice',
  factory(require) {
    const React = require('react')
    const module = makeFactory(null, React)
    return module
  },
})
