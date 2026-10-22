/** Actions shared by the data views' menus and the inspector. */

import { copy, toast } from '../../store';
import type { DataClient } from '../../worker/client';

/** Copies a node's value; one over `limit` characters is refused (pointing to Export) rather than cut off. */
export async function copyValue(client: DataClient, id: number, limit = 20_000_000): Promise<void> {
  try {
    const d = await client.call('detail', { id, maxChars: limit });
    if (d.valueTruncated) return toast(`This value is larger than ${Math.round(limit / 1_000_000)} MB, too big for the clipboard: use Export to save it instead.`, 'error');
    await copy(d.value, 'Value copied');
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}
