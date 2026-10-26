import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { createHash } from "crypto";
import type { SFTPWrapper } from "ssh2";
import type { FtpTarget, S3Target } from "../connections/target";
import { dbGet } from "../db/sqlite";
import { errorMessage } from "../errors";
import { createLogger } from "../logger";
import { FtpFs, type FtpSecurity } from "./ftpFs";
import { S3Fs } from "./s3Fs";
import { SftpFs } from "./sftpFs";

// Builds the RemoteFs of a file or FTP-shell session from its connection target.

const log = createLogger("files");

// The servers.ftp_secure column (FTPS): 1/true/"explicit" = explicit TLS,
// 2/"implicit" = implicit TLS, anything else plain FTP.
export function parseFtpSecurity(value: unknown): FtpSecurity {
    if (value === 2 || value === "2" || value === "implicit") return "implicit";
    if (value === 1 || value === true || value === "1" || value === "true" || value === "explicit") return true;
    return false;
}

// Read on its own so that databases without the column (before the migration
// that adds it) simply mean plain FTP.
export async function loadFtpSecurity(serverId: number): Promise<FtpSecurity> {
    try {
        const row = await dbGet<{ ftp_secure?: unknown }>("SELECT ftp_secure FROM servers WHERE id = ?", [serverId]);
        return parseFtpSecurity(row?.ftp_secure);
    } catch (err) {
        log.debug(`No FTPS setting for server #${serverId}: ${errorMessage(err)}`);
        return false;
    }
}

export async function connectFtpFs(target: FtpTarget): Promise<FtpFs> {
    return FtpFs.connect({
        host: target.host,
        port: target.port,
        user: target.username,
        password: target.password,
        secure: await loadFtpSecurity(target.serverId)
    });
}

// Custom endpoints (MinIO, R2...) default to https; an explicit http:// one is
// kept but reported as insecure to the file manager.
export function s3Endpoint(target: S3Target): string | null {
    if (target.provider !== "other" || !target.endpoint?.trim()) return null;
    const endpoint = target.endpoint.trim();
    return /^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`;
}

// DeleteObjects must carry a checksum. The SDK sends only a CRC32 one, which
// S3-compatible services that predate it (MinIO releases before 2025, older
// Ceph RGW...) refuse with "Missing required header for this request:
// Content-Md5"; this adds the MD5 they ask for. The body is the serialized XML.
export function addDeleteObjectsMd5(client: S3Client): void {
    client.middlewareStack.add((next, context) => async (args) => {
        const request = args.request as { body?: unknown; headers?: Record<string, string> };
        if (context.commandName === "DeleteObjectsCommand" && typeof request.body === "string" && request.headers) {
            request.headers["content-md5"] = createHash("md5").update(request.body).digest("base64");
        }
        return next(args);
    }, { step: "build", name: "deleteObjectsContentMd5" });
}

export function createS3Fs(target: S3Target): S3Fs {
    const config: S3ClientConfig = {
        region: target.region || "us-east-1",
        credentials: { accessKeyId: target.accessKey, secretAccessKey: target.secretKey },
        requestHandler: { connectionTimeout: 15_000, requestTimeout: 120_000 }
    };
    const endpoint = s3Endpoint(target);
    if (endpoint) {
        config.endpoint = endpoint;
        // MinIO and most S3-compatible services want path-style URLs.
        config.forcePathStyle = true;
        // The SDK adds CRC32 checksums (x-amz-checksum-*) to every upload by
        // default, and lib-storage asks for them on multipart uploads; older
        // Ceph RGW, MinIO, B2 and other S3-compatible services refuse those
        // headers. Checksums are then sent only where the API requires them.
        config.requestChecksumCalculation = "WHEN_REQUIRED";
        config.responseChecksumValidation = "WHEN_REQUIRED";
    }
    const client = new S3Client(config);
    if (endpoint) addDeleteObjectsMd5(client);
    return new S3Fs(client, target.bucket, !endpoint || endpoint.toLowerCase().startsWith("https://"));
}

export function createSftpFs(sftp: SFTPWrapper): SftpFs {
    return new SftpFs(sftp);
}
