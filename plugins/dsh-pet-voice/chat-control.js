/**
 * dsh-pet-voice 的「对话控制桌宠」部分。
 *
 * dsh-pet 自带的对话联动只能播动画（模型写 `[动作:名称]`，宿主写 anim 叶子）。
 * 睡觉、走动、被扔出去这些它做不到——那几条是独立端点，不在对话链路上。
 *
 * 本模块通过 dsh-pet 暴露的 Cordis 服务 `petApi7340.memory.register` 挂一个
 * 记忆后端，借它的两个钩子把控制动作接进对话：
 *
 *   recall（对话前）—— 往 system 里追加一份「控制指令」说明，告诉模型可以写
 *     [控制:sleep] / [控制:move-right] / [控制:throw] 这类标记；
 *   capture（对话落盘后）—— 拿到模型回复，解析 [控制:...] 并调对应端点执行。
 *
 * 为什么不复用 dsh-pet 自己的 [动作:]：那是动画白名单，只认 animations.categories
 * 里的名字，且只会写 anim 叶子；睡觉 / 位置 / 抛掷走的是另外的端点，插不进去。
 *
 * 注意：dsh-pet 的记忆后端是单槽，后注册覆盖先注册。本模块只在
 * 「原本没有第三方后端」时才注册，避免顶掉别人的记忆实现。
 */

/** 控制动作标记：`[控制:sleep]`、`[控制：move-right]`（中英文冒号都认）。 */
const CONTROL_TAG = /\[控制[:：]\s*([a-z-]+)\s*\]/gi

/** 允许的控制动作与它对应的执行参数。 */
const CONTROLS = {
  sleep: { kind: 'sleep', label: '睡下' },
  wake: { kind: 'wake', label: '醒来' },
  throw: { kind: 'throw', label: '被扔出去' },
  'move-left': { kind: 'position', x: 0.2, y: 0.65, label: '去左边' },
  'move-right': { kind: 'position', x: 0.8, y: 0.65, label: '去右边' },
  'move-center': { kind: 'position', x: 0.5, y: 0.65, label: '回中间' },
  'move-up': { kind: 'position', x: 0.5, y: 0.25, label: '去上面' },
  'move-down': { kind: 'position', x: 0.5, y: 0.8, label: '去下面' },
}

/** 注入给模型的说明。写清「什么时候写、怎么写、什么时候别写」。 */
const CONTROL_INSTRUCTION = `

[控制] 除了说话，你还能真的动起来。需要时在回复最后另起一行写一个控制标记：
- [控制:sleep] 睡下
- [控制:wake] 醒来
- [控制:throw] 被扔出去
- [控制:move-left] 去左边 / [控制:move-right] 去右边 / [控制:move-center] 回中间
- [控制:move-up] 去上面 / [控制:move-down] 去下面

什么时候写：用户让你做这些事，或对话语境明显适合（比如用户说「晚安」可以 [控制:sleep]）。
什么时候别写：普通聊天、回答问题、用户没让你动——不要为了动而动，一次回复最多写一个。
`

/**
 * 从模型回复里剥掉控制标记，取出第一个有效动作。
 *
 * @param {string} text - 模型回复原文。
 * @returns {{text: string, control?: {kind: string, x?: number, y?: number, label: string}}}
 */
export function extractControl(text) {
  if (typeof text !== 'string' || text === '') return { text: text ?? '' }
  let picked
  const cleaned = text.replace(CONTROL_TAG, (_tag, raw) => {
    const name = String(raw).toLowerCase()
    if (picked === undefined && Object.prototype.hasOwnProperty.call(CONTROLS, name)) {
      picked = { ...CONTROLS[name] }
    }
    return ''
  })
  // 标记通常独占一行：剥完会留下空行，压掉它，否则气泡顶部多一截空白
  const body = cleaned
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return picked === undefined ? { text: body } : { text: body, control: picked }
}

/**
 * 执行一个控制动作。
 *
 * @param {string} base - 本机地址 + dsh-pet 路由前缀。
 * @param {string} petId - 目标宠物。
 * @param {{kind: string, x?: number, y?: number}} control - 已解析的动作。
 * @param {Function} fetchJson - 注入的请求函数（与主模块共用一份实现）。
 * @returns {Promise<boolean>} 是否成功。
 */
