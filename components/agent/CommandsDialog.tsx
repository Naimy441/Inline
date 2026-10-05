"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { BUILTIN_COMMANDS, COMMAND_NAME, mergeCommands, type SlashCommand } from "@/lib/agent/commands";
import { api, Store } from "@/lib/client/api";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";

/** The slash commands, loaded once per page and shared by every composer. */
const commandStore = new Store<SlashCommand[]>(mergeCommands([]));
let loaded = false;

function loadCommands() {
  if (loaded) return;
  loaded = true;
  void api<{ commands: SlashCommand[] }>("/api/agent/commands")
    .then(({ commands }) => commandStore.set(commands))
    .catch(() => {
      loaded = false;
    });
}

export function useCommands() {
  useEffect(loadCommands, []);
  return useSyncExternalStore(commandStore.subscribe, commandStore.get, commandStore.get);
}

type Draft = { name: string; description: string; prompt: string };

/** Add, edit and remove the user's own slash commands. */
export function CommandsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDrafts(commandStore.get().filter((command) => !command.builtin).map(({ name, description, prompt }) => ({ name, description, prompt })));
  }, [open]);

  const update = (index: number, patch: Partial<Draft>) => setDrafts((list) => list.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  const invalid = drafts.find((draft) => !COMMAND_NAME.test(draft.name) || !draft.prompt.trim());

  const save = async () => {
    setSaving(true);
    try {
      const { commands } = await api<{ commands: SlashCommand[] }>("/api/agent/commands", { method: "PUT", json: { commands: drafts } });
      commandStore.set(commands);
      toast("Commands saved.", { tone: "success" });
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't save the commands.", { tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Slash commands"
      description={`Type / in the Claude panel to use one. Built in: ${BUILTIN_COMMANDS.map((command) => `/${command.name}`).join(", ")}. A command of yours with the same name replaces the built-in one.`}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || Boolean(invalid)}>
            Save
          </Button>
        </>
      }
    >
      <div className="commands-editor">
        {drafts.map((draft, index) => (
          <div key={index} className="commands-row">
            <div className="commands-row-head">
              <input
                className="input"
                aria-label="Command name"
                placeholder="name"
                value={draft.name}
                onChange={(event) => update(index, { name: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
              />
              <input className="input" aria-label="Description" placeholder="What it does" value={draft.description} onChange={(event) => update(index, { description: event.target.value })} />
              <IconButton label={`Remove /${draft.name || "command"}`} size="sm" onClick={() => setDrafts((list) => list.filter((_, i) => i !== index))}>
                <Trash2 size={14} />
              </IconButton>
            </div>
            <textarea className="input" aria-label="Prompt" rows={3} placeholder="The prompt Claude receives" value={draft.prompt} onChange={(event) => update(index, { prompt: event.target.value })} />
          </div>
        ))}
        <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => setDrafts((list) => [...list, { name: "", description: "", prompt: "" }])}>
          Add command
        </Button>
        {invalid && <p className="commands-hint">Each command needs a name (lowercase letters, numbers, dashes) and a prompt.</p>}
      </div>
    </Dialog>
  );
}
