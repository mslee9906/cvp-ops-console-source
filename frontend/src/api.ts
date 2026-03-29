import type {
  CollectionProgressResponse,
  ConfigPreviewResponse,
  DeviceSummary,
  LookupResponse,
  OverviewResponse,
  RecordListResponse,
  RecordScope,
} from './types'

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
    ...options,
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Request failed with status ${response.status}`)
  }

  return response.json() as Promise<T>
}

export const api = {
  getOverview: () => request<OverviewResponse>('/api/overview'),
  getDevices: () => request<DeviceSummary[]>('/api/devices'),
  getConfig: (deviceId: string) => request<ConfigPreviewResponse>(`/api/devices/${deviceId}/config`),
  getCollectionStatus: () => request<CollectionProgressResponse>('/api/collections/status'),
  startRefresh: () => request<CollectionProgressResponse>('/api/collections/refresh', { method: 'POST' }),
  getRecords: (scope: RecordScope, limit = 200, extraQuery = '') =>
    request<RecordListResponse>(`/api/records/${scope}?limit=${limit}${extraQuery}`),
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

