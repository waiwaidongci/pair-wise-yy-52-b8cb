import { simulatePointState } from '~/server/store'
import type { IsolationPoint } from '~/types'

interface PointStateBody {
  pointId: string
  state: IsolationPoint['state']
  actor?: string
}

export default defineEventHandler(async (event) => {
  const body = await readBody<PointStateBody>(event)
  if (!body || !body.pointId || !body.state) {
    throw createError({ statusCode: 400, statusMessage: '缺少 pointId 或 state' })
  }
  return simulatePointState(body.pointId, body.state, body.actor || '现场确认')
})
