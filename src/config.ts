import type { GroupKey } from './dashboard';

export const dashboardConfig = {
  title: 'Dashboard chef de rayon',
  subtitle: 'Priorites terrain, ruptures visibles et facing a corriger.',
  eyebrow: 'ShelfGuide terrain',
  scopeLabel: 'Perimetre chef de rayon',
  storeName: import.meta.env.VITE_STORE_NAME?.trim() || '',
  category: import.meta.env.VITE_CATEGORY?.trim() || '',
  primaryGroup: 'shelf_name' as GroupKey,
  primaryTitle: 'Rayons a corriger',
  secondaryGroup: 'category' as GroupKey,
  secondaryTitle: 'Categories sensibles',
  riskTitle: 'Actions prioritaires',
  recentTitle: 'Dernieres analyses',
  limit: 300,
  refreshMs: 15000,
  // Hypotheses ajustables pour la valorisation business reseau.
  costPerFacing: 65, // MAD de CA potentiel/jour par facing vide
  minPerManualAudit: 12, // minutes economisees par audit automatise vs manuel
  networkLabel: 'Reseau Franprix - Maroc',
};
