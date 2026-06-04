import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

/* ============================================================
   ShelfGuide Terrain — generateur de rapport PDF (chef de rayon)
   Document professionnel, branche, 2 a 3 pages max.
   ============================================================ */

type RGB = [number, number, number];

const ACCENT: RGB = [234, 88, 12];      // amber
const INK: RGB = [42, 26, 15];
const MUTED: RGB = [130, 110, 90];
const RULE: RGB = [231, 216, 196];
const ZEBRA: RGB = [252, 245, 235];
const OK: RGB = [21, 128, 61];
const WARN: RGB = [180, 83, 9];
const BAD: RGB = [194, 50, 40];

export interface ReportAction {
  shelf: string;
  category: string;
  status: string;
  action: string;
  emptyRatio: number;
  backRatio: number;
  priority: string;
}

export interface ChefReport {
  perimetre: string;
  periode: string;
  summary: { avgProfitability: number; avgEmptyRatio: number; avgBackRatio: number; audits: number; emptySpaces: number; backProducts: number };
  counts: { actions: number; high: number; medium: number };
  immediate?: { shelf: string; action: string; emptyRatio: number; backRatio: number };
  actions: ReportAction[];
  categories: { category: string; actions: number }[];
  timeline: { label: string; conformity: number }[];
  thresholds: { empty: number; back: number };
}

const pct = (v: number) => `${Math.round(v)}%`;

function nowLabel(): string {
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date());
}

function header(doc: jsPDF, M: number, W: number, title: string, meta: string) {
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, W, 6, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...INK);
  doc.text('ShelfGuide Terrain', M, 32);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...MUTED);
  doc.text('RAPPORT CHEF DE RAYON', W - M, 32, { align: 'right' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(21);
  doc.setTextColor(...INK);
  doc.text(title, M, 66);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(meta, M, 84);
  doc.setDrawColor(...RULE);
  doc.setLineWidth(0.8);
  doc.line(M, 94, W - M, 94);
}

function sectionTitle(doc: jsPDF, M: number, y: number, label: string) {
  doc.setFillColor(...ACCENT);
  doc.rect(M, y - 9, 3, 12, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...INK);
  doc.text(label, M + 9, y);
}

function kpiRow(doc: jsPDF, M: number, y: number, W: number, items: { label: string; value: string; tone?: RGB }[]) {
  const gap = 12;
  const h = 60;
  const n = items.length;
  const w = (W - M * 2 - gap * (n - 1)) / n;
  items.forEach((it, i) => {
    const x = M + i * (w + gap);
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.8);
    doc.setFillColor(253, 249, 243);
    doc.roundedRect(x, y, w, h, 4, 4, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(it.label.toUpperCase(), x + 12, y + 18);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(...(it.tone ?? INK));
    doc.text(it.value, x + 12, y + 44);
  });
  return y + h;
}

function sparkline(doc: jsPDF, M: number, y: number, W: number, points: { label: string; conformity: number }[]) {
  const h = 96;
  const x = M;
  const w = W - M * 2;
  doc.setDrawColor(...RULE);
  doc.setLineWidth(0.8);
  doc.setFillColor(253, 249, 243);
  doc.roundedRect(x, y, w, h, 4, 4, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text('EVOLUTION DE LA CONFORMITE', x + 12, y + 16);

  const padL = x + 34;
  const padR = x + w - 14;
  const top = y + 26;
  const bottom = y + h - 20;
  const innerH = bottom - top;
  [0, 50, 100].forEach((g) => {
    const gy = bottom - (g / 100) * innerH;
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.4);
    doc.line(padL, gy, padR, gy);
    doc.setFontSize(6.5);
    doc.setTextColor(...MUTED);
    doc.text(String(g), padL - 6, gy + 2, { align: 'right' });
  });
  if (points.length === 0) return y + h;
  const span = padR - padL;
  const step = points.length > 1 ? span / (points.length - 1) : 0;
  const px = (i: number) => padL + step * i;
  const py = (v: number) => bottom - (Math.max(0, Math.min(100, v)) / 100) * innerH;
  doc.setDrawColor(...ACCENT);
  doc.setLineWidth(1.6);
  for (let i = 1; i < points.length; i++) doc.line(px(i - 1), py(points[i - 1].conformity), px(i), py(points[i].conformity));
  doc.setFillColor(...ACCENT);
  points.forEach((p, i) => {
    doc.circle(px(i), py(p.conformity), 1.8, 'F');
    if (i % Math.ceil(points.length / 7) === 0 || i === points.length - 1) {
      doc.setFontSize(6.5);
      doc.setTextColor(...MUTED);
      doc.text(p.label, px(i), bottom + 12, { align: 'center' });
    }
  });
  return y + h;
}

function bullets(doc: jsPDF, M: number, y: number, W: number, lines: string[]) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  let cy = y;
  lines.forEach((line) => {
    doc.setFillColor(...ACCENT);
    doc.circle(M + 3, cy - 3, 1.6, 'F');
    doc.setTextColor(...INK);
    const wrapped = doc.splitTextToSize(line, W - M * 2 - 14);
    doc.text(wrapped, M + 12, cy);
    cy += wrapped.length * 13 + 6;
  });
  return cy;
}

