/** FilePreview — Previews attached files before sending. Images show thumbnails. */

import { useMemo } from "react";

type FilePreviewProps = {
  files: File[];
  onRemove: (index: number) => void;
};

function FilePreview({ files, onRemove }: FilePreviewProps) {
  if (files.length === 0) return null;

  return (
    <div className="file-preview">
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

  const previewUrl = useMemo(() => {
    if (isImage) return URL.createObjectURL(file);
    return null;
  }, [file, isImage]);

  return (
    <div className="file-preview-item">
      {/* Remove button */}
      <button className="file-preview-remove" onClick={onRemove}>
        ✕
      </button>

      {isImage && previewUrl ? (
        <img src={previewUrl} alt={file.name} />
      ) : (
        <span className="file-preview-name">{file.name}</span>
      )}
    </div>
  );
}

export default FilePreview;
