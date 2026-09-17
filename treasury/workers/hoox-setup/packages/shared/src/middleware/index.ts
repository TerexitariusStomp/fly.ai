/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Barrel exports for shared middleware
 */

export {
  createLogger,
  withRequestLog,
  type Logger,
  type LogContext,
} from "./logger";
export {
  requireAuth,
  requireOperatorAuth,
  createOperatorAuthMiddleware,
  resolveOperatorApiKey,
  requireInternalAuth,
  createInternalAuthMiddleware,
  checkInternalAuth,
  timingSafeEqual,
  timingSafeEqualAsync,
  collectInternalAuthKeys,
  type InternalAuthEnv,
  type InternalAuthKeyName,
  type OperatorAuthEnv,
} from "./auth";
export {
  createRateLimiter,
  type RateLimiter,
  type RateLimitConfig,
} from "./rate-limit";
export {
  validateJson,
  validateJsonLegacy,
  parseJsonBody,
  requireField,
  optionalField,
  DEFAULT_MAX_JSON_BODY_BYTES,
  type ParseJsonBodyOptions,
} from "./validate";
export { safeWaitUntil, waitUntilAll, type WaitUntilHost } from "./wait-until";
export {
  corsHeaders,
  resolveCorsOptions,
  type CorsEnv,
  publicCorsHeaders,
  internalCorsHeaders,
  handleCorsPreflightRequest,
  type CorsOptions,
} from "./cors";
export {
  secureHeaders,
  wrapWithSecurityHeaders,
  type SecurityHeadersOptions,
  SECURITY_HEADERS_DEFAULTS,
} from "./security-headers";
