export interface AuthUser {
  id: number;
  email: string;
  name?: string;
  avatarUrl?: string;
  createdAt: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

export type RegisterPayload = LoginPayload;
