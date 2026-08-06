// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import {
  FolderPlus, FolderOpen, ArrowRight, MoreHorizontal, Copy, Trash2, Archive, ArchiveRestore, ExternalLink,
  Search, ChevronDown, ArrowUpDown, ArrowUp, ArrowDown, Star, Map as MapIcon, CloudSun,
  Building2, DollarSign, Euro, PoundSterling, Globe2, MapPin, Layers, AlertTriangle,
  FileSpreadsheet, Download, Upload, LayoutGrid, List,
} from 'lucide-react';
import { formatDistanceToNowStrict, isValid as isValidDate, parseISO } from 'date-fns';
import { Button, Card, Badge, EmptyState, Skeleton, SkeletonGrid, Breadcrumb, ProjectMap, ProjectWeather, FileTypeChips, ConfirmDialog, ModuleGuideButton, RecoveryCard, type LatLng } from '@/shared/ui';
import { PageHeader } from '@/shared/ui/PageHeader';
import { DismissibleInfo, IntroRichText } from '@/shared/ui/DismissibleInfo';
import { useWidgetSettingsStore } from '@/stores/useWidgetSettingsStore';
import { getIntlLocale } from '@/shared/lib/formatters';
import { projectsApi, type Project } from './api';
import { apiGet, apiPatch, apiPost, apiDelete } from '@/shared/lib/api';
import { useToastStore } from '@/stores/useToastStore';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { useLocalStorage } from '@/shared/hooks/useLocalStorage';
import { CreateProjectModal } from './CreateProjectPage';
import { projectsGuide } from './projectsGuide';
import {
  ProjectStatusBadge,
  CURATED_PROJECT_STATUSES,
  WORKING_PROJECT_STATUSES,
  useProjectStatusLabel,
} from './ProjectStatusBadge';
import { BIMConverterStatusBanner } from '../bim/BIMConverterStatusBanner';
import { CURRENCY_GROUPS } from './currencyGroups';
import { REGION_GROUPS } from './CreateProjectPage';

interface ProjectBOQStats {
  projectId: string;
  boqCount: number;
  /** BOQ position total in project base currency. */
  totalValue: number;
  /** Contracts module register sum (总包+分包, converted). */
  contractRegisterValue: number;
  contractMainValue: number;
  contractSubValue: number;
  /** Project.contract_value manual field. */
  projectContractValue: number;
  /** Project.budget_estimate manual field. */
  budgetEstimate: number;
  hasError?: boolean;
}

/** Sortable columns on the projects page (list headers + toolbar). */
export type ProjectSortField =
  | 'name'
  | 'code'
  | 'status'
  | 'region'
  | 'currency'
  | 'boq'
  | 'value'
  | 'created'
  | 'updated';

export type ProjectSortDir = 'asc' | 'desc';

export type ProjectSortState = {
  field: ProjectSortField;
  dir: ProjectSortDir;
};

type ProjectViewMode = 'card' | 'list';
// Status filter: 'all' (incl. archived), 'working' (every non-archived),
// or an exact status token (active = 在建, closing, settling, settled, …).
type StatusFilter = string;

/** Allowed page sizes for the projects list / card grid. */
export const PROJECT_PAGE_SIZE_OPTIONS = [12, 24, 48, 96] as const;
const DEFAULT_PAGE_SIZE = 12;

const DEFAULT_SORT: ProjectSortState = { field: 'created', dir: 'desc' };

/** Lifecycle order for status sort (earlier = “more active”). */
const STATUS_SORT_RANK: Record<string, number> = Object.fromEntries(
  CURATED_PROJECT_STATUSES.map((s, i) => [s, i]),
);

/**
 * Map legacy sort tokens (pre field+dir) and partial localStorage blobs
 * onto a valid ProjectSortState.
 */
export function normalizeProjectSort(raw: unknown): ProjectSortState {
  if (raw && typeof raw === 'object' && 'field' in (raw as object)) {
    const o = raw as { field?: string; dir?: string };
    const field = (o.field || DEFAULT_SORT.field) as ProjectSortField;
    const dir = o.dir === 'asc' || o.dir === 'desc' ? o.dir : DEFAULT_SORT.dir;
    const allowed: ProjectSortField[] = [
      'name',
      'code',
      'status',
      'region',
      'currency',
      'boq',
      'value',
      'created',
      'updated',
    ];
    if (allowed.includes(field)) return { field, dir };
  }
  // Legacy string options from earlier builds
  switch (raw) {
    case 'name_asc':
      return { field: 'name', dir: 'asc' };
    case 'newest':
      return { field: 'created', dir: 'desc' };
    case 'oldest':
      return { field: 'created', dir: 'asc' };
    case 'value':
      return { field: 'value', dir: 'desc' };
    default:
      return { ...DEFAULT_SORT };
  }
}

function compareProjects(
  a: Project,
  b: Project,
  sort: ProjectSortState,
  boqStatsMap: Map<string, ProjectBOQStats>,
  hasMultipleCurrencies: boolean,
): number {
  const mul = sort.dir === 'asc' ? 1 : -1;
  const emptyLast = (va: string, vb: string) => {
    const ea = !va;
    const eb = !vb;
    if (ea && eb) return 0;
    if (ea) return 1; // empty after non-empty regardless of dir for readability
    if (eb) return -1;
    return va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' }) * mul;
  };

  switch (sort.field) {
    case 'name':
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * mul;
    case 'code':
      return emptyLast(
        (a.project_code || '').trim(),
        (b.project_code || '').trim(),
      );
    case 'status': {
      const ra = STATUS_SORT_RANK[a.status] ?? 50;
      const rb = STATUS_SORT_RANK[b.status] ?? 50;
      if (ra !== rb) return (ra - rb) * mul;
      return a.status.localeCompare(b.status) * mul;
    }
    case 'region':
      return emptyLast(a.region || '', b.region || '');
    case 'currency':
      return emptyLast(a.currency || '', b.currency || '');
    case 'boq': {
      const va = boqStatsMap.get(a.id)?.boqCount ?? -1;
      const vb = boqStatsMap.get(b.id)?.boqCount ?? -1;
      return (va - vb) * mul;
    }
    case 'value': {
      if (hasMultipleCurrencies) {
        const aCur = a.currency || '';
        const bCur = b.currency || '';
        if (aCur !== bCur) return aCur.localeCompare(bCur);
      }
      const va = boqStatsMap.get(a.id)?.totalValue ?? 0;
      const vb = boqStatsMap.get(b.id)?.totalValue ?? 0;
      return (va - vb) * mul;
    }
    case 'created': {
      const ta = new Date(a.created_at).getTime() || 0;
      const tb = new Date(b.created_at).getTime() || 0;
      return (ta - tb) * mul;
    }
    case 'updated': {
      const ta = new Date(a.updated_at || a.created_at).getTime() || 0;
      const tb = new Date(b.updated_at || b.created_at).getTime() || 0;
      return (ta - tb) * mul;
    }
    default:
      return 0;
  }
}

// Concrete statuses the backend GET /projects?status= filter accepts.
const SERVER_FILTERABLE_STATUSES = new Set([
  'active',
  'closing',
  'settling',
  'settled',
  'on_hold',
  'finished',
  'cancelled',
  'archived',
]);

/**
 * Build the status-filter option list shown in the toolbar dropdown.
 *
 * 'all' / 'working' are view sentinels; curated statuses follow (active =
 * in-progress construction). Custom statuses on loaded projects are unioned in.
 */
export function buildStatusFilterOptions(
  projectStatuses: Iterable<string | null | undefined>,
): string[] {
  const ordered: string[] = ['all', 'working', ...CURATED_PROJECT_STATUSES];
  const seen = new Set(ordered);
  for (const s of projectStatuses) {
    const status = (s ?? '').trim();
    if (status && !seen.has(status)) {
      seen.add(status);
      ordered.push(status);
    }
  }
  return ordered;
}

/**
 * Whether any non-default filter or search is currently applied.
 *
 * This drives the "no matching projects" empty state and - critically -
 * keeps the filter toolbar mounted when a filtered fetch (e.g. the Archived
 * view) comes back empty. Without it, an empty Archived list dropped the
 * whole toolbar, stranding the user with no Active/Archived switch (#284).
 */
export function isProjectFilterActive(
  searchQuery: string,
  statusFilter: StatusFilter,
  regionFilter: string,
): boolean {
  return Boolean(searchQuery) || statusFilter !== 'all' || regionFilter !== 'all';
}

// Region tags + colours are derived from actual project data — no
// region-specific list is hard-coded in the default UI per the
// "no country-specific standards or city names in default UI" rule.
// Avatar colours cycle through a palette indexed by region string.
const REGION_AVATAR_PALETTE = [
  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  'bg-gray-100 text-gray-700 dark:bg-gray-900/40 dark:text-gray-300',
];

function getRegionAvatarClass(region?: string): string {
  if (!region) return 'bg-oe-blue-subtle text-oe-blue-text';
  // Stable hash → palette index so the same region always renders the same colour.
  let h = 0;
  for (let i = 0; i < region.length; i++) h = (h * 31 + region.charCodeAt(i)) >>> 0;
  return REGION_AVATAR_PALETTE[h % REGION_AVATAR_PALETTE.length] ?? 'bg-oe-blue-subtle text-oe-blue-text';
}

