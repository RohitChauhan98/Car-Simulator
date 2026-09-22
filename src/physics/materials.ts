import type { Collider } from '@dimforge/rapier3d-compat';
import type { CollisionMaterial } from '../audio/types';

const byHandle = new Map<number, CollisionMaterial>();

export function tagCollider(collider: Collider, material: CollisionMaterial): void {
  byHandle.set(collider.handle, material);
}

export function colliderMaterial(collider: Collider): CollisionMaterial {
  return byHandle.get(collider.handle) ?? 'dirt';
}

export function untagCollider(handle: number): void {
  byHandle.delete(handle);
}
