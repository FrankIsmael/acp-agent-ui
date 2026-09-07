/**
 * Un selector de sesión de ACP. El del modelo es uno más: el agente declara
 * sus `configOptions` al crear la sesión y el cliente cambia el que quiera con
 * `session/set_config_option`. Aquí sólo se pintan los de tipo `select`; los
 * booleanos caben en el mismo hueco pero todavía no hay ninguno que enseñar.
 */
import { Check, ChevronDown, Loader2 } from "lucide-react";
import type { ConfigOption } from "~/hooks/useAcpStream";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

interface Value {
  value: string;
  name: string;
  description?: string | null;
}

/**
 * Las opciones vienen planas o agrupadas ("Anthropic", "OpenAI"…). Se aplana
 * conservando el nombre del grupo para pintarlo como encabezado.
 */
function groups(option: ConfigOption): { name: string | null; values: Value[] }[] {
  const raw = (option.options ?? []) as any[];
  if (raw.length === 0) return [];
  if ("group" in raw[0]) {
    return raw.map((g) => ({ name: g.name as string, values: (g.options ?? []) as Value[] }));
  }
  return [{ name: null, values: raw as Value[] }];
}

export function ConfigSelect({
  option,
  busy = false,
  disabled = false,
  onChange,
}: {
  option: ConfigOption;
  busy?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const all = groups(option);
  const current = all.flatMap((g) => g.values).find((v) => v.value === option.currentValue);
  // Un selector de un solo valor no es una decisión: se enseña como etiqueta.
  const only = all.reduce((n, g) => n + g.values.length, 0) <= 1;
  const label = current?.name ?? String(option.currentValue ?? option.name);

  if (only) {
    return (
      <span className="truncate rounded-md px-1.5 py-1 text-xs text-text-tertiary">{label}</span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled || busy}
        aria-label={option.name}
        className="flex max-w-[45vw] items-center gap-1 rounded-md px-1.5 py-1 text-xs text-text-secondary transition-colors hover:bg-background-secondary hover:text-text-primary disabled:opacity-50 data-[state=open]:bg-background-secondary sm:max-w-[16rem]"
      >
        {busy ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        ) : null}
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="max-h-80 w-64 overflow-y-auto">
        {all.map((g, gi) => (
          <div key={g.name ?? gi}>
            {g.name && (
              <>
                {gi > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="text-[11px] text-text-tertiary">
                  {g.name}
                </DropdownMenuLabel>
              </>
            )}
            {g.values.map((v) => (
              <DropdownMenuItem
                key={v.value}
                onSelect={() => v.value !== option.currentValue && onChange(v.value)}
                className="flex-col items-start gap-0.5"
              >
                <span className="flex w-full items-center gap-2">
                  <span className="flex-1 truncate">{v.name}</span>
                  {v.value === option.currentValue && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-text-success" strokeWidth={3} />
                  )}
                </span>
                {v.description && (
                  <span className="line-clamp-2 text-[11px] text-text-tertiary">
                    {v.description}
                  </span>
                )}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
