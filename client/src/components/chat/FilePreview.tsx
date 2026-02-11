/**
 * FilePreview — Mesaj göndermeden önce eklenen dosyaların önizlemesi.
 *
 * Resimler thumbnail olarak gösterilir.
 * Diğer dosyalar icon + isim + boyut olarak gösterilir.
 * X butonuyla dosya listeden çıkarılabilir.
 */

import { useMemo } from "react";

type FilePreviewProps = {
  files: File[];
  onRemove: (index: number) => void;
};

function FilePreview({ files, onRemove }: FilePreviewProps) {
  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 border-b border-background-tertiary px-4 py-3">
      {files.map((file, index) => (
        <FilePreviewItem key={index} file={file} onRemove={() => onRemove(index)} />
      ))}
    </div>
  );
}

type FilePreviewItemProps = {
  file: File;
  onRemove: () => void;
};

function FilePreviewItem({ file, onRemove }: FilePreviewItemProps) {
  const isImage = file.type.startsWith("image/");

  /** Resim dosyaları için object URL oluştur (thumbnail gösterimi) */
  const previewUrl = useMemo(() => {
    if (isImage) return URL.createObjectURL(file);
    return null;
  }, [file, isImage]);

  return (
    <div className="group relative rounded-md bg-background-secondary p-2">
      {/* Remove button */}
      <button
        onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-danger text-xs text-white opacity-0 transition-opacity group-hover:opacity-100"
      >
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {isImage && previewUrl ? (
        <img
          src={previewUrl}
          alt={file.name}
          className="h-20 w-20 rounded-md object-cover"
        />
      ) : (
        <div className="flex h-20 w-20 flex-col items-center justify-center gap-1">
          <svg
            className="h-8 w-8 text-text-muted"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
            />
          </svg>
          <span className="max-w-full truncate px-1 text-[10px] text-text-muted">
            {file.name}
          </span>
        </div>
      )}
    </div>
  );
}

export default FilePreview;