export async function runControl(base, petId, control, fetchJson) {
  const q = `?pet=${encodeURIComponent(petId)}&surface=any`
  if (control.kind === 'sleep') {
    const r = await fetchJson(base, `/sleep${q}`)
    return Boolean(r && r.ok === true)
  }
  if (control.kind === 'wake') {
    const r = await fetchJson(base, `/wake${q}`)
    return Boolean(r && r.ok === true)
  }
  if (control.kind === 'throw') {
    const r = await fetchJson(base, `/throw${q}`, { body: { angle: -60, power: 1 } })
    return Boolean(r && r.ok === true)
  }
  if (control.kind === 'position') {
    const walked = await walkTo(base, petId, control.x, control.y, fetchJson)
    return walked.ok
  }
  return false
}

/**
 * 走过去，而不是瞬移；速度对齐 dsh-pet 自己的随机漫游。
 *
 * dsh-pet 的漫游速度不是「按距离算时长」，而是**由走路动画自身的时长决定**
 * （见 lib/client.js 的 createWalk）：
 *
 *   duration     = 走路视频的时长（内置素材兜底 10.09 秒）
 *   leadSec      = 2s   起步：原地踏步，还没开始位移
 *   tailSec      = 2s   收尾：已经到位，原地踏步收势
 *   实际行走窗口 = duration - leadSec - tailSec ≈ 6.09 秒
 *
 * 所以位移必须走满「行走窗口」那么久，看起来才和它自己溜达一样。
 * 按距离算时长（哪怕夹在 1–3 秒）都会明显更快——那是错的。
 *
 * 参数从宠物配置的 `animations.moves` 读（default 与所选动作的 params 合并），
 * 读不到就用 dsh-pet 的内置兜底值。
 *
 * 动画与位移并行发：动画负责「看起来在走」，位移负责「真的过去」。
 *
 * @param {string} base - 本机地址 + dsh-pet 路由前缀。
 * @param {string} petId - 目标宠物。
 * @param {number} x - 目标 x（0..1）。
 * @param {number} y - 目标 y（0..1）。
 * @param {Function} fetchJson - 请求函数。
 * @returns {Promise<{ok: boolean, message?: string}>} 位移结果。
 */
export async function walkTo(base, petId, x, y, fetchJson) {
  const q = `?pet=${encodeURIComponent(petId)}&surface=any`

  // 先查当前位置，决定朝向
  let fromX = 0.5
  try {
    const st = await fetchJson(base, '/state', { method: 'GET' })
    const leaf = st && st.pets && st.pets[petId] ? st.pets[petId].position : null
    if (leaf && leaf.data && typeof leaf.data.x === 'number') fromX = leaf.data.x
  } catch {
    /* 读不到就按屏幕中间估 */
  }
  const facing = x >= fromX ? 'right' : 'left'

  // 走路动画与节奏参数都来自配置
  const walk = await pickWalkAnimation(base, fetchJson)
  const duration = Math.round(walk.walkMs)

  const tasks = [
    fetchJson(base, `/position${q}`, { body: { x, y, mode: 'line', duration } }),
  ]
  if (walk.name !== null) {
    tasks.push(fetchJson(base, `/anim${q}`, { body: { name: walk.name, facing } }))
  }
  const results = await Promise.all(tasks)
  const moved = results[0]
  if (moved && moved.ok === true) return { ok: true }
  return { ok: false, message: moved && typeof moved.message === 'string' ? moved.message : undefined }
}

/** dsh-pet 内置走路素材的兜底时长（秒），与 lib/client.js 的 FALLBACK_DURATION_SEC 同值。 */
const FALLBACK_ANIM_SEC = 10.09

/** dsh-pet 的默认起步 / 收尾时长（秒），与 assets/config.jsonc 的 moves.default 同值。 */
const FALLBACK_LEAD_SEC = 2
const FALLBACK_TAIL_SEC = 2

/**
 * 从宠物配置里挑一段走路动画，并算出该走多久。
 *
 * 时长公式照抄 dsh-pet 的 createWalk：实际位移窗口 = 动画时长 - leadSec - tailSec。
 * 我们拿不到视频的真实时长（素材不在 npm 包里），所以用它的兜底值 10.09 秒，
 * 或配置里显式写的时长（如果有）。这与它自己漫游时的观感一致。
 *
 * @param {string} base - 本机地址 + dsh-pet 路由前缀。
 * @param {Function} fetchJson - 请求函数。
 * @returns {Promise<{name: string | null, walkMs: number}>} 动画名与位移时长（毫秒）。
 */