const currencyFmt = new Intl.NumberFormat(getIntlLocale(), {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function ProjectsPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);

  // Create project modal
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const excelImportRef = useRef<HTMLInputElement>(null);
  const [excelBusy, setExcelBusy] = useState(false);
  useEffect(() => {
    const state = location.state as { openCreateModal?: boolean } | null;
    if (state?.openCreateModal) {
      setCreateModalOpen(true);
      window.history.replaceState({}, '');
    }
  }, [location.state]);

  const handleExcelTemplate = async () => {
    try {
      setExcelBusy(true);
      await projectsApi.downloadExcelTemplate();
      addToast({
        type: 'success',
        title: t('projects.excel.template_ok', { defaultValue: 'Template downloaded' }),
        message: t('projects.excel.template_hint', {
          defaultValue: 'Fill rows (name required), then use Import Excel.',
        }),
      });
    } catch (e) {
      addToast({
        type: 'error',
        title: t('projects.excel.template_fail', { defaultValue: 'Template download failed' }),
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setExcelBusy(false);
    }
  };

  const handleExcelExport = async () => {
    try {
      setExcelBusy(true);
      await projectsApi.exportExcel();
      addToast({
        type: 'success',
        title: t('projects.excel.export_ok', { defaultValue: 'Projects exported' }),
      });
    } catch (e) {
      addToast({
        type: 'error',
        title: t('projects.excel.export_fail', { defaultValue: 'Export failed' }),
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setExcelBusy(false);
    }
  };

  const handleExcelImport = async (file: File) => {
    try {
      setExcelBusy(true);
      const result = await projectsApi.importExcel(file);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['projects-switcher'] });
      const errN = result.errors?.length ?? 0;
      addToast({
        type: errN && !result.imported ? 'error' : 'success',
        title: t('projects.excel.import_ok', {
          defaultValue: 'Imported {{n}} project(s)',
          n: result.imported,
        }),
        message: t('projects.excel.import_detail', {
          defaultValue: 'Skipped {{skipped}} · Errors {{errors}} · Rows {{total}}',
          skipped: result.skipped,
          errors: errN,
          total: result.total_rows,
        }),
      });
      if (errN > 0) {
        const sample = result.errors
          .slice(0, 5)
          .map((e) => `row ${e.row}: ${e.error}`)
          .join('; ');
        addToast({
          type: 'warning',
          title: t('projects.excel.import_errors', { defaultValue: 'Some rows failed' }),
          message: sample,
        });
      }
    } catch (e) {
      addToast({
        type: 'error',
        title: t('projects.excel.import_fail', { defaultValue: 'Import failed' }),
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setExcelBusy(false);
      if (excelImportRef.current) excelImportRef.current.value = '';
    }
  };

  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useLocalStorage('oe_projects_filters', {
    status: 'all' as StatusFilter,
    region: 'all',
    // Prefer structured sort; legacy `sort` string still normalized below.
    sortState: DEFAULT_SORT as ProjectSortState,
    sort: undefined as string | undefined,
    view: 'card' as ProjectViewMode,
    pageSize: DEFAULT_PAGE_SIZE as number,
  });
  const statusFilter = filters.status;
  const regionFilter = filters.region;
  const sortState = normalizeProjectSort(
    filters.sortState ?? filters.sort ?? DEFAULT_SORT,
  );
  const viewMode: ProjectViewMode =
    filters.view === 'list' ? 'list' : 'card';
  const pageSize = PROJECT_PAGE_SIZE_OPTIONS.includes(
    filters.pageSize as (typeof PROJECT_PAGE_SIZE_OPTIONS)[number],
  )
    ? (filters.pageSize as number)
    : DEFAULT_PAGE_SIZE;
  const setStatusFilter = (v: StatusFilter) => setFilters((p) => ({ ...p, status: v }));
  const setRegionFilter = (v: string) => setFilters((p) => ({ ...p, region: v }));
  const setSortState = (v: ProjectSortState) =>
    setFilters((p) => ({ ...p, sortState: v, sort: undefined }));
  const setViewMode = (v: ProjectViewMode) => setFilters((p) => ({ ...p, view: v }));
  const setPageSize = (n: number) => {
    setFilters((p) => ({ ...p, pageSize: n }));
    setPage(1);
  };
  /** Toggle sort: same field flips dir; new field uses sensible default dir. */
  const applySortField = (field: ProjectSortField) => {
    if (sortState.field === field) {
      setSortState({ field, dir: sortState.dir === 'asc' ? 'desc' : 'asc' });
    } else {
      // Dates / value / boq default to descending; text fields ascending.
      const dir: ProjectSortDir =
        field === 'created' ||
        field === 'updated' ||
        field === 'value' ||
        field === 'boq'
          ? 'desc'
          : 'asc';
      setSortState({ field, dir });
    }
  };
  const [page, setPage] = useState(1);

  const {
    data: projects,
    isLoading,
    isError: projectsError,
    error: projectsErrorValue,
    refetch: refetchProjects,
  } = useQuery({
    queryKey: ['projects', statusFilter],
    // 'archived' / 'all' need explicit server flags; exact curated statuses
    // use server filter; 'working' = default list (non-archived).
    queryFn: () => {
      if (statusFilter === 'archived') return projectsApi.listByStatus('archived');
      if (statusFilter === 'all') return projectsApi.listByStatus('all');
      if (statusFilter === 'working') return projectsApi.list();
      if (SERVER_FILTERABLE_STATUSES.has(statusFilter)) {
        return projectsApi.listByStatus(statusFilter);
      }
      return projectsApi.list();
    },
    staleTime: 5 * 60_000,
  });

  /** Multi-select for bulk archive / restore / status. */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState<
    null | { kind: 'archive' | 'restore' | 'hard-delete' }
  >(null);
  const [bulkStatusValue, setBulkStatusValue] = useState<string>('active');
  const [bulkCurrencyValue, setBulkCurrencyValue] = useState<string>('');
  const [bulkRegionValue, setBulkRegionValue] = useState<string>('');

  // Clear selection when the filtered set changes so we never act on hidden rows.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [statusFilter, regionFilter, searchQuery, projects]);

  const invalidateProjects = () => {
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void queryClient.invalidateQueries({ queryKey: ['projects-switcher'] });
  };

  const toastBulkResult = (
    title: string,
    result: { ok: string[]; failed: Array<{ id: string; error: string }> },
  ) => {
    if (result.failed.length === 0) {
      addToast({
        type: 'success',
        title,
        message: t('projects.bulk_ok', {
          defaultValue: '{{count}} project(s) updated',
          count: result.ok.length,
        }),
      });
    } else {
      addToast({
        type: 'warning',
        title,
        message: t('projects.bulk_partial', {
          defaultValue: '{{ok}} succeeded, {{fail}} failed',
          ok: result.ok.length,
          fail: result.failed.length,
        }),
      });
    }
    setSelectedIds(new Set());
    invalidateProjects();
  };

  const runBulkArchive = async () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      const result = await projectsApi.bulkArchive(ids);
      toastBulkResult(
        t('projects.bulk_archived', { defaultValue: 'Projects archived' }),
        result,
      );
    } finally {
      setBulkBusy(false);
      setBulkConfirm(null);
    }
  };

  const runBulkRestore = async () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      const result = await projectsApi.bulkRestore(ids);
      toastBulkResult(
        t('projects.bulk_restored', { defaultValue: 'Projects restored' }),
        result,
      );
    } finally {
      setBulkBusy(false);
      setBulkConfirm(null);
    }
  };

  const projectsById = useMemo(
    () => new Map((projects ?? []).map((p) => [p.id, p] as const)),
    [projects],
  );

  const runBulkHardDelete = async () => {
    const ids = Array.from(selectedIds).filter(
      (id) => projectsById.get(id)?.status === 'archived',
    );
    if (!ids.length) {
      addToast({
        type: 'info',
        title: t('projects.bulk_hard_delete_none', {
          defaultValue: 'Only archived projects can be permanently deleted',
        }),
        message: t('projects.bulk_hard_delete_none_hint', {
          defaultValue: '请先归档，或将筛选切换到「已归档」后再选。',
        }),
      });
      setBulkConfirm(null);
      return;
    }
    setBulkBusy(true);
    try {
      const result = await projectsApi.bulkHardDelete(ids);
      toastBulkResult(
        t('projects.bulk_hard_deleted', {
          defaultValue: 'Projects permanently deleted',
        }),
        result,
      );
    } finally {
      setBulkBusy(false);
      setBulkConfirm(null);
    }
  };

  const runBulkCurrencyRegion = async () => {
    const ids = Array.from(selectedIds).filter(
      (id) => projectsById.get(id)?.status !== 'archived',
    );
    if (!ids.length) {
      addToast({
        type: 'warning',
        title: t('projects.bulk_status_none', {
          defaultValue: 'No eligible projects',
        }),
        message: t('projects.bulk_status_archived_hint', {
          defaultValue: 'Restore archived projects before changing currency/region.',
        }),
      });
      return;
    }
    if (!bulkCurrencyValue && !bulkRegionValue) {
      addToast({
        type: 'info',
        title: t('projects.bulk_currency_region_empty', {
          defaultValue: '请选择币种和/或地区',
        }),
      });
      return;
    }
    setBulkBusy(true);
    try {
      const result = await projectsApi.bulkSetCurrencyRegion(ids, {
        currency: bulkCurrencyValue || undefined,
        region: bulkRegionValue || undefined,
      });
      toastBulkResult(
        t('projects.bulk_currency_region_done', {
          defaultValue: '币种 / 地区已更新',
        }),
        result,
      );
    } finally {
      setBulkBusy(false);
    }
  };

  const runBulkStatus = async (status: string) => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    // Only non-archived rows; restore first if user selected archived.
    const eligible = ids.filter((id) => projectsById.get(id)?.status !== 'archived');
    const skipped = ids.length - eligible.length;
    if (!eligible.length) {
      addToast({
        type: 'warning',
        title: t('projects.bulk_status_none', {
          defaultValue: 'No eligible projects',
        }),
        message: t('projects.bulk_status_archived_hint', {
          defaultValue: 'Restore archived projects before changing status.',
        }),
      });
      return;
    }
    setBulkBusy(true);
    try {
      const result = await projectsApi.bulkSetStatus(eligible, status);
      toastBulkResult(
        t('projects.bulk_status_done', {
          defaultValue: 'Status updated to {{status}}',
          status: statusLabel(status),
        }),
        result,
      );
      if (skipped > 0) {
        addToast({
          type: 'info',
          title: t('projects.bulk_status_skipped', {
            defaultValue: '{{n}} archived project(s) skipped',
            n: skipped,
          }),
        });
      }
    } finally {
      setBulkBusy(false);
    }
  };

  /* Demo-data banner: seeded demo projects carry metadata.demo_id. The
     purge action lives in Settings > Advanced too, but new users could not
     find it there ("how do I delete all this pre-created data?"), so the
     projects list - where the demo cards actually confront the user -
     offers it directly to admins. */
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => apiGet<{ role?: string }>('/v1/users/me/'),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const demoCount = useMemo(
    () => (projects ?? []).filter((p) => Boolean((p.metadata as Record<string, unknown> | null)?.demo_id)).length,
    [projects],
  );
  const [showPurgeDemo, setShowPurgeDemo] = useState(false);
  const purgeDemoMutation = useMutation({
    mutationFn: () => apiPost<{ deleted: number }>('/v1/projects/demo-data/purge/', {}),
    onSuccess: (data) => {
      setShowPurgeDemo(false);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['projects-switcher'] });
      addToast({
        type: 'success',
        title: t('settings.demo_data_removed_title', { defaultValue: 'Sample data removed' }),
        message: t('settings.demo_data_removed_message', {
          defaultValue: '{{count}} sample projects were deleted. They will not be recreated on restart.',
          count: data.deleted,
        }),
      });
    },
    onError: (error: Error) => {
      setShowPurgeDemo(false);
      addToast({
        type: 'error',
        title: t('settings.demo_data_remove_failed', { defaultValue: 'Could not remove sample data' }),
        message: error.message,
      });
    },
  });

  /* Map of project_id → uploaded file extensions (rvt/ifc/dwg/pdf/…),
     served by one aggregate endpoint so the cards don't fan out N
     requests. Used to show "has BIM / drawings / docs" chips. */
  const { data: fileTypesByProject } = useQuery({
    queryKey: ['projects-file-types'],
    queryFn: () => apiGet<Record<string, string[]>>('/v1/documents/file-types-by-project/'),
    staleTime: 60_000,
  });

  /* BOQ stats per project — pulled from the single dashboard/cards aggregator
     so the grid does not fan out N requests per project. The endpoint excludes
     archived projects, so archived rows simply show 0 stats (acceptable trade-off:
     archived projects are rarely sorted by value). */
  interface DashboardCard {
    id: string;
    boq_total_value: number;
    boq_count: number;
    open_tasks?: number;
    open_rfis?: number;
    safety_incidents?: number;
    progress_pct?: number;
    contract_register_value?: number;
    contract_main_value?: number;
    contract_sub_value?: number;
    project_contract_value?: number;
    budget_estimate?: number;
  }
  const projectIdsKey = useMemo(
    () => (projects ? projects.map((p) => p.id).join(',') : ''),
    [projects],
  );
  const {
    data: boqStats,
    error: boqStatsError,
    refetch: refetchBoqStats,
    isFetching: isFetchingBoqStats,
  } = useQuery({
    queryKey: ['projects-dashboard-cards', projectIdsKey],
    queryFn: async () => {
      const cards = await apiGet<DashboardCard[]>('/v1/projects/dashboard/cards/');
      const cardMap = new Map(cards.map((c) => [c.id, c]));
      return (projects ?? []).map((p) => {
        const c = cardMap.get(p.id);
        // Prefer server rollups; fall back to project row fields when cards lag.
        const projectContract = c?.project_contract_value
          ?? (p.contract_value ? Number(String(p.contract_value).replace(/,/g, '')) || 0 : 0);
        const budget = c?.budget_estimate
          ?? (p.budget_estimate ? Number(String(p.budget_estimate).replace(/,/g, '')) || 0 : 0);
        return {
          projectId: p.id,
          boqCount: c?.boq_count ?? 0,
          totalValue: c?.boq_total_value ?? 0,
          contractRegisterValue: c?.contract_register_value ?? 0,
          contractMainValue: c?.contract_main_value ?? 0,
          contractSubValue: c?.contract_sub_value ?? 0,
          projectContractValue: projectContract,
          budgetEstimate: budget,
          hasError: false,
        };
      });
    },
    enabled: !!projects && projects.length > 0,
    staleTime: 60_000,
  });

  // Show a persistent warning if BOQ stats failed to load at the top level.
  // The cards still render via per-project fallback (boqStatsMap.get(id) →
  // undefined → ProjectCard's own fetcher fills in), so the whole page
  // doesn't blank out on a 500 from the rollup endpoint — but the warning
  // banner below makes the partial-data state explicit instead of leaving
  // the cards looking like "no BOQs / €0 value".
  useEffect(() => {
    if (boqStatsError) {
      if (import.meta.env.DEV) console.error('BOQ stats query failed:', boqStatsError);
    }
  }, [boqStatsError]);

  const boqStatsMap = useMemo(() => {
    if (!boqStats) return new Map<string, ProjectBOQStats>();
    return new Map(boqStats.map((s) => [s.projectId, s]));
  }, [boqStats]);

  /* ── Filter + Sort ────────────────────────────────────────────────── */

  const pinnedIds = useProjectContextStore((s) => s.pinnedProjectIds);

  // Whether the user's projects span more than one currency. Used to guard
  // the "Value" sort (cross-currency ordering is apples-to-oranges, since
  // there is no cross-project rate table) and to label the stat cards.
  const hasMultipleCurrencies = useMemo(() => {
    if (!projects) return false;
    const set = new Set(projects.map((p) => p.currency || '').filter(Boolean));
    return set.size > 1;
  }, [projects]);

  const filtered = useMemo(() => {
    if (!projects) return [];
    let list = [...projects];

    // Search by name, description, and project code
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description && p.description.toLowerCase().includes(q)) ||
          (p.project_code && p.project_code.toLowerCase().includes(q)),
      );
    }

    // Status filter. 'working' = every non-archived; 'all' = everything;
    // concrete tokens (active = 在建, closing, settling, …) exact-match.
    if (statusFilter === 'working') {
      list = list.filter((p) => p.status !== 'archived');
    } else if (statusFilter !== 'all') {
      list = list.filter((p) => p.status === statusFilter);
    }

    // Region filter
    if (regionFilter !== 'all') {
      list = list.filter((p) => p.region === regionFilter);
    }

    // Sort — pinned first, then user-selected field/direction.
    list.sort((a, b) => {
      const aPinned = pinnedIds.includes(a.id) ? 0 : 1;
      const bPinned = pinnedIds.includes(b.id) ? 0 : 1;
      if (aPinned !== bPinned) return aPinned - bPinned;
      return compareProjects(a, b, sortState, boqStatsMap, hasMultipleCurrencies);
    });

    return list;
  }, [projects, searchQuery, statusFilter, regionFilter, sortState, boqStatsMap, pinnedIds, hasMultipleCurrencies]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [searchQuery, statusFilter, regionFilter, sortState.field, sortState.dir, pageSize]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paginatedProjects = filtered.slice(
    (page - 1) * pageSize,
    page * pageSize,
  );
  // Clamp page if pageSize grew / list shrank
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  // Whether any non-default filter or search is currently applied. Drives
  // both the "no matching projects" empty state and - critically - keeping
  // the filter toolbar mounted when a filtered view (e.g. Archived) comes
  // back empty, so the user can always switch back to Active. Without this
  // guard an empty Archived view hid the toolbar and trapped the user (#284).
  const hasActiveFilter = isProjectFilterActive(searchQuery, statusFilter, regionFilter);

  /* ── Stats ────────────────────────────────────────────────────────── */

  const stats = useMemo(() => {
    if (!projects) return null;
    const totalProjects = projects.length;
    const activeProjects = projects.filter((p) => p.status === 'active').length;
    const archivedProjects = projects.filter((p) => p.status === 'archived').length;
    const totalBoqs = boqStats ? boqStats.reduce((s, b) => s + b.boqCount, 0) : 0;
    const avgBoqsPerProject = totalProjects > 0 ? totalBoqs / totalProjects : 0;

    // Money rule (b): BOQ values live in each project's own base currency
    // and there is NO cross-project rate table, so we never blend them into
    // a single scalar. Group totals BY currency; the UI shows per-currency
    // chips when more than one currency is present, or one currency-labelled
    // figure when they all share a currency. Avg is computed per currency
    // over that currency's active projects.
    const currencyOf = new Map(projects.map((p) => [p.id, p.currency || '']));
    interface CurrencyRollup {
      currency: string;
      total: number;
      largest: number;
      activeCount: number;
    }
    const byCurrency = new Map<string, CurrencyRollup>();
    if (boqStats) {
      // Seed active-project counts per currency so the average divides by
      // active projects of THAT currency (matching the legacy semantics).
      for (const p of projects) {
        if (p.status !== 'active') continue;
        const cur = p.currency || '';
        const r =
          byCurrency.get(cur) ??
          ({ currency: cur, total: 0, largest: 0, activeCount: 0 } as CurrencyRollup);
        r.activeCount += 1;
        byCurrency.set(cur, r);
      }
      for (const b of boqStats) {
        if (b.totalValue <= 0) continue;
        const cur = currencyOf.get(b.projectId) || '';
        const r =
          byCurrency.get(cur) ??
          ({ currency: cur, total: 0, largest: 0, activeCount: 0 } as CurrencyRollup);
        r.total += b.totalValue;
        if (b.totalValue > r.largest) r.largest = b.totalValue;
        byCurrency.set(cur, r);
      }
    }
    // Only currencies that actually carry value drive the per-currency UI.
    const valueByCurrency = Array.from(byCurrency.values())
      .filter((r) => r.total > 0)
      .map((r) => ({
        currency: r.currency,
        total: r.total,
        avg: r.activeCount > 0 ? r.total / r.activeCount : 0,
        largest: r.largest,
      }))
      .sort((a, b) => b.total - a.total);
    const multiCurrency = valueByCurrency.length > 1;

    const regions = new Set(projects.map((p) => p.region).filter(Boolean));
    const currencies = new Set(projects.map((p) => p.currency).filter(Boolean));

    const BIM_EXTS = new Set(['rvt', 'ifc', 'skp', 'nwc', 'nwd', 'dgn']);
    const bimProjectCount = fileTypesByProject
      ? projects.filter((p) =>
          (fileTypesByProject[p.id] ?? []).some((ext) =>
            BIM_EXTS.has(ext.toLowerCase()),
          ),
        ).length
      : 0;

    return {
      totalProjects,
      activeProjects,
      archivedProjects,
      totalBoqs,
      avgBoqsPerProject,
      valueByCurrency,
      multiCurrency,
      regionCount: regions.size,
      currencyCount: currencies.size,
      primaryCurrency: currencies.size === 1 ? [...currencies][0] : '',
      bimProjectCount,
    };
  }, [projects, boqStats, fileTypesByProject]);

  const formatBigValue = (v: number) =>
    v >= 1_000_000
      ? `${(v / 1_000_000).toFixed(1)}M`
      : v >= 1_000
        ? `${(v / 1_000).toFixed(0)}K`
        : currencyFmt.format(v);

  // Render a money figure with its ISO currency code, never a bare number.
  const formatMoney = (v: number, currency: string) =>
    `${formatBigValue(v)}${currency ? ` ${currency}` : ''}`;

  // Available region filter values — only regions actually present in the
  // user's project list (no globally hard-coded country/region inventory).
  const availableRegions = useMemo(() => {
    if (!projects) return ['all'];
    const set = new Set<string>();
    for (const p of projects) if (p.region) set.add(p.region);
    return ['all', ...Array.from(set).sort()];
  }, [projects]);

  // Available status filter values - the curated recommended set UNION any
  // distinct statuses actually present on the fetched projects (mirrors the
  // availableRegions pattern). This is what lets the dropdown offer every
  // status, including a custom/legacy one, instead of just All/Active/Archived.
  const statusLabel = useProjectStatusLabel();
  const availableStatuses = useMemo(
    () => buildStatusFilterOptions((projects ?? []).map((p) => p.status)),
    [projects],
  );

  /* ── Sort field labels ────────────────────────────────────────────── */

  const sortFieldOptions: {
    value: ProjectSortField;
    label: string;
    title?: string;
  }[] = [
    { value: 'name', label: t('projects.sort_name', { defaultValue: '名称' }) },
    {
      value: 'code',
      label: t('projects.sort_code', { defaultValue: '项目编码' }),
    },
    {
      value: 'status',
      label: t('projects.sort_status', { defaultValue: '状态' }),
      title: t('projects.sort_status_hint', {
        defaultValue: '生命周期顺序：在建 → 收尾 → 结算中 → 已结算完成 → …',
      }),
    },
    { value: 'region', label: t('projects.sort_region', { defaultValue: '区域' }) },
    {
      value: 'currency',
      label: t('projects.sort_currency', { defaultValue: '币种' }),
    },
    { value: 'boq', label: t('projects.sort_boq', { defaultValue: 'BOQ 数量' }) },
    {
      value: 'value',
      label: t('projects.sort_value', { defaultValue: '金额' }),
      title: hasMultipleCurrencies
        ? t('projects.sort_value_mixed_hint', {
            defaultValue: '多币种时按币种分组后排序金额',
          })
        : undefined,
    },
    {
      value: 'created',
      label: t('projects.sort_created', { defaultValue: '创建时间' }),
    },
    {
      value: 'updated',
      label: t('projects.sort_updated', { defaultValue: '更新时间' }),
    },
  ];

  return (
    <div className="space-y-5 animate-fade-in">
      <Breadcrumb items={[{ label: t('projects.title', 'Projects') }]} />
      {/* Header — the module name + icon live in the global top bar; this
          page renders only the muted subtitle + actions (canon §2). */}
      <PageHeader
        srTitle={t('nav.projects', { defaultValue: 'Projects' })}
        subtitle={
          projects
            ? t('projects.subtitle_count', {
                defaultValue: 'Manage your construction estimation projects ({{count}} total)',
                count: projects.length,
              })
            : t('common.loading', { defaultValue: 'Loading...' })
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* "How it works" guide — explains what a project is and how to
                fill it in. Sibling to the primary action so the header reads
                as one control cluster. Its closing CTA opens the create
                modal, matching the guide's "Create your first project" call. */}
            <ModuleGuideButton
              content={projectsGuide}
              onCta={() => setCreateModalOpen(true)}
            />
            <Button
              variant="secondary"
              size="sm"
              icon={<FileSpreadsheet size={15} />}
              disabled={excelBusy}
              onClick={() => void handleExcelTemplate()}
              data-testid="projects-excel-template"
            >
              {t('projects.excel.template', { defaultValue: 'Excel template' })}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Download size={15} />}
              disabled={excelBusy}
              onClick={() => void handleExcelExport()}
              data-testid="projects-excel-export"
            >
              {t('projects.excel.export', { defaultValue: 'Export Excel' })}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Upload size={15} />}
              disabled={excelBusy}
              onClick={() => excelImportRef.current?.click()}
              data-testid="projects-excel-import"
            >
              {t('projects.excel.import', { defaultValue: 'Import Excel' })}
            </Button>
            <input
              ref={excelImportRef}
              type="file"
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleExcelImport(f);
              }}
            />
            <Button
              variant="primary"
              size="sm"
              icon={<FolderPlus size={16} />}
              onClick={() => setCreateModalOpen(true)}
            >
              {t('projects.new_project')}
            </Button>
          </div>
        }
      />

      <DismissibleInfo
        storageKey="projects"
        title={t('projects.intro_title', { defaultValue: "One home for every project's numbers" })}
        more={
          t('projects.intro_more', { defaultValue: '' })
            ? <IntroRichText text={t('projects.intro_more')} />
            : undefined
        }
        links={[
          {
            label: t('nav.projects_new', { defaultValue: 'New project' }),
            onClick: () => setCreateModalOpen(true),
          },
          {
            label: t('nav.analytics', { defaultValue: 'Analytics' }),
            onClick: () => navigate('/analytics'),
          },
          {
            label: t('nav.reporting', { defaultValue: 'Reporting' }),
            onClick: () => navigate('/reporting'),
          },
        ]}
      >
        {t('projects.intro_body', {
          defaultValue:
            'Every project you create lands here as a card carrying its BOQ count, total value in its own currency, region and uploaded file types, so you see the whole portfolio at a glance without opening each one. Open a card to reach the project hub, or pin and filter to keep daily work on top. Totals feed Analytics and the role dashboards in Reporting.',
        })}
      </DismissibleInfo>

      {/* Demo-data notice: admins see how to clear the seeded showcase
          projects right where those cards live. */}
      {demoCount > 0 && me?.role === 'admin' && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border border-border-default bg-surface-elevated px-4 py-3">
          <p className="text-sm text-content-secondary min-w-0">
            {t('projects.demo_banner', {
              defaultValue:
                '{{count}} of these are sample projects, included so you can explore the platform with realistic content. Want to start with an empty workspace? Remove them here. Your own projects are never affected.',
              count: demoCount,
            })}
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowPurgeDemo(true)}
            data-testid="projects-remove-demo"
          >
            {t('settings.remove_demo_action', { defaultValue: 'Remove sample data' })}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={showPurgeDemo}
        loading={purgeDemoMutation.isPending}
        title={t('settings.remove_demo_confirm_title', { defaultValue: 'Remove sample data?' })}
        message={t('settings.remove_demo_confirm_message', {
          defaultValue:
            'All sample projects and their data will be permanently deleted, including archived ones. This cannot be undone.',
        })}
        confirmLabel={t('settings.remove_demo_action', { defaultValue: 'Remove sample data' })}
        onCancel={() => { if (!purgeDemoMutation.isPending) setShowPurgeDemo(false); }}
        onConfirm={() => purgeDemoMutation.mutate()}
      />

      {/* Stats cards — 4-up portfolio summary, each card with primary
          number + sub-line so no card is sparse. */}
      {stats && projects && projects.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {/* 1. Total Projects */}
            <div className="rounded-xl border border-border-light bg-surface-elevated/90 p-3 shadow-xs transition-shadow duration-normal ease-oe hover:shadow-sm">
              <div className="text-2xs font-medium text-content-tertiary uppercase tracking-wider">
                {t('projects.stats_total', { defaultValue: 'Total Projects' })}
              </div>
              <div className="mt-1 text-xl font-bold text-content-primary tabular-nums leading-none">
                {stats.totalProjects}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1">
                <Badge variant="success" size="sm" dot>
                  {t('projects.stats_active', {
                    defaultValue: '{{count}} active',
                    count: stats.activeProjects,
                  })}
                </Badge>
                {stats.archivedProjects > 0 && (
                  <Badge variant="neutral" size="sm" dot>
                    {t('projects.stats_archived', {
                      defaultValue: '{{count}} archived',
                      count: stats.archivedProjects,
                    })}
                  </Badge>
                )}
              </div>
            </div>

            {/* 2. Total BOQs */}
            <div className="rounded-xl border border-border-light bg-surface-elevated/90 p-3 shadow-xs transition-shadow duration-normal ease-oe hover:shadow-sm">
              <div className="text-2xs font-medium text-content-tertiary uppercase tracking-wider">
                {t('projects.stats_boqs', { defaultValue: 'Total BOQs' })}
              </div>
              <div className="mt-1 text-xl font-bold text-content-primary tabular-nums leading-none">
                {boqStats ? stats.totalBoqs.toLocaleString() : (
                  <Skeleton width={40} height={20} className="inline-block align-middle" />
                )}
              </div>
              <div className="mt-2 text-2xs text-content-tertiary">
                {boqStats && stats.totalProjects > 0
                  ? t('projects.stats_boqs_per_project', {
                      defaultValue: '{{avg}} per project',
                      avg: stats.avgBoqsPerProject.toFixed(1),
                    })
                  : ''}
              </div>
            </div>

            {/* 3. Total Value — never blend currencies into one scalar.
                Single currency → one labelled total. Multiple → "Mixed
                currencies" headline + a per-currency subtotal line. */}
            <div className="rounded-xl border border-border-light bg-surface-elevated/90 p-3 shadow-xs transition-shadow duration-normal ease-oe hover:shadow-sm">
              <div className="text-2xs font-medium text-content-tertiary uppercase tracking-wider">
                {t('projects.stats_value', { defaultValue: 'Total Value' })}
              </div>
              {!boqStats ? (
                <div className="mt-1 leading-none">
                  <Skeleton width={64} height={20} className="inline-block align-middle" />
                </div>
              ) : stats.valueByCurrency.length === 0 ? (
                <div className="mt-1 text-xl font-bold text-content-primary tabular-nums leading-none">
                  {currencyFmt.format(0)}
                </div>
              ) : stats.multiCurrency ? (
                <>
                  <div className="mt-1 text-sm font-bold text-content-primary leading-none">
                    {t('projects.stats_value_mixed', { defaultValue: 'Mixed currencies' })}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {stats.valueByCurrency.map((c) => (
                      <span
                        key={c.currency || 'unknown'}
                        className="inline-flex items-center gap-1 rounded-md bg-surface-secondary px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-content-secondary"
                      >
                        {formatBigValue(c.total)}
                        <span className="font-medium text-content-tertiary">
                          {c.currency || t('common.unknown', { defaultValue: 'Unknown' })}
                        </span>
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="mt-1 flex items-baseline gap-1.5 leading-none">
                    <span className="text-xl font-bold text-content-primary tabular-nums">
                      {formatBigValue(stats.valueByCurrency[0]!.total)}
                    </span>
                    <span className="text-2xs font-semibold uppercase tracking-wider text-content-tertiary">
                      {stats.valueByCurrency[0]!.currency}
                    </span>
                  </div>
                  <div className="mt-2 text-2xs text-content-tertiary">
                    {stats.valueByCurrency[0]!.currency}
                  </div>
                </>
              )}
            </div>

            {/* 4. Avg Project Size — per-currency average; never a blended
                scalar. Single currency → one labelled figure; multiple →
                "Mixed currencies" + per-currency average chips. */}
            <div className="rounded-xl border border-border-light bg-surface-elevated/90 p-3 shadow-xs transition-shadow duration-normal ease-oe hover:shadow-sm">
              <div className="text-2xs font-medium text-content-tertiary uppercase tracking-wider">
                {t('projects.stats_avg', { defaultValue: 'Avg Project Size' })}
              </div>
              {!boqStats ? (
                <div className="mt-1 leading-none">
                  <Skeleton width={64} height={20} className="inline-block align-middle" />
                </div>
              ) : stats.valueByCurrency.length === 0 ? (
                <div className="mt-1 text-xl font-bold text-content-primary tabular-nums leading-none">
                  {currencyFmt.format(0)}
                </div>
              ) : stats.multiCurrency ? (
                <>
                  <div className="mt-1 text-sm font-bold text-content-primary leading-none">
                    {t('projects.stats_value_mixed', { defaultValue: 'Mixed currencies' })}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {stats.valueByCurrency.map((c) => (
                      <span
                        key={c.currency || 'unknown'}
                        className="inline-flex items-center gap-1 rounded-md bg-surface-secondary px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-content-secondary"
                      >
                        {formatBigValue(c.avg)}
                        <span className="font-medium text-content-tertiary">
                          {c.currency || t('common.unknown', { defaultValue: 'Unknown' })}
                        </span>
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="mt-1 flex items-baseline gap-1.5 leading-none">
                    <span className="text-xl font-bold text-content-primary tabular-nums">
                      {formatBigValue(stats.valueByCurrency[0]!.avg)}
                    </span>
                    <span className="text-2xs font-semibold uppercase tracking-wider text-content-tertiary">
                      {stats.valueByCurrency[0]!.currency}
                    </span>
                  </div>
                  <div className="mt-2 text-2xs text-content-tertiary">
                    {stats.valueByCurrency[0]!.largest > 0
                      ? t('projects.stats_largest', {
                          defaultValue: 'Largest {{value}}',
                          value: formatMoney(
                            stats.valueByCurrency[0]!.largest,
                            stats.valueByCurrency[0]!.currency,
                          ),
                        })
                      : ''}
                  </div>
                </>
              )}
            </div>
          </div>

        </>
      )}

      {/* Search + Filters. Stay mounted whenever there are projects OR a
          filter/search is active: a filtered fetch (e.g. Archived) can return
          an empty list, and hiding the toolbar there would strand the user on
          the Archived view with no Active/Archived switch to get back. */}
      {((projects && projects.length > 0) || hasActiveFilter) && (
        <Card padding="none" className="mb-6">
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            {/* Search */}
            <div className="relative flex-1">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-content-tertiary">
                <Search size={16} />
              </div>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('projects.search_placeholder', {
                  defaultValue: 'Search projects...',
                })}
                aria-label={t('projects.search_placeholder', { defaultValue: 'Search projects...' })}
                className="h-10 w-full rounded-lg border border-border bg-surface-primary pl-10 pr-3 text-sm text-content-primary placeholder:text-content-tertiary focus:outline-none focus:ring-2 focus:ring-oe-blue focus:border-transparent"
              />
            </div>

            {/* Status filter. 'all' / 'working' are view sentinels; curated
                statuses (active = 在建) and any custom values follow. */}
            <div className="relative">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                aria-label={t('a11y.projects.status_filter', {
                  defaultValue: 'Filter projects by status',
                })}
                className="h-10 appearance-none rounded-lg border border-border bg-surface-primary pl-3 pr-9 text-sm text-content-primary focus:outline-none focus:ring-2 focus:ring-oe-blue sm:w-40"
              >
                {availableStatuses.map((s) => (
                  <option key={s} value={s}>
                    {s === 'all'
                      ? t('projects.filter_all', { defaultValue: '全部' })
                      : s === 'working'
                        ? t('projects.filter_working', {
                            defaultValue: '全部在办',
                          })
                        : s === 'archived'
                          ? t('projects.filter_archived', { defaultValue: '已归档' })
                          : statusLabel(s)}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2.5 text-content-tertiary">
                <ChevronDown size={14} />
              </div>
            </div>

            {/* Region filter */}
            <div className="relative">
              <select
                value={regionFilter}
                onChange={(e) => setRegionFilter(e.target.value)}
                aria-label={t('a11y.projects.region_filter', {
                  defaultValue: 'Filter projects by region',
                })}
                className="h-10 appearance-none rounded-lg border border-border bg-surface-primary pl-3 pr-9 text-sm text-content-primary focus:outline-none focus:ring-2 focus:ring-oe-blue sm:w-40"
              >
                {availableRegions.map((r) => (
                  <option key={r} value={r}>
                    {r === 'all'
                      ? t('projects.filter_all_regions', { defaultValue: 'All Regions' })
                      : r}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2.5 text-content-tertiary">
                <ChevronDown size={14} />
              </div>
            </div>

            {/* Sort field + direction */}
            <div className="flex shrink-0 items-center gap-1">
              <div className="relative">
                <select
                  value={sortState.field}
                  onChange={(e) => {
                    const field = e.target.value as ProjectSortField;
                    if (field === sortState.field) return;
                    const dir: ProjectSortDir =
                      field === 'created' ||
                      field === 'updated' ||
                      field === 'value' ||
                      field === 'boq'
                        ? 'desc'
                        : 'asc';
                    setSortState({ field, dir });
                  }}
                  aria-label={t('projects.sort_by', { defaultValue: 'Sort by' })}
                  title={
                    sortFieldOptions.find((o) => o.value === sortState.field)?.title
                  }
                  className="h-10 appearance-none rounded-lg border border-border bg-surface-primary pl-3 pr-8 text-sm text-content-primary focus:outline-none focus:ring-2 focus:ring-oe-blue sm:w-36"
                  data-testid="projects-sort-field"
                >
                  {sortFieldOptions.map((opt) => (
                    <option key={opt.value} value={opt.value} title={opt.title}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-content-tertiary">
                  <ChevronDown size={14} />
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  setSortState({
                    field: sortState.field,
                    dir: sortState.dir === 'asc' ? 'desc' : 'asc',
                  })
                }
                className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-surface-primary text-content-secondary hover:bg-surface-secondary"
                title={
                  sortState.dir === 'asc'
                    ? t('projects.sort_asc', { defaultValue: 'Ascending' })
                    : t('projects.sort_desc', { defaultValue: 'Descending' })
                }
                aria-label={t('projects.sort_toggle_dir', {
                  defaultValue: 'Toggle sort direction',
                })}
                data-testid="projects-sort-dir"
              >
                {sortState.dir === 'asc' ? (
                  <ArrowUp size={15} />
                ) : (
                  <ArrowDown size={15} />
                )}
              </button>
            </div>

            {/* Card / list view toggle */}
            <div
              className="flex shrink-0 items-center rounded-lg border border-border bg-surface-primary p-0.5"
              role="group"
              aria-label={t('projects.view_mode', { defaultValue: 'View mode' })}
            >
              <button
                type="button"
                onClick={() => setViewMode('card')}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                  viewMode === 'card'
                    ? 'bg-oe-blue-subtle text-oe-blue-text'
                    : 'text-content-tertiary hover:text-content-secondary'
                }`}
                title={t('projects.view_card', { defaultValue: 'Card view' })}
                aria-pressed={viewMode === 'card'}
                data-testid="projects-view-card"
              >
                <LayoutGrid size={15} />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                  viewMode === 'list'
                    ? 'bg-oe-blue-subtle text-oe-blue-text'
                    : 'text-content-tertiary hover:text-content-secondary'
                }`}
                title={t('projects.view_list', { defaultValue: 'List view' })}
                aria-pressed={viewMode === 'list'}
                data-testid="projects-view-list"
              >
                <List size={15} />
              </button>
            </div>

            {/* Page size */}
            <div className="relative shrink-0">
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                aria-label={t('projects.page_size', {
                  defaultValue: 'Rows per page',
                })}
                className="h-10 appearance-none rounded-lg border border-border bg-surface-primary pl-3 pr-8 text-sm text-content-primary focus:outline-none focus:ring-2 focus:ring-oe-blue"
                data-testid="projects-page-size"
              >
                {PROJECT_PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {t('projects.per_page', {
                      defaultValue: '{{n}} / page',
                      n,
                    })}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-content-tertiary">
                <ChevronDown size={14} />
              </div>
            </div>

            {/* Widget toggles — map + weather */}
            <WidgetToggles />
          </div>
        </Card>
      )}

      {/* Results */}
      {isLoading ? (
        <SkeletonGrid items={3} />
      ) : projectsError ? (
        // Genuine fetch failure — surface a recovery affordance instead of
        // the "No projects yet" empty state, which would silently hide an
        // auth/permission/server error behind a create-your-first CTA.
        <RecoveryCard error={projectsErrorValue} onRetry={() => refetchProjects()} />
      ) : filtered.length === 0 && hasActiveFilter ? (
        <EmptyState
          icon={<Search size={28} strokeWidth={1.5} />}
          title={t('projects.no_results', { defaultValue: 'No matching projects' })}
          description={
            statusFilter === 'archived'
              ? t('projects.no_archived_hint', {
                  defaultValue: 'No archived projects. Switch back to active projects below.',
                })
              : t('projects.no_results_hint', {
                  defaultValue: 'Try adjusting your search or filters',
                })
          }
          // Give a one-click escape back to the active list. The filter
          // toolbar above already lets the user switch, but a primary action
          // here makes the way out unmissable from an empty filtered view.
          action={{
            label: t('projects.show_working', {
              defaultValue: 'Show working projects',
            }),
            onClick: () => {
              setSearchQuery('');
              setStatusFilter('working');
              setRegionFilter('all');
            },
          }}
        />
      ) : !projects || projects.length === 0 ? (
        <div className="space-y-4">
          {/* Surface the BIM converter status here so a fresh-install user
           *  can see at a glance whether RVT/IFC/DWG/DGN drag-and-drop will
           *  work BEFORE creating the first project. Dismissible — once
           *  acknowledged it stays out of the way until the user resets
           *  the localStorage flag. */}
          <BIMConverterStatusBanner dismissible />
          {/* Empty-state copy unified per Probe-D P2-11. Title +
              description follow the shared "No {entity} yet" / "Create
              your first {entity}" template; the description retains the
              project-specific elaboration so users understand what a
              project is for. */}
          <EmptyState
            icon={<FolderOpen size={28} strokeWidth={1.5} />}
            title={t('projects.no_projects', { defaultValue: 'No projects yet' })}
            description={t('projects.no_projects_description', {
              defaultValue:
                'Projects organize your estimates, documents, and team. Create your first project to get started with cost estimation.',
            })}
            action={{
              label: t('projects.create_first', { defaultValue: 'Create your first project' }),
              onClick: () => setCreateModalOpen(true),
            }}
          />
        </div>
      ) : (
        <>
          {/* Rollup-failure banner. The aggregated /v1/projects/dashboard/
              cards endpoint feeds every card's BOQ count + value. When it
              500s the cards still render via per-project fallback (the
              card fetches its own stats), but the user has no idea the
              numbers are partial — they look identical to a zero-data
              project. Surface the failure explicitly with a Retry CTA. */}
          {boqStatsError && (
            <div
              role="status"
              className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 px-3 py-2"
            >
              <AlertTriangle
                size={16}
                className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-amber-900 dark:text-amber-100">
                  {t('projects.rollup_error', {
                    defaultValue:
                      'Could not load aggregated stats. Showing individual project data only.',
                  })}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => refetchBoqStats()}
                disabled={isFetchingBoqStats}
              >
                {isFetchingBoqStats
                  ? t('common.loading', { defaultValue: 'Loading...' })
                  : t('common.retry', { defaultValue: 'Retry' })}
              </Button>
            </div>
          )}

          {/* Bulk selection toolbar */}
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border-light bg-surface-secondary/50 px-3 py-2">
            <label className="flex items-center gap-2 text-sm text-content-secondary cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border"
                checked={
                  paginatedProjects.length > 0 &&
                  paginatedProjects.every((p) => selectedIds.has(p.id))
                }
                ref={(el) => {
                  if (!el) return;
                  const some = paginatedProjects.some((p) => selectedIds.has(p.id));
                  const all =
                    paginatedProjects.length > 0 &&
                    paginatedProjects.every((p) => selectedIds.has(p.id));
                  el.indeterminate = some && !all;
                }}
                onChange={(e) => {
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) {
                      paginatedProjects.forEach((p) => next.add(p.id));
                    } else {
                      paginatedProjects.forEach((p) => next.delete(p.id));
                    }
                    return next;
                  });
                }}
                data-testid="projects-select-page"
              />
              {t('projects.select_page', {
                defaultValue: 'Select page ({{n}})',
                n: paginatedProjects.length,
              })}
            </label>
            {selectedIds.size > 0 && (
              <>
                <span className="text-xs font-medium text-content-primary">
                  {t('projects.selected_count', {
                    defaultValue: '{{count}} selected',
                    count: selectedIds.size,
                  })}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Archive size={14} />}
                  disabled={bulkBusy}
                  onClick={() => setBulkConfirm({ kind: 'archive' })}
                  data-testid="projects-bulk-archive"
                >
                  {t('common.archive', { defaultValue: 'Archive' })}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<ArchiveRestore size={14} />}
                  disabled={bulkBusy}
                  onClick={() => setBulkConfirm({ kind: 'restore' })}
                  data-testid="projects-bulk-restore"
                >
                  {t('common.restore', { defaultValue: 'Restore' })}
                </Button>
                {(statusFilter === 'archived' ||
                  Array.from(selectedIds).some(
                    (id) => projectsById.get(id)?.status === 'archived',
                  )) && (
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Trash2 size={14} />}
                    disabled={bulkBusy}
                    onClick={() => setBulkConfirm({ kind: 'hard-delete' })}
                    data-testid="projects-bulk-hard-delete"
                  >
                    {t('projects.permanent_delete', {
                      defaultValue: '永久删除',
                    })}
                  </Button>
                )}
                <div className="flex items-center gap-1.5">
                  <select
                    value={bulkStatusValue}
                    onChange={(e) => setBulkStatusValue(e.target.value)}
                    disabled={bulkBusy}
                    className="h-8 rounded-md border border-border bg-surface-primary px-2 text-xs"
                    aria-label={t('projects.bulk_status', {
                      defaultValue: 'Bulk status',
                    })}
                    data-testid="projects-bulk-status-select"
                  >
                    {WORKING_PROJECT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {statusLabel(s)}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={bulkBusy}
                    loading={bulkBusy}
                    onClick={() => void runBulkStatus(bulkStatusValue)}
                    data-testid="projects-bulk-status-apply"
                  >
                    {t('projects.bulk_set_status', {
                      defaultValue: 'Set status',
                    })}
                  </Button>
                </div>
                <div
                  className="flex flex-wrap items-center gap-1.5 border-l border-border-light pl-2"
                  data-testid="projects-bulk-currency-region"
                >
                  <select
                    value={bulkCurrencyValue}
                    onChange={(e) => setBulkCurrencyValue(e.target.value)}
                    disabled={bulkBusy}
                    className="h-8 max-w-[9rem] rounded-md border border-border bg-surface-primary px-2 text-xs"
                    aria-label={t('projects.bulk_currency', {
                      defaultValue: '批量币种',
                    })}
                    data-testid="projects-bulk-currency-select"
                  >
                    <option value="">
                      {t('projects.bulk_currency_placeholder', {
                        defaultValue: '币种…',
                      })}
                    </option>
                    {CURRENCY_GROUPS.map((g) => (
                      <optgroup key={g.group} label={g.group}>
                        {g.options
                          .filter((o) => o.value !== '__custom__')
                          .map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                  <select
                    value={bulkRegionValue}
                    onChange={(e) => setBulkRegionValue(e.target.value)}
                    disabled={bulkBusy}
                    className="h-8 max-w-[10rem] rounded-md border border-border bg-surface-primary px-2 text-xs"
                    aria-label={t('projects.bulk_region', {
                      defaultValue: '批量地区',
                    })}
                    data-testid="projects-bulk-region-select"
                  >
                    <option value="">
                      {t('projects.bulk_region_placeholder', {
                        defaultValue: '地区…',
                      })}
                    </option>
                    {REGION_GROUPS.map((g) => (
                      <optgroup key={g.group} label={g.group}>
                        {g.options
                          .filter((o) => o.value !== '__custom__')
                          .map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={bulkBusy || (!bulkCurrencyValue && !bulkRegionValue)}
                    loading={bulkBusy}
                    onClick={() => void runBulkCurrencyRegion()}
                    data-testid="projects-bulk-currency-region-apply"
                  >
                    {t('projects.bulk_apply_currency_region', {
                      defaultValue: '应用币种/地区',
                    })}
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={bulkBusy}
                  onClick={() => setSelectedIds(new Set())}
                >
                  {t('common.clear', { defaultValue: 'Clear' })}
                </Button>
              </>
            )}
          </div>

          {viewMode === 'card' ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {paginatedProjects.map((project, i) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  boqStats={boqStatsMap.get(project.id)}
                  fileTypes={fileTypesByProject?.[project.id] ?? []}
                  style={{ animationDelay: `${50 + i * 30}ms` }}
                  selected={selectedIds.has(project.id)}
                  onToggleSelect={(id, on) => {
                    setSelectedIds((prev) => {
                      const next = new Set(prev);
                      if (on) next.add(id);
                      else next.delete(id);
                      return next;
                    });
                  }}
                  onDeleted={() => setStatusFilter('working')}
                />
              ))}
            </div>
          ) : (
            <ProjectsListTable
              projects={paginatedProjects}
              boqStatsMap={boqStatsMap}
              selectedIds={selectedIds}
              sortState={sortState}
              onSortField={applySortField}
              onToggleSelect={(id, on) => {
                setSelectedIds((prev) => {
                  const next = new Set(prev);
                  if (on) next.add(id);
                  else next.delete(id);
                  return next;
                });
              }}
              formatMoney={formatMoney}
              onOpen={(id) => navigate(`/projects/${id}`)}
              onDeleted={() => setStatusFilter('working')}
            />
          )}

          {/* Pagination */}
          <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
            <p className="text-sm text-content-tertiary order-2 sm:order-1">
              {t('projects.showing_of', {
                defaultValue: '{{from}}–{{to}} of {{filtered}} projects',
                from: filtered.length === 0 ? 0 : (page - 1) * pageSize + 1,
                to: Math.min(page * pageSize, filtered.length),
                filtered: filtered.length,
              })}
              {hasActiveFilter && filtered.length !== (projects?.length ?? 0)
                ? ` (${t('projects.filtered_from', { defaultValue: 'filtered from {{total}}', total: projects?.length ?? 0 })})`
                : ''}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2 order-1 sm:order-2">
              <div className="relative">
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  aria-label={t('projects.page_size', {
                    defaultValue: 'Rows per page',
                  })}
                  className="h-9 appearance-none rounded-lg border border-border bg-surface-primary pl-2.5 pr-7 text-xs text-content-primary focus:outline-none focus:ring-2 focus:ring-oe-blue"
                >
                  {PROJECT_PAGE_SIZE_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {t('projects.per_page', {
                        defaultValue: '{{n}} / page',
                        n,
                      })}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-1.5 text-content-tertiary">
                  <ChevronDown size={12} />
                </div>
              </div>
              {totalPages > 1 && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPage(1)}
                    disabled={page === 1}
                    className="rounded-lg border border-border-light px-3 py-2 text-sm font-medium text-content-secondary hover:bg-surface-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title={t('common.first_page', { defaultValue: 'First page' })}
                    aria-label={t('common.first_page', { defaultValue: 'First page' })}
                  >
                    &laquo;
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="rounded-lg border border-border-light px-4 py-2 text-sm font-medium text-content-secondary hover:bg-surface-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    {t('common.previous', { defaultValue: 'Previous' })}
                  </button>

                  {Array.from({ length: totalPages }, (_, i) => i + 1)
                    .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
                    .reduce<(number | 'dots')[]>((acc, p, i, arr) => {
                      if (i > 0 && arr[i - 1] !== undefined && p - (arr[i - 1] as number) > 1) acc.push('dots');
                      acc.push(p);
                      return acc;
                    }, [])
                    .map((item, i) =>
                      item === 'dots' ? (
                        <span key={`dots-${i}`} className="px-1 text-content-quaternary">...</span>
                      ) : (
                        <button
                          key={item}
                          onClick={() => setPage(item as number)}
                          className={`rounded-lg min-w-[40px] py-2 text-sm font-semibold transition-colors ${
                            page === item
                              ? 'bg-oe-blue text-white shadow-sm'
                              : 'border border-border-light text-content-secondary hover:bg-surface-secondary'
                          }`}
                        >
                          {item}
                        </button>
                      ),
                    )}

                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="rounded-lg border border-border-light px-4 py-2 text-sm font-medium text-content-secondary hover:bg-surface-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    {t('common.next', { defaultValue: 'Next' })}
                  </button>
                  <button
                    onClick={() => setPage(totalPages)}
                    disabled={page === totalPages}
                    className="rounded-lg border border-border-light px-3 py-2 text-sm font-medium text-content-secondary hover:bg-surface-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title={t('common.last_page', { defaultValue: 'Last page' })}
                    aria-label={t('common.last_page', { defaultValue: 'Last page' })}
                  >
                    &raquo;
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <CreateProjectModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
      />

      <ConfirmDialog
        open={bulkConfirm?.kind === 'archive'}
        onCancel={() => setBulkConfirm(null)}
        onConfirm={() => void runBulkArchive()}
        title={t('projects.bulk_archive_title', {
          defaultValue: 'Archive {{count}} project(s)?',
          count: selectedIds.size,
        })}
        message={t('projects.bulk_archive_desc', {
          defaultValue:
            'Projects are soft-deleted (status = archived) and can be restored later. Data is kept.',
        })}
        confirmLabel={t('common.archive', { defaultValue: 'Archive' })}
        variant="warning"
        loading={bulkBusy}
      />
      <ConfirmDialog
        open={bulkConfirm?.kind === 'restore'}
        onCancel={() => setBulkConfirm(null)}
        onConfirm={() => void runBulkRestore()}
        title={t('projects.bulk_restore_title', {
          defaultValue: 'Restore {{count}} project(s)?',
          count: selectedIds.size,
        })}
        message={t('projects.bulk_restore_desc', {
          defaultValue:
            '已归档项目将恢复为「在建」。未归档的选中项会被服务器跳过。',
        })}
        confirmLabel={t('common.restore', { defaultValue: 'Restore' })}
        variant="warning"
        loading={bulkBusy}
      />
      <ConfirmDialog
        open={bulkConfirm?.kind === 'hard-delete'}
        onCancel={() => setBulkConfirm(null)}
        onConfirm={() => void runBulkHardDelete()}
        title={t('projects.bulk_hard_delete_title', {
          defaultValue: '永久删除 {{count}} 个已归档项目？',
          count: Array.from(selectedIds).filter(
            (id) => projectsById.get(id)?.status === 'archived',
          ).length,
        })}
        message={t('projects.bulk_hard_delete_desc', {
          defaultValue:
            '将从数据库彻底删除项目及其关联数据（清单、合同关联等），不可恢复。仅处理已归档项；未归档选中项会跳过。',
        })}
        confirmLabel={t('projects.permanent_delete', {
          defaultValue: '永久删除',
        })}
        variant="danger"
        loading={bulkBusy}
      />
    </div>
  );
}

function SortableTh({
  field,
  sortState,
  onSort,
  children,
  className,
  align = 'left',
}: {
  field: ProjectSortField;
  sortState: ProjectSortState;
  onSort: (field: ProjectSortField) => void;
  children: React.ReactNode;
  className?: string;
  align?: 'left' | 'right';
}) {
  const active = sortState.field === field;
  return (
    <th
      className={`px-3 py-2.5 font-semibold ${align === 'right' ? 'text-right' : 'text-left'} ${className ?? ''}`}
      scope="col"
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={`inline-flex items-center gap-1 max-w-full font-semibold transition-colors hover:text-oe-blue ${
          active ? 'text-oe-blue' : 'text-content-tertiary'
        } ${align === 'right' ? 'flex-row-reverse' : ''}`}
        data-testid={`projects-sort-th-${field}`}
      >
        <span className="truncate">{children}</span>
        {active ? (
          sortState.dir === 'asc' ? (
            <ArrowUp size={12} className="shrink-0" />
          ) : (
            <ArrowDown size={12} className="shrink-0" />
          )
        ) : (
          <ArrowUpDown size={11} className="shrink-0 opacity-40" />
        )}
      </button>
    </th>
  );
}

/** Compact table view of projects (complements the card grid). */
function ProjectsListTable({
  projects,
  boqStatsMap,
  selectedIds,
  sortState,
  onSortField,
  onToggleSelect,
  formatMoney,
  onOpen,
  onDeleted,
}: {
  projects: Project[];
  boqStatsMap: Map<string, ProjectBOQStats>;
  selectedIds: Set<string>;
  sortState: ProjectSortState;
  onSortField: (field: ProjectSortField) => void;
  onToggleSelect: (id: string, selected: boolean) => void;
  formatMoney: (v: number, currency: string) => string;
  onOpen: (id: string) => void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);

  const archiveMut = useMutation({
    mutationFn: (id: string) => projectsApi.archive(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['projects-switcher'] });
      addToast({
        type: 'success',
        title: t('toasts.project_archived', { defaultValue: 'Project archived successfully' }),
      });
      onDeleted?.();
    },
    onError: (e: Error) =>
      addToast({
        type: 'error',
        title: t('toasts.archive_failed', { defaultValue: 'Failed to archive project' }),
        message: e.message,
      }),
  });

  const restoreMut = useMutation({
    mutationFn: (id: string) => projectsApi.restore(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['projects-switcher'] });
      addToast({
        type: 'success',
        title: t('toasts.project_restored', { defaultValue: 'Project restored' }),
      });
    },
    onError: (e: Error) =>
      addToast({
        type: 'error',
        title: t('toasts.restore_failed', { defaultValue: 'Failed to restore project' }),
        message: e.message,
      }),
  });

  const hardDeleteMut = useMutation({
    mutationFn: (id: string) => projectsApi.hardDelete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['projects-switcher'] });
      addToast({
        type: 'success',
        title: t('projects.hard_deleted', {
          defaultValue: '项目已永久删除',
        }),
      });
      onDeleted?.();
    },
    onError: (e: Error) =>
      addToast({
        type: 'error',
        title: t('projects.hard_delete_failed', {
          defaultValue: '永久删除失败',
        }),
        message: e.message,
      }),
  });

  const [hardDeleteId, setHardDeleteId] = useState<string | null>(null);

  return (
    <div
      className="overflow-x-auto rounded-xl border border-border-light bg-surface-elevated"
      data-testid="projects-list-table"
    >
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="bg-surface-secondary/80 text-xs uppercase tracking-wide text-content-tertiary">
          <tr>
            <th className="w-10 px-3 py-2.5" scope="col">
              <span className="sr-only">
                {t('projects.select', { defaultValue: 'Select' })}
              </span>
            </th>
            <SortableTh field="name" sortState={sortState} onSort={onSortField}>
              {t('projects.name', { defaultValue: 'Name' })}
            </SortableTh>
            <SortableTh field="code" sortState={sortState} onSort={onSortField}>
              {t('projects.project_code', { defaultValue: 'Code' })}
            </SortableTh>
            <SortableTh field="status" sortState={sortState} onSort={onSortField}>
              {t('projects.status_col', { defaultValue: 'Status' })}
            </SortableTh>
            <SortableTh field="region" sortState={sortState} onSort={onSortField}>
              {t('projects.region', { defaultValue: 'Region' })}
            </SortableTh>
            <SortableTh
              field="boq"
              sortState={sortState}
              onSort={onSortField}
              align="right"
            >
              {t('projects.boq', { defaultValue: 'BOQs' })}
            </SortableTh>
            <th className="px-3 py-2.5 font-semibold text-right" scope="col">
              {t('projects.col_contract_register', {
                defaultValue: '合同台账',
              })}
            </th>
            <th className="px-3 py-2.5 font-semibold text-right" scope="col">
              {t('projects.col_project_contract', {
                defaultValue: '项目合同额',
              })}
            </th>
            <th className="px-3 py-2.5 font-semibold text-right" scope="col">
              {t('projects.col_budget', {
                defaultValue: '预算',
              })}
            </th>
            <SortableTh
              field="value"
              sortState={sortState}
              onSort={onSortField}
              align="right"
            >
              {t('projects.value_boq', { defaultValue: '清单金额' })}
            </SortableTh>
            <SortableTh field="updated" sortState={sortState} onSort={onSortField}>
              {t('projects.updated', { defaultValue: 'Updated' })}
            </SortableTh>
            <th className="w-28 px-3 py-2.5 font-semibold text-right" scope="col">
              {t('common.actions', { defaultValue: 'Actions' })}
            </th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => {
            const stats = boqStatsMap.get(project.id);
            const modifiedSource = project.updated_at || project.created_at;
            const modifiedDate = modifiedSource ? parseISO(modifiedSource) : null;
            const relativeModified =
              modifiedDate && isValidDate(modifiedDate)
                ? formatDistanceToNowStrict(modifiedDate, { addSuffix: true })
                : '—';
            return (
              <tr
                key={project.id}
                className="border-t border-border-light hover:bg-surface-secondary/60 cursor-pointer"
                onClick={() => onOpen(project.id)}
              >
                <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-border"
                    checked={selectedIds.has(project.id)}
                    onChange={(e) => onToggleSelect(project.id, e.target.checked)}
                    aria-label={t('projects.select_one', {
                      defaultValue: 'Select {{name}}',
                      name: project.name,
                    })}
                  />
                </td>
                <td className="px-3 py-2.5">
                  <div className="font-medium text-content-primary truncate max-w-[220px]">
                    {project.name}
                  </div>
                  {project.description ? (
                    <div className="text-2xs text-content-tertiary truncate max-w-[220px]">
                      {project.description}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 font-mono text-xs text-content-secondary">
                  {project.project_code || '—'}
                </td>
                <td className="px-3 py-2.5">
                  <ProjectStatusBadge status={project.status || 'active'} dot={false} />
                </td>
                <td className="px-3 py-2.5 text-content-secondary truncate max-w-[100px]">
                  {project.region || '—'}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-content-secondary">
                  {stats?.boqCount ?? '—'}
                </td>
                <td
                  className="px-3 py-2.5 text-right tabular-nums text-content-primary"
                  title={
                    stats
                      ? t('projects.contract_register_hint', {
                          defaultValue: '总包 {{main}} · 分包 {{sub}}',
                          main: formatMoney(
                            stats.contractMainValue,
                            project.currency || '',
                          ),
                          sub: formatMoney(
                            stats.contractSubValue,
                            project.currency || '',
                          ),
                        })
                      : undefined
                  }
                >
                  {stats && stats.contractRegisterValue > 0
                    ? formatMoney(stats.contractRegisterValue, project.currency || '')
                    : '—'}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-content-secondary">
                  {stats && stats.projectContractValue > 0
                    ? formatMoney(stats.projectContractValue, project.currency || '')
                    : project.contract_value
                      ? formatMoney(
                          Number(String(project.contract_value).replace(/,/g, '')) || 0,
                          project.currency || '',
                        )
                      : '—'}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-content-secondary">
                  {stats && stats.budgetEstimate > 0
                    ? formatMoney(stats.budgetEstimate, project.currency || '')
                    : project.budget_estimate
                      ? formatMoney(
                          Number(String(project.budget_estimate).replace(/,/g, '')) || 0,
                          project.currency || '',
                        )
                      : '—'}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-content-tertiary">
                  {stats && stats.totalValue > 0
                    ? formatMoney(stats.totalValue, project.currency || '')
                    : '—'}
                </td>
                <td
                  className="px-3 py-2.5 text-xs text-content-tertiary whitespace-nowrap"
                  title={
                    modifiedDate && isValidDate(modifiedDate)
                      ? modifiedDate.toLocaleString(getIntlLocale())
                      : undefined
                  }
                >
                  {relativeModified}
                </td>
                <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="inline-flex items-center gap-0.5">
                    <button
                      type="button"
                      className="rounded p-1.5 text-content-tertiary hover:bg-surface-secondary hover:text-oe-blue"
                      title={t('common.open', { defaultValue: 'Open' })}
                      onClick={() => onOpen(project.id)}
                    >
                      <ExternalLink size={14} />
                    </button>
                    {project.status === 'archived' ? (
                      <>
                        <button
                          type="button"
                          className="rounded p-1.5 text-content-tertiary hover:bg-surface-secondary hover:text-oe-blue"
                          title={t('common.restore', { defaultValue: 'Restore' })}
                          disabled={restoreMut.isPending}
                          onClick={() => restoreMut.mutate(project.id)}
                          data-testid="projects-list-restore"
                        >
                          <ArchiveRestore size={14} />
                        </button>
                        <button
                          type="button"
                          className="rounded p-1.5 text-content-tertiary hover:bg-semantic-error-bg hover:text-semantic-error"
                          title={t('projects.permanent_delete', {
                            defaultValue: '永久删除',
                          })}
                          disabled={hardDeleteMut.isPending}
                          onClick={() => setHardDeleteId(project.id)}
                          data-testid="projects-list-hard-delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="rounded p-1.5 text-content-tertiary hover:bg-surface-secondary hover:text-oe-blue"
                        title={t('common.archive', { defaultValue: 'Archive' })}
                        disabled={archiveMut.isPending}
                        onClick={() => archiveMut.mutate(project.id)}
                      >
                        <Archive size={14} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {projects.length === 0 && (
        <p className="px-4 py-8 text-center text-sm text-content-tertiary">
          {t('projects.no_results', { defaultValue: 'No matching projects' })}
        </p>
      )}
      <ConfirmDialog
        open={hardDeleteId != null}
        onCancel={() => setHardDeleteId(null)}
        onConfirm={() => {
          if (hardDeleteId) hardDeleteMut.mutate(hardDeleteId, {
            onSettled: () => setHardDeleteId(null),
          });
        }}
        title={t('projects.hard_delete_title', {
          defaultValue: '永久删除此项目？',
        })}
        message={t('projects.hard_delete_desc', {
          defaultValue:
            '将从数据库彻底删除「{{name}}」及其关联数据，不可恢复。仅已归档项目可永久删除。',
          name:
            projects.find((p) => p.id === hardDeleteId)?.name ?? '',
        })}
        confirmLabel={t('projects.permanent_delete', {
          defaultValue: '永久删除',
        })}
        variant="danger"
        loading={hardDeleteMut.isPending}
      />
    </div>
  );
}

function ProjectCard({
  project,
  boqStats,
  fileTypes,
  style,
  selected,
  onToggleSelect,
  onDeleted,
}: {
  project: Project;
  boqStats?: ProjectBOQStats;
  /** Uploaded file extensions for this project (e.g. ['rvt','dwg','pdf']). */
  fileTypes?: string[];
  style?: React.CSSProperties;
  selected?: boolean;
  onToggleSelect?: (id: string, selected: boolean) => void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // Close dropdown on Escape key
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [menuOpen]);

  const isArchived = project.status === 'archived';

  /** Soft-archive for active projects; hard-delete when already archived. */
  const deleteMutation = useMutation({
    mutationFn: () =>
      isArchived
        ? projectsApi.hardDelete(project.id)
        : apiDelete(`/v1/projects/${project.id}`),
    onSuccess: () => {
      setConfirmDelete(false);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['projects-switcher'] });
      addToast({
        type: 'success',
        title: isArchived
          ? t('projects.hard_deleted', { defaultValue: '项目已永久删除' })
          : t('projects.deleted', 'Project deleted successfully'),
      });
      onDeleted?.();
    },
    onError: (e: Error) => {
      addToast({
        type: 'error',
        title: isArchived
          ? t('projects.hard_delete_failed', { defaultValue: '永久删除失败' })
          : t('projects.delete_failed', 'Failed to delete project'),
        message: e.message,
      });
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: () => projectsApi.duplicate(project.id),
    onSuccess: (newProject) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['projects-switcher'] });
      addToast({ type: 'success', title: t('projects.duplicated', 'Project duplicated successfully') });
      navigate(`/projects/${newProject.id}`);
    },
    onError: (e: Error) => {
      addToast({
        type: 'error',
        title: t('projects.duplicate_failed', 'Failed to duplicate project'),
        message: e.message,
      });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: () => projectsApi.restore(project.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['projects-switcher'] });
      addToast({
        type: 'success',
        title: t('toasts.project_restored', { defaultValue: 'Project restored' }),
      });
    },
    onError: (error: Error) => {
      addToast({
        type: 'error',
        title: t('toasts.restore_failed', { defaultValue: 'Failed to restore project' }),
        message: error.message,
      });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: () => apiPatch(`/v1/projects/${project.id}`, { status: 'archived' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['projects-switcher'] });
      // Offer an immediate Undo — re-activates the project (the canonical
      // un-archive path) so an accidental archive is one click to reverse.
      addToast({
        type: 'success',
        title: t('toasts.project_archived', { defaultValue: 'Project archived successfully' }),
        action: {
          label: t('common.undo', { defaultValue: 'Undo' }),
          onClick: () => restoreMutation.mutate(),
        },
      });
    },
    onError: (error: Error) => {
      addToast({ type: 'error', title: t('toasts.archive_failed', { defaultValue: 'Failed to archive project' }), message: error.message });
    },
  });

  const standardLabels: Record<string, string> = {
    din276: 'DIN 276',
    nrm: 'NRM',
    masterformat: 'MasterFormat',
  };

  // Currency symbol icon — falls back to neutral DollarSign for unknown codes
  // so we never render an empty chip. Tabular currency labels still appear
  // alongside the icon for unambiguous reading.
  const CurrencyIcon =
    project.currency === 'EUR'
      ? Euro
      : project.currency === 'GBP'
        ? PoundSterling
        : DollarSign;

  // Last-modified relative time. We prefer updated_at when present so the
  // freshness signal reflects actual edits rather than only project age.
  // date-fns gracefully degrades for invalid input — guard so a malformed
  // timestamp can't crash the card render.
  const modifiedSource = project.updated_at || project.created_at;
  const modifiedDate = modifiedSource ? parseISO(modifiedSource) : null;
  const relativeModified =
    modifiedDate && isValidDate(modifiedDate)
      ? formatDistanceToNowStrict(modifiedDate, { addSuffix: true })
      : null;
  const absoluteModified = modifiedDate && isValidDate(modifiedDate)
    ? modifiedDate.toLocaleDateString(getIntlLocale())
    : '';

  // Variations marker — rendered only when project metadata exposes a
  // non-zero count. Acts as a passive warning chip; clicking the card
  // still opens the project (variations module owns the resolution UI).
  const openVariations = (() => {
    const meta = project.metadata as Record<string, unknown> | undefined;
    const v = meta?.open_variations;
    return typeof v === 'number' && v > 0 ? v : 0;
  })();

  const mapEnabled = useWidgetSettingsStore((s) => s.projectMapEnabled);
  const weatherEnabled = useWidgetSettingsStore((s) => s.projectWeatherEnabled);
  const [cardCoords, setCardCoords] = useState<LatLng | null>(
    project.address?.lat && project.address?.lng
      ? { lat: project.address.lat, lng: project.address.lng }
      : null,
  );

  return (
    <Card
      hoverable
      padding="none"
      className="group cursor-pointer relative animate-card-in overflow-hidden rounded-xl bg-gradient-to-b from-surface-elevated to-surface-primary hover:shadow-xl hover:border-oe-blue/40 focus-within:ring-2 focus-within:ring-oe-blue/30 motion-safe:transition-all"
      style={style}
      onClick={() => navigate(`/projects/${project.id}`)}
    >
      {mapEnabled && (
        <div className="relative" onClick={(e) => e.stopPropagation()}>
          <ProjectMap
            variant="card"
            lat={project.address?.lat ?? null}
            lng={project.address?.lng ?? null}
            address={project.address?.street}
            city={project.address?.city}
            country={project.address?.country}
            label={[project.address?.city, project.address?.country]
              .filter(Boolean)
              .join(', ')}
            className="rounded-none border-none"
            onResolved={setCardCoords}
          />
          {/* Geo Hub overlay CTA — only when coords are resolved so we
              never ship a deeplink to an unanchored project. Sits over
              the map (top-right) with a glass pill so the underlying
              tiles remain visible. */}
          {cardCoords && (
            <Link
              to={`/projects/${project.id}/geo`}
              onClick={(e) => e.stopPropagation()}
              className="absolute top-2 right-2 z-10 inline-flex items-center gap-1 rounded-full border border-white/40 bg-white/85 px-2.5 py-1 text-2xs font-semibold text-oe-blue shadow-sm backdrop-blur-md transition-all hover:bg-white hover:shadow-md hover:scale-[1.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-oe-blue/60 dark:border-white/10 dark:bg-slate-900/70 dark:text-sky-300 dark:hover:bg-slate-900/90"
              title={t('projects.card.fly_to_on_map', {
                defaultValue: 'Fly camera to {{name}} on the globe',
                name: project.name,
              })}
              aria-label={t('projects.card.fly_to_on_map', {
                defaultValue: 'Fly camera to {{name}} on the globe',
                name: project.name,
              })}
              data-testid="project-card-view-on-map"
            >
              <Globe2 size={11} strokeWidth={2.25} />
              {t('projects.card.view_on_map', { defaultValue: 'On map' })}
            </Link>
          )}
        </div>
      )}
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2 min-w-0">
            {onToggleSelect && (
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 rounded border-border"
                checked={!!selected}
                onChange={(e) => {
                  e.stopPropagation();
                  onToggleSelect(project.id, e.target.checked);
                }}
                onClick={(e) => e.stopPropagation()}
                aria-label={t('projects.select_one', {
                  defaultValue: 'Select {{name}}',
                  name: project.name,
                })}
                data-testid={`project-select-${project.id}`}
              />
            )}
            <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-base font-bold ring-1 ring-inset ring-white/40 dark:ring-white/5 shadow-sm transition-transform duration-normal ease-oe group-hover:scale-105 ${getRegionAvatarClass(project.region)}`}>
              {project.name.charAt(0).toUpperCase()}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {/* Always show status badge so 在建 / 收尾 / 结算 are visible. */}
            {project.status && (
              <ProjectStatusBadge status={project.status} dot={false} />
            )}
            <PinButton projectId={project.id} />
            <button
              type="button"
              className="flex h-7 w-7 min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-content-tertiary hover:bg-surface-secondary transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(!menuOpen);
              }}
              aria-label={t('a11y.projects.card_actions', {
                defaultValue: 'Project actions for {{name}}',
                name: project.name,
              })}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
        </div>

        {/* Dropdown menu */}
        {menuOpen && (
          <div
            ref={menuRef}
            className="absolute top-14 right-4 z-20 w-44 rounded-lg border border-border bg-surface-elevated shadow-lg overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                navigate(`/projects/${project.id}`);
                setMenuOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-content-primary hover:bg-surface-secondary transition-colors"
            >
              <ExternalLink size={14} /> {t('common.open', 'Open')}
            </button>
            <button
              onClick={() => {
                duplicateMutation.mutate();
                setMenuOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-content-primary hover:bg-surface-secondary transition-colors"
            >
              <Copy size={14} /> {t('common.duplicate', 'Duplicate')}
            </button>
            {isArchived ? (
              <button
                onClick={() => {
                  restoreMutation.mutate();
                  setMenuOpen(false);
                }}
                disabled={restoreMutation.isPending}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-content-secondary hover:bg-surface-secondary transition-colors disabled:opacity-60"
              >
                <ArchiveRestore size={14} /> {t('common.restore', { defaultValue: 'Restore' })}
              </button>
            ) : (
              <button
                onClick={() => {
                  archiveMutation.mutate();
                  setMenuOpen(false);
                }}
                disabled={archiveMutation.isPending}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-content-secondary hover:bg-surface-secondary transition-colors disabled:opacity-60"
              >
                <Archive size={14} /> {t('common.archive', 'Archive')}
              </button>
            )}
            <div className="h-px bg-border-light" />
            <button
              onClick={() => {
                setConfirmDelete(true);
                setMenuOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-semantic-error hover:bg-semantic-error-bg transition-colors"
              data-testid={isArchived ? 'project-card-hard-delete' : 'project-card-delete'}
            >
              <Trash2 size={14} />{' '}
              {isArchived
                ? t('projects.permanent_delete', { defaultValue: '永久删除' })
                : t('common.delete', 'Delete')}
            </button>
          </div>
        )}

        {/* Delete confirmation */}
        {confirmDelete && (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center rounded-xl bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-semantic-error-bg mx-auto mb-3">
                <Trash2 size={18} className="text-semantic-error" />
              </div>
              <p className="text-sm font-semibold text-content-primary mb-1">
                {isArchived
                  ? t('projects.hard_delete_title', {
                      defaultValue: '永久删除此项目？',
                    })
                  : t('projects.confirm_delete', 'Delete this project?')}
              </p>
              <p className="text-xs text-content-tertiary mb-1 max-w-[220px] mx-auto">
                {project.name}
              </p>
              {isArchived && (
                <p className="text-xs text-semantic-error mb-4 max-w-[220px] mx-auto">
                  {t('projects.hard_delete_card_hint', {
                    defaultValue: '不可恢复：关联清单与数据将一并清除。',
                  })}
                </p>
              )}
              {!isArchived && (
                <p className="text-xs text-content-tertiary mb-4 max-w-[200px] mx-auto">
                  {t('projects.soft_delete_hint', {
                    defaultValue: '将归档（软删除），之后可恢复。',
                  })}
                </p>
              )}
              <div className="flex items-center justify-center gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => deleteMutation.mutate()}
                  loading={deleteMutation.isPending}
                >
                  {isArchived
                    ? t('projects.permanent_delete', { defaultValue: '永久删除' })
                    : t('common.delete', 'Delete')}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>
                  {t('common.cancel', 'Cancel')}
                </Button>
              </div>
            </div>
          </div>
        )}

        <h3 className="mt-4 text-base font-semibold tracking-tight text-content-primary truncate">
          {project.name}
        </h3>
        {project.description && (
          <p className="mt-1 text-xs leading-relaxed text-content-secondary line-clamp-2 transition-colors group-hover:text-content-primary/80">
            {project.description}
          </p>
        )}
        <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full border border-oe-blue/20 bg-oe-blue-subtle px-2 py-0.5 text-2xs font-medium text-oe-blue-text">
            <Building2 size={11} strokeWidth={2.25} />
            {standardLabels[project.classification_standard] ?? project.classification_standard}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border-light bg-surface-secondary px-2 py-0.5 text-2xs font-medium text-content-secondary">
            <CurrencyIcon size={11} strokeWidth={2.25} />
            {project.currency}
          </span>
          {project.region && (
            <span className="inline-flex items-center gap-1 rounded-full border border-border-light bg-surface-secondary px-2 py-0.5 text-2xs font-medium text-content-secondary">
              <Globe2 size={11} strokeWidth={2.25} />
              {project.region}
            </span>
          )}
          {project.address?.city && (
            <span className="inline-flex items-center gap-1 rounded-full border border-border-light bg-surface-secondary px-2 py-0.5 text-2xs font-medium text-content-secondary">
              <MapPin size={11} strokeWidth={2.25} />
              {project.address.city}
            </span>
          )}
          {/* Inline fallback: when the map widget is OFF we still want a
              discoverable jump-to-Geo affordance on geo-anchored projects.
              Hidden when the overlay version is already shown above. */}
          {!mapEnabled && cardCoords && (
            <Link
              to={`/projects/${project.id}/geo`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 rounded-full border border-oe-blue/30 bg-oe-blue-subtle px-2 py-0.5 text-2xs font-semibold text-oe-blue-text transition-all hover:bg-oe-blue hover:text-white hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-oe-blue/60"
              title={t('projects.card.fly_to_on_map', {
                defaultValue: 'Fly camera to {{name}} on the globe',
                name: project.name,
              })}
              aria-label={t('projects.card.fly_to_on_map', {
                defaultValue: 'Fly camera to {{name}} on the globe',
                name: project.name,
              })}
              data-testid="project-card-view-on-map-inline"
            >
              <Globe2 size={11} strokeWidth={2.25} />
              {t('projects.card.view_on_map', { defaultValue: 'On map' })}
            </Link>
          )}
          {fileTypes && fileTypes.length > 0 && (
            <div className="ml-auto">
              <FileTypeChips fileTypes={fileTypes} size="md" />
            </div>
          )}
        </div>
      </div>
      {/* Money channels — 合同台账 / 项目合同额 / 预算 / 清单 (distinct). */}
      {(() => {
        const register = boqStats?.contractRegisterValue ?? 0;
        const projContract =
          boqStats?.projectContractValue ??
          (project.contract_value
            ? Number(String(project.contract_value).replace(/,/g, '')) || 0
            : 0);
        const budget =
          boqStats?.budgetEstimate ??
          (project.budget_estimate
            ? Number(String(project.budget_estimate).replace(/,/g, '')) || 0
            : 0);
        const boqVal = boqStats?.totalValue ?? 0;
        const hasAny = register > 0 || projContract > 0 || budget > 0 || boqVal > 0;
        if (!hasAny) return null;
        const cur = project.currency || '';
        const row = (
          label: string,
          value: number,
          emphasize?: boolean,
          hint?: string,
        ) =>
          value > 0 ? (
            <div
              key={label}
              className="flex items-baseline justify-between gap-2"
              title={hint}
            >
              <span className="text-[10px] font-medium uppercase tracking-wider text-content-tertiary shrink-0">
                {label}
              </span>
              <span
                className={`tabular-nums ${
                  emphasize
                    ? 'text-base font-bold text-content-primary'
                    : 'text-xs font-semibold text-content-secondary'
                }`}
              >
                {currencyFmt.format(value)}
                {cur ? (
                  <span className="ml-1 text-2xs font-semibold uppercase text-content-tertiary">
                    {cur}
                  </span>
                ) : null}
              </span>
            </div>
          ) : null;
        return (
          <div className="relative px-5 pb-3">
            <div className="rounded-xl border border-border-light bg-gradient-to-br from-oe-blue-subtle/60 via-surface-elevated to-surface-elevated px-4 py-3 space-y-1.5">
              {row(
                t('projects.money_contract_register', {
                  defaultValue: '合同台账',
                }),
                register,
                true,
                t('projects.contract_register_hint', {
                  defaultValue: '总包 {{main}} · 分包 {{sub}}',
                  main: currencyFmt.format(boqStats?.contractMainValue ?? 0),
                  sub: currencyFmt.format(boqStats?.contractSubValue ?? 0),
                }),
              )}
              {row(
                t('projects.money_project_contract', {
                  defaultValue: '项目合同额',
                }),
                projContract,
                false,
                t('projects.money_project_contract_hint', {
                  defaultValue: '项目字段手动填写，非合同管理台账汇总',
                }),
              )}
              {row(
                t('projects.money_budget', { defaultValue: '预算金额' }),
                budget,
              )}
              {row(
                t('projects.money_boq', { defaultValue: '清单金额' }),
                boqVal,
              )}
            </div>
          </div>
        );
      })()}
      <div className="border-t border-border-light px-5 py-3">
        {weatherEnabled && cardCoords && (
          <div className="mb-2" onClick={(e) => e.stopPropagation()}>
            <ProjectWeather
              variant="summary"
              lat={cardCoords.lat}
              lng={cardCoords.lng}
            />
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {relativeModified && (
              <span
                className="text-2xs text-content-tertiary"
                title={absoluteModified}
              >
                {relativeModified}
              </span>
            )}
            {boqStats && boqStats.boqCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md bg-surface-secondary px-1.5 py-0.5 text-2xs font-medium text-content-secondary">
                <Layers size={10} strokeWidth={2.25} />
                <span className="tabular-nums">{boqStats.boqCount}</span>
                <span>
                  {t('projects.boq_short', { defaultValue: 'BOQs' })}
                </span>
              </span>
            )}
            {openVariations > 0 && (
              <span
                className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-2xs font-semibold text-amber-700 ring-1 ring-amber-200/60 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20"
                title={t('projects.card_open_variations', {
                  defaultValue: 'Open variations',
                })}
              >
                <AlertTriangle size={10} strokeWidth={2.25} />
                <span className="tabular-nums">{openVariations}</span>
              </span>
            )}
          </div>
          <ArrowRight
            size={14}
            className="shrink-0 text-content-tertiary transition-transform duration-normal ease-oe group-hover:translate-x-0.5 group-hover:text-oe-blue"
          />
        </div>
      </div>
    </Card>
  );
}

/**
 * WidgetToggles — inline on/off switches for the map + weather widgets.
 *
 * Lives in the filters toolbar next to sort.  State is persisted via
 * `useWidgetSettingsStore`, so the choice sticks across reloads without
 * a server round-trip.
 */
function WidgetToggles() {
  const { t } = useTranslation();
  const mapEnabled = useWidgetSettingsStore((s) => s.projectMapEnabled);
  const weatherEnabled = useWidgetSettingsStore((s) => s.projectWeatherEnabled);
  const toggleMap = useWidgetSettingsStore((s) => s.toggleProjectMap);
  const toggleWeather = useWidgetSettingsStore((s) => s.toggleProjectWeather);

  const btn = (active: boolean) =>
    `flex items-center gap-1 rounded-md px-2 py-1.5 text-2xs font-medium transition-colors ${
      active
        ? 'bg-oe-blue-subtle text-oe-blue-text'
        : 'text-content-tertiary hover:text-content-secondary hover:bg-surface-secondary'
    }`;

  return (
    <div className="flex items-center gap-1 shrink-0 border-l border-border-light pl-2 ml-1">
      <button
        type="button"
        onClick={toggleMap}
        className={btn(mapEnabled)}
        title={t('widget_settings.toggle_map', { defaultValue: 'Toggle project map' })}
      >
        <MapIcon size={12} />
        {t('widget_settings.map', { defaultValue: 'Map' })}
      </button>
      <button
        type="button"
        onClick={toggleWeather}
        className={btn(weatherEnabled)}
        title={t('widget_settings.toggle_weather', { defaultValue: 'Toggle weather forecast' })}
      >
        <CloudSun size={12} />
        {t('widget_settings.weather', { defaultValue: 'Weather' })}
      </button>
    </div>
  );
}

function PinButton({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const togglePinned = useProjectContextStore((s) => s.togglePinned);
  const isPinned = useProjectContextStore((s) => s.pinnedProjectIds.includes(projectId));

  return (
    <button
      className={`flex h-7 w-7 min-h-[44px] min-w-[44px] items-center justify-center rounded-md transition-colors ${
        isPinned
          ? 'text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-500/10'
          : 'text-content-tertiary hover:bg-surface-secondary hover:text-content-secondary'
      }`}
      onClick={(e) => {
        e.stopPropagation();
        togglePinned(projectId);
      }}
      title={isPinned ? t('common.unpin', 'Unpin') : t('common.pin', 'Pin')}
    >
      <Star size={14} fill={isPinned ? 'currentColor' : 'none'} />
    </button>
  );
}

