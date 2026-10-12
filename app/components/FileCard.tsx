/**
 * A file the agent delivered (an `eb-file` block, see ~/lib/files): name, type and size, and
 * the cover when the SDK sent one (slides). The link is a presigned URL valid for 7 days.
 */
import { useEffect, useRef, useState } from "react";
import { Download, FileText, Image, Presentation, Sheet } from "lucide-react";
import { useI18n } from "~/i18n";
import { fileLabel, formatSize, type DeliveredFile } from "~/lib/files";

function iconFor(file: DeliveredFile) {
  const label = fileLabel(file);
  if (file.mime.startsWith("image/")) return Image;
  if (["PPTX", "PPT", "KEY"].includes(label)) return Presentation;
  if (["XLSX", "XLS", "CSV"].includes(label)) return Sheet;
  return FileText;
}

export function FileCard({ file }: { file: DeliveredFile }) {
  const { t, locale } = useI18n();
  const Icon = iconFor(file);
  // The cover link expires with the file's (7 days): then the type icon takes its place.
  // An image that failed before hydration never fires onError, so check it once on mount.
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumbRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = thumbRef.current;
    if (img?.complete && img.naturalWidth === 0) setThumbFailed(true);
  }, []);
  const details = [fileLabel(file), file.size !== undefined ? formatSize(file.size, locale) : ""].filter(Boolean).join(" · ");
  return (
    <a
      href={file.url}
      target="_blank"
      rel="noopener noreferrer"
      download={file.name}
      aria-label={t("Download {name}", { name: file.name })}
      className="my-3 flex w-full min-w-0 items-center gap-3 rounded-xl border border-border-secondary bg-background-primary p-4 text-left no-underline shadow-xs transition-colors hover:bg-background-secondary focus-visible:outline-2 focus-visible:outline-border-primary"
    >
      {file.thumb && !thumbFailed ? (
        <img ref={thumbRef} src={file.thumb} alt="" loading="lazy" onError={() => setThumbFailed(true)} className="h-11 w-16 shrink-0 rounded-lg border border-border-secondary object-cover" />
      ) : (
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border-secondary bg-background-secondary">
          <Icon className="h-5 w-5" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text-primary" title={file.name}>{file.name}</span>
        <span className="block text-xs text-text-secondary">{t("Download")}{details && ` · ${details}`}</span>
      </span>
      <Download className="h-4 w-4 shrink-0 text-text-tertiary" />
    </a>
  );
}
