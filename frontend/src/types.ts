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
  vni_count: number
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

export interface VniGroupDevice {
  device_id: string
  hostname: string
  mgmt_ip: string
  vlan_id: string
  vlan_name: string
}

export interface VniGroupItem {
  vni: string
  device_count: number
  vlan_ids: string[]
  devices: VniGroupDevice[]
}

export interface VniGroupListResponse {
  scope: 'vni'
  total_count: number
  items: VniGroupItem[]
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

export type EdmLinkColorKey = 'ocean' | 'forest' | 'sunset' | 'plum' | 'cobalt' | 'slate'

export interface EdmLink {
  id: number
  title: string
  subtitle: string
  link_type: string
  url: string
  color_key: EdmLinkColorKey
  sort_order: number
  created_at: string
  updated_at: string
}

export interface EdmLinkInput {
  title: string
  subtitle: string
  link_type: string
  url: string
  color_key: EdmLinkColorKey
}

export type UserRole = 'admin' | 'editor' | 'viewer'

export interface UserSummary {
  id: number
  username: string
  display_name: string
  role: UserRole
  is_active: boolean
  created_at: string
  updated_at: string
  last_login_at: string
}

export interface LoginResponse {
  user: UserSummary
}

export interface UserCreateInput {
  username: string
  display_name: string
  password: string
  role: UserRole
}

export type KanbanColumnKey = 'blocked' | 'planned' | 'ready' | 'in_progress' | 'verifying' | 'done'
export type KanbanCardType = 'existing' | 'new'
export type KanbanPriority = 'high' | 'medium' | 'low'
export type KanbanTargetKind = 'existing' | 'new'
export type KanbanTargetMatchStatus = 'manual_only' | 'candidate_found' | 'linked_to_cvp' | 'ignored'
export type KanbanTargetServiceStatus = 'planned' | 'mgmt_only' | 'service_partial' | 'service_ready'

export interface KanbanChecklistItem {
  id?: number | null
  title: string
  is_completed: boolean
  sort_order?: number | null
}

export interface KanbanTargetItem {
  id?: number | null
  target_kind: KanbanTargetKind
  display_name: string
  mgmt_ip: string
  model: string
  role_hint: string
  cvp_device_id: string
  match_status: KanbanTargetMatchStatus
  service_status?: KanbanTargetServiceStatus
  sort_order?: number | null
  created_at?: string
  updated_at?: string
}

export interface KanbanPlannedConfigItem {
  id?: number | null
  target_id: number
  config_text: string
  created_at?: string
  updated_at?: string
}

export interface KanbanCard {
  id: number
  card_code: string
  title: string
  description: string
  due_at: string
  assignee: string
  assignee_user_id?: number | null
  created_by_user_id?: number | null
  created_by_name?: string
  updated_by_user_id?: number | null
  updated_by_name?: string
  column_key: KanbanColumnKey
  card_type: KanbanCardType
  priority: KanbanPriority
  sort_order: number
  checklist_total: number
  checklist_completed: number
  progress_percent: number
  checklist_items: KanbanChecklistItem[]
  targets: KanbanTargetItem[]
  planned_configs: KanbanPlannedConfigItem[]
  created_at: string
  updated_at: string
}

export interface KanbanCardInput {
  title: string
  description: string
  due_at: string
  assignee: string
  assignee_user_id?: number | null
  column_key: KanbanColumnKey
  card_type: KanbanCardType
  priority: KanbanPriority
  checklist_items?: KanbanChecklistItem[]
  targets?: KanbanTargetItem[]
  planned_configs?: KanbanPlannedConfigItem[]
}

export interface KanbanCardPosition {
  id: number
  column_key: KanbanColumnKey
  sort_order: number
}

export interface KanbanTargetSnapshotResponse {
  target: KanbanTargetItem
  linked_device: DeviceSummary | Record<string, never>
  config: ConfigPreviewResponse | Record<string, never>
  bgp_entries: Array<Record<string, DetailValue>>
  vrfs: Array<Record<string, DetailValue>>
  vlans: Array<Record<string, DetailValue>>
  vnis: Array<Record<string, DetailValue>>
  ip_records: Array<Record<string, DetailValue>>
}

export interface KanbanValidationMatch {
  title: string
  body: string
  severity: 'info' | 'warning' | 'error'
  details: Record<string, DetailValue>
}

export interface KanbanValidationSection {
  key: string
  title: string
  items: KanbanValidationMatch[]
}

export interface KanbanValidationResponse {
  target_id: number
  has_conflict: boolean
  sections: KanbanValidationSection[]
}

export interface KanbanDiffLine {
  left_line_number: number | null
  right_line_number: number | null
  left_text: string
  right_text: string
  kind: 'equal' | 'insert' | 'delete' | 'replace' | string
}

export interface KanbanDiffResponse {
  target_id: number
  snapshot_available: boolean
  snapshot_text: string
  planned_text: string
  lines: KanbanDiffLine[]
}

export type WorkflowBlockType = 'table' | 'note' | 'checklist'
export type WorkflowTableMode = 'target' | 'custom'
export type WorkflowColumnType = 'text' | 'textarea' | 'status'
export type WorkflowStatus = 'not_started' | 'in_progress' | 'done' | 'blocked' | 'n_a'
export type WorkflowBlockSize = 'compact' | 'regular' | 'wide' | 'full'

export interface WorkflowTableColumn {
  key: string
  label: string
  type: WorkflowColumnType
  width: number
}

export interface WorkflowChecklistItem {
  text: string
  done: boolean
  assignee: string
}

export interface WorkflowBaseBlock {
  id: string
  type: WorkflowBlockType
  title: string
  subtitle: string
  editing: boolean
  size: WorkflowBlockSize
  widthUnits: number
  heightPx: number
}

export interface WorkflowTableBlock extends WorkflowBaseBlock {
  type: 'table'
  mode: WorkflowTableMode
  columns: WorkflowTableColumn[]
  rows: Array<Record<string, string>>
}

export interface WorkflowNoteBlock extends WorkflowBaseBlock {
  type: 'note'
  content: string
}

export interface AutomationSource {
  name: string
  host: string
  port: number
  raw_device_count: number
  latest_collected_at: string | null
}

export interface AutomationSourceDevice {
  raw_device_key: string
  cvp_source: string
  device_id: string
  hostname: string
  serial: string
  mgmt_ip: string
  model: string
  site: string
  tags: string[]
  last_collected_at: string
  has_config: boolean
  config_collected_at: string | null
}

export interface AutomationConfigPreviewResponse extends ConfigPreviewResponse {
  cvp_source: string
}

export interface AutomationApiStep {
  title: string
  target: string
  detail: string
}

export interface AutomationToolSummary {
  slug: string
  title: string
  summary: string
  workspace_name: string
}

export interface AutomationToolDetail extends AutomationToolSummary {
  description: string
  code_preview: string
  api_steps: AutomationApiStep[]
  notes: string[]
  warnings: string[]
}

export type AutomationTargetMode = 'selected' | 'all'

export interface AutomationTagOperation {
  action: 'add' | 'remove'
  element_type: 'device' | 'interface'
  label: string
  value: string
  device_id: string
  interface_id: string | null
  display_key: string
}

export interface AutomationResolvedDevice {
  device_id: string
  hostname: string
}

export interface AutomationPlanResponse {
  slug: string
  source: string
  target_mode: AutomationTargetMode
  requested_device_ids: string[]
  resolved_device_ids: string[]
  resolved_devices: AutomationResolvedDevice[]
  summary: string
  add_count: number
  remove_count: number
  operations: AutomationTagOperation[]
  notes: string[]
  warnings: string[]
}

export interface AutomationWorkspaceResult {
  action: 'add' | 'remove'
  workspace_name: string
  workspace_id: string
  change_control_ids: string[]
}

export interface AutomationApplyResponse {
  slug: string
  source: string
  target_mode: AutomationTargetMode
  requested_device_ids: string[]
  resolved_device_ids: string[]
  summary: string
  add_count: number
  remove_count: number
  workspaces: AutomationWorkspaceResult[]
  notes: string[]
  warnings: string[]
}

export interface WorkflowChecklistBlock extends WorkflowBaseBlock {
  type: 'checklist'
  items: WorkflowChecklistItem[]
}

export type WorkflowBlock = WorkflowTableBlock | WorkflowNoteBlock | WorkflowChecklistBlock

export interface WorkflowPhase {
  id: string
  title: string
  subtitle: string
  assigneeUserId?: number | null
  assigneeName: string
  includeInProgress: boolean
  isCompleted: boolean
  completedAt: string
  completedByUserId?: number | null
  completedByName: string
  blocks: WorkflowBlock[]
}

export interface WorkflowDocument {
  ticketId: string
  cardTitle: string
  projectName: string
  summary: string
  grade: string
  owner: string
  createdBy: string
  lastUpdated: string
  lastUpdatedBy: string
  templateId?: number | null
  templateName: string
  targets: string[]
  phases: WorkflowPhase[]
}

export interface WorkflowDocumentResponse {
  card_id: number
  workflow: WorkflowDocument
  created_at: string
  updated_at: string
}

export interface WorkflowPhaseCompleteResponse extends WorkflowDocumentResponse {
  completed_phase_id: string
  notified_phase_id: string
  notified_phase_title: string
  notification_recipient: string
  notification_title: string
  notification_body: string
}

export interface WorkflowTemplate {
  id: number
  name: string
  description: string
  card_type: string
  workflow: WorkflowDocument
  is_system: boolean
  created_by_user_id?: number | null
  updated_by_user_id?: number | null
  created_at: string
  updated_at: string
}

export type NotificationKind = 'info' | 'assignment' | 'workflow_ready' | 'workflow_completed'

export interface NotificationItem {
  id: number
  user_id: number
  kind: NotificationKind
  title: string
  body: string
  link_view: string
  link_card_id?: number | null
  link_phase_id: string
  is_read: boolean
  created_by_user_id?: number | null
  created_at: string
  read_at: string
}

export interface NotificationListResponse {
  items: NotificationItem[]
  unread_count: number
}
