import type {
  AutomationApplyResponse,
  AutomationConfigPreviewResponse,
  AutomationPlanResponse,
  AutomationSource,
  AutomationSourceDevice,
  AutomationTargetMode,
  AutomationToolDetail,
  AutomationToolSummary,
  BackupCreateResponse,
  BackupItem,
  BgpManagementResponse,
  BackupRestoreResponse,
  BgpManagementManualEntry,
  CollectionProgressResponse,
  CardReservationsResponse,
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
  MonitoringDashboardResponse,
  MonitoringHistoryResponse,
  MonitoringSourceConfig,
  MonitoringSourceConfigInput,
  NotificationItem,
  NotificationListResponse,
  OverviewResponse,
  RecordListResponse,
  RecordScope,
  ResourceReservation,
  UserCreateInput,
  UserSummary,
  VmacGroupListResponse,
  VniGroupListResponse,
  VrfGroupListResponse,
  WorkHistoryItem,
  WorkHistoryRestoreResponse,
  WorkPlanExportRequest,
  WorkPlanProgressResponse,
  WorkflowDocument,
  WorkflowDocumentResponse,
  WorkflowPhaseCompleteResponse,
  WorkflowTemplate,
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

async function requestBlob(path: string, options?: RequestInit): Promise<{ blob: Blob; filename: string }> {
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

  const blob = await response.blob()
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const encodedNameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  const basicNameMatch = disposition.match(/filename="?([^";]+)"?/i)
  const filename = encodedNameMatch?.[1]
    ? decodeURIComponent(encodedNameMatch[1])
    : basicNameMatch?.[1] ?? 'workplan.xlsx'
  return { blob, filename }
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
  getAutomationSources: () => request<AutomationSource[]>('/api/automation/sources'),
  getAutomationSourceDevices: (source: string) =>
    request<AutomationSourceDevice[]>(`/api/automation/sources/${encodeURIComponent(source)}/devices`),
  getAutomationSourceConfig: (source: string, deviceId: string) =>
    request<AutomationConfigPreviewResponse>(
      `/api/automation/sources/${encodeURIComponent(source)}/devices/${encodeURIComponent(deviceId)}/config`,
    ),
  getAutomationTools: () => request<AutomationToolSummary[]>('/api/automation/tools'),
  getAutomationToolDetail: (toolSlug: string) =>
    request<AutomationToolDetail>(`/api/automation/tools/${encodeURIComponent(toolSlug)}`),
  previewAutomationTool: (
    toolSlug: string,
    payload: { source: string; target_mode: AutomationTargetMode; device_ids: string[] },
  ) =>
    request<AutomationPlanResponse>(`/api/automation/tools/${encodeURIComponent(toolSlug)}/preview`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  applyAutomationTool: (
    toolSlug: string,
    payload: { source: string; target_mode: AutomationTargetMode; device_ids: string[] },
  ) =>
    request<AutomationApplyResponse>(`/api/automation/tools/${encodeURIComponent(toolSlug)}/apply`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getRecords: (scope: RecordScope, limit = 200, extraQuery = '') =>
    request<RecordListResponse>(`/api/records/${scope}?limit=${limit}${extraQuery}`),
  getVrfGroups: (limit = 200, excludeDefault = false, name = '') =>
    request<VrfGroupListResponse>(
      `/api/records/vrf?limit=${limit}&exclude_default=${excludeDefault}${name ? `&name=${encodeURIComponent(name)}` : ''}`,
    ),
  getBgpManagementSnapshot: () => request<BgpManagementResponse>('/api/bgp/management'),
  createBgpManagementEntry: (payload: {
    asn: string
    entry_kind: 'reserved' | 'custom'
    device_names: string[]
    note: string
  }) =>
    request<BgpManagementManualEntry>('/api/bgp/management/entries', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteBgpManagementEntry: async (entryId: number) => {
    await request<{ ok: boolean }>(`/api/bgp/management/entries/${entryId}`, { method: 'DELETE' })
  },
  updateBgpManagementEntry: (
    entryId: number,
    payload: {
      asn: string
      entry_kind: 'reserved' | 'custom'
      device_names: string[]
      note: string
    },
  ) =>
    request<BgpManagementManualEntry>(`/api/bgp/management/entries/${entryId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  getVniGroups: (limit = 200, vni = '') =>
    request<VniGroupListResponse>(`/api/records/vni?limit=${limit}${vni ? `&vni=${encodeURIComponent(vni)}` : ''}`),
  getVmacGroups: (limit = 200, vmac = '') =>
    request<VmacGroupListResponse>(`/api/records/vmac?limit=${limit}${vmac ? `&vmac=${encodeURIComponent(vmac)}` : ''}`),
  searchConfig: (query: string, limit = 200) =>
    request<ConfigSearchResponse>(`/api/search/config?q=${encodeURIComponent(query)}&limit=${limit}`),
  getEdmLinks: () => request<EdmLink[]>('/api/edm-links'),
  createEdmLink: (payload: EdmLinkInput) =>
    request<EdmLink>('/api/edm-links', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateEdmLink: (linkId: number, payload: Partial<EdmLinkInput & { sort_order: number }>) =>
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
  clearKanbanColumnCards: (columnKey: string) =>
    request<{ ok: boolean; deleted: number }>(`/api/kanban/columns/${encodeURIComponent(columnKey)}/cards`, {
      method: 'DELETE',
    }),
  completeKanbanCard: (cardId: number, completedNote: string) =>
    request<WorkHistoryItem>(`/api/history/cards/${cardId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ completed_note: completedNote }),
    }),
  reorderKanbanCards: (items: KanbanCardPosition[]) =>
    request<KanbanCard[]>('/api/kanban/cards/reorder', {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),
  getKanbanTargetSnapshot: (targetId: number) =>
    request<KanbanTargetSnapshotResponse>(`/api/kanban/targets/${targetId}/snapshot`),
  startWorkPlanWorkbookJob: (cardId: number, payload: WorkPlanExportRequest) =>
    request<WorkPlanProgressResponse>(`/api/workplans/cards/${cardId}/jobs`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getWorkPlanWorkbookJob: (jobId: string) =>
    request<WorkPlanProgressResponse>(`/api/workplans/jobs/${encodeURIComponent(jobId)}`),
  downloadWorkPlanWorkbookJob: (jobId: string) =>
    requestBlob(`/api/workplans/jobs/${encodeURIComponent(jobId)}/download`, {
      method: 'GET',
    }),
  downloadWorkPlanSnapshotArchiveJob: (jobId: string) =>
    requestBlob(`/api/workplans/jobs/${encodeURIComponent(jobId)}/snapshot-archive`, {
      method: 'GET',
    }),
  downloadWorkPlanWorkbook: (cardId: number, payload: WorkPlanExportRequest) =>
    requestBlob(`/api/workplans/cards/${cardId}/export`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getCardReservations: (cardId: number) =>
    request<CardReservationsResponse>(`/api/reservations/cards/${cardId}`),
  createBgpAsReservation: (cardId: number, asn: string) =>
    request<ResourceReservation>(`/api/reservations/cards/${cardId}/bgp-as`, {
      method: 'POST',
      body: JSON.stringify({ asn }),
    }),
  createVniReservation: (cardId: number, vni: string) =>
    request<ResourceReservation>(`/api/reservations/cards/${cardId}/vni`, {
      method: 'POST',
      body: JSON.stringify({ vni }),
    }),
  cancelBgpAsReservation: (cardId: number, reservationId: number) =>
    request<ResourceReservation>(`/api/reservations/cards/${cardId}/bgp-as/${reservationId}/cancel`, {
      method: 'POST',
    }),
  cancelVniReservation: (cardId: number, reservationId: number) =>
    request<ResourceReservation>(`/api/reservations/cards/${cardId}/vni/${reservationId}/cancel`, {
      method: 'POST',
    }),
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
  getNotifications: (limit = 20) => request<NotificationListResponse>(`/api/notifications?limit=${limit}`),
  markNotificationRead: (notificationId: number) =>
    request<NotificationItem>(`/api/notifications/${notificationId}/read`, {
      method: 'POST',
    }),
  markAllNotificationsRead: () =>
    request<{ ok: boolean; updated: number }>('/api/notifications/read-all', {
      method: 'POST',
    }),
  getWorkflow: (cardId: number) => request<WorkflowDocumentResponse>(`/api/workflows/cards/${cardId}`),
  saveWorkflow: (cardId: number, workflow: WorkflowDocument) =>
    request<WorkflowDocumentResponse>(`/api/workflows/cards/${cardId}`, {
      method: 'PUT',
      body: JSON.stringify({ workflow }),
    }),
  completeWorkflowPhase: (cardId: number, phaseId: string) =>
    request<WorkflowPhaseCompleteResponse>(`/api/workflows/cards/${cardId}/phases/${encodeURIComponent(phaseId)}/complete`, {
      method: 'POST',
    }),
  uncompleteWorkflowPhase: (cardId: number, phaseId: string) =>
    request<WorkflowDocumentResponse>(`/api/workflows/cards/${cardId}/phases/${encodeURIComponent(phaseId)}/uncomplete`, {
      method: 'POST',
    }),
  getWorkflowTemplates: (cardType?: string) =>
    request<WorkflowTemplate[]>(
      `/api/workflows/templates${cardType ? `?card_type=${encodeURIComponent(cardType)}` : ''}`,
    ),
  createWorkflowTemplate: (payload: { name: string; description: string; card_type: string; workflow: WorkflowDocument }) =>
    request<WorkflowTemplate>('/api/workflows/templates', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateWorkflowTemplate: (
    templateId: number,
    payload: Partial<{ name: string; description: string; workflow: WorkflowDocument }>,
  ) =>
    request<WorkflowTemplate>(`/api/workflows/templates/${templateId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteWorkflowTemplate: async (templateId: number) => {
    await request<{ ok: boolean }>(`/api/workflows/templates/${templateId}`, { method: 'DELETE' })
  },
  getWorkHistory: () => request<WorkHistoryItem[]>('/api/history'),
  getWorkHistoryItem: (historyId: number) => request<WorkHistoryItem>(`/api/history/${historyId}`),
  restoreWorkHistoryItem: (historyId: number, options?: { delete_history?: boolean }) =>
    request<WorkHistoryRestoreResponse>(`/api/history/${historyId}/restore`, {
      method: 'POST',
      body: JSON.stringify({ delete_history: Boolean(options?.delete_history) }),
    }),
  deleteWorkHistoryItem: async (historyId: number) => {
    await request<{ ok: boolean }>(`/api/history/${historyId}`, {
      method: 'DELETE',
    })
  },
  getBackups: () => request<BackupItem[]>('/api/backups'),
  createBackup: () =>
    request<BackupCreateResponse>('/api/backups', {
      method: 'POST',
    }),
  restoreBackup: (name: string) =>
    request<BackupRestoreResponse>('/api/backups/restore', {
      method: 'POST',
      body: JSON.stringify({ name }),
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
  getMonitoringSources: () => request<MonitoringSourceConfig[]>('/api/monitoring/sources'),
  saveMonitoringSources: (sources: MonitoringSourceConfigInput[]) =>
    request<MonitoringSourceConfig[]>('/api/monitoring/sources', {
      method: 'PUT',
      body: JSON.stringify({ sources }),
    }),
  getMonitoringLive: () => request<MonitoringDashboardResponse>('/api/monitoring/live'),
  refreshMonitoringLive: () =>
    request<MonitoringDashboardResponse>('/api/monitoring/live/refresh', {
      method: 'POST',
    }),
  acknowledgeMonitoringSourceAlerts: (sourceId: number) =>
    request<MonitoringDashboardResponse>(`/api/monitoring/sources/${sourceId}/acknowledge`, {
      method: 'POST',
    }),
  getMonitoringHistory: (query = '', severity = '', startDate = '', endDate = '', limit = 100, offset = 0) =>
    request<MonitoringHistoryResponse>(
      `/api/monitoring/history?query=${encodeURIComponent(query)}&severity=${encodeURIComponent(severity)}&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&limit=${limit}&offset=${offset}`,
    ),
}