function footer(doc: jsPDF, M: number, W: number, H: number) {
  const total = doc.getNumberOfPages();
  const stamp = nowLabel();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.6);
    doc.line(M, H - 30, W - M, H - 30);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text('ShelfGuide Terrain — Rapport confidentiel', M, H - 18);
    doc.text(`Genere le ${stamp}`, W / 2, H - 18, { align: 'center' });
    doc.text(`Page ${i} / ${total}`, W - M, H - 18, { align: 'right' });
  }
}

function recommendations(data: ChefReport): string[] {
  const out: string[] = [];
  if (data.immediate) {
    out.push(`Commencer le tour par "${data.immediate.shelf}" : ${data.immediate.action.toLowerCase()} (${pct(data.immediate.emptyRatio)} de vide, ${pct(data.immediate.backRatio)} en back-side).`);
  }
  if (data.counts.high > 0) {
    out.push(`${data.counts.high} action(s) en haute priorite a traiter immediatement, puis ${data.counts.medium} action(s) moyenne(s).`);
  } else {
    out.push('Aucune action haute priorite : rayons globalement propres, controle de routine.');
  }
  if (data.summary.emptySpaces > 0) out.push(`${data.summary.emptySpaces} facings vides recenses : prevoir le reapprovisionnement (seuil vide ${data.thresholds.empty}%).`);
  if (data.summary.backProducts > 0) out.push(`${data.summary.backProducts} produits mal orientes a remettre en front (seuil back-side ${data.thresholds.back}%).`);
  out.push(`Charge analysee : ${data.counts.actions} actions sur la periode "${data.periode}" (${data.summary.audits} audits).`);
  return out;
}

export function generateChefReport(data: ChefReport): void {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;

  header(doc, M, W, "Plan d'action terrain", `Periode : ${data.periode}   •   Edite le ${nowLabel()}`);

  let y = 122;
  sectionTitle(doc, M, y, 'Synthese terrain');
  y += 14;
  y = kpiRow(doc, M, y, W, [
    { label: 'Score terrain', value: pct(data.summary.avgProfitability), tone: data.summary.avgProfitability >= 85 ? OK : data.summary.avgProfitability >= 65 ? WARN : BAD },
    { label: 'Actions hautes', value: String(data.counts.high), tone: data.counts.high > 0 ? BAD : OK },
    { label: 'Actions moyennes', value: String(data.counts.medium), tone: WARN },
    { label: 'Vide moyen', value: pct(data.summary.avgEmptyRatio), tone: WARN },
  ]);

  y += 22;
  y = sparkline(doc, M, y, W, data.timeline);

  y += 30;
  sectionTitle(doc, M, y, "File d'actions prioritaires");
  y += 8;
  autoTable(doc, {
    startY: y,
    margin: { left: M, right: M },
    head: [['Rayon', 'Categorie', 'Statut', 'Action', 'Vide', 'Back', 'Priorite']],
    body: data.actions.map((a) => [a.shelf, a.category, a.status, a.action, pct(a.emptyRatio), pct(a.backRatio), a.priority]),
    theme: 'plain',
    headStyles: { fillColor: ACCENT, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5 },
    styles: { fontSize: 8.5, cellPadding: 5, textColor: INK, lineColor: RULE, lineWidth: 0.4 },
    alternateRowStyles: { fillColor: ZEBRA },
    columnStyles: { 4: { halign: 'right' }, 5: { halign: 'right' } },
    didParseCell: (h) => {
      if (h.section === 'body' && h.column.index === 2) {
        const v = String(h.cell.raw);
        h.cell.styles.textColor = v === 'Critique' ? BAD : v === 'Moyen' ? WARN : OK;
        h.cell.styles.fontStyle = 'bold';
      }
      if (h.section === 'body' && h.column.index === 6) {
        const v = String(h.cell.raw);
        h.cell.styles.textColor = v === 'Haute' ? BAD : v === 'Moyenne' ? WARN : OK;
        h.cell.styles.fontStyle = 'bold';
      }
    },
  });

  // @ts-expect-error lastAutoTable is augmented by jspdf-autotable at runtime
  y = (doc.lastAutoTable?.finalY ?? y) + 30;
  if (y > H - 220) { doc.addPage(); y = 60; }

  sectionTitle(doc, M, y, 'Consignes & recommandations');
  y += 18;
  y = bullets(doc, M, y, W, recommendations(data));

  if (data.categories.length > 0) {
    y += 14;
    if (y > H - 160) { doc.addPage(); y = 60; }
    sectionTitle(doc, M, y, 'Zones sensibles');
    y += 8;
    autoTable(doc, {
      startY: y,
      margin: { left: M, right: M },
      head: [['#', 'Categorie', 'Actions ouvertes']],
      body: data.categories.map((c, i) => [String(i + 1), c.category, String(c.actions)]),
      theme: 'plain',
      headStyles: { fillColor: INK, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5 },
      styles: { fontSize: 8.5, cellPadding: 5, textColor: INK, lineColor: RULE, lineWidth: 0.4 },
      alternateRowStyles: { fillColor: ZEBRA },
      columnStyles: { 0: { cellWidth: 28 }, 2: { halign: 'right' } },
    });
  }

  footer(doc, M, W, H);
  doc.save(`rapport-terrain-${new Date().toISOString().slice(0, 10)}.pdf`);
}
