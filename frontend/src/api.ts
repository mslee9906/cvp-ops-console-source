import type {
  CollectionProgressResponse,
  ConfigPreviewResponse,
  ConfigSearchResponse,
  DeviceSummary,
  EdmLink,
  EdmLinkInput,
  KanbanCard,
  KanbanCardInput,
  KanbanCardPosition,
  KanbanDiffResponse,
  KanbanTargetSnapshotResponse,
  KanbanValidationResponse,
  LoginResponse,
  LookupResponse,
  OverviewResponse,
  RecordListResponse,
  RecordScope,
  UserCreateInput,
  UserSummary,
  VniGroupListResponse,
  VrfGroupListResponse,
} from './types'

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
    ...options,
  })

  if (!response.ok) {
    const raw = await response.text()
    let message = raw
    try {
      message = raw ? JSON.parse(raw).detail ?? raw : raw
    } catch {
      message = raw
    }
    throw new ApiError(response.status, message || `Request failed with status ${response.status}`)
  }

  return response.json() as Promise<T>
}

export const api = {
  login: (username: string, password: string) =>
    request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: async () => {
    await request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' })
  },
  getCurrentUser: () => request<UserSummary>('/api/auth/me'),
  getUsers: () => request<UserSummary[]>('/api/auth/users'),
  createUser: (payload: UserCreateInput) =>
    request<UserSummary>('/api/auth/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteUser: async (userId: number) => {
    await request<{ ok: boolean }>(`/api/auth/users/${userId}`, { method: 'DELETE' })
  },
  changePassword: (currentPassword: string, newPassword: string) =>
    request<UserSummary>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),
  getOverview: () => request<OverviewResponse>('/api/overview'),
  getDevices: () => request<DeviceSummary[]>('/api/devices'),
  getConfig: (deviceId: string) => request<ConfigPreviewResponse>(`/api/devices/${deviceId}/config`),
  getCollectionStatus: () => request<CollectionProgressResponse>('/api/collections/status'),
  startRefresh: () => request<CollectionProgressResponse>('/api/collections/refresh', { method: 'POST' }),
  getRecords: (scope: RecordScope, limit = 200, extraQuery = '') =>
    request<RecordListResponse>(`/api/records/${scope}?limit=${limit}${extraQuery}`),
  getVrfGroups: (limit = 200, excludeDefault = false, name = '') =>
    request<VrfGroupListResponse>(
      `/api/records/vrf?limit=${limit}&exclude_default=${excludeDefault}${name ? `&name=${encodeURIComponent(name)}` : ''}`,
    ),
  getVniGroups: (limit = 200, vni = '') =>
    request<VniGroupListResponse>(`/api/records/vni?limit=${limit}${vni ? `&vni=${encodeURIComponent(vni)}` : ''}`),
  searchConfig: (query: string, limit = 200) =>
    request<ConfigSearchResponse>(`/api/search/config?q=${encodeURIComponent(query)}&limit=${limit}`),
  getEdmLinks: () => request<EdmLink[]>('/api/edm-links'),
  createEdmLink: (payload: EdmLinkInput) =>
    request<EdmLink>('/api/edm-links', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateEdmLink: (linkId: number, payload: Partial<EdmLinkInput>) =>
    request<EdmLink>(`/api/edm-links/${linkId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteEdmLink: async (linkId: number) => {
    await request<{ ok: boolean }>(`/api/edm-links/${linkId}`, { method: 'DELETE' })
  },
  getKanbanCards: () => request<KanbanCard[]>('/api/kanban/cards'),
  createKanbanCard: (payload: KanbanCardInput) =>
    request<KanbanCard>('/api/kanban/cards', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateKanbanCard: (cardId: number, payload: Partial<KanbanCardInput>) =>
    request<KanbanCard>(`/api/kanban/cards/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteKanbanCard: async (cardId: number) => {
    await request<{ ok: boolean }>(`/api/kanban/cards/${cardId}`, { method: 'DELETE' })
  },
  reorderKanbanCards: (items: KanbanCardPosition[]) =>
    request<KanbanCard[]>('/api/kanban/cards/reorder', {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),
  getKanbanTargetSnapshot: (targetId: number) =>
    request<KanbanTargetSnapshotResponse>(`/api/kanban/targets/${targetId}/snapshot`),
  validateKanbanConfig: (targetId: number, configText: string) =>
    request<KanbanValidationResponse>('/api/kanban/validate', {
      method: 'POST',
      body: JSON.stringify({ target_id: targetId, config_text: configText }),
    }),
  diffKanbanConfig: (targetId: number, configText: string) =>
    request<KanbanDiffResponse>('/api/kanban/diff', {
      method: 'POST',
      body: JSON.stringify({ target_id: targetId, config_text: configText }),
    }),
  lookupIp: (query: string, vrf?: string) =>
    request<LookupResponse>(
      `/api/lookup/ip?q=${encodeURIComponent(query)}${vrf ? `&vrf=${encodeURIComponent(vrf)}` : ''}`,
    ),
  lookupBgp: (asn: string) => request<LookupResponse>(`/api/lookup/bgp?asn=${encodeURIComponent(asn)}`),
  lookupVlan: (vlanId?: string, name?: string) =>
    request<LookupResponse>(
      `/api/lookup/vlan?${[vlanId ? `vlan_id=${encodeURIComponent(vlanId)}` : '', name ? `name=${encodeURIComponent(name)}` : '']
        .filter(Boolean)
        .join('&')}`,
    ),
  lookupVrf: (name: string) => request<LookupResponse>(`/api/lookup/vrf?name=${encodeURIComponent(name)}`),
}
