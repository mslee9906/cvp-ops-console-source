export type LookupStatus = 'available' | 'in_use' | 'review' | 'not_available' | 'error'
export type RecordScope = 'ip' | 'bgp' | 'vlan'
export type DetailValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | DetailValue[]
  | { [key: string]: DetailValue }

export interface CollectionJobSummary {
  job_name: string
  source: string
  status: string
  start_time: string
  end_time: string
  error_message: string
}

export interface CollectionProgressResponse {
  source_mode: string
  status: string
  progress_percent: number
  step: string
  detail: string
  started_at: string
  updated_at: string
  latest_job: CollectionJobSummary | null
}

export interface OverviewResponse {
  device_count: number
  ip_count: number
  bgp_count: number
  vlan_count: number
  vrf_count: number
  config_snapshot_count: number
  latest_collection_at: string | null
  source_mode: string
  latest_job: CollectionJobSummary | null
}

export interface DeviceSummary {
  device_id: string
  hostname: string
  serial: string
  mgmt_ip: string
  model: string
  site: string
  tags: string[]
  last_collected_at: string
  config_hash?: string | null
  config_collected_at?: string | null
}

export interface LookupMatch {
  device_id: string
  hostname: string
  interface_name?: string | null
  vrf?: string | null
  match_type?: string | null
  label?: string | null
  details: Record<string, DetailValue>
}

export interface LookupResponse {
  query: string
  scope: string
  status: LookupStatus
  summary: string
  exact_match_count: number
  related_match_count: number
  matches: LookupMatch[]
}

export interface RecordListResponse {
  scope: string
  total_count: number
  items: LookupMatch[]
}

export interface ConfigPreviewResponse {
  device_id: string
  hostname: string
  config_hash: string
  collected_at: string
  line_count: number
  file_path: string
  content: string
}

export interface VrfGroupDevice {
  device_id: string
  hostname: string
  mgmt_ip: string
}

export interface VrfGroupItem {
  vrf_name: string
  device_count: number
  devices: VrfGroupDevice[]
}

export interface VrfGroupListResponse {
  scope: 'vrf'
  total_count: number
  items: VrfGroupItem[]
}

export interface ConfigSearchLine {
  line_number: number
  text: string
}

export interface ConfigSearchMatch {
  device_id: string
  hostname: string
  mgmt_ip: string
  collected_at: string
  match_count: number
  matched_lines: ConfigSearchLine[]
}

export interface ConfigSearchResponse {
  query: string
  total_count: number
  total_line_matches: number
  items: ConfigSearchMatch[]
}

export type KanbanWorkType = 'existing_device' | 'new_device'
export type KanbanColumnKey = 'draft' | 'planned' | 'ready' | 'in_progress' | 'verifying' | 'done' | 'blocked'

export interface KanbanLinkedDevice {
  device_id: string
  hostname: string
  mgmt_ip: string
  model: string
  serial: string
}

export interface KanbanDraftDevice {
  hostname: string
  mgmt_ip: string
  model: string
  serial: string
}

export interface KanbanCard {
  id: number
  title: string
  description: string
  work_type: KanbanWorkType
  column_key: KanbanColumnKey
  order_index: number
  existing_device_id?: string | null
  linked_device?: KanbanLinkedDevice | null
  draft_device?: KanbanDraftDevice | null
  created_at: string
  updated_at: string
}

export interface KanbanBoardResponse {
  columns: KanbanColumnKey[]
  cards: KanbanCard[]
}

export interface KanbanCardPayload {
  title: string
  description: string
  work_type: KanbanWorkType
  column_key: KanbanColumnKey
  existing_device_id?: string | null
  new_device_hostname?: string
  new_device_mgmt_ip?: string
  new_device_model?: string
  new_device_serial?: string
}
