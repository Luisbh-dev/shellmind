import { describe, expectTypeOf, it } from 'vitest';
import type { FileResult, FileSessionInfo, ListResult, UploadStartResult } from '../../shared/files';
import { ok, request, type FileSocket } from './fileClient';

// The file manager tests' helper follows the socket protocol maps
// (arch-protocol-halves-tested-apart): checked by `npm run typecheck`, where
// an unused @ts-expect-error is an error too.

describe('file test helper', () => {
    it('takes requests and gives results of the protocol\'s types', () => {
        const calls = (socket: FileSocket) => {
            expectTypeOf(request(socket, 'files-list', { path: '/' })).resolves.toEqualTypeOf<FileResult<ListResult>>();
            expectTypeOf(ok(socket, 'files-upload-start', { path: '/a', size: 1, overwrite: false })).resolves.toEqualTypeOf<UploadStartResult>();
            expectTypeOf(ok(socket, 'files-session')).resolves.toEqualTypeOf<FileSessionInfo>();
            // An explicit result type, as most tests write it.
            expectTypeOf(ok<ListResult>(socket, 'files-list', { path: '/' })).resolves.toEqualTypeOf<ListResult>();

            // @ts-expect-error not a request of the protocol
            void request(socket, 'files-lst', { path: '/' });
            // @ts-expect-error a list request names a path
            void request(socket, 'files-list', { pth: '/' });
            // @ts-expect-error neither with an explicit result type
            void ok<ListResult>(socket, 'files-list', { pth: '/' });
            // @ts-expect-error files-session takes no request
            void ok(socket, 'files-session', { path: '/' });
            // @ts-expect-error a download ack is not answered
            void request(socket, 'files-download-ack', { transferId: 't', seq: 0 });
        };
        expectTypeOf(calls).toBeFunction();
    });
});
