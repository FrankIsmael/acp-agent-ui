/**
 * Input del chat: textarea que crece, Enter envía y Shift+Enter hace salto de
 * línea. Mientras el agente responde, el botón de enviar se vuelve el de parar.
 *
 * Debajo del textarea va la barra de la sesión: adjuntar imágenes, los
 * selectores que expone el agente (el modelo, entre ellos) y el cwd.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, EyeOff, ImagePlus, Square, X } from "lucide-react";
import { cn } from "~/lib/utils";
import { ConfigSelect } from "~/components/ConfigSelect";
import type { ConfigOption, PromptImage } from "~/hooks/useAcpStream";

const MAX_HEIGHT = 240;
const MAX_IMAGES = 8;

interface Attachment extends PromptImage {
  key: string;
  url: string;
}

/** Del `data:image/png;base64,AAA…` ACP sólo quiere el `AAA…` y el mimeType. */
function readImage(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`No pude leer ${file.name}`));
    reader.onload = () => {
      const url = String(reader.result);
      resolve({
        key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
        name: file.name,
        mimeType: file.type,
        data: url.slice(url.indexOf(",") + 1),
        url,
      });
    };
    reader.readAsDataURL(file);
  });
}

export function ChatInput({
  onSubmit,
  onStop,
  busy = false,
  autoFocus = true,
  placeholder = "Pídele algo al agente…",
  workingDir,
  imageSupport = false,
  configOptions = [],
  visionModels = [],
  configBusy = null,
  onConfigChange,
  disabled = false,
}: {
  onSubmit: (text: string, images?: PromptImage[]) => void;
  onStop?: () => void;
  busy?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  workingDir?: string;
  /** El agente aceptó bloques `image` en el handshake; si no, ni se ofrece. */
  imageSupport?: boolean;
  configOptions?: ConfigOption[];
  /** Los modelos del selector que ven imágenes de verdad. */
  visionModels?: string[];
  configBusy?: string | null;
  onConfigChange?: (configId: string, value: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  // rAF es más confiable que autoFocus cuando el render cruza una frontera async.
  useEffect(() => {
    if (!autoFocus) return;
    const id = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [autoFocus]);

  // Crece con el contenido. Vacío se queda en su altura de una línea: dejarlo
  // en `auto` dentro del flex lo estira a lo alto de la tarjeta.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!value) {
      el.style.height = "";
      return;
    }
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  const addFiles = async (files: FileList | File[] | null) => {
    if (!imageSupport || !files) return;
    const picked = [...files].filter((f) => f.type.startsWith("image/"));
    if (picked.length === 0) return;
    const read = await Promise.all(picked.map(readImage));
    setImages((prev) => [...prev, ...read].slice(0, MAX_IMAGES));
  };

  const submit = () => {
    const text = value.trim();
    // Con imágenes, el texto es opcional: la imagen ya es el mensaje.
    if ((!text && images.length === 0) || busy || disabled) return;
    onSubmit(text, images.map(({ mimeType, data, name }) => ({ mimeType, data, name })));
    setValue("");
    setImages([]);
  };

  const selects = configOptions.filter((o) => (o.type ?? "select") === "select");

  // El agente acepta imágenes aunque el modelo elegido no las vea: en ese caso
  // goose las cambia por "[image omitted: model does not support vision]" y el
  // modelo contesta sobre un texto, sin que nada falle. El aviso existe porque
  // ese fallo es invisible desde el chat.
  const modelOption = configOptions.find((o) => o.category === "model" || o.id === "model");
  const blind =
    images.length > 0 &&
    visionModels.length > 0 &&
    !!modelOption &&
    !visionModels.includes(String(modelOption.currentValue));
  const visionName = (() => {
    const raw = (modelOption?.options ?? []) as any[];
    const flat = raw.length > 0 && "group" in (raw[0] ?? {})
      ? raw.flatMap((g) => g.options ?? [])
      : raw;
    return flat.find((v: any) => v.value === visionModels[0])?.name ?? visionModels[0];
  })();

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-2xl p-3 transition-colors",
        dragging && "bg-background-secondary/60"
      )}
      onDragOver={(e) => {
        if (!imageSupport) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!imageSupport) return;
        e.preventDefault();
        setDragging(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
      {blind && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background-warning/40 px-3 py-2 text-xs text-text-primary">
          <EyeOff className="h-3.5 w-3.5 shrink-0 text-text-warning" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">{modelOption?.name ?? "El modelo"}</span> actual no ve
            imágenes: se enviarán descartadas.
          </span>
          <button
            type="button"
            onClick={() => onConfigChange?.(modelOption!.id, visionModels[0])}
            className="shrink-0 rounded-md border border-border-primary px-2 py-1 font-medium transition-colors hover:bg-background-primary"
          >
            Cambiar a {visionName}
          </button>
        </div>
      )}

      {images.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {images.map((img) => (
            <li key={img.key} className="group relative">
              <img
                src={img.url}
                alt={img.name}
                title={img.name}
                className="h-16 w-16 rounded-lg border border-border-secondary object-cover"
              />
              <button
                type="button"
                aria-label={`Quitar ${img.name}`}
                onClick={() => setImages((prev) => prev.filter((x) => x.key !== img.key))}
                className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-background-inverse text-text-inverse opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
              >
                <X className="h-3 w-3" strokeWidth={3} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <textarea
        ref={ref}
        rows={1}
        value={value}
        placeholder={dragging ? "Suelta la imagen aquí…" : placeholder}
        onChange={(e) => setValue(e.target.value)}
        // Pegar una captura es la forma natural de mandar una imagen: sin esto
        // el Cmd+V no hace nada y hay que pasar por el diálogo de archivos.
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.some((f) => f.type.startsWith("image/"))) {
            e.preventDefault();
            void addFiles(files);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        className="max-h-60 min-h-[24px] w-full flex-none resize-none overflow-y-auto bg-transparent px-1 text-sm leading-6 text-text-primary outline-none placeholder:text-text-tertiary"
      />

      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {imageSupport && (
            <>
              <input
                ref={picker}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                aria-label="Adjuntar imagen"
                title="Adjuntar imagen (o pega una captura)"
                disabled={images.length >= MAX_IMAGES}
                onClick={() => picker.current?.click()}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-secondary hover:text-text-primary disabled:opacity-40"
              >
                <ImagePlus className="h-4 w-4" />
              </button>
            </>
          )}

          {selects.map((option) => (
            <ConfigSelect
              key={option.id}
              option={option}
              busy={configBusy === option.id}
              disabled={busy}
              onChange={(v) => onConfigChange?.(option.id, v)}
            />
          ))}

          {workingDir && (
            <span className="hidden min-w-0 flex-1 truncate pl-1 text-right font-mono text-[11px] text-text-tertiary sm:block">
              {workingDir}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={busy ? onStop : submit}
          disabled={!busy && value.trim().length === 0 && images.length === 0}
          aria-label={busy ? "Detener" : "Enviar"}
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
            busy || value.trim() || images.length > 0
              ? "bg-background-inverse text-text-inverse"
              : "bg-background-disabled text-text-disabled"
          )}
        >
          {busy ? <Square className="h-3 w-3 fill-current" /> : <ArrowUp className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
