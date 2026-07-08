import type { RootState } from '../store.ts';

export const selectPortfolios    = (state: RootState) => state.portfolios.items;
export const selectEditingId     = (state: RootState) => state.portfolios.editingId;
export const selectIsCreateOpen  = (state: RootState) => state.portfolios.isCreateOpen;

export const selectPortfolioById = (id: number) =>
  (state: RootState) => state.portfolios.items.find(p => p.id === id) ?? null;

export const selectEditingPortfolio = (state: RootState) => {
  const { editingId, items } = state.portfolios;
  return editingId != null ? (items.find(p => p.id === editingId) ?? null) : null;
};
