type RealtimeEvent = { type: 'permit-update' | 'connection'; payload: string }

export function useRealtime(onEvent: (event: RealtimeEvent) => void) {
  let timer: ReturnType<typeof setInterval> | undefined
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
    timer = setInterval(() => {
      // 模拟其他班组的现场确认与许可变化；页面收到后会以服务端事实刷新本端
      const updates = ['WTG-03 隔离点状态已由周野确认（服务端事实已更新）', 'LINE-A2 许可复核提醒已送达负责人', 'IP-413 共享隔离点出现状态变化，请关注相关许可']
      onEvent({ type: 'permit-update', payload: updates[Math.floor(Math.random() * updates.length)]! })
    }, 9000)
  }
  function disconnect() { if (timer) clearInterval(timer); socket?.close() }
  onMounted(connect)
  onBeforeUnmount(disconnect)
  return { reconnect: connect, disconnect }
}
