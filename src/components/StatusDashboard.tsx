import { useEffect, useMemo, useState } from "react";
import { Activity, BarChart3, Clock3, Cpu, HardDrive, RefreshCw, Server } from "lucide-react";
import { clsx } from "clsx";

type StatusDisk = {
  name: string;
  mount: string;
  totalGB: number;
  usedGB: number;
  freeGB: number;
  usagePercent: number;
};

type StatusProcess = {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryPercent?: number;
  memoryMB?: number;
};

type StatusSnapshot = {
  platform: "linux" | "windows";
  hostname: string;
  os: string;
  uptime: string;
  cpuUsagePercent: number;
  memory: {
    totalMB: number;
    usedMB: number;
    freeMB: number;
    usagePercent: number;
  };
  storage: {
    totalGB: number;
    usedGB: number;
    freeGB: number;
    usagePercent: number;
  };
  disks: StatusDisk[];
  processes: StatusProcess[];
  loadAverage?: {
    one: number;
    five: number;
    fifteen: number;
  } | null;
};

interface StatusDashboardProps {
  server: any;
  isVisible: boolean;
}

function formatMemoryMB(value: number) {
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GB`;
  return `${Math.round(value)} MB`;
}

function formatDiskGB(value: number) {
  if (value >= 1024) return `${(value / 1024).toFixed(1)} TB`;
  return `${value.toFixed(1)} GB`;
}

function MetricBar({ value, tone = "teal" }: { value: number; tone?: "teal" | "amber" | "red" | "blue" }) {
  const palette = {
    teal: "from-teal-400 to-cyan-400",
    amber: "from-amber-400 to-orange-400",
    red: "from-rose-400 to-red-400",
    blue: "from-blue-400 to-indigo-400"
  }[tone];

  return (
    <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
      <div
        className={clsx("h-full rounded-full bg-gradient-to-r transition-[width] duration-500", palette)}
        style={{ width: `${Math.max(0, Math.min(value, 100))}%` }}
      />
    </div>
  );
}

function MetricCard({
  title,
  value,
  subtitle,
  icon,
  barValue,
  tone = "teal"
}: {
  title: string;
  value: string;
  subtitle: string;
  icon: React.ReactNode;
  barValue?: number;
  tone?: "teal" | "amber" | "red" | "blue";
}) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 shadow-[0_12px_30px_rgba(0,0,0,0.28)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.24em] text-zinc-500">{title}</div>
          <div className="mt-2 text-2xl font-semibold text-zinc-100">{value}</div>
          <div className="mt-1 text-xs text-zinc-500">{subtitle}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/90 p-2 text-zinc-300">
          {icon}
        </div>
      </div>
      {typeof barValue === "number" && (
        <div className="mt-4">
          <MetricBar value={barValue} tone={tone} />
        </div>
      )}
    </div>
  );
}

export default function StatusDashboard({ server, isVisible }: StatusDashboardProps) {
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const fetchStatus = async () => {
    if (!server?.id) return;

    try {
      setError(null);
      const res = await fetch(`http://localhost:3001/api/servers/${server.id}/status`);
      const rawBody = await res.text();
      const isJson = (res.headers.get("content-type") || "").includes("application/json");
      const data = isJson && rawBody ? JSON.parse(rawBody) : null;

      if (!res.ok) {
        if (res.status === 404 && /cannot get/i.test(rawBody)) {
          throw new Error("Status backend not available yet. Restart the app and try again.");
        }

        throw new Error(data?.error || rawBody || "Failed to load status");
      }

      if (!data) {
        throw new Error("Status endpoint returned an invalid response.");
      }

      setSnapshot(data);
      setLastUpdated(Date.now());
    } catch (err: any) {
      setError(err.message || "Failed to load status");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!isVisible || !server?.id) return;

    setIsLoading(true);
    void fetchStatus();

    const interval = window.setInterval(() => {
      void fetchStatus();
    }, 12000);

    return () => {
      window.clearInterval(interval);
    };
  }, [isVisible, server?.id]);

  const processRows = useMemo(() => snapshot?.processes || [], [snapshot?.processes]);

  if (!server) {
    return null;
  }

  return (
    <div className="absolute inset-0 overflow-y-auto bg-[radial-gradient(circle_at_top_left,_rgba(20,184,166,0.08),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(59,130,246,0.08),_transparent_22%),#0a0a0a]">
      <div className="mx-auto max-w-6xl p-6 md:p-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.28em] text-teal-400/80">Status</div>
            <h1 className="mt-2 text-3xl font-semibold text-zinc-100">{server.name}</h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-xs text-zinc-400">
              <div className="flex items-center gap-2">
                {isLoading && <RefreshCw className="h-3.5 w-3.5 animate-spin text-teal-300" />}
                <span>
                  {isLoading && !lastUpdated
                    ? "Loading metrics..."
                    : isLoading
                      ? "Refreshing..."
                      : lastUpdated
                        ? `Updated ${new Date(lastUpdated).toLocaleTimeString()}`
                        : "Waiting for first sample"}
                </span>
              </div>
            </div>
            <button
              onClick={() => {
                setIsLoading(true);
                void fetchStatus();
              }}
              className="rounded-xl border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800 transition-colors flex items-center gap-2"
            >
              <RefreshCw className={clsx("w-3.5 h-3.5", isLoading && "animate-spin")} />
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-6 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {isLoading && !snapshot ? (
          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-36 animate-pulse rounded-2xl border border-zinc-800 bg-zinc-950/70" />
            ))}
          </div>
        ) : snapshot && (
          <>
            <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                title="CPU"
                value={`${snapshot.cpuUsagePercent.toFixed(1)}%`}
                subtitle="Current processor usage"
                icon={<Cpu className="w-5 h-5" />}
                barValue={snapshot.cpuUsagePercent}
                tone={snapshot.cpuUsagePercent >= 85 ? "red" : snapshot.cpuUsagePercent >= 65 ? "amber" : "teal"}
              />
              <MetricCard
                title="Memory"
                value={`${snapshot.memory.usagePercent.toFixed(1)}%`}
                subtitle={`${formatMemoryMB(snapshot.memory.usedMB)} used of ${formatMemoryMB(snapshot.memory.totalMB)}`}
                icon={<Activity className="w-5 h-5" />}
                barValue={snapshot.memory.usagePercent}
                tone={snapshot.memory.usagePercent >= 85 ? "red" : snapshot.memory.usagePercent >= 70 ? "amber" : "blue"}
              />
              <MetricCard
                title="Storage"
                value={`${snapshot.storage.usagePercent.toFixed(1)}%`}
                subtitle={`${formatDiskGB(snapshot.storage.usedGB)} used of ${formatDiskGB(snapshot.storage.totalGB)}`}
                icon={<HardDrive className="w-5 h-5" />}
                barValue={snapshot.storage.usagePercent}
                tone={snapshot.storage.usagePercent >= 90 ? "red" : snapshot.storage.usagePercent >= 75 ? "amber" : "teal"}
              />
              <MetricCard
                title="Uptime"
                value={snapshot.uptime}
                subtitle={snapshot.platform === "windows" ? "Windows host runtime" : "Linux host runtime"}
                icon={<Clock3 className="w-5 h-5" />}
              />
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-5 shadow-[0_12px_30px_rgba(0,0,0,0.28)]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.24em] text-zinc-500">Host</div>
                    <div className="mt-2 text-xl font-semibold text-zinc-100">{snapshot.hostname}</div>
                    <div className="mt-1 text-sm text-zinc-400">{snapshot.os}</div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/90 p-2 text-zinc-300">
                    <Server className="w-5 h-5" />
                  </div>
                </div>

                <div className="mt-5 grid gap-3 md:grid-cols-3">
                  <div className="rounded-xl border border-zinc-800 bg-black/30 p-3">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Free memory</div>
                    <div className="mt-1 text-lg font-medium text-zinc-100">{formatMemoryMB(snapshot.memory.freeMB)}</div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-black/30 p-3">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Free storage</div>
                    <div className="mt-1 text-lg font-medium text-zinc-100">{formatDiskGB(snapshot.storage.freeGB)}</div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-black/30 p-3">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Platform</div>
                    <div className="mt-1 text-lg font-medium text-zinc-100 capitalize">{snapshot.platform}</div>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-5 shadow-[0_12px_30px_rgba(0,0,0,0.28)]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.24em] text-zinc-500">Load Signals</div>
                    <div className="mt-2 text-xl font-semibold text-zinc-100">
                      {snapshot.loadAverage ? snapshot.loadAverage.one.toFixed(2) : `${snapshot.cpuUsagePercent.toFixed(1)}%`}
                    </div>
                    <div className="mt-1 text-sm text-zinc-400">
                      {snapshot.loadAverage ? "1 minute load average" : "CPU snapshot"}
                    </div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/90 p-2 text-zinc-300">
                    <BarChart3 className="w-5 h-5" />
                  </div>
                </div>

                {snapshot.loadAverage ? (
                  <div className="mt-5 grid grid-cols-3 gap-3">
                    {[
                      { label: "1 min", value: snapshot.loadAverage.one },
                      { label: "5 min", value: snapshot.loadAverage.five },
                      { label: "15 min", value: snapshot.loadAverage.fifteen }
                    ].map((entry) => (
                      <div key={entry.label} className="rounded-xl border border-zinc-800 bg-black/30 p-3">
                        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">{entry.label}</div>
                        <div className="mt-1 text-lg font-medium text-zinc-100">{entry.value.toFixed(2)}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-5 rounded-xl border border-zinc-800 bg-black/30 p-3 text-sm text-zinc-400">
                    Load averages are not exposed on this platform, so this card shows the current CPU snapshot instead.
                  </div>
                )}
              </div>
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-5 shadow-[0_12px_30px_rgba(0,0,0,0.28)]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.24em] text-zinc-500">Top Processes</div>
                    <div className="mt-2 text-xl font-semibold text-zinc-100">Live hot spots</div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/90 p-2 text-zinc-300">
                    <Cpu className="w-5 h-5" />
                  </div>
                </div>

                <div className="mt-5 overflow-hidden rounded-xl border border-zinc-800">
                  <div className="grid grid-cols-[minmax(0,1fr)_90px_110px] bg-zinc-900/70 px-4 py-2 text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                    <span>Process</span>
                    <span>CPU</span>
                    <span>Memory</span>
                  </div>
                  <div className="divide-y divide-zinc-800">
                    {processRows.length ? processRows.map((process) => (
                      <div key={`${process.pid}-${process.name}`} className="grid grid-cols-[minmax(0,1fr)_90px_110px] items-center px-4 py-3 text-sm">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-zinc-100">{process.name}</div>
                          <div className="text-xs text-zinc-500">PID {process.pid}</div>
                        </div>
                        <div className="text-zinc-300">{process.cpuPercent.toFixed(1)}%</div>
                        <div className="text-zinc-300">
                          {typeof process.memoryMB === "number"
                            ? formatMemoryMB(process.memoryMB)
                            : `${(process.memoryPercent || 0).toFixed(1)}%`}
                        </div>
                      </div>
                    )) : (
                      <div className="px-4 py-6 text-sm text-zinc-500">No process data returned.</div>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-5 shadow-[0_12px_30px_rgba(0,0,0,0.28)]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.24em] text-zinc-500">Volumes</div>
                    <div className="mt-2 text-xl font-semibold text-zinc-100">Disk usage</div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/90 p-2 text-zinc-300">
                    <HardDrive className="w-5 h-5" />
                  </div>
                </div>

                <div className="mt-5 space-y-3">
                  {snapshot.disks.length ? snapshot.disks.map((disk) => (
                    <div key={`${disk.name}-${disk.mount}`} className="rounded-xl border border-zinc-800 bg-black/30 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-zinc-100">{disk.name}</div>
                          <div className="truncate text-xs text-zinc-500">{disk.mount}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-medium text-zinc-200">{disk.usagePercent.toFixed(1)}%</div>
                          <div className="text-[11px] text-zinc-500">{formatDiskGB(disk.usedGB)} / {formatDiskGB(disk.totalGB)}</div>
                        </div>
                      </div>
                      <div className="mt-3">
                        <MetricBar
                          value={disk.usagePercent}
                          tone={disk.usagePercent >= 90 ? "red" : disk.usagePercent >= 75 ? "amber" : "blue"}
                        />
                      </div>
                    </div>
                  )) : (
                    <div className="rounded-xl border border-zinc-800 bg-black/30 p-4 text-sm text-zinc-500">
                      No disk data returned.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
