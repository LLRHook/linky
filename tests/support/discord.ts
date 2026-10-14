/**
 * Shared Discord fakes for handler and command tests (FEAT-1791990471).
 *
 * Every factory returns a plain object with the minimum fields the production code reads. Overrides
 * replace defaults property by property (accessors are preserved), so a suite only spells out what
 * its scenario changes. These are test doubles, not discord.js objects: callers cast at the boundary.
 */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Collection, MessageFlagsBitField, MessageType, PermissionsBitField, type APIEmbed, type Attachment } from 'discord.js';
import type { DeliveryDiagnostics } from '../../src/services/DeliveryDiagnostics';
import type { DeliveryOutcome } from '../../src/services/DeliveryContext';

export const TEST_BOT_ID = '1491240385031311470';
export const TEST_USER_ID = '777777777777777777';
export const TEST_CHANNEL_ID = '123456789012345678';
export const TEST_GUILD_ID = '987654321098765432';
export const TEST_SOURCE_ID = '123456789012345679';

type Merged<D, O> = Omit<D, keyof O> & O;

/** Apply overrides onto defaults without invoking getters, so live accessors in overrides survive. */
function merge<D extends object, O extends object>(defaults: D, overrides: O): Merged<D, O> {
  return Object.defineProperties(defaults, Object.getOwnPropertyDescriptors(overrides)) as unknown as Merged<D, O>;
}

// ---------------------------------------------------------------------------------------------
// Forbidden-call recorder
// ---------------------------------------------------------------------------------------------

export interface ForbiddenCalls {
  /** An async callback that records its message and rejects; use for handler dependencies. */
  forbid(message: string): (...args: unknown[]) => Promise<never>;
  /** A synchronous variant for callbacks whose callers do not await. */
  forbidSync(message: string): (...args: unknown[]) => never;
  readonly calls: readonly string[];
  /** Fails if any forbidden callback ran, then clears the record. Call from afterEach. */
  assertNone(): void;
}

/**
 * Repost handlers log and swallow callback errors, so a throwing assertion inside a dependency
 * cannot fail a test on its own. Forbidden callbacks still throw (preserving the production path)
 * and are also recorded; `assertNone()` in an afterEach hook turns any recorded call into a failure.
 */
export function createForbidden(): ForbiddenCalls {
  const calls: string[] = [];
  const record = (message: string) => { calls.push(message); return new Error(message); };
  return {
    calls,
    forbid: message => async () => { throw record(message); },
    forbidSync: message => () => { throw record(message); },
    assertNone: () => assert.deepEqual(calls.splice(0), []),
  };
}

// ---------------------------------------------------------------------------------------------
// Repost source message and its sendable channel
// ---------------------------------------------------------------------------------------------

/** A guild text channel where Linky holds every permission unless a test removes one. */
export function sendableChannel<O extends object>(overrides: O) {
  return merge({
    isSendable: (): boolean => true, isThread: (): boolean => false,
    permissionsFor: (): PermissionsBitField => new PermissionsBitField(PermissionsBitField.All),
  }, overrides);
}

/** An ordinary, unedited, deletable member message eligible for automatic reposting. */
export function repostSource<O extends { channel: object }>(overrides: O) {
  const defaults = {
    id: TEST_SOURCE_ID, channelId: TEST_CHANNEL_ID, guildId: TEST_GUILD_ID, content: '',
    author: { id: TEST_USER_ID, bot: false },
    guild: { members: { me: { id: TEST_BOT_ID } } },
    partial: false, webhookId: null as string | null, type: MessageType.Default,
    poll: null as unknown, pinned: false, hasThread: false, editedTimestamp: null as number | null,
    stickers: new Collection<string, unknown>(), components: [] as unknown[],
    messageSnapshots: new Collection<string, unknown>(),
    flags: new MessageFlagsBitField(), attachments: new Collection<string, Attachment>(),
    reference: null as { messageId: string; channelId?: string; guildId?: string } | null,
    mentions: { repliedUser: null as { id: string } | null, users: new Collection<string, { id: string }>() },
    deletable: true, inGuild: (): boolean => true,
    fetch: async (_force?: boolean): Promise<unknown> => source,
    delete: async (): Promise<void> => {},
  };
  const source = merge(defaults, overrides);
  return source;
}

/** A message Linky sent (replacement, progress or notice) that it may edit, fetch and delete. */
export function botMessage<O extends object>(overrides: O) {
  const message = merge({
    id: '123456789012345680', channelId: TEST_CHANNEL_ID, author: { id: TEST_BOT_ID, bot: true }, content: '',
    attachments: new Collection<string, Attachment>(), embeds: [] as { toJSON(): APIEmbed }[],
    fetch: async (): Promise<unknown> => message,
    edit: async (_payload: unknown): Promise<unknown> => message,
    delete: async (): Promise<void> => {},
  }, overrides);
  return message;
}

