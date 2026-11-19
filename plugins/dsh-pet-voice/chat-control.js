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
 * 走过去，而不是瞬移。
 *
 * dsh-pet 的 `/position` 支持三种 mode：`instant`（瞬移）、`spring`（弹簧，很快）、
 * `line`（按 duration 走直线）。默认的 spring 看起来仍像“闪过去”，所以这里用 `line`
 * 配一段时长，让它真的走过去。
 *
 * 光有位移还不够——宠物会在原地「滑行」。所以同时点播走路动画（配置里
 * `animations.moves.actions` 那几段，如「螃蟹走路」），并按移动方向给 facing。
 * 两个请求并行发：动画负责「看起来在走」，位移负责「真的过去」。
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

  // 先查当前位置，决定朝向与时长：距离越远走越久，但夹在 1.2–3.2 秒之间
  let fromX = 0.5
  try {
    const st = await fetchJson(base, '/state', { method: 'GET' })
    const leaf = st && st.pets && st.pets[petId] ? st.pets[petId].position : null
    if (leaf && leaf.data && typeof leaf.data.x === 'number') fromX = leaf.data.x
  } catch {
    /* 读不到就按屏幕中间估 */
  }
  const facing = x >= fromX ? 'right' : 'left'
  const distance = Math.abs(x - fromX)
  // 每 10% 屏宽约 0.35 秒，夹在 1.2–3.2 秒：太短像瞬移，太长像卡住
  const duration = Math.round(Math.min(3200, Math.max(1200, distance * 3500)))

  // 走路动画：取配置里第一段 moves 动作；没有就只做位移（至少不瞬移）
  const walkAnim = await pickWalkAnimation(base, fetchJson)

  const tasks = [
    fetchJson(base, `/position${q}`, { body: { x, y, mode: 'line', duration } }),
  ]
  if (walkAnim !== null) {
    tasks.push(fetchJson(base, `/anim${q}`, { body: { name: walkAnim, facing } }))
  }
  const results = await Promise.all(tasks)
  const moved = results[0]
  if (moved && moved.ok === true) return { ok: true }
  return { ok: false, message: moved && typeof moved.message === 'string' ? moved.message : undefined }
}

/**
 * 从宠物配置里挑一段走路动画。
 *
 * `animations.moves.actions` 是移动专用池（如「螃蟹走路」「原地漂浮踏步」「原地左转奔跑」），
 * 与随机动作池分开——用它们才像在走，而不是一边走路一边玩魔方。
 *
 * @param {string} base - 本机地址 + dsh-pet 路由前缀。
 * @param {Function} fetchJson - 请求函数。
 * @returns {Promise<string | null>} 动画名；没有可用的返回 null。
 */
async function pickWalkAnimation(base, fetchJson) {
  try {
    const cfg = await fetchJson(base, '/config', { method: 'GET' })
    if (!cfg || typeof cfg !== 'object') return null
    for (const conf of Object.values(cfg)) {
      if (!conf || typeof conf !== 'object') continue
      const moves = conf.animations && conf.animations.moves
      if (!moves || !Array.isArray(moves.actions)) continue
      for (const action of moves.actions) {
        if (action && typeof action === 'object' && typeof action.name === 'string' && action.name !== '') {
          return action.name
        }
      }
    }
  } catch {
    /* 配置读不到就不播动画，位移照做 */
  }
  return null
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
