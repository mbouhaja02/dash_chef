import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { QRCodeSVG } from 'qrcode.react';
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

function buildTimeline(rows: AnalysisRow[], maxPoints = 7): TimelinePoint[] {
  const buckets = new Map<string, AnalysisRow[]>();

  for (const row of rows) {
    const key = dayKey(row.audit_date);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-maxPoints)
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

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]): void {
  const escape = (value: string | number) => {
    const text = String(value ?? '');
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = [headers, ...rows].map((row) => row.map(escape).join(';')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.();
}

type Range = '7d' | '30d' | 'all';
const RANGE_DAYS: Record<Range, number> = { '7d': 7, '30d': 30, all: 36500 };
const RANGE_LABELS: Record<Range, string> = { '7d': '7 jours', '30d': '30 jours', all: 'Tout' };
const DEFAULT_EMPTY = 10;
const DEFAULT_BACK = 7;

function scopeByRange(rows: AnalysisRow[], range: Range): AnalysisRow[] {
  if (range === 'all') return rows;
  const cutoff = Date.now() - RANGE_DAYS[range] * 86400000;
  return rows.filter((row) => new Date(row.audit_date).getTime() >= cutoff);
}

function readParams() {
  const p = new URLSearchParams(window.location.search);
  const r = p.get('range');
  return {
    range: (r === '7d' || r === '30d' || r === 'all' ? r : 'all') as Range,
    query: p.get('q') ?? '',
    emptyTh: Number(p.get('empty')) || DEFAULT_EMPTY,
    backTh: Number(p.get('back')) || DEFAULT_BACK,
  };
}

function buildQuery(range: Range, query: string, emptyTh: number, backTh: number): string {
  const p = new URLSearchParams();
  if (range !== 'all') p.set('range', range);
  if (query) p.set('q', query);
  if (emptyTh !== DEFAULT_EMPTY) p.set('empty', String(emptyTh));
  if (backTh !== DEFAULT_BACK) p.set('back', String(backTh));
  return p.toString();
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

  const initial = useRef(readParams()).current;
  const [range, setRange] = useState<Range>(initial.range);
  const [query, setQuery] = useState(initial.query);
  const [emptyTh, setEmptyTh] = useState(initial.emptyTh);
  const [backTh, setBackTh] = useState(initial.backTh);
  const [panel, setPanel] = useState<null | 'settings' | 'share'>(null);
  const [copied, setCopied] = useState(false);

  const scopedRows = useMemo(() => scopeByRange(rows, range), [rows, range]);
  const summary = useMemo(() => summarize(scopedRows), [scopedRows]);
  const actions = useMemo(() => buildActions(scopedRows), [scopedRows]);
  const categories = useMemo(() => buildCategories(scopedRows), [scopedRows]);
  const timeline = useMemo(() => buildTimeline(scopedRows, range === '7d' ? 7 : 14), [scopedRows, range]);
  const filteredActions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => `${a.shelf} ${a.category} ${a.store} ${a.action}`.toLowerCase().includes(q));
  }, [actions, query]);

  const qs = buildQuery(range, query, emptyTh, backTh);
  const snapshotUrl = `${window.location.origin}${window.location.pathname}${qs ? '?' + qs : ''}`;

  useEffect(() => {
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [qs]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(id);
  }, [copied]);

  function exportCsv() {
    downloadCsv(
      `shelfguide-terrain-actions-${dayKey(new Date().toISOString())}.csv`,
      ['Rayon', 'Categorie', 'Magasin', 'Statut', 'Priorite', 'Action', 'Vide %', 'Back-side %', 'Profitabilite %', 'Facings vides', 'Back produits', 'Dernier audit'],
      actions.map((a) => [
        a.shelf, a.category, a.store, a.status, a.priority, a.action,
        Math.round(a.emptyRatio), Math.round(a.backRatio), Math.round(a.profitability),
        a.emptySpaces, a.backProducts, formatDate(a.lastAudit),
      ]),
    );
  }

  function copySnapshot() {
    void navigator.clipboard?.writeText(snapshotUrl).then(() => setCopied(true));
  }
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
            <div className="seg" role="group" aria-label="Periode d'analyse">
              {(['7d', '30d', 'all'] as Range[]).map((r) => (
                <button key={r} className={range === r ? 'active' : ''} onClick={() => setRange(r)}>{RANGE_LABELS[r]}</button>
              ))}
            </div>
            <div className="tool-group">
              <button className="tool-btn" onClick={() => setPanel(panel === 'settings' ? null : 'settings')} title="Reglages des seuils d'alerte">⚙</button>
              <button className="tool-btn" onClick={exportCsv} disabled={rows.length === 0} title="Exporter les actions en CSV">CSV</button>
              <button className="tool-btn" onClick={() => window.print()} disabled={rows.length === 0} title="Generer un rapport PDF">PDF</button>
              <button className="tool-btn" onClick={toggleFullscreen} title="Mode presentation plein ecran">⛶</button>
              <button className="tool-btn" onClick={() => setPanel(panel === 'share' ? null : 'share')} title="Partager / QR code">⤴</button>
            </div>
            <button className="refresh" onClick={() => void refresh()} disabled={loading || !isSupabaseConfigured}>
              Actualiser
            </button>

            {panel ? <div className="popover-backdrop" onClick={() => setPanel(null)} /> : null}
            {panel === 'settings' ? (
              <div className="popover">
                <h3>Seuils d'alerte</h3>
                <label className="field">
                  <span>Vide critique <b>{emptyTh}%</b></span>
                  <input type="range" min={3} max={30} value={emptyTh} onChange={(e) => setEmptyTh(Number(e.target.value))} />
                </label>
                <label className="field">
                  <span>Back-side critique <b>{backTh}%</b></span>
                  <input type="range" min={2} max={20} value={backTh} onChange={(e) => setBackTh(Number(e.target.value))} />
                </label>
                <button className="ghost-btn" onClick={() => { setEmptyTh(DEFAULT_EMPTY); setBackTh(DEFAULT_BACK); }}>Reinitialiser</button>
              </div>
            ) : null}
            {panel === 'share' ? (
              <div className="popover share">
                <h3>Partager cette vue</h3>
                <p>Scannez pour ouvrir sur mobile (filtres inclus)</p>
                <div className="qr"><QRCodeSVG value={snapshotUrl} size={148} bgColor="#ffffff" fgColor="#111111" level="M" /></div>
                <div className="share-url">
                  <input readOnly value={snapshotUrl} onFocus={(e) => e.currentTarget.select()} />
                  <button onClick={copySnapshot}>{copied ? 'Copie !' : 'Copier'}</button>
                </div>
              </div>
            ) : null}
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
                    <strong className="score-value"><CountUp value={pct(summary.avgProfitability)} /></strong>
                    <p>{highActions} actions hautes et {mediumActions} actions moyennes a traiter.</p>
                  </div>
                  <div className="score-ring" style={{ '--score': `${clamp(summary.avgProfitability)}%` } as CSSProperties}>
                    <span><CountUp value={pct(summary.avgProfitability)} /></span>
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
                <div className="panel-head">
                  <PanelTitle eyebrow="Execution terrain" title="File d'actions rayon" />
                  <input
                    className="search"
                    type="search"
                    placeholder="Rechercher un rayon, action..."
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <ActionTable actions={filteredActions.slice(0, 12)} emptyTh={emptyTh} backTh={backTh} />
                {filteredActions.length === 0 ? <p className="muted">Aucune action ne correspond a la recherche.</p> : null}
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

