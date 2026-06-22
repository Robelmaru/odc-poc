// Chunked-upload assembly store. Large productions (hundreds of MB) can't be
// uploaded in a single request — the external load balancer times out the slow
// transfer (~60s). The client instead uploads the file in small chunks (each a
// short request), which we append to a temp file on disk here; a later /process
// call reads the assembled file. Keeps peak memory low (one chunk at a time) and
// every HTTP request short.
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const ROOT = path.join(os.tmpdir(), "odc-timeline-uploads");

// Reject anything that isn't a plain id token — these compose into filesystem
// paths, so this is the guard against path traversal.
function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid upload id");
  return id;
}

// Collapse a client-supplied filename to a safe basename (no separators, no ..).
function safeName(name: string): string {
  const base = path
    .basename(name)
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .slice(0, 200);
  return base && base !== "." && base !== ".." ? base : "upload.bin";
}

function filePathFor(uploadId: string, filename: string): string {
  return path.join(ROOT, safeId(uploadId), safeName(filename));
}

/**
 * Append (or, for chunk index 0, create/truncate) a chunk to the upload's temp
 * file. Index 0 starts fresh so a retried upload with the same id is clean.
 * Returns the file's size so far. Chunks must be sent in order.
 */
export async function appendChunk(
  uploadId: string,
  filename: string,
  buffer: Buffer,
  index: number,
): Promise<number> {
  const p = filePathFor(uploadId, filename);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  if (index <= 0) await fsp.writeFile(p, buffer);
  else await fsp.appendFile(p, buffer);
  const st = await fsp.stat(p);
  return st.size;
}

/** Read a fully-assembled upload into a buffer for processing. */
export async function readUpload(uploadId: string, filename: string): Promise<Buffer> {
  return fsp.readFile(filePathFor(uploadId, filename));
}

/** Remove an upload's temp directory. Best-effort. */
export async function cleanupUpload(uploadId: string): Promise<void> {
  try {
    await fsp.rm(path.join(ROOT, safeId(uploadId)), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Best-effort sweep of upload dirs older than maxAgeMs — reclaims disk from
 * uploads that were started but never processed (browser closed, etc.).
 */
export async function sweepOldUploads(maxAgeMs = 6 * 60 * 60 * 1000): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;
  try {
    for (const entry of await fsp.readdir(ROOT)) {
      const p = path.join(ROOT, entry);
      try {
        const st = await fsp.stat(p);
        if (st.mtimeMs < cutoff) await fsp.rm(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ROOT may not exist yet */
  }
}
