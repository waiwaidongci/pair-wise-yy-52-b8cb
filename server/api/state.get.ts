import { getServerState } from '~/server/store'

export default defineEventHandler(() => getServerState())
