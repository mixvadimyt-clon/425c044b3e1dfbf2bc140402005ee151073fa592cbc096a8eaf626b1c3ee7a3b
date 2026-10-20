import type { ObjectPatch } from '@/api/projects';
import type { Project } from '@/shared/projects';

// Пустая строка означает «стереть значение»: api ждёт null, а не «»
const orNull = (value: string): string | null => (value.trim() ? value : null);

/** В тело PATCH попадают только тронутые поля; `Project.developer` / `permit` переименованы под контракт (`customer` / `permit_number`). */
export const toObjectPatch = (patch: Partial<Omit<Project, 'id'>>): ObjectPatch => ({
  ...(patch.name !== undefined ? { name: patch.name } : {}),
  ...(patch.address !== undefined ? { address: orNull(patch.address) } : {}),
  ...(patch.developer !== undefined ? { customer: orNull(patch.developer) } : {}),
  ...(patch.contractor !== undefined ? { contractor: orNull(patch.contractor) } : {}),
  ...(patch.permit !== undefined ? { permit_number: orNull(patch.permit) } : {}),
});
