// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
/**
 * API helpers for THCC 综合成本看板.
 * Paths relative to /api (apiGet prepends /api).
 */

import { apiGet, apiPost, API_BASE, getAuthToken } from '@/shared/lib/api';

const BASE = '/v1/thcc-cost-board';

export interface SnapshotSummary {
  id: string;
  period: string;
  period_label: string | null;
  title: string | null;
  fx_cny_to_thb: number | null;
  unit: string | null;
  status: string;
  source_generated_at: string | null;
  imported_at: string | null;
  project_count: number;
  source_meta: Record<string, unknown>;
}

export interface PortfolioKpis {
  snapshot_id: string;
  period: string;
  period_label: string | null;
  title: string | null;
  fx_cny_to_thb: number | null;
  unit: string | null;
  source_generated_at: string | null;
  counts: Record<string, number>;
  total_contract: number;
  total_resp_cost: number;
  total_actual: number;
  total_forecast: number;
  total_budget: number;
  total_proc: number;
  total_fin_paid: number;
  total_sub_contract: number;
  active_count: number;
  done_count: number;
  risk_count: number;
  avg_exp_margin: number | null;
  avg_bid_margin: number | null;
  avg_progress: number | null;
}

export interface ProjectRowSummary {
  id: string;
  snapshot_id: string;
  project_id: string | null;
  project_code: string;
  name: string;
  full_name: string | null;
  bucket: string | null;
  status: string | null;
  risk: string | null;
  pm: string | null;
  contract: number | null;
  resp_cost: number | null;
  actual: number | null;
  forecast: number | null;
  settle: number | null;
  progress: number | null;
  bid_margin: number | null;
  exp_margin: number | null;
  budget_total: number | null;
  proc_total: number | null;
  fin_paid: number | null;
  sub_contract: number | null;
  alerts: string[];
}

export interface ProjectRowList {
  items: ProjectRowSummary[];
  total: number;
  snapshot: SnapshotSummary | null;
}

export interface ProjectDetail {
  summary: ProjectRowSummary;
  payload: Record<string, unknown>;
  snapshot: SnapshotSummary | null;
}

export interface LaborProjectInfo {
  project_key: string;
  project_code: string | null;
  project_name: string;
  total_amount: number;
}

export interface LaborCatalog {
  projects: LaborProjectInfo[];
  categories: string[];
  months: string[];
}

export interface LaborProjectSeries {
  project_key: string;
  project_code: string | null;
  project_name: string;
  months: string[];
  series: Record<string, number[]>;
  cumulative: Record<string, number[]>;
}

export interface ImportPathsInfo {
  cost_board_json: string | null;
  cost_board_json_exists: boolean;
  labor_html: string | null;
  labor_html_exists: boolean;
  labor_xlsx: string | null;
  labor_xlsx_exists: boolean;
  thcc_root: string | null;
}

export interface ImportResult {
  ok: boolean;
  snapshot_id: string | null;
  period: string | null;
  project_count: number;
  linked_projects: number;
  labor_rows: number;
  replaced: boolean;
  message: string;
  source_path: string | null;
}

export function fetchSnapshots() {
  return apiGet<{ items: SnapshotSummary[]; total: number }>(`${BASE}/snapshots`);
}

export function fetchPortfolio(params?: { snapshot_id?: string; period?: string }) {
  const qs = new URLSearchParams();
  if (params?.snapshot_id) qs.set('snapshot_id', params.snapshot_id);
  if (params?.period) qs.set('period', params.period);
  const q = qs.toString();
  return apiGet<PortfolioKpis>(`${BASE}/portfolio${q ? `?${q}` : ''}`);
}

export function fetchProjects(params?: {
  snapshot_id?: string;
  period?: string;
  bucket?: string;
  risk?: string;
  q?: string;
}) {
  const qs = new URLSearchParams();
  if (params?.snapshot_id) qs.set('snapshot_id', params.snapshot_id);
  if (params?.period) qs.set('period', params.period);
  if (params?.bucket) qs.set('bucket', params.bucket);
  if (params?.risk) qs.set('risk', params.risk);
  if (params?.q) qs.set('q', params.q);
  const q = qs.toString();
  return apiGet<ProjectRowList>(`${BASE}/projects${q ? `?${q}` : ''}`);
}

export function fetchProjectByRowId(rowId: string) {
  return apiGet<ProjectDetail>(`${BASE}/projects/${rowId}`);
}

export function fetchProjectByCode(code: string, params?: { snapshot_id?: string; period?: string }) {
  const qs = new URLSearchParams();
  if (params?.snapshot_id) qs.set('snapshot_id', params.snapshot_id);
  if (params?.period) qs.set('period', params.period);
  const q = qs.toString();
  return apiGet<ProjectDetail>(
    `${BASE}/by-code/${encodeURIComponent(code)}${q ? `?${q}` : ''}`,
  );
}

export function fetchProjectByOceId(
  projectId: string,
  params?: { snapshot_id?: string; period?: string },
) {
  const qs = new URLSearchParams();
  if (params?.snapshot_id) qs.set('snapshot_id', params.snapshot_id);
  if (params?.period) qs.set('period', params.period);
  const q = qs.toString();
  return apiGet<ProjectDetail>(
    `${BASE}/by-oce-project/${projectId}${q ? `?${q}` : ''}`,
  );
}

export function fetchLaborCatalog() {
  return apiGet<LaborCatalog>(`${BASE}/labor/catalog`);
}

export function fetchLaborSeries(params: { project_key?: string; project_code?: string }) {
  const qs = new URLSearchParams();
  if (params.project_key) qs.set('project_key', params.project_key);
  if (params.project_code) qs.set('project_code', params.project_code);
  return apiGet<LaborProjectSeries>(`${BASE}/labor/series?${qs.toString()}`);
}

export function fetchImportPaths() {
  return apiGet<ImportPathsInfo>(`${BASE}/import/paths`);
}

export function importFromDisk(opts?: { replace?: boolean; include_labor?: boolean }) {
  const qs = new URLSearchParams();
  if (opts?.replace !== undefined) qs.set('replace', String(opts.replace));
  if (opts?.include_labor !== undefined) qs.set('include_labor', String(opts.include_labor));
  const q = qs.toString();
  return apiPost<ImportResult>(`${BASE}/import/from-disk${q ? `?${q}` : ''}`, {}, { longRunning: true });
}

async function uploadFile(path: string, file: File, extraQs?: string): Promise<ImportResult> {
  const token = getAuthToken();
  const form = new FormData();
  form.append('file', file);
  const url = `${API_BASE}${path}${extraQs ? `?${extraQs}` : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = (body as { detail?: string }).detail || res.statusText;
    throw new Error(detail);
  }
  return res.json() as Promise<ImportResult>;
}

export function importJsonFile(file: File, replace = true) {
  return uploadFile(`${BASE}/import/json`, file, `replace=${replace}`);
}

export function importLaborHtmlFile(file: File) {
  return uploadFile(`${BASE}/import/labor-html`, file);
}
