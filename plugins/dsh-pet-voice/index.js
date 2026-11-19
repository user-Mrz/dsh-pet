/**
 * dsh-pet-voice —— 宿主半侧。
 *
 * 这个插件真正干活的部分在浏览器半侧（client.js）：录音、识别、解析指令、驱动桌宠。
 * 宿主半侧只做一件事：确认 dsh-pet 在场，并把它的 HTTP 前缀（/dsh-pet-7340）告诉浏览器半侧，
 * 免得两边各写一份常量、改了地址就对不上。
 *
 * 不注册路由、不注册工具、不碰凭据：
 *   - 语音识别走 dsh-pet 自己的 /voice/hear（provider=deepseek），鉴权在 dsh-pet 里完成；
 *   - 桌宠动作走 dsh-pet 自己的 /anim、/sleep、/wake、/position、/throw、/broadcast；
 *   - 本插件因此不需要任何密钥，也不出现在对话工具列表里。
 */

/** dsh-pet 注册在宿主上的路由段；与 dsh-pet 的 shared/constants.ts 同值。 */
const PET_ROUTE_SEGMENT = '/dsh-pet-7340'

/** 依赖：webServer 用来确认 dsh-pet 的 HTTP 前缀路由是否在场。 */
export const inject = ['webServer']

/**
 * 探测 dsh-pet 是否可用：请求它自己的 /config 读端点。
 *
 * 只读、不改任何状态；失败一律当作「不在场」，由浏览器半侧给出可读的提示。
 *
 * @param {string} origin - 本机监听地址。
 * @returns {Promise<boolean>} dsh-pet 是否应答。
 */
async function petReachable(origin) {
  try {
    const res = await fetch(origin + PET_ROUTE_SEGMENT + '/config', {
      signal: AbortSignal.timeout(4000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * 插件主体。
 *
 * @param {any} ctx - DSH 宿主上下文。
 */
export function apply(ctx) {
  // 探测结果只进日志：浏览器半侧每次录音前都会自己确认，这里的作用是让用户
  // 在 dsh-pet 没装/没启用时，能在插件日志里看到一句明确的话，而不是只看到按钮没反应。
  void (async () => {
    let origin = ''
    try {
      origin = ctx.webServer.getOrigin()
    } catch {
      return // 监听还没绑上端口：浏览器半侧会自己按页面同源去请求
    }
    const ok = await petReachable(origin)
    if (!ok) {
      ctx.logger?.warn?.(
        `[dsh-pet-voice] 没有在 ${origin}${PET_ROUTE_SEGMENT} 找到 dsh-pet；` +
          '语音控制需要 dsh-pet 已安装并启用。',
      )
    }
  })()
}