// ---------------------------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------------------------

/** One recorded interaction response call, in call order. */
export interface InteractionEvent<P = any> { name: string; payload?: P }

/** A guild command interaction whose responses are appended to `events`. */
export function commandInteraction<P = any, O extends object = object>(events: InteractionEvent<P>[], overrides: O) {
  return merge({
    guildId: TEST_GUILD_ID as string | null, channelId: TEST_CHANNEL_ID, user: { id: TEST_USER_ID },
    inGuild(): boolean { return this.guildId !== null; },
    reply: async (payload: P): Promise<unknown> => { events.push({ name: 'reply', payload }); return undefined; },
    deferReply: async (payload: P): Promise<unknown> => { events.push({ name: 'defer', payload }); return undefined; },
    editReply: async (payload: P): Promise<unknown> => { events.push({ name: 'edit', payload }); return undefined; },
  }, overrides);
}

/** A guild button interaction on a Linky message whose responses are appended to `events`. */
export function buttonInteraction<P = any, O extends object = object>(events: InteractionEvent<P>[], overrides: O) {
  return merge({
    customId: '', inGuild: (): boolean => true, user: { id: TEST_USER_ID },
    client: { user: { id: TEST_BOT_ID } }, applicationId: TEST_BOT_ID,
    memberPermissions: new PermissionsBitField(0n),
    reply: async (payload: P): Promise<unknown> => { events.push({ name: 'reply', payload }); return undefined; },
    deferUpdate: async (): Promise<unknown> => { events.push({ name: 'defer' }); return undefined; },
    deleteReply: async (): Promise<unknown> => { events.push({ name: 'delete' }); return undefined; },
  }, overrides);
}

// ---------------------------------------------------------------------------------------------
// Delivery diagnostics
// ---------------------------------------------------------------------------------------------

/** A diagnostics recorder that captures finished outcomes and chosen paths without persisting. */
export function diagnosticsStub({ id = 'attempt', outcomes, paths, bind = async () => false }: {
  id?: string; outcomes?: DeliveryOutcome[]; paths?: string[];
  bind?: (id: string, messageId: string) => Promise<boolean>;
} = {}): DeliveryDiagnostics {
  return {
    begin: () => ({ id, setPath: (path: string) => { paths?.push(path); }, startStage: () => ({ finish() {} }),
      finish: (outcome: DeliveryOutcome) => { outcomes?.push(outcome); } }),
    bind,
  } as unknown as DeliveryDiagnostics;
}

// ---------------------------------------------------------------------------------------------
// Deterministic clock
// ---------------------------------------------------------------------------------------------

/**
 * Mocks setTimeout and performance.now together, so delays computed from performance.now
 * (DeliveryProgress) fire at exact millisecond boundaries regardless of machine speed.
 */
export function mockClock(t: TestContext) {
  // An integral start keeps `deadline - now` exact; a fractional one can round 500 ms to 500.0000001.
  let now = Math.ceil(performance.now());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => now);
  return {
    /** Settle pending work, advance virtual time by `ms`, then settle the callbacks that fired. */
    async advance(ms: number): Promise<void> {
      await nextTurn();
      now += ms;
      t.mock.timers.tick(ms);
      await nextTurn();
    },
    /**
     * Drives virtual time until `work` settles (bounded), so cleanup after a failed assertion
     * cannot hang on work that is waiting for a mocked timer.
     */
    async settle<T>(work: Promise<T>, { stepMs = 1_000, maxMs = 600_000 } = {}): Promise<T> {
      let settled = false;
      work.then(() => { settled = true; }, () => { settled = true; });
      // Let ordinary async work finish without moving time; only stalled work sees virtual time pass.
      for (let turn = 0; turn < 20 && !settled; turn++) await nextTurn();
      for (let elapsed = 0; !settled && elapsed < maxMs; elapsed += stepMs) await this.advance(stepMs);
      if (!settled) throw new Error(`Work did not settle within ${maxMs} ms of virtual time`);
      return work;
    },
  };
}

/** Waits for `signal`, failing instead of hanging if `work` finishes first without raising it. */
export async function reached(signal: Promise<unknown>, work: Promise<unknown>, what: string): Promise<void> {
  await Promise.race([signal, work.then(() => assert.fail(`${what} was never reached`))]);
}

/** A promise a test resolves explicitly, for holding work at a chosen point. */
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
