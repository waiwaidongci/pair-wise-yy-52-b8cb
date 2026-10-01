import type { Operation, OperationResponse, PointStateResponse, ServerState } from '~/types'

/**
 * 服务端唯一事实源的客户端封装。
 * 所有写操作走 POST /api/operations（带 opId 幂等键 + seenRevision 版本）。
 */
export function useOperationsApi() {
  function fetchState(): Promise<ServerState> {
    return $fetch<ServerState>('/api/state')
  }

  function submit(opId: string, seenRevision: number, ops: Operation[]): Promise<OperationResponse> {
    return $fetch<OperationResponse>('/api/operations', {
      method: 'POST',
      body: { opId, seenRevision, ops },
    })
  }

  function setPointState(pointId: string, state: string, actor?: string): Promise<PointStateResponse> {
    return $fetch<PointStateResponse>('/api/point-state', {
      method: 'POST',
      body: { pointId, state, actor },
    })
  }

  function simulateExternalAdvance(permitId?: string): Promise<ServerState> {
    return $fetch<ServerState>('/api/simulate', { method: 'POST', body: { permitId } })
  }

  function reset(): Promise<ServerState> {
    return $fetch<ServerState>('/api/reset', { method: 'POST' })
  }

  return { fetchState, submit, setPointState, simulateExternalAdvance, reset }
}
