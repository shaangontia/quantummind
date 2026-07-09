import { baseApi } from '../api/baseApi.ts';
import type { AuthUser, LoginPayload, RegisterPayload } from './auth.types.ts';

export const authApi = baseApi.injectEndpoints({
  endpoints: builder => ({

    // ─── Current user ─────────────────────────────────────────────────────────
    getCurrentUser: builder.query<AuthUser, void>({
      query: () => ({ url: '/auth/me', method: 'GET' }),
      providesTags: ['AuthUser'],
    }),

    // ─── Register ─────────────────────────────────────────────────────────────
    register: builder.mutation<AuthUser, RegisterPayload>({
      query: body => ({ url: '/auth/register', method: 'POST', body }),
      invalidatesTags: ['AuthUser'],
    }),

    // ─── Login ────────────────────────────────────────────────────────────────
    login: builder.mutation<AuthUser, LoginPayload>({
      query: body => ({ url: '/auth/login', method: 'POST', body }),
      invalidatesTags: ['AuthUser'],
    }),

    // ─── Logout ───────────────────────────────────────────────────────────────
    logout: builder.mutation<void, void>({
      query: () => ({ url: '/auth/logout', method: 'POST' }),
      invalidatesTags: ['AuthUser'],
    }),

  }),
  overrideExisting: false,
});

export const {
  useGetCurrentUserQuery,
  useRegisterMutation,
  useLoginMutation,
  useLogoutMutation,
} = authApi;
