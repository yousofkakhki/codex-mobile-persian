import type { CodexApprovalPolicy, CodexSandboxMode } from './appServerRuntimeConfig.js'

export type AppServerPermissionIntent = { approvalPolicy: boolean; sandbox: boolean }
export type AppServerTurnPermissionOverrides = Record<string, unknown>
export type AppServerPermissionDefaults = { approvalPolicy: CodexApprovalPolicy; sandboxMode: CodexSandboxMode }

/** Snapshot the exact launch flags; never borrow replacement env while a writer is attached. */
export function readAppServerPermissionDefaults(args: readonly string[]): AppServerPermissionDefaults {
  const defaults: AppServerPermissionDefaults = { approvalPolicy: 'never', sandboxMode: 'danger-full-access' }
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] !== '-c') continue
    const value = args[index + 1]
    const separator = value.indexOf('=')
    const key = value.slice(0, separator)
    const raw = value.slice(separator + 1)
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { parsed = raw }
    if (key === 'approval_policy' && ['never', 'untrusted', 'on-failure', 'on-request'].includes(parsed as string)) defaults.approvalPolicy = parsed as CodexApprovalPolicy
    if (key === 'sandbox_mode' && ['danger-full-access', 'read-only', 'workspace-write'].includes(parsed as string)) defaults.sandboxMode = parsed as CodexSandboxMode
  }
  return defaults
}

/** Only caller intent is sticky; effective stale rollout permissions are not an opt-out. */
export function readAppServerPermissionIntent(method: string, params: unknown): AppServerPermissionIntent {
  const record = params && typeof params === 'object' ? params as Record<string, unknown> : null
  const config = record?.config && typeof record.config === 'object' ? record.config as Record<string, unknown> : null
  // A permission/profile config is resolved by Codex, not by this bridge. Do not mix it
  // with RPC defaults or guess the resulting sandbox from a profile name.
  const configPermissions = !!config && Object.keys(config).some(key => ['approval_policy', 'sandbox_mode', 'sandbox_workspace_write', 'default_permissions', 'permissions', 'profile', 'profiles'].some(root => key === root || key.startsWith(`${root}.`)))
  const profile = record?.permissions != null || configPermissions
  return { approvalPolicy: profile || record?.approvalPolicy != null, sandbox: profile || record?.[['turn/start', 'thread/settings/update'].includes(method) ? 'sandboxPolicy' : 'sandbox'] != null }
}

/** A hot resume cannot change active work; stage only supported next-turn fields. */
export function prepareAppServerHotPermissionOverrides(params: unknown): AppServerTurnPermissionOverrides {
  const record = params as Record<string, unknown>
  const configIntent = readAppServerPermissionIntent('thread/resume', { config: record.config })
  if (configIntent.approvalPolicy || configIntent.sandbox) throw new Error('Hot permission config cannot be applied to active work; choose explicit permissions on the next turn.')
  if (record.permissions != null && record.sandbox != null) throw new Error('A permissions profile cannot be combined with sandbox.')
  if (record.sandbox != null && !['read-only', 'danger-full-access'].includes(record.sandbox as string)) throw new Error('Hot sandbox requires an explicit sandboxPolicy or permissions profile on the next turn; active writer preserved.')
  return {
    ...(record.approvalPolicy != null ? { approvalPolicy: record.approvalPolicy } : {}),
    ...(record.permissions != null ? { permissions: record.permissions } : {}),
    ...(record.sandbox === 'read-only' ? { sandboxPolicy: { type: 'readOnly', networkAccess: false } } : {}),
    ...(record.sandbox === 'danger-full-access' ? { sandboxPolicy: { type: 'dangerFullAccess' } } : {}),
  }
}

/** The more recent turn choice wins; named profiles must never acquire a staged sandbox. */
export function mergeAppServerHotPermissionOverrides(pending: AppServerTurnPermissionOverrides, params: Record<string, unknown>): Record<string, unknown> {
  const staged = { ...pending }
  if (params.permissions != null) delete staged.sandboxPolicy
  if (params.sandboxPolicy != null) delete staged.permissions
  const merged = { ...staged, ...params }
  for (const key of ['approvalPolicy', 'sandboxPolicy', 'permissions']) if (params[key] == null && staged[key] != null) merged[key] = staged[key]
  return merged
}

/** Apply UI permission defaults at native RPC boundaries without mutating the caller. */
export function applyAppServerPermissionDefaults(method: string, params: unknown, retained?: AppServerPermissionIntent, defaults: AppServerPermissionDefaults = { approvalPolicy: 'never', sandboxMode: 'danger-full-access' }, effectiveSandbox?: unknown): unknown {
  if (!['thread/start', 'thread/resume', 'turn/start'].includes(method) || !params || typeof params !== 'object' || Array.isArray(params)) return params
  const record = params as Record<string, unknown>
  const sandboxKey = method === 'turn/start' ? 'sandboxPolicy' : 'sandbox'
  const intent = readAppServerPermissionIntent(method, params)
  let defaultSandbox: unknown = defaults.sandboxMode
  if (method === 'turn/start' && !retained?.sandbox && !intent.sandbox) {
    if (defaults.sandboxMode === 'workspace-write') {
      const policy = effectiveSandbox && typeof effectiveSandbox === 'object' ? effectiveSandbox as Record<string, unknown> : null
      if (policy?.type !== 'workspaceWrite' || !Array.isArray(policy.writableRoots) || !policy.writableRoots.every(root => typeof root === 'string')
        || typeof policy.networkAccess !== 'boolean' || typeof policy.excludeTmpdirEnvVar !== 'boolean' || typeof policy.excludeSlashTmp !== 'boolean') {
        throw new Error('Workspace runtime permissions require a native workspace policy or an explicit next-turn permission choice; active writer preserved.')
      }
      defaultSandbox = policy
    } else defaultSandbox = defaults.sandboxMode === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'dangerFullAccess' }
  }
  return {
    ...record,
    // Legacy launch-only on-failure is not in the pinned typed RPC contract. Leave
    // it to native launch config rather than translating it to a different policy.
    ...(!retained?.approvalPolicy && !intent.approvalPolicy && defaults.approvalPolicy !== 'on-failure' ? { approvalPolicy: defaults.approvalPolicy } : {}),
    ...(!retained?.sandbox && !intent.sandbox ? { [sandboxKey]: defaultSandbox } : {}),
  }
}
