import { useState } from "react";
import type { PendingPermission } from "~/.server/permissions";

const labels = {
  allow_once: "Permitir una vez", allow_always: "Permitir siempre",
  reject_once: "Rechazar una vez", reject_always: "Rechazar siempre",
};

export function PermissionCard({ permission, conversationId, connected }: {
  permission: PendingPermission; conversationId: string; connected: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(optionId: string) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/permissions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissionId: permission.id, optionId }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "No pude enviar la decisión");
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "No pude enviar la decisión");
    } finally { setSaving(false); }
  }

  return (
    <section aria-label="Permiso pendiente" className="rounded-xl border border-border-primary bg-background-secondary p-4">
      <p className="text-xs text-text-secondary" role="status">Esperando tu permiso</p>
      <h3 className="mt-1 break-words text-sm font-medium">{permission.title}</h3>
      {permission.input != null && <details className="mt-2 text-xs text-text-secondary">
        <summary className="cursor-pointer">Ver detalles de la operación</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(permission.input, null, 2)}</pre>
      </details>}
      <div className="mt-3 flex flex-wrap gap-2">
        {permission.options.map(option => (
          <button key={option.optionId} disabled={saving || !connected} onClick={() => void decide(option.optionId)}
            title={option.name}
            className="rounded-lg border border-border-primary bg-background-primary px-3 py-2 text-sm hover:bg-background-secondary disabled:opacity-50">
            {labels[option.kind] ?? option.name}
          </button>
        ))}
      </div>
      {permission.options.some(option => option.kind.endsWith("_always")) && (
        <p className="mt-2 text-xs text-text-secondary">«Siempre» recuerda esta decisión según las reglas del agente.</p>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-text-danger">{error}</p>}
    </section>
  );
}
