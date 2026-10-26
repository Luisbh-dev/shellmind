// File manager protocol (the files-* socket events): every request carries a
// socket.io acknowledgement that answers exactly that request with a typed
// FileResult, so replies can never be confused with another operation's.
// Paths are absolute POSIX paths ("/srv/app/x.conf"); for S3 the first segment
// after "/" is the first segment of the object key.

export type FileProtocol = "sftp" | "ftp" | "s3";

// How the file session reaches the server. Plain FTP and http:// S3 endpoints
// send credentials and data in clear text (`secure: false`).
export type FileTransport = "ssh" | "ftp" | "ftps" | "ftps-implicit" | "https" | "http";

export type FileSessionInfo = {
    protocol: FileProtocol;
    transport: FileTransport;
    secure: boolean;
    // Where browsing starts: the login directory (SFTP/FTP) or the bucket root.
    home: string;
    // Largest file the editor may open.
    maxEditBytes: number;
};

export type FileStat = {
    isDir: boolean;
    // A symbolic link; isDir/size describe its target when it could be resolved.
    isLink: boolean;
    size: number;
    // Seconds since the epoch; 0 when unknown.
    mtime: number;
    // POSIX mode bits; 0 when unknown.
    permissions: number;
};

export type FileEntry = FileStat & { name: string };

// A listed entry an operation applies to. S3 needs `isDir`: "a" can be both an
// object and a prefix. A link is removed itself, never what it points to.
export type FileItemRef = { path: string; isDir: boolean; isLink?: boolean };

export const FILE_ERROR_CODES = [
    "NOT_CONNECTED",
    "NOT_FOUND",
    "PERMISSION_DENIED",
    "EXISTS",
    "NOT_EMPTY",
    "NOT_A_FILE",
    "NOT_A_DIRECTORY",
    "TOO_LARGE",
    "CONFLICT",
    "INVALID",
    "CANCELLED",
    "TIMEOUT",
    "PARTIAL",
    "UNSUPPORTED",
    // Every connection the server allows is busy with another transfer: try
    // again once one of them ended.
    "BUSY",
    // The file can only be replaced by overwriting it in place (its folder is
    // not writable), which an interrupted upload would leave damaged: send
    // the upload again with `inPlace: true` to accept that.
    "NOT_ATOMIC",
    "FAILED"
] as const;
export type FileErrorCode = typeof FILE_ERROR_CODES[number];

export type FileFailure = { path: string; message: string };

export type FileError = {
    code: FileErrorCode;
    message: string;
    // CONFLICT: what the file looks like on the server now (null: it is gone).
    current?: FileStat | null;
    // PARTIAL: the items that failed (the first ones, see failureCount).
    failures?: FileFailure[];
    failureCount?: number;
};

export type FileResult<T> = { ok: true; data: T } | { ok: false; error: FileError };
export type FileReply<T> = (result: FileResult<T>) => void;

// Raw bytes on the wire: socket.io carries them as binary attachments. Node
// receives a Buffer (a Uint8Array), browsers an ArrayBuffer.
export type FileBytes = ArrayBuffer | Uint8Array;

// The size and modification time a client last saw, to detect that someone
// else changed the file in between.
export type FileVersion = { size: number; mtime: number };

export type ListRequest = { path: string };
export type ListResult = {
    path: string;
    entries: FileEntry[];
    // More entries exist than a listing returns (see MAX_LIST_ENTRIES).
    truncated: boolean;
};

export type StatRequest = { path: string };
export type StatResult = { path: string; stat: FileStat | null };

export type ReadRequest = { path: string; maxBytes?: number };
export type ReadResult = { path: string; data: FileBytes; stat: FileStat };

// `expected` set: refuse with CONFLICT when the file changed (or disappeared)
// since that version, unless `force`. A new file needs `expected: null`; it is
// refused with EXISTS when the path is taken (again unless `force`).
export type WriteRequest = { path: string; data: FileBytes; expected?: FileVersion | null; force?: boolean };
export type WriteResult = { path: string; stat: FileStat | null };

export type MkdirRequest = { path: string };
export type PathResult = { path: string };

// Renames or moves; refused with EXISTS when the target exists.
export type RenameRequest = { from: string; to: string; isDir: boolean };
export type RenameResult = { from: string; to: string };

// Folders are deleted with everything inside them.
export type DeleteRequest = { items: FileItemRef[] };
export type DeleteResult = { deleted: number; failures: FileFailure[]; failureCount: number };

// What a delete would remove: the items plus everything inside the folders.
export type CountRequest = { items: FileItemRef[] };
export type CountResult = { files: number; dirs: number; bytes: number; truncated: boolean };

// Uploads: start -> chunk* (several in flight, each acknowledged once written)
// -> end, or cancel. Data goes to a temporary file that `end` moves into place,
// so a failed or cancelled upload never leaves a partial target behind.
// `inPlace`: the user accepted overwriting the target directly when no
// temporary file can be created next to it (see NOT_ATOMIC).
export type UploadStartRequest = { path: string; size: number; overwrite: boolean; inPlace?: boolean };
export type UploadStartResult = { transferId: string; chunkSize: number; window: number };
export type UploadChunkRequest = { transferId: string; seq: number; data: FileBytes };
export type UploadChunkResult = { seq: number; received: number };
export type TransferRequest = { transferId: string };
export type UploadEndResult = { path: string; size: number };

// Downloads: start, then the server pushes chunks; the client acknowledges
// each one and the server keeps at most `window` unacknowledged chunks in
// flight. It ends with files-download-end or files-download-error.
export type DownloadStartRequest = { path: string };
export type DownloadStartResult = { transferId: string; size: number | null; window: number };
export type DownloadChunk = { transferId: string; seq: number; data: FileBytes };
export type DownloadAck = { transferId: string; seq: number };
export type DownloadEnd = { transferId: string; bytes: number };
export type DownloadFailure = { transferId: string; error: FileError };

export const FILE_CHUNK_BYTES = 256 * 1024;
// Chunks an upload keeps in flight: 2 MiB, what an SSH channel window (and
// so an SFTP upload per round trip) holds.
export const UPLOAD_WINDOW = 8;
export const DOWNLOAD_WINDOW = 8;
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
export const MAX_LIST_ENTRIES = 50_000;
// Either side abandons a transfer that saw no progress for this long.
export const TRANSFER_IDLE_MS = 60_000;
