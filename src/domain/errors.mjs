export class EmailMarError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'EmailMarError';
    this.code = code;
    this.status = status;
  }
}

export function fail(code, message, status = 400) {
  throw new EmailMarError(code, message, status);
}

export function requireContext(context) {
  if (!context || !context.tenantId || !context.businessId || !context.actorId) {
    fail('UNAUTHORIZED', 'A trusted tenant, business, and actor context is required.', 401);
  }
  return context;
}

export function requirePermission(context, permission) {
  requireContext(context);
  const permissions = new Set(context.permissions ?? []);
  if (!permissions.has('*') && !permissions.has(permission)) {
    fail('FORBIDDEN', `Permission ${permission} is required.`, 403);
  }
}

export function notFound() {
  fail('NOT_FOUND', 'Resource not found in this tenant and business scope.', 404);
}
