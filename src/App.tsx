import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  AnalysisRow,
  average,
  formatDate,
  isSupabaseConfigured,
  loadAnalyses,
  summarize,
  supabaseClient,
} from './dashboard';
import { dashboardConfig } from './config';
import './styles.css';

type Tone = 'danger' | 'warning' | 'success' | 'primary';
type Priority = 'Haute' | 'Moyenne' | 'Faible';

interface ActionRow {
  id: string;
  store: string;
  shelf: string;
  category: string;
  status: string;
  priority: Priority;
  action: string;
  emptyRatio: number;
  backRatio: number;
  profitability: number;
  emptySpaces: number;
  backProducts: number;
  lastAudit: string;
  score: number;
}

interface CategoryFocus {
  category: string;
  actions: number;
  avgProfitability: number;
  emptySpaces: number;
  backProducts: number;
}

interface TimelinePoint {
  label: string;
  conformity: number;
  actions: number;
  corrected: number;
}

function pct(value: number): string {
  return `${Math.round(value)}%`;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function dayKey(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function shortDay(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' }).format(new Date(value));
}

function isToday(value: string): boolean {
  return dayKey(value) === dayKey(new Date().toISOString());
}

function statusOf(row: AnalysisRow): string {
  if (row.status === 'Critique' || row.severity === 'high' || row.weighted_profitability_percent < 65) return 'Critique';
  if (row.status === 'Moyen' || row.weighted_profitability_percent < 85) return 'Moyen';
  return 'Bon';
}

function toneFromStatus(status: string): Tone {
  if (status === 'Critique') return 'danger';
  if (status === 'Moyen') return 'warning';
  return 'success';
}

function toneFromPriority(priority: Priority): Tone {
  if (priority === 'Haute') return 'danger';
  if (priority === 'Moyenne') return 'warning';
  return 'success';
}

function actionFor(row: AnalysisRow): string {
  if (row.empty_ratio_percent >= 10 || row.empty_spaces >= 3) return 'Recharger le facing';
  if (row.back_ratio_percent >= 7 || row.back_products >= 3) return 'Remettre produits en front';
  if (row.weighted_profitability_percent < 75) return 'Verifier implantation';
  return 'Controle rapide';
}

function priorityFor(row: AnalysisRow): Priority {
  if (
    statusOf(row) === 'Critique' ||
    row.empty_ratio_percent >= 15 ||
    row.back_ratio_percent >= 10 ||
    row.weighted_profitability_percent < 70
  ) return 'Haute';

  if (
    statusOf(row) === 'Moyen' ||
    row.empty_ratio_percent >= 7 ||
    row.back_ratio_percent >= 5 ||
    row.weighted_profitability_percent < 85
  ) return 'Moyenne';

  return 'Faible';
}

function issueCount(rows: AnalysisRow[]): number {
  return rows.reduce((sum, row) => sum + row.empty_spaces + row.back_products, 0);
}

function buildActions(rows: AnalysisRow[]): ActionRow[] {
  return [...rows]
    .sort((a, b) => new Date(b.audit_date).getTime() - new Date(a.audit_date).getTime())
    .map((row) => {
      const priority = priorityFor(row);
      const score =
        (100 - row.weighted_profitability_percent) +
        row.empty_ratio_percent * 1.7 +
        row.back_ratio_percent * 1.3 +
        row.empty_spaces * 3 +
        row.back_products * 2;

      return {
        id: row.id,
        store: row.store_name,
        shelf: row.shelf_name,
        category: row.category,
        status: statusOf(row),
        priority,
        action: actionFor(row),
        emptyRatio: row.empty_ratio_percent,
        backRatio: row.back_ratio_percent,
        profitability: row.weighted_profitability_percent,
        emptySpaces: row.empty_spaces,
        backProducts: row.back_products,
        lastAudit: row.audit_date,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function buildCategories(rows: AnalysisRow[]): CategoryFocus[] {
  const buckets = new Map<string, AnalysisRow[]>();

  for (const row of rows) {
    buckets.set(row.category, [...(buckets.get(row.category) ?? []), row]);
  }

  return Array.from(buckets.entries())
    .map(([category, items]) => ({
      category,
      actions: items.filter((item) => priorityFor(item) !== 'Faible').length,
      avgProfitability: average(items.map((item) => item.weighted_profitability_percent)),
      emptySpaces: items.reduce((sum, item) => sum + item.empty_spaces, 0),
      backProducts: items.reduce((sum, item) => sum + item.back_products, 0),
    }))
    .sort((a, b) => b.actions - a.actions || a.avgProfitability - b.avgProfitability)
    .slice(0, 5);
}

function buildTimeline(rows: AnalysisRow[]): TimelinePoint[] {
  const buckets = new Map<string, AnalysisRow[]>();

  for (const row of rows) {
    const key = dayKey(row.audit_date);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-7)
    .map(([key, items], index, all) => {
      const actions = issueCount(items);
      const previous = index > 0 ? issueCount(all[index - 1][1]) : actions;

      return {
        label: shortDay(key),
        conformity: average(items.map((item) => item.weighted_profitability_percent)),
        actions,
        corrected: Math.max(0, previous - actions),
      };
    });
}

export default function App() {
  const [rows, setRows] = useState<AnalysisRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  async function refresh(showLoading = false) {
    try {
      if (showLoading) setLoading(true);
      else setRefreshing(true);
      setError(null);
      const data = await loadAnalyses({
        storeName: dashboardConfig.storeName,
        category: dashboardConfig.category,
        limit: dashboardConfig.limit,
      });
      setRows(data);
      setLastUpdated(new Date());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement Supabase.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      setError('Variables Supabase manquantes.');
      return;
    }

    void refresh(true);

    const intervalId = window.setInterval(() => {
      void refresh();
    }, dashboardConfig.refreshMs);

    const channel = supabaseClient
      ?.channel('shelfguide-chef-live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'shelfguide_analyses' },
        () => void refresh(),
      )
      .subscribe();

    return () => {
      window.clearInterval(intervalId);
      if (channel) void supabaseClient?.removeChannel(channel);
    };
  }, []);

  const summary = useMemo(() => summarize(rows), [rows]);
  const actions = useMemo(() => buildActions(rows), [rows]);
  const categories = useMemo(() => buildCategories(rows), [rows]);
  const timeline = useMemo(() => buildTimeline(rows), [rows]);
  const immediate = actions[0];
  const highActions = actions.filter((action) => action.priority === 'Haute').length;
  const mediumActions = actions.filter((action) => action.priority === 'Moyenne').length;
  const analysedToday = actions.filter((action) => isToday(action.lastAudit)).length;
  const maxActions = Math.max(1, ...timeline.map((point) => point.actions));
  const latestTimeline = timeline[timeline.length - 1];
  const terrainReady = summary.avgProfitability >= 85 && highActions === 0;

  return (
    <main className="app-frame">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">CR</div>
          <div>
            <strong>ShelfGuide Terrain</strong>
            <span>Chef de rayon</span>
          </div>
        </div>

        <nav className="side-nav" aria-label="Navigation dashboard">
          <a className="active" href="#overview">Tour terrain</a>
          <a href="#actions">Actions</a>
          <a href="#categories">Categories</a>
          <a href="#timeline">Evolution</a>
        </nav>

        <div className={`sync-card ${error ? 'offline' : 'online'}`}>
          <span className="sync-dot" />
          <strong>{error ? 'Connexion a verifier' : refreshing ? 'Synchronisation' : 'Supabase live'}</strong>
          <small>{lastUpdated ? formatDate(lastUpdated.toISOString()) : 'En attente'}</small>
        </div>
      </aside>

      <section className="workspace">
        <header className="page-header" id="overview">
          <div>
            <p className="eyebrow">Chef de rayon</p>
            <h1>Plan d'action terrain</h1>
            <p className="subtitle">Ruptures visibles, produits mal orientes et rayons a remettre en propre.</p>
          </div>
          <div className="header-actions">
            <div className="store-chip">
              <span>Perimetre</span>
              <strong>{dashboardConfig.storeName || 'Tous magasins'}{dashboardConfig.category ? ` / ${dashboardConfig.category}` : ''}</strong>
            </div>
            <button className="refresh" onClick={() => void refresh()} disabled={loading || !isSupabaseConfigured}>
              Actualiser
            </button>
          </div>
        </header>

        {error ? <div className="notice danger">{error}</div> : null}
        {loading ? <div className="notice">Chargement des analyses Supabase...</div> : null}

        {!loading && rows.length === 0 && !error ? (
          <div className="empty">Aucune analyse disponible pour ce perimetre.</div>
        ) : null}

        {rows.length > 0 ? (
          <>
            <section className="command-grid">
              <article className="command-card score-card">
                <div className="section-heading">
                  <span>Score terrain</span>
                  <StatusBadge tone={terrainReady ? 'success' : 'warning'} label={terrainReady ? 'Rayons propres' : 'Tour requis'} />
                </div>
                <div className="score-layout">
                  <div>
                    <strong className="score-value">{pct(summary.avgProfitability)}</strong>
                    <p>{highActions} actions hautes et {mediumActions} actions moyennes a traiter.</p>
                  </div>
                  <div className="score-ring" style={{ '--score': `${clamp(summary.avgProfitability)}%` } as CSSProperties}>
                    <span>{pct(summary.avgProfitability)}</span>
                  </div>
                </div>
              </article>

              <article className="command-card priority-card">
                <div className="section-heading">
                  <span>Action immediate</span>
                  <StatusBadge tone={immediate ? toneFromPriority(immediate.priority) : 'primary'} label={immediate?.priority ?? 'N/A'} />
                </div>
                <strong className="priority-title">{immediate?.shelf ?? 'Aucun rayon'}</strong>
                <p>{immediate ? `${immediate.action}: ${pct(immediate.emptyRatio)} vide, ${pct(immediate.backRatio)} back-side.` : 'Aucune action detectee.'}</p>
                <div className="mini-metrics">
                  <span>Consigne terrain</span>
                  <strong>{immediate?.action ?? 'Maintenir controle rayon'}</strong>
                </div>
              </article>

              <article className="command-card execution-card">
                <div className="section-heading">
                  <span>Tour du jour</span>
                  <StatusBadge tone={analysedToday > 0 ? 'success' : 'warning'} label={`${analysedToday} analyses`} />
                </div>
                <strong className="priority-title">{latestTimeline?.corrected ?? 0} anomalies corrigees</strong>
                <p>Dernier passage synchronise avec Supabase en temps reel.</p>
                <div className="progress-line">
                  <i style={{ width: `${clamp((analysedToday / Math.max(1, actions.length)) * 100)}%` }} />
                </div>
              </article>
            </section>

            <section className="metric-grid">
              <MetricCard label="Analyses" value={String(summary.audits)} detail="Audits rayon" />
              <MetricCard label="Haute priorite" value={String(highActions)} detail="A traiter maintenant" tone="danger" />
              <MetricCard label="Moyenne" value={String(mediumActions)} detail="A corriger ensuite" tone="warning" />
              <MetricCard label="Profitabilite" value={pct(summary.avgProfitability)} detail="Score moyen" tone="success" />
              <MetricCard label="Facings vides" value={String(summary.emptySpaces)} detail={`${pct(summary.avgEmptyRatio)} moyen`} tone="warning" />
              <MetricCard label="Back-side" value={String(summary.backProducts)} detail={`${pct(summary.avgBackRatio)} moyen`} />
              <MetricCard label="Aujourd'hui" value={String(analysedToday)} detail="Analyses du jour" tone="success" />
            </section>

            <section className="content-grid">
              <section className="panel table-panel" id="actions">
                <PanelTitle eyebrow="Execution terrain" title="File d'actions rayon" />
                <ActionTable actions={actions.slice(0, 12)} />
              </section>

              <section className="panel decisions-panel">
                <PanelTitle eyebrow="Checklist" title="Ordre de passage" />
                <DecisionStack
                  items={[
                    ['Commencer par', immediate?.shelf ?? 'Aucun rayon'],
                    ['Action', immediate?.action ?? 'Controle rapide'],
                    ['Ruptures visibles', String(summary.emptySpaces)],
                    ['Mal orientes', String(summary.backProducts)],
                  ]}
                />
              </section>

              <section className="panel alerts-panel" id="categories">
                <PanelTitle eyebrow="Categories" title="Zones sensibles" />
                <CategoryList categories={categories} />
              </section>

              <section className="panel timeline-panel" id="timeline">
                <PanelTitle eyebrow="Evolution" title="Conformite et corrections terrain" />
                <Timeline points={timeline} maxActions={maxActions} />
              </section>
            </section>
          </>
        ) : null}
      </section>
    </main>
  );
}

function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  return <span className={`status-badge ${tone}`}>{label}</span>;
}

function MetricCard({ label, value, detail, tone = 'primary' }: { label: string; value: string; detail: string; tone?: Tone }) {
  return (
    <article className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function PanelTitle({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="panel-title">
      <span>{eyebrow}</span>
      <h2>{title}</h2>
    </div>
  );
}

function RatioCell({ value, tone }: { value: number; tone: Tone }) {
  return (
    <div className="ratio-cell">
      <span>{pct(value)}</span>
      <div className={`ratio-track ${tone}`}>
        <i style={{ width: `${clamp(value)}%` }} />
      </div>
    </div>
  );
}

function ActionTable({ actions }: { actions: ActionRow[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Rayon</th>
            <th>Statut</th>
            <th>Vide</th>
            <th>Back-side</th>
            <th>Profitabilite</th>
            <th>Action</th>
            <th>Priorite</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((action) => (
            <tr key={action.id}>
              <td>
                <strong>{action.shelf}</strong>
                <small>{action.category} - {action.store}</small>
              </td>
              <td><StatusBadge tone={toneFromStatus(action.status)} label={action.status} /></td>
              <td><RatioCell value={action.emptyRatio} tone={action.emptyRatio >= 10 ? 'danger' : action.emptyRatio >= 7 ? 'warning' : 'success'} /></td>
              <td><RatioCell value={action.backRatio} tone={action.backRatio >= 7 ? 'warning' : 'success'} /></td>
              <td><RatioCell value={action.profitability} tone={action.profitability >= 85 ? 'success' : action.profitability >= 65 ? 'warning' : 'danger'} /></td>
              <td>{action.action}</td>
              <td><StatusBadge tone={toneFromPriority(action.priority)} label={action.priority} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DecisionStack({ items }: { items: [string, string][] }) {
  return (
    <div className="decision-stack">
      {items.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function CategoryList({ categories }: { categories: CategoryFocus[] }) {
  return (
    <div className="recurring-list">
      {categories.map((category, index) => (
        <div key={category.category}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <div>
            <strong>{category.category}</strong>
            <small>{category.emptySpaces} vides - {category.backProducts} back-side</small>
          </div>
          <em>{category.actions} actions</em>
        </div>
      ))}
    </div>
  );
}

function Timeline({ points, maxActions }: { points: TimelinePoint[]; maxActions: number }) {
  if (points.length === 0) return <p className="muted">Pas encore assez de donnees temporelles.</p>;

  const W = 720;
  const H = 240;
  const padL = 34;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const x = (i: number) => padL + stepX * i;
  const yConf = (v: number) => padT + innerH * (1 - clamp(v, 0, 100) / 100);
  const yAction = (v: number) => padT + innerH * (1 - clamp(v / maxActions, 0, 1));

  const confPoints = points.map((p, i) => [x(i), yConf(p.conformity)] as const);
  const actionPoints = points.map((p, i) => [x(i), yAction(p.actions)] as const);

  const toPath = (pts: readonly (readonly [number, number])[]) =>
    pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`).join(' ');

  const confLine = toPath(confPoints);
  const areaPath = `${confLine} L${x(points.length - 1).toFixed(1)} ${padT + innerH} L${padL} ${padT + innerH} Z`;
  const actionLine = toPath(actionPoints);
  const gridValues = [0, 25, 50, 75, 100];

  return (
    <div className="timeline">
      <div className="timeline-legend">
        <span><i className="legend-compliance" /> Conformite</span>
        <span><i className="legend-anomaly" /> Actions</span>
      </div>

      <div className="chart">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Evolution de la conformite et des actions">
          <defs>
            <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(99, 102, 241, .28)" />
              <stop offset="100%" stopColor="rgba(99, 102, 241, 0)" />
            </linearGradient>
          </defs>

          {gridValues.map((g) => {
            const gy = yConf(g);
            return (
              <g key={g}>
                <line className="grid-line" x1={padL} y1={gy} x2={W - padR} y2={gy} />
                <text className="y-label" x={padL - 8} y={gy + 3}>{g}</text>
              </g>
            );
          })}

          <path className="area" d={areaPath} fill="url(#areaFill)" />
          <path className="line anomaly" d={actionLine} />
          <path className="line compliance" d={confLine} />

          {confPoints.map((pt, i) => (
            <circle
              key={i}
              className="dot"
              cx={pt[0]}
              cy={pt[1]}
              r={4}
              style={{ animationDelay: `${0.9 + i * 0.08}s` }}
            />
          ))}

          {points.map((p, i) => (
            <text key={p.label} className="x-label" x={x(i)} y={H - 8}>{p.label}</text>
          ))}
        </svg>
      </div>

      <div className="chart-foot">
        {points.map((p) => (
          <small key={p.label}>{pct(p.conformity)} · {p.corrected} corr.</small>
        ))}
      </div>
    </div>
  );
}
