import { ConsoleClient } from '@richardblaha/osiris-protocol';

/** Same-origin client — the console is served by osiris-server itself. */
export const client = new ConsoleClient({ baseUrl: '' });
