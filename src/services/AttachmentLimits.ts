import type { AttachmentBuilder } from 'discord.js';

const MiB = 1024 * 1024;
const DEFAULT_UPLOAD_BYTES = 20 * MiB, MAX_OUTPUT_BYTES = 63 * MiB;

/** Preserve Discord's explicit allowance, reserve a margin, and cap local video processing. */
export function attachmentBudget(uploadLimit: unknown = DEFAULT_UPLOAD_BYTES): number {
  if (typeof uploadLimit !== 'number' || !Number.isSafeInteger(uploadLimit) || uploadLimit < 2 * MiB) return 0;
  return Math.min(uploadLimit - MiB, MAX_OUTPUT_BYTES);
}

/** Gateway premiumTier describes server boosts; an author's Nitro status is not a bot upload allowance. */
export function guildAttachmentBudget(premiumTier?: unknown): number {
  return attachmentBudget(premiumTier === 3 ? 100 * MiB : premiumTier === 2 ? 50 * MiB : DEFAULT_UPLOAD_BYTES);
}

export function fitsAttachmentBudget(file: AttachmentBuilder, maxBytes: number): boolean {
  return Number.isSafeInteger(maxBytes) && maxBytes >= MiB && maxBytes <= MAX_OUTPUT_BYTES &&
    Buffer.isBuffer(file.attachment) && file.attachment.length > 0 && file.attachment.length <= maxBytes;
}
