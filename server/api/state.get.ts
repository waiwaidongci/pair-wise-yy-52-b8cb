import { snapshotState } from '../utils/state'

/** 服务端唯一事实的只读快照；客户端通过 stateVersion 判断本地是否落后 */
export default defineEventHandler(() => snapshotState())
