import { configureStore } from '@reduxjs/toolkit';
import { portfoliosSlice } from './portfolios/portfolios.slice.ts';
import { baseApi } from './api/baseApi.ts';

export const store = configureStore({
  reducer: {
    portfolios: portfoliosSlice.reducer,
    [baseApi.reducerPath]: baseApi.reducer,
  },
  middleware: getDefaultMiddleware =>
    getDefaultMiddleware().concat(baseApi.middleware),
});

export type RootState   = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
