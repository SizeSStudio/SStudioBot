// React on top of the store: useSyncExternalStore on one version key, then a memo on that version, so a component
// re-renders only when the rows it selected changed (07 「store」).
import { useMemo, useSyncExternalStore } from "react";
import type { EntityName } from "../../../../protocol/api/entities.ts";
import type { Live, Rec, Store, TimelineRow } from "./store.ts";
import type { Writes } from "../conn/writes.ts";

function useVersion(store: Store, key: string): number {
  return useSyncExternalStore(store.subscribe, () => store.version(key), () => store.version(key));
}

export function useEntity<E extends EntityName>(store: Store, entity: E, id: string | undefined): Rec<E> | undefined {
  const v = useVersion(store, `row:${entity}:${id ?? ""}`);
  return useMemo(() => (id ? store.get(entity, id) : undefined), [store, entity, id, v]);
}

export function useList<E extends EntityName>(store: Store, entity: E, filter?: (r: Rec<E>) => boolean): Rec<E>[] {
  const v = useVersion(store, `entity:${entity}`);
  return useMemo(() => (filter ? store.list(entity).filter(filter) : store.list(entity)), [store, entity, v]);
}

export function useTimeline(store: Store, lane: string | undefined): { rows: TimelineRow[]; live: Live[] } {
  const v = useVersion(store, `lane:${lane ?? ""}`);
  return useMemo(() => (lane ? { rows: store.timeline(lane), live: store.liveOn(lane) } : { rows: [], live: [] }), [store, lane, v]);
}

/** Re-render when the write layer changes (an op sent, answered, refused); `pick` reads what this component needs
 * (run on every render: it's a scan of a few in-flight ops). */
export function useWrites<T>(writes: Writes, pick: (w: Writes) => T): T {
  useSyncExternalStore(writes.subscribe, writes.version, writes.version);
  return pick(writes);
}
