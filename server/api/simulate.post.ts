import { simulateExternalAdvance } from '~/server/store'

interface SimulateBody {
  permitId?: string
}

/** 演示用：模拟"其他班组"提交，使本地看到的版本过期 */
export default defineEventHandler(async (event) => {
  const body = (await readBody<SimulateBody>(event).catch(() => ({}))) as SimulateBody
  const permitId = body.permitId || 'WP-260929-004'
  return simulateExternalAdvance(permitId)
})
