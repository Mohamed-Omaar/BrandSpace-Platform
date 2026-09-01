import type { Realm } from './realms';

/** A customer acting inside one workspace. */
export interface CustomerActor {
  readonly kind: 'customer';
  readonly realm: Extract<Realm, 'customer'>;
  readonly userId: string;
  readonly workspaceId: string;
  readonly membershipId: string;
  readonly roleKey: string;
  readonly permissionKeys: readonly string[];
  /** null = all brands; an array restricts the member to those brands. */
  readonly brandScope: readonly string[] | null;
}

/** A platform staff member. Never carries a workspace scope implicitly. */
export interface PlatformActor {
  readonly kind: 'platform';
  readonly realm: Extract<Realm, 'platform'>;
  readonly platformUserId: string;
  readonly roleKey: string;
  readonly permissionKeys: readonly string[];
  readonly mfaVerified: boolean;
}

export type Actor = CustomerActor | PlatformActor;

export function isPlatformActor(a: Actor): a is PlatformActor {
  return a.kind === 'platform';
}

export function isCustomerActor(a: Actor): a is CustomerActor {
  return a.kind === 'customer';
}

export function hasPermission(actor: Actor, permissionKey: string): boolean {
  return actor.permissionKeys.includes(permissionKey);
}
