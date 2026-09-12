import { randomUUID } from "node:crypto";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface PendingPermission {
  id: string;
  toolCallId: string;
  title: string;
  input?: unknown;
  options: PermissionOption[];
  createdAt: number;
}

type Outcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
type Response = { outcome: Outcome };

export class PermissionQueue {
  private pending = new Map<string, { permission: PendingPermission; resolve: (response: Response) => void }>();
  private changed: (permissions: PendingPermission[]) => void;

  constructor(changed: (permissions: PendingPermission[]) => void) { this.changed = changed; }

  snapshot() { return [...this.pending.values()].map(entry => entry.permission); }

  request(tool: { toolCallId: string; title?: string | null; rawInput?: unknown }, options: PermissionOption[]): Promise<Response> {
    if (!options.length) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const permission: PendingPermission = {
      id: randomUUID(), toolCallId: tool.toolCallId, title: tool.title || "La herramienta solicita permiso",
      input: tool.rawInput, options, createdAt: Date.now(),
    };
    return new Promise(resolve => {
      this.pending.set(permission.id, { permission, resolve });
      this.changed(this.snapshot());
    });
  }

  decide(id: string, optionId: string): "ok" | "missing" | "invalid" {
    const entry = this.pending.get(id);
    if (!entry) return "missing";
    if (!entry.permission.options.some(option => option.optionId === optionId)) return "invalid";
    this.pending.delete(id);
    entry.resolve({ outcome: { outcome: "selected", optionId } });
    this.changed(this.snapshot());
    return "ok";
  }

  cancel() {
    if (!this.pending.size) return;
    for (const entry of this.pending.values()) entry.resolve({ outcome: { outcome: "cancelled" } });
    this.pending.clear();
    this.changed([]);
  }
}
