export type UserRole = "owner" | "admin" | "developer" | "viewer";

export const RoleHierarchy: Record<UserRole, number> = {
  viewer: 1,
  developer: 2,
  admin: 3,
  owner: 4,
};

export function hasPermission(userRole: UserRole, requiredRole: UserRole): boolean {
  return RoleHierarchy[userRole] >= RoleHierarchy[requiredRole];
}

export function assertPermission(userRole: UserRole, requiredRole: UserRole): void {
  if (!hasPermission(userRole, requiredRole)) {
    throw new Error(`Forbidden: requires role '${requiredRole}' or higher, but you have '${userRole}'`);
  }
}
