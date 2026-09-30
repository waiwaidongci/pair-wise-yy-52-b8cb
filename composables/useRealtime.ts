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
      return
    }
    onEvent({ type: 'connection', payload: '在线 · 模拟通道' })
    timer = setInterval(() => {
      const updates = ['WTG-03 隔离点状态已由周野确认', '风速 10.8m/s，高空作业保持暂停', 'LINE-A2 许可复核提醒已送达负责人']
      onEvent({ type: 'permit-update', payload: updates[Math.floor(Math.random() * updates.length)]! })
    }, 9000)
  }
  function disconnect() { if (timer) clearInterval(timer); socket?.close() }
  onMounted(connect)
  onBeforeUnmount(disconnect)
  return { reconnect: connect, disconnect }
}
