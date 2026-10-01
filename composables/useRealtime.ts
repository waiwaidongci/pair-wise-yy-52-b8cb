type RealtimeEvent = { type: 'connection'; payload: string }

/**
 * 管理实时通道连接状态。
 * 配置 wsUrl 时走真实 WebSocket，否则使用模拟通道；
 * 状态轮询与现场活动模拟由 layout 统一处理。
 */
export function useRealtime(onEvent: (event: RealtimeEvent) => void) {
  let socket: WebSocket | undefined

  function connect() {
    const url = useRuntimeConfig().public.wsUrl as string | undefined
    if (url && import.meta.client) {
      socket = new WebSocket(url)
      socket.onmessage = (event) => onEvent(JSON.parse(event.data))
      socket.onclose = () => onEvent({ type: 'connection', payload: '重连中' })
      socket.onopen = () => onEvent({ type: 'connection', payload: '在线' })
      return
    }
    onEvent({ type: 'connection', payload: '在线 · 模拟通道' })
  }

  function disconnect() {
    socket?.close()
  }

  onMounted(connect)
  onBeforeUnmount(disconnect)
  return { reconnect: connect, disconnect }
}
