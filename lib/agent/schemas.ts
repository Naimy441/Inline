import { z } from "zod";

/** Request validation for the chat API. */

export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const SettingsPatchSchema = z
  .object({
    model: z.string().max(120).nullable().optional(),
    effort: EffortSchema.optional(),
    mode: z.enum(["agent", "ask"]).optional(),
    maxTurns: z.number().int().min(1).max(1000).nullable().optional(),
    maxBudgetUsd: z.number().min(0.01).max(1000).nullable().optional(),
  })
  .strict();

export const SelectionSchema = z.object({
  documentId: z.string().max(80),
  text: z.string().max(100_000),
  from: z.number().int().min(0),
  to: z.number().int().min(0),
});

export const AttachmentSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  name: z.string().max(300),
  mime: z.string().max(120),
  size: z.number().int().min(0),
  kind: z.enum(["image", "text", "pdf"]),
});

/** Ids the panel picks for things it shows before the server answers. */
export const ClientIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);

export const SendSchema = z.object({
  text: z.string().max(200_000),
  documentId: z.string().max(80).nullable().optional(),
  selection: SelectionSchema.optional(),
  attachments: z.array(AttachmentSchema).max(10).optional(),
  mentions: z.array(z.object({ id: z.string().max(80), title: z.string().max(300) })).max(20).optional(),
  ids: z.object({ user: ClientIdSchema, assistant: ClientIdSchema }).optional(),
});
