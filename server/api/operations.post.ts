import { processOperations } from '~/server/store'
import type { OperationEnvelope } from '~/types'

export default defineEventHandler(async (event) => {
  const body = await readBody<OperationEnvelope>(event)
  if (!body || !body.opId || !Array.isArray(body.ops)) {
    throw createError({ statusCode: 400, statusMessage: '缺少 opId 或 ops' })
  }
  return processOperations({ opId: body.opId, ops: body.ops })
})
