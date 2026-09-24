// "The file" in a picture's details (CONTEXT.md "File metadata"): what the
// file is (format, size, hash, who brought it in, what it came from), and
// everything it carries about itself, grouped the way cameras write it.
// Read from the server only when opened: most people never open it, and the
// first read of a picture parses its original.
import type { ImageMetadata, MetadataGroupName } from '@digsite/shared/api';
import { useState } from 'react';
import { ApiError, api } from '../lib/api.ts';
import { bytesLabel } from '../lib/bytes.ts';
import './file-facts.css';

const GROUP_TITLES: Record<MetadataGroupName, string> = {
  ifd0: 'Camera and software',
  exif: 'Exposure',
  gps: 'Place',
  iptc: 'Caption and rights',
  xmp: 'XMP',
  jfif: 'JPEG',
  ihdr: 'PNG',
};

/** "ExposureTime" reads as "Exposure time". */
export function fieldLabel(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function FileFacts({ imageId }: { imageId: string }) {
  const [meta, setMeta] = useState<ImageMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    if (meta || error) return;
    try {
      setMeta(await api.imageMetadata(imageId));
    } catch (err) {
      setError(err instanceof ApiError ? err.reason : String(err));
    }
  }

  const groups = meta
    ? (Object.entries(meta.groups) as [
        MetadataGroupName,
        Record<string, unknown>,
      ][])
    : [];
  const fields = groups.reduce((n, [, g]) => n + Object.keys(g).length, 0);

  return (
    <details
      className="file-facts"
      data-testid="file-facts"
      onToggle={(e) => {
        if (e.currentTarget.open) void load();
      }}
    >
      <summary>The file</summary>
      {error && <p className="file-facts-note">{error}</p>}
      {!meta && !error && <p className="file-facts-note">Reading the file…</p>}
      {meta && (
        <>
          <dl className="file-facts-list">
            <dt>Format</dt>
            <dd>
              {meta.file.format ? meta.file.format.toUpperCase() : 'Unknown'}
              {meta.file.bytes !== null && ` · ${bytesLabel(meta.file.bytes)}`}
              {` · ${meta.file.width} × ${meta.file.height} px`}
            </dd>
            {meta.file.source && (
              <>
                <dt>Came in as</dt>
                <dd>
                  <a href={api.sourceUrl(imageId)} download>
                    {meta.file.source.format} (
                    {bytesLabel(meta.file.source.bytes)})
                  </a>
                </dd>
              </>
            )}
            {meta.file.derivedFrom && (
              <>
                <dt>Cut from</dt>
                <dd>{meta.file.derivedFrom}</dd>
              </>
            )}
            <dt>Added</dt>
            <dd>
              {when(meta.file.uploadedAt)}
              {meta.file.uploadedBy && ` by ${meta.file.uploadedBy}`}
            </dd>
            <dt>SHA-256</dt>
            <dd className="file-facts-hash">
              <code data-testid="file-facts-sha256">{meta.file.sha256}</code>
              <button
                type="button"
                className="board-quiet-button"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(meta.file.sha256)
                    .then(() => setCopied(true));
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </dd>
          </dl>
          {fields === 0 ? (
            <p className="file-facts-note">
              The file carries no camera, place or caption data.
            </p>
          ) : (
            groups.map(([name, group]) => (
              <details
                className="file-facts-group"
                key={name}
                data-testid={`file-facts-${name}`}
              >
                <summary>
                  {GROUP_TITLES[name]}{' '}
                  <span className="file-facts-count">
                    {Object.keys(group).length}
                  </span>
                </summary>
                <dl className="file-facts-list">
                  {Object.entries(group).map(([key, value]) => (
                    <div key={key} className="file-facts-row">
                      <dt title={key}>{fieldLabel(key)}</dt>
                      <dd>{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            ))
          )}
        </>
      )}
    </details>
  );
}
