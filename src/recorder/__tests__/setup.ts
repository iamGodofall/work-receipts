import { afterEach } from "vitest";

/**
 * Recorder tests run real git processes synchronously. Vitest awaits between
 * tests without returning to the event loop's I/O phase, so a long file can
 * hold back the reply to the worker's progress report until vitest's 60 s RPC
 * timeout fires ("Timeout calling onTaskUpdate"). Yielding one macrotask after
 * each test lets pending replies arrive.
 */
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
