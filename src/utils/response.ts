import { Response, Request, NextFunction } from 'express';

// ─── Standardized API Response ────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp: string;
}

export function successResponse<T>(data: T, message?: string): ApiResponse<T> {
  return {
    success: true,
    data,
    message,
    timestamp: new Date().toISOString(),
  };
}

export function errorResponse(error: string, message?: string): ApiResponse {
  return {
    success: false,
    error,
    message,
    timestamp: new Date().toISOString(),
  };
}

// ─── Express response helpers ─────────────────────────────────

declare module 'express-serve-static-core' {
  interface Response {
    apiSuccess<T>(data: T, message?: string, status?: number): Response;
    apiError(error: string, message?: string, status?: number): Response;
  }
}

export function extendResponsePrototype(_res: Response): void {
  // These are added via middleware instead
}

export function sendSuccess<T>(res: Response, data: T, message?: string, status = 200): Response {
  return res.status(status).json(successResponse(data, message));
}

export function sendError(res: Response, error: string, message?: string, status = 400): Response {
  return res.status(status).json(errorResponse(error, message));
}
