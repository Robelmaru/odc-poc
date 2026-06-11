// Helper to read a multipart/form-data request with @fastify/multipart into
// buffered files + string fields. Centralizes the upload handling that the
// analyze / timeline / translate / ai-detect / discovery routes share.
import type { FastifyRequest } from "fastify";

export interface UploadedFile {
  field: string;
  filename: string;
  buffer: Buffer;
  size: number;
}

export async function readMultipart(
  request: FastifyRequest,
): Promise<{ files: UploadedFile[]; fields: Record<string, string> }> {
  const files: UploadedFile[] = [];
  const fields: Record<string, string> = {};
  for await (const part of request.parts()) {
    if (part.type === "file") {
      const buffer = await part.toBuffer();
      files.push({ field: part.fieldname, filename: part.filename, buffer, size: buffer.length });
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  return { files, fields };
}
