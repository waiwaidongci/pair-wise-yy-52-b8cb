import type { OperationRequest, OperationsBatchResponse } from '~~/types'
import { processBatch, snapshotState } from '../../utils/state'

/**
 * 班组批量提交隔离操作。
 * 每条操作携带 opId（幂等）与 baseRevision（看到的许可版本）：
 * - 版本过期 / 待复核只驳回对应许可的操作，同批其他操作正常成功；
 * - 同一 opId 重试回放首次结果，不重复写入审计与状态；
 * - 响应总是返回最新全量事实，便于冲突后页面继续处理其他许可。
 */
export default defineEventHandler(async (event): Promise<OperationsBatchResponse> => {
  const body = await readBody<{ operations?: OperationRequest[] }>(event)
  if (!body || !Array.isArray(body.operations)) {
    throw createError({ statusCode: 400, statusMessage: '请求体需要 operations 数组' })
  }
  const results = processBatch(body.operations)
  return snapshotState(results)
})