async function pickWalkAnimation(base, fetchJson) {
  let name = null
  let leadSec = FALLBACK_LEAD_SEC
  let tailSec = FALLBACK_TAIL_SEC
  let animSec = FALLBACK_ANIM_SEC
  try {
    const cfg = await fetchJson(base, '/config', { method: 'GET' })
    if (cfg && typeof cfg === 'object') {
      for (const conf of Object.values(cfg)) {
        if (!conf || typeof conf !== 'object') continue
        const moves = conf.animations && conf.animations.moves
        if (!moves || !Array.isArray(moves.actions) || moves.actions.length === 0) continue
        const first = moves.actions[0]
        if (first && typeof first === 'object' && typeof first.name === 'string' && first.name !== '') {
          name = first.name
          // 动作级 params 覆盖 moves.default（与 dsh-pet 的 Object.assign 同序）
          const merged = Object.assign({}, moves.default || {}, first.params || {})
          if (typeof merged.leadSec === 'number' && merged.leadSec >= 0) leadSec = merged.leadSec
          if (typeof merged.tailSec === 'number' && merged.tailSec >= 0) tailSec = merged.tailSec
          if (typeof merged.durationSec === 'number' && merged.durationSec > 0) animSec = merged.durationSec
        }
        break
      }
    }
  } catch {
    /* 配置读不到就用兜底值 */
  }
  // 与 createWalk 同一条公式：位移窗口 = 动画时长 - 起步 - 收尾
  const windowSec = Math.max(0.1, animSec - leadSec - tailSec)
  return { name, walkMs: Math.round(windowSec * 1000) }
}

/**
 * 把对话控制挂到 dsh-pet 上。
 *
 * @param {object} deps - 依赖。
 * @param {any} deps.ctx - 宿主上下文。
 * @param {string} deps.base - 本机地址 + dsh-pet 路由前缀。
 * @param {Function} deps.fetchJson - 请求函数。
 * @param {Function} deps.log - 日志函数。
 * @returns {boolean} 是否注册成功（dsh-pet 不在场时为 false）。
 */
export function attachChatControl(deps) {
  const { ctx, base, fetchJson, log } = deps

  // dsh-pet 用 ctx.provide('petApi7340', {...}) 暴露服务；拿不到就是它没装 / 版本太老
  const hasGet = typeof ctx.get === 'function'
  const petApi = hasGet ? ctx.get('petApi7340') : undefined
  log(
    'info',
    `对话控制探测：ctx.get=${hasGet} petApi=${petApi === undefined ? 'undefined' : typeof petApi}` +
      (petApi && typeof petApi === 'object' ? ` keys=${Object.keys(petApi).join(',')}` : ''),
  )
  if (!petApi || typeof petApi !== 'object' || !petApi.memory || typeof petApi.memory.register !== 'function') {
    log('warn', '拿不到 dsh-pet 的 petApi7340.memory.register，对话控制不可用（需要 dsh-pet 0.4.9+）')
    return false
  }

  // 单槽：已有第三方记忆后端时不抢，避免顶掉别人的实现
  try {
    const listed = petApi.memory.list?.()
    const external = listed && Array.isArray(listed.external) ? listed.external : []
    if (external.length > 0) {
      log('warn', `已有第三方记忆后端（${external.join(',')}），跳过对话控制以免覆盖它`)
      return false
    }
  } catch {
    /* list 不可用就按没有处理 */
  }

  const provider = {
    id: 'dsh-pet-voice-chat-control',

    /** 对话前：往 system 追加控制说明。 */
    recall(input) {
      const system = typeof input.system === 'string' ? input.system : ''
      return { system: system + CONTROL_INSTRUCTION }
    },

    /** 对话落盘后：解析并执行控制动作。 */
    capture(input) {
      const reply = typeof input.replyText === 'string' ? input.replyText : ''
      const petId = typeof input.petId === 'string' ? input.petId : ''
      if (reply === '' || petId === '') return
      const { control } = extractControl(reply)
      if (control === undefined) return
      void runControl(base, petId, control, fetchJson)
        .then((ok) => {
          if (ok) log('info', `对话触发控制：${control.label}（pet=${petId}）`)
          else log('warn', `对话触发控制失败：${control.label}`)
        })
        .catch((error) => {
          log('warn', `对话控制出错：${error && error.message ? error.message : String(error)}`)
        })
    },
  }

  try {
    const dispose = petApi.memory.register(provider)
    log('info', '对话控制已挂上（说「晚安」会睡下、「去右边」会走过去）')
    return typeof dispose === 'function' ? { dispose } : true
  } catch (error) {
    log('warn', `注册对话控制失败：${error && error.message ? error.message : String(error)}`)
    return false
  }
}
