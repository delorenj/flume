import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** Nonblocking open and descriptor checks also bound replaced or growing inputs. */
export function readAuditText(path, limit = 1024 * 1024) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Audit input is not a regular file");
    if (!(stat.mode & 0o444)) throw new Error("Audit input has no read permission");
    if (stat.size > limit) throw new Error(`Audit input exceeds ${limit} bytes`);
    const bytes = Buffer.alloc(limit + 1);
    let length = 0, count;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > limit) throw new Error(`Audit input exceeds ${limit} bytes`);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } finally { closeSync(fd); }
}
