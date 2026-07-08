import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Portfolio } from '../../api/portfolio.api.types.ts';

interface PortfoliosState {
  /** Cached portfolio list — synced from API on successful fetch */
  items: Portfolio[];
  /** ID of the portfolio currently open in the edit modal (null = modal closed) */
  editingId: number | null;
  /** Whether the create-portfolio modal is open */
  isCreateOpen: boolean;
}

const initialState: PortfoliosState = {
  items: [],
  editingId: null,
  isCreateOpen: false,
};

export const portfoliosSlice = createSlice({
  name: 'portfolios',
  initialState,
  reducers: {
    /** Replace the full list (called after a successful list fetch) */
    setPortfolios(state, action: PayloadAction<Portfolio[]>) {
      state.items = action.payload;
    },
    /** Insert or update a single portfolio in the list */
    upsertPortfolio(state, action: PayloadAction<Portfolio>) {
      const idx = state.items.findIndex(p => p.id === action.payload.id);
      if (idx !== -1) {
        state.items[idx] = action.payload;
      } else {
        state.items.push(action.payload);
      }
    },
    /** Open the edit modal for a specific portfolio */
    openEditModal(state, action: PayloadAction<number>) {
      state.editingId = action.payload;
    },
    /** Close the edit modal */
    closeEditModal(state) {
      state.editingId = null;
    },
    /** Open the create-portfolio modal */
    openCreateModal(state) {
      state.isCreateOpen = true;
    },
    /** Close the create-portfolio modal */
    closeCreateModal(state) {
      state.isCreateOpen = false;
    },
  },
});

export const {
  setPortfolios,
  upsertPortfolio,
  openEditModal,
  closeEditModal,
  openCreateModal,
  closeCreateModal,
} = portfoliosSlice.actions;

export default portfoliosSlice.reducer;
