import { useState, useEffect, useRef, useCallback } from 'react';
import { Monitor, Download, Plug, Unplug, AlertTriangle, Loader2, ExternalLink } from 'lucide-react';
import io, { Socket } from 'socket.io-client';
import { clsx } from 'clsx';

interface RdpProps {
  server: any;
}

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected' | 'native-launched';

const HEADER_HEIGHT = 32;
const DEFAULT_REMOTE_SIZE = { width: 1280, height: 800 };
const DEFAULT_VIEW_SIZE = { width: 1280, height: 800 };
const RENDER_DEBOUNCE_MS = 160;

const normalizeSize = (width: number, height: number) => ({
  width: Math.max(320, Math.floor(width / 2) * 2),
  height: Math.max(240, Math.floor(height / 2) * 2),
});

const bufferToBytes = (data: any): Uint8Array | null => {
  if (!data) return null;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  if (data && data.type === 'Buffer' && Array.isArray(data.data)) return new Uint8Array(data.data);
  if (typeof data === 'string') {
    const binaryStr = atob(data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    return bytes;
  }
  if (Array.isArray(data)) return new Uint8Array(data);
  return null;
};

// RDP Component - Render remote desktop via Canvas
export default function RdpComponent({ server }: RdpProps) {
  const displayAreaRef = useRef<HTMLDivElement>(null);
  const visibleCanvasRef = useRef<HTMLCanvasElement>(null);
  const backingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTimerRef = useRef<number | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const requestedSizeRef = useRef(DEFAULT_REMOTE_SIZE);

  const [state, setState] = useState<ConnectionState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [remoteSize, setRemoteSize] = useState(DEFAULT_REMOTE_SIZE);
  const [viewSize, setViewSize] = useState(DEFAULT_VIEW_SIZE);

  useEffect(() => {
    requestedSizeRef.current = remoteSize;
  }, [remoteSize]);

  const getBackingCanvas = useCallback(() => {
    if (!backingCanvasRef.current) {
      backingCanvasRef.current = document.createElement('canvas');
    }
    return backingCanvasRef.current;
  }, []);

  const syncVisibleCanvasSize = useCallback((size: { width: number; height: number }) => {
    const visibleCanvas = visibleCanvasRef.current;
    if (!visibleCanvas) return;

    if (visibleCanvas.width !== size.width) visibleCanvas.width = size.width;
    if (visibleCanvas.height !== size.height) visibleCanvas.height = size.height;
  }, []);

  const renderVisible = useCallback(() => {
    const visibleCanvas = visibleCanvasRef.current;
    const backingCanvas = backingCanvasRef.current;
    if (!visibleCanvas || !backingCanvas) return;

    const ctx = visibleCanvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, visibleCanvas.width, visibleCanvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      backingCanvas,
      0,
      0,
      backingCanvas.width,
      backingCanvas.height,
      0,
      0,
      visibleCanvas.width,
      visibleCanvas.height
    );
  }, []);

  const scheduleRenderVisible = useCallback(() => {
    if (renderTimerRef.current !== null) {
      window.clearTimeout(renderTimerRef.current);
    }

    renderTimerRef.current = window.setTimeout(() => {
      renderTimerRef.current = null;
      renderVisible();
    }, RENDER_DEBOUNCE_MS);
  }, [renderVisible]);

  const applyBitmap = useCallback((bitmap: any, shouldSchedule = true) => {
    const backingCanvas = getBackingCanvas();
    const ctx = backingCanvas.getContext('2d');
    if (!ctx) return;

    if (!(window as any).rdpDebugLogged && bitmap) {
      console.log('BITMAP DEBUG:', JSON.stringify({
        w: bitmap.width, h: bitmap.height,
        destLeft: bitmap.destLeft, destRight: bitmap.destRight,
        destTop: bitmap.destTop, destBottom: bitmap.destBottom,
        bpp: bitmap.bitsPerPixel, isCompress: bitmap.isCompress,
        dataLength: bitmap.data ? (bitmap.data.byteLength || bitmap.data.length || (bitmap.data.data ? bitmap.data.data.length : 0)) : 0
      }));
      (window as any).rdpDebugLogged = true;
    }

    try {
      const bytes = bufferToBytes(bitmap.data);
      if (!bytes) {
        console.error('Unknown bitmap format:', bitmap);
        return;
      }

      const width = Math.max(1, bitmap.width || ((bitmap.destRight - bitmap.destLeft + 1) || 1));
      const height = Math.max(1, bitmap.height || ((bitmap.destBottom - bitmap.destTop + 1) || 1));
      const totalBytes = bytes.length;

      // @electerm/rdpjs already emits canvas-ready 4-byte pixels for the common path.
      if (totalBytes === width * height * 4) {
        const imageData = new ImageData(new Uint8ClampedArray(bytes), width, height);
        ctx.putImageData(imageData, bitmap.destLeft, bitmap.destTop);
      } else {
        const bytesPerPixel = Math.max(1, Math.min(4, Math.round((bitmap.bitsPerPixel || 32) / 8)));
        const stride = Math.floor(totalBytes / height) || (width * bytesPerPixel);
        const rgbaData = new Uint8ClampedArray(width * height * 4);

        for (let y = 0; y < height; y++) {
          const srcRowStart = y * stride;
          const dstRowStart = y * width * 4;

          for (let x = 0; x < width; x++) {
            const srcIdx = srcRowStart + (x * bytesPerPixel);
            const dstIdx = dstRowStart + (x * 4);

            if (srcIdx + bytesPerPixel > totalBytes) continue;

            if (bytesPerPixel === 4) {
              rgbaData[dstIdx] = bytes[srcIdx];
              rgbaData[dstIdx + 1] = bytes[srcIdx + 1];
              rgbaData[dstIdx + 2] = bytes[srcIdx + 2];
              rgbaData[dstIdx + 3] = bytes[srcIdx + 3] ?? 255;
            } else if (bytesPerPixel === 3) {
              rgbaData[dstIdx] = bytes[srcIdx];
              rgbaData[dstIdx + 1] = bytes[srcIdx + 1];
              rgbaData[dstIdx + 2] = bytes[srcIdx + 2];
              rgbaData[dstIdx + 3] = 255;
            } else if (bytesPerPixel === 2) {
              const val = bytes[srcIdx] | (bytes[srcIdx + 1] << 8);
              const r = ((val >> 11) & 0x1F) << 3;
              const g = ((val >> 5) & 0x3F) << 2;
              const b = (val & 0x1F) << 3;
              rgbaData[dstIdx] = r;
              rgbaData[dstIdx + 1] = g;
              rgbaData[dstIdx + 2] = b;
              rgbaData[dstIdx + 3] = 255;
            }
          }
        }

        const imageData = new ImageData(rgbaData, width, height);
        ctx.putImageData(imageData, bitmap.destLeft, bitmap.destTop);
      }

      if (shouldSchedule) {
        scheduleRenderVisible();
      }

    } catch (e) {
      console.error('Bitmap render error:', e);
    }
  }, [getBackingCanvas, scheduleRenderVisible]);

  useEffect(() => {
    const area = displayAreaRef.current;
    if (!area || typeof ResizeObserver === 'undefined') return;

    const updateSize = () => {
      const rect = area.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const nextSize = normalizeSize(rect.width, rect.height);
      setViewSize((prev) => (
        prev.width === nextSize.width && prev.height === nextSize.height ? prev : nextSize
      ));
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(area);
    window.addEventListener('resize', updateSize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  useEffect(() => {
    if (state !== 'connected') return;
    syncVisibleCanvasSize(viewSize);
    scheduleRenderVisible();
  }, [scheduleRenderVisible, state, syncVisibleCanvasSize, viewSize]);

  const handleNativeLaunch = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    const socket = io('http://localhost:3001');
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('launch-rdp-native', {
        host: server.ip,
        username: server.username,
        password: server.password,
        port: server.port || 3389,
        domain: '',
      });
    });

    socket.on('rdp-native-launched', () => {
      setState('native-launched');
    });

    socket.on('rdp-error', (err: string) => {
      setErrorMsg(err);
      setState('error');
    });
  }, [server]);

  const handleEmbeddedConnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    setState('connecting');
    setErrorMsg('');

    const socket = io('http://localhost:3001');
    socketRef.current = socket;

    socket.on('connect', () => {
      const nextSize = normalizeSize(
        displayAreaRef.current?.getBoundingClientRect().width || DEFAULT_REMOTE_SIZE.width,
        displayAreaRef.current?.getBoundingClientRect().height || DEFAULT_REMOTE_SIZE.height
      );

      requestedSizeRef.current = nextSize;
      setRemoteSize(nextSize);

      socket.emit('start-rdp', {
        host: server.ip,
        username: server.username,
        password: server.password,
        port: server.port || 3389,
        domain: '',
        screenWidth: nextSize.width,
        screenHeight: nextSize.height
      });
    });

    socket.on('rdp-bitmap-batch', (bitmaps: any[]) => {
      if (!Array.isArray(bitmaps) || bitmaps.length === 0) return;
      for (const bitmap of bitmaps) {
        applyBitmap(bitmap, false);
      }
      scheduleRenderVisible();
    });

    socket.on('rdp-connect', () => {
      const backingCanvas = getBackingCanvas();
      const { width, height } = requestedSizeRef.current;
      backingCanvas.width = width;
      backingCanvas.height = height;

      const backingCtx = backingCanvas.getContext('2d');
      if (backingCtx) {
        backingCtx.imageSmoothingEnabled = false;
        backingCtx.fillStyle = '#000';
        backingCtx.fillRect(0, 0, backingCanvas.width, backingCanvas.height);
      }

      setState('connected');
    });

    socket.on('rdp-bitmap', (bitmap: any) => {
      applyBitmap(bitmap, true);
    });

    socket.on('rdp-error', (err: string) => {
      console.error('[RDP Client] Error:', err);
      setErrorMsg(err);
      setState('error');
    });

    socket.on('rdp-closed', () => {
      setState('disconnected');
    });

    socket.on('disconnect', () => {
      setState((prev) => (prev === 'connected' ? 'disconnected' : prev));
    });
  }, [applyBitmap, getBackingCanvas, scheduleRenderVisible, server, syncVisibleCanvasSize, viewSize]);

  const handleDisconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.emit('rdp-disconnect');
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setState('disconnected');
  }, []);

  const handleMouseEvent = useCallback((e: React.MouseEvent<HTMLCanvasElement>, isPressed: boolean) => {
    if (!socketRef.current || state !== 'connected') return;
    const visibleCanvas = visibleCanvasRef.current;
    if (!visibleCanvas) return;
    const rect = visibleCanvas.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) * (visibleCanvas.width / rect.width));
    const y = Math.round((e.clientY - rect.top) * (visibleCanvas.height / rect.height));
    let button = 1;
    if (e.button === 2) button = 2;
    if (e.button === 1) button = 3;
    socketRef.current.emit('rdp-mouse', { x, y, button, isPressed });
  }, [state]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!socketRef.current || state !== 'connected') return;
    const visibleCanvas = visibleCanvasRef.current;
    if (!visibleCanvas) return;
    const rect = visibleCanvas.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) * (visibleCanvas.width / rect.width));
    const y = Math.round((e.clientY - rect.top) * (visibleCanvas.height / rect.height));
    socketRef.current.emit('rdp-mouse', { x, y, button: 0, isPressed: false });
  }, [state]);

  useEffect(() => {
    if (state !== 'connected') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!socketRef.current) return;
      e.preventDefault();
      socketRef.current.emit('rdp-keyboard', { code: e.code, isPressed: true, key: e.key });
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (!socketRef.current) return;
      e.preventDefault();
      socketRef.current.emit('rdp-keyboard', { code: e.code, isPressed: false, key: e.key });
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [state]);

  useEffect(() => {
    return () => {
      if (renderTimerRef.current !== null) {
        window.clearTimeout(renderTimerRef.current);
        renderTimerRef.current = null;
      }
      if (socketRef.current) {
        socketRef.current.emit('rdp-disconnect');
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [server.id]);

  const downloadRdpFile = () => {
    const rdpContent = `full address:s:${server.ip}:${server.port || 3389}
username:s:${server.username}
screen mode id:i:2
session bpp:i:32
compression:i:1
keyboardhook:i:2
redirectclipboard:i:1
displayconnectionbar:i:1
autoreconnection enabled:i:1
authentication level:i:2
prompt for credentials:i:1
negotiate security layer:i:1`.trim();
    const blob = new Blob([rdpContent], { type: 'application/x-rdp' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${server.name.replace(/\s+/g, '_')}.rdp`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="w-full h-full relative overflow-hidden bg-[#0a0a0a] text-zinc-400">
      {state === 'native-launched' ? (
        <div className="w-full h-full flex flex-col items-center justify-center gap-6">
          <div className="w-24 h-24 rounded-full flex items-center justify-center bg-emerald-900/20 border border-emerald-800/50 shadow-2xl">
            <ExternalLink className="w-10 h-10 text-emerald-500" />
          </div>
          <div className="text-center max-w-md space-y-2">
            <h2 className="text-xl font-bold text-zinc-200">Remote Desktop Launched</h2>
            <p className="text-sm text-emerald-400">
              Windows Remote Desktop (mstsc.exe) has been opened for <strong>{server.ip}</strong>
            </p>
            <p className="text-xs text-zinc-500 mt-2">
              The connection has been launched in a separate window with your saved credentials.
            </p>
          </div>
          <button
            onClick={() => setState('idle')}
            className="flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 py-2.5 px-6 rounded-md text-sm font-medium transition-colors border border-zinc-700"
          >
            Back
          </button>
        </div>
      ) : state === 'connecting' ? (
        <div className="w-full h-full flex flex-col items-center justify-center gap-4">
          <Loader2 className="w-12 h-12 text-blue-500 animate-spin" />
          <div className="text-center">
            <h2 className="text-lg font-bold text-zinc-200">Connecting...</h2>
            <p className="text-sm text-zinc-500 mt-1">
              Establishing RDP session to {server.ip}:{server.port || 3389}
            </p>
          </div>
        </div>
      ) : state === 'connected' ? (
        <div className="w-full h-full flex flex-col bg-black relative overflow-hidden">
          <div className="h-8 bg-zinc-900/80 border-b border-zinc-800 flex items-center justify-between px-3 shrink-0 z-10">
            <div className="flex items-center gap-2 text-xs text-zinc-400 min-w-0">
              <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50 shrink-0" />
              <span className="truncate">RDP - {server.ip}:{server.port || 3389}</span>
              <span className="text-zinc-600 shrink-0">({requestedSizeRef.current.width}x{requestedSizeRef.current.height})</span>
            </div>
            <button
              onClick={handleDisconnect}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-zinc-800"
            >
              <Unplug className="w-3 h-3" /> Disconnect
            </button>
          </div>
          <div ref={displayAreaRef} className="flex-1 min-h-0 overflow-hidden bg-[#0a0a0a]">
            <canvas
              ref={visibleCanvasRef}
              className="block w-full h-full cursor-default select-none"
              style={{ imageRendering: 'auto' } as any}
              tabIndex={0}
              onMouseDown={(e) => { e.preventDefault(); handleMouseEvent(e, true); }}
              onMouseUp={(e) => { e.preventDefault(); handleMouseEvent(e, false); }}
              onMouseMove={handleMouseMove}
              onContextMenu={(e) => e.preventDefault()}
            />
          </div>
        </div>
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-6">
          <div className={clsx(
            "w-24 h-24 rounded-full flex items-center justify-center border shadow-2xl",
            state === 'error' ? "bg-red-900/20 border-red-800/50" : "bg-zinc-900 border-zinc-800"
          )}>
            {state === 'error'
              ? <AlertTriangle className="w-10 h-10 text-red-500" />
              : <Monitor className="w-10 h-10 text-blue-500" />
            }
          </div>

          <div className="text-center max-w-md space-y-2">
            <h2 className="text-xl font-bold text-zinc-200">Remote Desktop Connection</h2>
            {state === 'error' ? (
              <p className="text-sm text-red-400">{errorMsg || 'Connection failed'}</p>
            ) : state === 'disconnected' ? (
              <p className="text-sm text-zinc-500">Session disconnected. Click to reconnect.</p>
            ) : (
              <p className="text-sm text-zinc-500">
                Connect to <strong>{server.ip}</strong> via Remote Desktop.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-3 w-72">
            <button
              onClick={handleNativeLaunch}
              className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white py-3 rounded-md font-medium transition-colors shadow-lg shadow-blue-900/20"
            >
              <ExternalLink className="w-4 h-4" />
              Open Remote Desktop
            </button>

            <button
              disabled
              title="Temporarily disabled in v0.1.8 while the embedded renderer is being stabilized."
              className="flex items-center justify-center gap-2 bg-zinc-900 text-zinc-500 py-2.5 rounded-md text-sm font-medium border border-zinc-800 cursor-not-allowed opacity-70"
            >
              <Plug className="w-4 h-4" />
              Embedded Connection Disabled
            </button>

            <button
              onClick={downloadRdpFile}
              className="flex items-center justify-center gap-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 py-2 rounded-md text-xs font-medium transition-colors border border-zinc-800"
            >
              <Download className="w-3 h-3" />
              Download .rdp File
            </button>

            <div className="text-xs text-center text-zinc-600 mt-1">
              <strong>{server.ip}:{server.port || 3389}</strong> as <strong>{server.username}</strong>
            </div>

            {state === 'error' && (
              <div className="mt-2 p-3 bg-zinc-900 border border-zinc-800 rounded-md text-xs text-zinc-500 space-y-1">
                <p className="font-medium text-zinc-400">Tips:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Use "Open Remote Desktop" for NLA-enabled servers</li>
                  <li>Ensure port {server.port || 3389} is accessible</li>
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
