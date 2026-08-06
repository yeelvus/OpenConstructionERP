// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
/**
 * 项目总览 — cost board project drill-down (6 thematic sections).
 */

import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowLeft, AlertTriangle } from 'lucide-react';
import { Badge, Card, EmptyState, SkeletonTable } from '@/shared/ui';
import { PageHeader } from '@/shared/ui/PageHeader';
import { getErrorMessage } from '@/shared/lib/api';
import {
  fetchProjectByCode,
  fetchProjectByOceId,
  fetchProjectByRowId,
  type ProjectDetail,
} from './api';
import { fmtPct, fmtWan, riskBadgeClass } from './format';

type TabId =
  | 'overview'
  | 'budget'
  | 'purchase'
  | 'cmp'
  | 'sub'
  | 'finance';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: '总览' },
  { id: 'budget', label: '预算人材机' },
  { id: 'purchase', label: '采购材料' },
  { id: 'cmp', label: '预算 vs 采购' },
  { id: 'sub', label: '分包 · 责任成本' },
  { id: 'finance', label: '财务付款' },
];

function num(p: Record<string, unknown>, key: string): number | null {
  const v = p[key];
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function Metric({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-secondary/40 p-3">
      <div className="text-2xs uppercase tracking-wide text-content-secondary">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">
        {value}
        {unit ? <span className="ml-1 text-xs font-normal text-content-secondary">{unit}</span> : null}
      </div>
    </div>
  );
}

export function ProjectCostBoardPage() {
  const { projectId, rowId } = useParams<{ projectId?: string; rowId?: string }>();
  const [search] = useSearchParams();
  const code = search.get('code') || undefined;
  const [tab, setTab] = useState<TabId>('overview');

  const detailQ = useQuery({
    queryKey: ['thcc-cost-board', 'project', projectId, rowId, code],
    queryFn: async (): Promise<ProjectDetail> => {
      if (rowId) return fetchProjectByRowId(rowId);
      if (projectId) return fetchProjectByOceId(projectId);
      if (code) return fetchProjectByCode(code);
      throw new Error('Missing project identifier');
    },
    enabled: Boolean(rowId || projectId || code),
    retry: false,
  });

  const detail = detailQ.data;
  const p = (detail?.payload || {}) as Record<string, unknown>;
  const s = detail?.summary;

  const finMonthly = useMemo(() => {
    const arr = p.fin_monthly;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => {
        const o = x as { month?: string; amount?: number };
        return { month: o.month || '', amount: Number(o.amount || 0) };
      })
      .filter((x) => x.month);
  }, [p]);

  if (detailQ.isLoading) {
    return (
      <div className="p-6">
        <SkeletonTable rows={6} />
      </div>
    );
  }

  if (detailQ.isError || !s) {
    return (
      <div className="p-6">
        <EmptyState
          title="未找到项目成本数据"
          description={getErrorMessage(detailQ.error) || '请确认已导入快照，且项目编码已匹配。'}
          action={
            <Link to="/cost-board" className="text-oe-blue-text hover:underline text-sm">
              返回组合层
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6 max-w-[1400px] mx-auto">
      <div className="flex items-center gap-2 text-sm">
        <Link
          to="/cost-board"
          className="inline-flex items-center gap-1 text-content-secondary hover:text-oe-blue-text"
        >
          <ArrowLeft className="h-4 w-4" />
          组合层
        </Link>
        <span className="text-content-secondary">/</span>
        <span className="font-medium">{s.name}</span>
      </div>

      <PageHeader
        srTitle={s.name}
        subtitle={`${s.name} · ${s.project_code || '无编码'} · ${s.full_name || ''} · ${s.status || s.bucket || ''}`}
        actions={
          <div className="flex flex-wrap gap-2 items-center">
            <span className={`rounded px-2 py-1 text-xs font-medium ${riskBadgeClass(s.risk)}`}>
              {s.risk || '—'}
            </span>
            {s.alerts?.length ? (
              <Badge variant="warning" className="gap-1">
                <AlertTriangle className="h-3 w-3" />
                {s.alerts.length} 预警
              </Badge>
            ) : null}
          </div>
        }
      />

      {s.alerts?.length ? (
        <Card className="p-3 border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20">
          <ul className="list-disc pl-5 text-sm text-amber-900 dark:text-amber-100">
            {s.alerts.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-1 border-b border-border pb-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-t px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === t.id
                ? 'bg-oe-blue/10 text-oe-blue-text border border-b-0 border-border'
                : 'text-content-secondary hover:text-content-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <Metric label="合同额" value={fmtWan(s.contract)} unit="万" />
          <Metric label="责任成本" value={fmtWan(s.resp_cost)} unit="万" />
          <Metric label="已发生(报公司)" value={fmtWan(s.actual)} unit="万" />
          <Metric label="预估最终成本" value={fmtWan(s.forecast)} unit="万" />
          <Metric label="结算" value={fmtWan(s.settle)} unit="万" />
          <Metric label="形象进度" value={fmtPct(s.progress)} />
          <Metric label="投标毛利" value={fmtPct(s.bid_margin)} />
          <Metric label="预估毛利" value={fmtPct(s.exp_margin)} />
          <Metric label="预算合计" value={fmtWan(s.budget_total)} unit="万" />
          <Metric label="过程人材机" value={fmtWan(s.proc_total)} unit="万" />
          <Metric label="财务已付" value={fmtWan(s.fin_paid)} unit="万" />
          <Metric label="分包合同" value={fmtWan(s.sub_contract)} unit="万" />
          {s.pm ? <Metric label="项目经理" value={s.pm} /> : null}
          {typeof p.note === 'string' && p.note ? (
            <Card className="col-span-full p-3 text-sm text-content-secondary">{p.note}</Card>
          ) : null}
        </div>
      )}

      {tab === 'budget' && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Metric label="预算·人工" value={fmtWan(num(p, 'budget_labor'))} unit="万" />
          <Metric label="预算·材料" value={fmtWan(num(p, 'budget_mat'))} unit="万" />
          <Metric label="预算·机具" value={fmtWan(num(p, 'budget_mach'))} unit="万" />
          <Metric label="预算·管理" value={fmtWan(num(p, 'budget_mgmt'))} unit="万" />
          <Metric label="预算·其他" value={fmtWan(num(p, 'budget_other'))} unit="万" />
          <Metric label="预算合计" value={fmtWan(num(p, 'budget_total'))} unit="万" />
          <Metric label="钢筋量 kg" value={fmtWan(num(p, 'bud_rebar_qty_kg'), 0)} />
          <Metric label="钢筋金额" value={fmtWan(num(p, 'bud_rebar_amt'))} unit="万" />
          <Metric label="砼 m³" value={fmtWan(num(p, 'bud_conc_qty_m3'), 0)} />
          <Metric label="砼金额" value={fmtWan(num(p, 'bud_conc_amt'))} unit="万" />
        </div>
      )}

      {tab === 'purchase' && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Metric label="过程·人工" value={fmtWan(num(p, 'proc_labor'))} unit="万" />
          <Metric label="过程·材料" value={fmtWan(num(p, 'proc_mat'))} unit="万" />
          <Metric label="过程·机具" value={fmtWan(num(p, 'proc_mach'))} unit="万" />
          <Metric label="采购分类合计" value={fmtWan(num(p, 'proc_purchase'))} unit="万" />
          <Metric label="商混" value={fmtWan(num(p, 'proc_ready_mix'))} unit="万" />
          <Metric label="商混 m³" value={fmtWan(num(p, 'ready_mix_m3'), 0)} />
          <Metric label="采购钢筋 kg" value={fmtWan(num(p, 'buy_rebar_kg'), 0)} />
          <Metric label="采购钢筋额" value={fmtWan(num(p, 'buy_rebar_amt'))} unit="万" />
          <Metric label="中方正式" value={fmtWan(num(p, 'labor_cn_formal'))} unit="万" />
          <Metric label="中方劳务" value={fmtWan(num(p, 'labor_cn_temp'))} unit="万" />
          <Metric label="属地" value={fmtWan(num(p, 'labor_local'))} unit="万" />
          <Metric label="中介" value={fmtWan(num(p, 'labor_agency'))} unit="万" />
        </div>
      )}

      {tab === 'cmp' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Metric label="钢筋量比" value={fmtPct(cmpRatio(p, 'cmp_rebar_qty'))} />
            <Metric label="钢筋额比" value={fmtPct(cmpRatio(p, 'cmp_rebar_amt'))} />
            <Metric label="砼量比" value={fmtPct(cmpRatio(p, 'cmp_concrete', 'qty_ratio'))} />
            <Metric
              label="执行率(人材机)"
              value={fmtPct(num(p, 'exec_total'))}
            />
          </div>
          <CmpBlock title="钢筋量" data={p.cmp_rebar_qty} />
          <CmpBlock title="钢筋金额" data={p.cmp_rebar_amt} />
          <CmpBlock title="混凝土" data={p.cmp_concrete} />
        </div>
      )}

      {tab === 'sub' && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Metric label="分包合同" value={fmtWan(num(p, 'sub_contract'))} unit="万" />
          <Metric label="分包已付" value={fmtWan(num(p, 'sub_paid'))} unit="万" />
          <Metric label="分包未付" value={fmtWan(num(p, 'sub_unpaid'))} unit="万" />
          <Metric label="分包支付比" value={fmtPct(num(p, 'sub_pay_ratio'))} />
          <Metric label="分包/责任成本" value={fmtPct(num(p, 'sub_vs_resp'))} />
          <Metric label="分包已付/责任" value={fmtPct(num(p, 'sub_pay_vs_resp'))} />
          <Metric label="责任成本" value={fmtWan(s.resp_cost)} unit="万" />
          <Metric label="毛利侵蚀" value={fmtPct(num(p, 'margin_erosion'))} />
          <Metric label="成本进度缺口" value={fmtPct(num(p, 'cost_progress_gap'))} />
        </div>
      )}

      {tab === 'finance' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Metric label="应付" value={fmtWan(num(p, 'fin_payable'))} unit="万" />
            <Metric label="已付" value={fmtWan(num(p, 'fin_paid'))} unit="万" />
            <Metric label="支付比" value={fmtPct(num(p, 'fin_pay_ratio'))} />
            <Metric label="不含税" value={fmtWan(num(p, 'fin_exvat'))} unit="万" />
            <Metric label="增值税" value={fmtWan(num(p, 'fin_vat'))} unit="万" />
            <Metric label="预扣税" value={fmtWan(num(p, 'fin_withhold'))} unit="万" />
          </div>
          {finSubjects(p).length > 0 ? (
            <Card className="p-4">
              <h4 className="text-sm font-semibold mb-3">付款科目</h4>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {finSubjects(p).map(([k, v]) => (
                  <Metric key={k} label={k} value={fmtWan(v)} unit="万" />
                ))}
              </div>
            </Card>
          ) : null}
          {finMonthly.length > 0 ? (
            <Card className="p-4">
              <h4 className="text-sm font-semibold mb-3">月度付款</h4>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={finMonthly}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="amount" name="付款(万)" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          ) : null}
        </div>
      )}
    </div>
  );
}

function cmpRatio(
  p: Record<string, unknown>,
  key: string,
  ratioKey = 'ratio',
): number | null {
  const d = p[key];
  if (!d || typeof d !== 'object') return null;
  const r = (d as Record<string, unknown>)[ratioKey];
  return r === undefined || r === null ? null : Number(r);
}

function CmpBlock({ title, data }: { title: string; data: unknown }) {
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  return (
    <Card className="p-4">
      <h4 className="text-sm font-semibold mb-2">{title}</h4>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
        {Object.entries(o).map(([k, v]) => (
          <div key={k}>
            <div className="text-2xs text-content-secondary">{k}</div>
            <div className="tabular-nums font-medium">
              {typeof v === 'number' ? fmtWan(v, 2) : String(v)}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function finSubjects(p: Record<string, unknown>): [string, number][] {
  const s = p.fin_subjects;
  if (!s || typeof s !== 'object') return [];
  return Object.entries(s as Record<string, unknown>).map(([k, v]) => [k, Number(v || 0)]);
}

export default ProjectCostBoardPage;
