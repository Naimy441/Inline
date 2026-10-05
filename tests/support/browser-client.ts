import { collab, getVersion, receiveTransaction, sendableSteps } from "prosemirror-collab";
import { Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { Step } from "prosemirror-transform";

import { docToMarkdown } from "@/lib/doc/markdown";
import { schema } from "@/lib/doc/schema";
import { StepConflictError, type HubEvent, type LiveDocument } from "@/lib/server/hub";

/**
 * A headless stand-in for the browser editor: the same prosemirror-collab
 * protocol lib/client/documentSession.ts speaks, minus the DOM. It receives
 * the hub's events (what the SSE stream carries) and sends its own steps
 * with the version they're based on, rebasing on conflicts.
 */
export class BrowserClient {
  state: EditorState;
  hunks: unknown[] = [];
  readonly clientID: string;
  private unsubscribe: () => void;
  conflicts = 0;

  constructor(
    readonly live: LiveDocument,
    clientID = `browser-${Math.random().toString(36).slice(2, 8)}`,
  ) {
    this.clientID = clientID;
    const snapshot = live.snapshot();
    this.state = EditorState.create({ doc: PMNode.fromJSON(schema, snapshot.doc), plugins: [collab({ version: snapshot.version, clientID })] });
    this.hunks = snapshot.hunks;
    this.unsubscribe = live.subscribe((event) => {
      if (this.buffer) {
        this.buffer.push(event);
        return;
      }
      this.receive(event);
    });
  }

  /** Events held back while the connection is "slow" (see pause). */
  private buffer: HubEvent[] | null = null;

  /** Simulate network latency: hold incoming events until resume() or a conflict forces a catch-up. */
  pause() {
    this.buffer ??= [];
  }

  resume() {
    const events = this.buffer ?? [];
    this.buffer = null;
    for (const event of events) this.receive(event);
  }

  private receive(event: HubEvent) {
    if (event.type === "steps") {
      const steps = event.steps.map((json) => Step.fromJSON(schema, json));
      this.state = this.state.apply(receiveTransaction(this.state, steps, event.clientIDs, { mapSelectionBackward: true }));
      if (event.hunks) this.hunks = event.hunks;
    } else if (event.type === "hunks") {
      this.hunks = event.hunks;
    }
  }

  get markdown() {
    return docToMarkdown(this.state.doc);
  }

  get version() {
    return getVersion(this.state);
  }

  /** Position just inside the start of the first textblock containing `text`, plus the offset. */
  find(text: string) {
    let found = -1;
    this.state.doc.descendants((node, pos) => {
      if (found >= 0) return false;
      if (node.isText && node.text!.includes(text)) found = pos + node.text!.indexOf(text);
      return true;
    });
    if (found < 0) throw new Error(`"${text}" not in the browser's document`);
    return found;
  }

  /** Type text at a position, locally (not yet sent). */
  type(at: number, text: string) {
    this.state = this.state.apply(this.state.tr.insertText(text, at));
  }

  /** Replace a range locally. */
  replace(from: number, to: number, text: string) {
    this.state = this.state.apply(this.state.tr.insertText(text, from, to));
  }

  select(from: number, to = from) {
    this.state = this.state.apply(this.state.tr.setSelection(TextSelection.create(this.state.doc, from, to)));
    this.live.setSelection({ from, to, version: this.version });
  }

  /** Send unconfirmed steps; on a version conflict the hub's events have already rebased us, so retry. */
  flush(options: { suggest?: boolean } = {}) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const sendable = sendableSteps(this.state);
      if (!sendable) return;
      try {
        this.live.receiveClientSteps(
          sendable.version,
          sendable.steps.map((step) => step.toJSON()),
          String(sendable.clientID),
          options,
        );
        return;
      } catch (error) {
        if (!(error instanceof StepConflictError)) throw error;
        // The server is ahead: catch up on its steps (rebasing ours over them), then resend.
        this.conflicts += 1;
        this.resume();
      }
    }
    throw new Error("Could not sync after 20 attempts");
  }

  close() {
    this.unsubscribe();
  }
}
