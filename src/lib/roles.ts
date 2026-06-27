export type Role = "admin" | "operator" | "viewer";

const ROLE_RANK: Record<Role, number> = { admin: 3, operator: 2, viewer: 1 };

const userRoles = new Map<string, Role>();

export function assignRole(userId: string, role: Role): void {
  userRoles.set(userId, role);
}

export function removeRole(userId: string): boolean {
  return userRoles.delete(userId);
}

export function getRole(userId: string): Role | undefined {
  return userRoles.get(userId);
}

export function listRoles(): Array<{ userId: string; role: Role }> {
  return Array.from(userRoles.entries()).map(([userId, role]) => ({ userId, role }));
}

export function hasPermission(userId: string, required: Role): boolean {
  const role = userRoles.get(userId);
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[required];
}
