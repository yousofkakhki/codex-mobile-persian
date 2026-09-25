import { onBeforeUnmount, ref } from 'vue'
import {
  getRpcTelemetrySnapshot,
  subscribeRpcTelemetry,
  type RpcTelemetrySnapshot,
} from '../api/codexRpcTelemetry'

export function useRpcTelemetry() {
  const telemetry = ref<RpcTelemetrySnapshot>(getRpcTelemetrySnapshot())
  const stop = subscribeRpcTelemetry((nextSnapshot) => {
    telemetry.value = nextSnapshot
  })
  const refreshTimer = typeof window !== 'undefined'
    ? window.setInterval(() => {
      telemetry.value = getRpcTelemetrySnapshot()
    }, 500)
    : null

  onBeforeUnmount(() => {
    stop()
    if (refreshTimer !== null) window.clearInterval(refreshTimer)
  })

  return { rpcTelemetry: telemetry }
}