function CountUp({ value }: { value: string }) {
  const match = value.match(/^(\D*)(-?\d+(?:[.,]\d+)?)(.*)$/);
  const target = match ? parseFloat(match[2].replace(',', '.')) : 0;
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(0);

  useEffect(() => {
    if (!match) {
      setDisplay(value);
      return;
    }
    const prefix = match[1];
    const suffix = match[3];
    const decimals = /[.,]/.test(match[2]) ? match[2].split(/[.,]/)[1]?.length ?? 0 : 0;
    const from = fromRef.current;
    fromRef.current = target;
    const duration = 900;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = from + (target - from) * eased;
      setDisplay(`${prefix}${current.toFixed(decimals)}${suffix}`);
      if (t < 1) raf = requestAnimationFrame(tick);
      else setDisplay(value);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <>{display}</>;
}

function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  return <span className={`status-badge ${tone}`}>{label}</span>;
}

function MetricCard({ label, value, detail, tone = 'primary' }: { label: string; value: string; detail: string; tone?: Tone }) {
  return (
    <article className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong><CountUp value={value} /></strong>
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

function ActionTable({ actions, emptyTh, backTh }: { actions: ActionRow[]; emptyTh: number; backTh: number }) {
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
              <td><RatioCell value={action.emptyRatio} tone={action.emptyRatio >= emptyTh ? 'danger' : action.emptyRatio >= emptyTh * 0.7 ? 'warning' : 'success'} /></td>
              <td><RatioCell value={action.backRatio} tone={action.backRatio >= backTh ? 'warning' : 'success'} /></td>
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
  const [active, setActive] = useState<number | null>(null);
  if (points.length === 0) return <p className="muted">Pas encore assez de donnees temporelles.</p>;

  const W = 720;
  const H = 240;
  const padL = 34;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const baseY = padT + innerH;

  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const x = (i: number) => padL + stepX * i;
  const yConf = (v: number) => padT + innerH * (1 - clamp(v, 0, 100) / 100);
  const ySec = (v: number) => padT + innerH * (1 - clamp(v / maxActions, 0, 1));

  const confPoints = points.map((p, i) => [x(i), yConf(p.conformity)] as const);
  const secPoints = points.map((p, i) => [x(i), ySec(p.actions)] as const);

  const toPath = (pts: readonly (readonly [number, number])[]) =>
    pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`).join(' ');

  const confLine = toPath(confPoints);
  const areaPath = `${confLine} L${x(points.length - 1).toFixed(1)} ${baseY} L${padL} ${baseY} Z`;
  const secLine = toPath(secPoints);
  const gridValues = [0, 25, 50, 75, 100];
  const hovered = active !== null ? points[active] : null;

  return (
    <div className="timeline">
      <div className="timeline-legend">
        <span><i className="legend-compliance" /> Conformite</span>
        <span><i className="legend-anomaly" /> Actions</span>
      </div>

      <div className="chart">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="Evolution de la conformite et des actions"
          onMouseLeave={() => setActive(null)}
        >
          <defs>
            <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(249, 115, 22, .28)" />
              <stop offset="100%" stopColor="rgba(249, 115, 22, 0)" />
            </linearGradient>
            <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#fbbf24" />
              <stop offset="100%" stopColor="#ea580c" />
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
          <path className="line anomaly" d={secLine} />
          <path className="line compliance" d={confLine} />

          {confPoints.map((pt, i) => (
            <circle
              key={i}
              className="dot"
              cx={pt[0]}
              cy={pt[1]}
              r={active === i ? 0 : 4}
              style={{ animationDelay: `${0.9 + i * 0.08}s` }}
            />
          ))}

          {hovered ? (
            <g>
              <line className="cursor-line" x1={x(active!)} y1={padT} x2={x(active!)} y2={baseY} />
              <circle className="cursor-dot" cx={x(active!)} cy={yConf(hovered.conformity)} r={5.5} />
            </g>
          ) : null}

          {points.map((p, i) =>
            i % Math.ceil(points.length / 7) === 0 || i === points.length - 1 ? (
              <text key={p.label} className="x-label" x={x(i)} y={H - 8}>{p.label}</text>
            ) : null,
          )}

          {points.map((_, i) => (
            <rect
              key={`hit-${i}`}
              className="hit"
              x={x(i) - (stepX || innerW) / 2}
              y={padT}
              width={stepX || innerW}
              height={innerH}
              onMouseEnter={() => setActive(i)}
            />
          ))}
        </svg>

        {hovered ? (
          <div
            className="chart-tooltip"
            style={{ left: `${(x(active!) / W) * 100}%`, top: `${(yConf(hovered.conformity) / H) * 100}%` }}
          >
            <b>{hovered.label}</b>
            <div className="tt-row">
              <span><i style={{ background: 'linear-gradient(90deg,#fbbf24,#ea580c)' }} />Conformite</span>
              <strong>{pct(hovered.conformity)}</strong>
            </div>
            <div className="tt-row">
              <span><i style={{ background: '#16a34a' }} />Actions</span>
              <strong>{hovered.actions}</strong>
            </div>
            <div className="tt-row">
              <span>Corrigees</span>
              <strong>{hovered.corrected}</strong>
            </div>
          </div>
        ) : null}
      </div>

      {points.length <= 8 ? (
        <div className="chart-foot" style={{ gridTemplateColumns: `repeat(${points.length}, 1fr)` }}>
          {points.map((p) => (
            <small key={p.label}>{pct(p.conformity)} · {p.corrected} corr.</small>
          ))}
        </div>
      ) : null}
    </div>
  );
}
