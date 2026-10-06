"use client";

import { useSyncExternalStore } from "react";
import { Store } from "@/lib/client/api";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";

type Request = { title: string; body?: string; confirmLabel?: string; danger?: boolean; resolve: (ok: boolean) => void };

const store = new Store<Request | null>(null);

/** An in-app replacement for window.confirm: resolves true when the user confirms. */
export function confirmDialog(options: Omit<Request, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    store.get()?.resolve(false);
    store.set({ ...options, resolve });
  });
}

function settle(ok: boolean) {
  const request = store.get();
  store.set(null);
  request?.resolve(ok);
}

/** Renders the open confirmation; mounted once per page. */
export function ConfirmHost() {
  const request = useSyncExternalStore(store.subscribe, store.get, () => null);
  return (
    <Dialog
      open={request !== null}
      onClose={() => settle(false)}
      title={request?.title ?? ""}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={() => settle(false)}>
            Cancel
          </Button>
          <Button variant={request?.danger ? "danger" : "primary"} onClick={() => settle(true)}>
            {request?.confirmLabel ?? "OK"}
          </Button>
        </>
      }
    >
      {request?.body && <p>{request.body}</p>}
    </Dialog>
  );
}
