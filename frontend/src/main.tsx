import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { store } from './store/store.ts';
import { router } from './router.tsx';
import { theme } from './styles/theme.ts';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,          // data stays fresh for 30s
      gcTime: 5 * 60_000,         // keep in cache for 5 min after unmount
      refetchOnWindowFocus: true, // silently refresh when user returns to tab
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <RouterProvider router={router} />
        </ThemeProvider>
      </QueryClientProvider>
    </Provider>
  </React.StrictMode>,
);
