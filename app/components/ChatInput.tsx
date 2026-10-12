/**
 * Input del chat: textarea que crece, Enter envía y Shift+Enter hace salto de
 * línea. Mientras el agente responde, el botón de enviar se vuelve el de parar.
 *
 * Debajo del textarea va la barra de la sesión: adjuntar imágenes y documentos, los
 * selectores que expone el agente (el modelo, entre ellos) y el cwd.
 */
import { useI18n } from "~/i18n";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, EyeOff, FileText, ImagePlus, Paperclip, Square, X } from "lucide-react";
import { cn } from "~/lib/utils";
import { ConfigSelect } from "~/components/ConfigSelect";
import type { ConfigOption, PromptImage } from "~/hooks/useAcpStream";
import { MAX_FILE_BYTES, MAX_FILES, MAX_MESSAGE_BYTES, type PromptFile } from "~/lib/attachments";
import { formatSize } from "~/lib/files";

const MAX_HEIGHT = 240;
const MAX_IMAGES = 8;

interface Attachment extends PromptImage {
  key: string;
  url: string;
}

interface AttachedDocument extends PromptFile {
  key: string;
  size: number;
}

/** Un documento, en base64 como las imágenes; el servidor lo sube a la caja del agente. */
function readDocument(file: File): Promise<AttachedDocument> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`No pude leer ${file.name}`));
    reader.onload = () => {
      const url = String(reader.result);
      resolve({
        key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        data: url.slice(url.indexOf(",") + 1),
        size: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
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
  placeholder,
  workingDir,
  imageSupport = false,
  fileSupport = false,
  configOptions = [],
  visionModels = [],
  configBusy = null,
  onConfigChange,
  disabled = false,
}: {
  onSubmit: (text: string, images?: PromptImage[], files?: PromptFile[]) => void;
  onStop?: () => void;
  busy?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  workingDir?: string;
  /** El agente aceptó bloques `image` en el handshake; si no, ni se ofrece. */
  imageSupport?: boolean;
  /** Documentos (PDF, Word, Excel…): el servidor los deja en `adjuntos/` de la conversación. */
  fileSupport?: boolean;
  configOptions?: ConfigOption[];
  /** Los modelos del selector que ven imágenes de verdad. */
  visionModels?: string[];
  configBusy?: string | null;
  onConfigChange?: (configId: string, value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [images, setImages] = useState<Attachment[]>([]);
  const [documents, setDocuments] = useState<AttachedDocument[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const canAttach = imageSupport || fileSupport;

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

  // Una imagen va al modelo si el agente las acepta; si no, y todo lo demás, como documento.
  const addFiles = async (files: FileList | File[] | null) => {
    if (!canAttach || !files) return;
    setNotice(null);
    const all = [...files];
    const asImage = imageSupport ? all.filter((f) => f.type.startsWith("image/")) : [];
    const rest = fileSupport ? all.filter((f) => !asImage.includes(f)) : [];
    const tooBig = rest.filter((f) => f.size > MAX_FILE_BYTES);
    if (tooBig.length > 0) {
      setNotice(t("{name} is larger than {size}.", { name: tooBig.map((f) => f.name).join(", "), size: formatSize(MAX_FILE_BYTES) }));
    }
    let total = documents.reduce((sum, d) => sum + d.size, 0);
    const docs = rest.filter((f) => f.size <= MAX_FILE_BYTES && (total += f.size) <= MAX_MESSAGE_BYTES);
    if (docs.length > 0 && documents.length + docs.length > MAX_FILES) {
      setNotice(t("You can attach up to {count} files per message.", { count: MAX_FILES }));
    }
    if (docs.length < rest.length - tooBig.length) {
      setNotice(t("The files of one message can add up to {size}.", { size: formatSize(MAX_MESSAGE_BYTES) }));
    }
    const [readImages, readDocs] = await Promise.all([
      Promise.all(asImage.map(readImage)),
      Promise.all(docs.map(readDocument)),
    ]);
    if (readImages.length > 0) setImages((prev) => [...prev, ...readImages].slice(0, MAX_IMAGES));
    if (readDocs.length > 0) setDocuments((prev) => [...prev, ...readDocs].slice(0, MAX_FILES));
  };

  const submit = () => {
    const text = value.trim();
    // Con adjuntos, el texto es opcional: el archivo ya es el mensaje.
    if ((!text && images.length === 0 && documents.length === 0) || busy || disabled) return;
    onSubmit(
      text,
      images.map(({ mimeType, data, name }) => ({ mimeType, data, name })),
      documents.map(({ name, mimeType, data }) => ({ name, mimeType, data })),
    );
    setValue("");
    setImages([]);
    setDocuments([]);
    setNotice(null);
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
        if (!canAttach) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!canAttach) return;
        e.preventDefault();
        setDragging(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
      {blind && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background-warning/40 px-3 py-2 text-xs text-text-primary">
          <EyeOff className="h-3.5 w-3.5 shrink-0 text-text-warning" />
          <span className="min-w-0 flex-1">
            {t("The current model cannot view images. Attached images will be omitted.")}
          </span>
          <button
            type="button"
            onClick={() => onConfigChange?.(modelOption!.id, visionModels[0])}
            className="shrink-0 rounded-md border border-border-primary px-2 py-1 font-medium transition-colors hover:bg-background-primary"
          >
            {t("Switch to {model}", { model: visionName })}
          </button>
        </div>
      )}

      {notice && (
        <p role="status" className="px-1 text-xs text-text-warning">
          {notice}
        </p>
      )}

      {documents.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {documents.map((doc) => (
            <li
              key={doc.key}
              className="flex max-w-full items-center gap-2 rounded-lg border border-border-secondary bg-background-secondary py-1.5 pr-1.5 pl-2 text-xs"
            >
              <FileText className="h-4 w-4 shrink-0 text-text-secondary" />
              <span className="min-w-0 truncate font-medium text-text-primary" title={doc.name}>
                {doc.name}
              </span>
              <span className="shrink-0 text-text-tertiary">{formatSize(doc.size)}</span>
              <button
                type="button"
                aria-label={t("Remove {name}", { name: doc.name })}
                onClick={() => setDocuments((prev) => prev.filter((x) => x.key !== doc.key))}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-primary hover:text-text-primary"
              >
                <X className="h-3 w-3" strokeWidth={3} />
              </button>
            </li>
          ))}
        </ul>
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
                aria-label={t("Remove {name}", { name: img.name ?? t("Attached image") })}
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
        placeholder={dragging ? (fileSupport ? t("Drop the file here…") : t("Drop the image here…")) : (placeholder ?? t("Ask the agent something…"))}
        onChange={(e) => setValue(e.target.value)}
        // Pegar una captura es la forma natural de mandar una imagen: sin esto
        // el Cmd+V no hace nada y hay que pasar por el diálogo de archivos.
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (fileSupport ? files.length > 0 : files.some((f) => f.type.startsWith("image/"))) {
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
                aria-label={t("Attach image")}
                title={t("Attach image (or paste a screenshot)")}
                disabled={images.length >= MAX_IMAGES}
                onClick={() => picker.current?.click()}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-secondary hover:text-text-primary disabled:opacity-40"
              >
                <ImagePlus className="h-4 w-4" />
              </button>
            </>
          )}

          {fileSupport && (
            <>
              <input
                ref={filePicker}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                aria-label={t("Attach file")}
                title={t("Attach a document (PDF, Word, Excel…)")}
                disabled={documents.length >= MAX_FILES}
                onClick={() => filePicker.current?.click()}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-secondary hover:text-text-primary disabled:opacity-40"
              >
                <Paperclip className="h-4 w-4" />
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
          disabled={!busy && value.trim().length === 0 && images.length === 0 && documents.length === 0}
          aria-label={busy ? t("Stop") : t("Send")}
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
            busy || value.trim() || images.length > 0 || documents.length > 0
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
