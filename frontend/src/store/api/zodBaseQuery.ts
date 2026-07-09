import { fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { BaseQueryFn, FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query/react';
import type { z } from 'zod';

export const apiBaseUrl = '/api';

// credentials: 'include' is required for HttpOnly auth cookies to be sent
const rawBaseQuery = fetchBaseQuery({ baseUrl: apiBaseUrl, credentials: 'include' });

/** Unwraps `{ success, data, error }` envelope + optional Zod schema validation */
export const zodBaseQuery: BaseQueryFn<
  string | FetchArgs,
  unknown,
  FetchBaseQueryError,
  { dataSchema?: z.ZodTypeAny }
> = async (args, api, extraOptions) => {
  const result = await rawBaseQuery(args, api, extraOptions);

  if (result.error) return result;

  const envelope = result.data as { success: boolean; data: unknown; error?: string };
  if (!envelope.success) {
    return {
      error: {
        status: 'CUSTOM_ERROR',
        error: envelope.error ?? 'Unknown server error',
      } as FetchBaseQueryError,
    };
  }

  const payload = envelope.data;

  // Optional Zod validation — parse if schema provided
  const schema = extraOptions?.dataSchema;
  if (schema) {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      console.warn('[zodBaseQuery] Schema validation failed:', parsed.error.flatten());
      // Return data anyway (non-blocking) — log but don't crash
    }
  }

  return { data: payload };
};
