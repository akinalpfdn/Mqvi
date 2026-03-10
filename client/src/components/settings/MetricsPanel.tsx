/** MetricsPanel — LiveKit instance monitoring: real-time metrics, history summary, time-series charts. */

import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useToastStore } from "../../stores/toastStore";
import {
  getLiveKitInstanceMetrics,
  getLiveKitMetricsHistory,
  getLiveKitMetricsTimeSeries,
} from "../../api/admin";
import type {
  LiveKitInstanceMetrics,
  MetricsHistorySummary,
  MetricsTimeSeriesPoint,
} from "../../types";

type MetricsPanelProps = {
  instanceId: string;
};

function MetricsPanel({ instanceId }: MetricsPanelProps) {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const [metrics, setMetrics] = useState<LiveKitInstanceMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // History state
  const [selectedPeriod, setSelectedPeriod] = useState<"24h" | "7d" | "30d">("24h");
  const [historySummary, setHistorySummary] = useState<MetricsHistorySummary | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);

  // Time-series chart state
  const [timeSeries, setTimeSeries] = useState<MetricsTimeSeriesPoint[]>([]);
  const [isChartLoading, setIsChartLoading] = useState(false);

  const fetchMetrics = useCallback(async () => {
    try {
      setIsLoading(true);
      const res = await getLiveKitInstanceMetrics(instanceId);
      if (res.success && res.data) {
        setMetrics(res.data);
      } else {
        addToast("error", res.error ?? t("platformMetricsLoadError"));
      }
    } catch {
      addToast("error", t("platformMetricsLoadError"));
    } finally {
      setIsLoading(false);
    }
  }, [instanceId, addToast, t]);

  const fetchHistory = useCallback(async (period: "24h" | "7d" | "30d") => {
    try {
      setIsHistoryLoading(true);
      const res = await getLiveKitMetricsHistory(instanceId, period);
      if (res.success && res.data) {
        setHistorySummary(res.data);
      } else {
        addToast("error", res.error ?? t("platformMetricsHistoryLoadError"));
      }
    } catch {
      addToast("error", t("platformMetricsHistoryLoadError"));
    } finally {
      setIsHistoryLoading(false);
    }
  }, [instanceId, addToast, t]);

  const fetchTimeSeries = useCallback(async (period: "24h" | "7d" | "30d") => {
    try {
      setIsChartLoading(true);
      const res = await getLiveKitMetricsTimeSeries(instanceId, period);
      setTimeSeries(res.success && res.data ? res.data : []);
    } catch {
      // chart data is optional — fail silently
    } finally {
      setIsChartLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  useEffect(() => {
    fetchHistory(selectedPeriod);
    fetchTimeSeries(selectedPeriod);
  }, [fetchHistory, fetchTimeSeries, selectedPeriod]);

  const handlePeriodChange = useCallback((period: "24h" | "7d" | "30d") => {
    setSelectedPeriod(period);
  }, []);

  return (
    <>
      <div className="metrics-section">
        <div className="metrics-header">
          <h2 className="settings-section-title">{t("platformMetrics")}</h2>
          <button
            className="settings-btn settings-btn-secondary metrics-refresh-btn"
            onClick={fetchMetrics}
            disabled={isLoading}
          >
            {isLoading ? t("platformMetricsRefreshing") : t("platformMetricsRefresh")}
          </button>
        </div>

        {metrics && !metrics.available && (
          <p className="metrics-unavailable">
            {t("platformMetricsUnavailable")}
          </p>
        )}

        {metrics?.available && (
          <>
            <p className="metrics-timestamp">
              {t("platformMetricsLastUpdated", {
                time: new Date(metrics.fetched_at).toLocaleTimeString(),
              })}
            </p>

            <div className="metrics-grid">
              {metrics.hetzner_avail && (
                <div className="metrics-card">
                  <span className="metrics-card-label">{t("platformMetricsCPU")}</span>
                  <span className="metrics-card-value">
                    {metrics.cpu_pct.toFixed(1)}%
                  </span>
                  <span className="metrics-card-sub">Hetzner</span>
                </div>
              )}

              {metrics.hetzner_avail && (
                <div className="metrics-card">
                  <span className="metrics-card-label">{t("platformMetricsBwIn")}</span>
                  <span className="metrics-card-value">
                    {formatBps(metrics.bw_in_bps)}
                  </span>
                  <span className="metrics-card-sub">Hetzner</span>
                </div>
              )}

              {metrics.hetzner_avail && (
                <div className="metrics-card">
                  <span className="metrics-card-label">{t("platformMetricsBwOut")}</span>
                  <span className="metrics-card-value">
                    {formatBps(metrics.bw_out_bps)}
                  </span>
                  <span className="metrics-card-sub">Hetzner</span>
                </div>
              )}

              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsGoroutines")}</span>
                <span className="metrics-card-value">
                  {metrics.goroutines.toLocaleString()}
                </span>
              </div>

              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsMemoryUsed")}</span>
                <span className="metrics-card-value">
                  {formatBytes(metrics.memory_used)}
                </span>
              </div>

              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsRooms")}</span>
                <span className="metrics-card-value">{metrics.room_count}</span>
              </div>

              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsParticipants")}</span>
                <span className="metrics-card-value">{metrics.participant_count}</span>
              </div>

              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsTracks")}</span>
                <span className="metrics-card-value">
                  {metrics.track_publish_count} / {metrics.track_subscribe_count}
                </span>
                <span className="metrics-card-sub">
                  {t("platformMetricsPublished")} / {t("platformMetricsSubscribed")}
                </span>
              </div>

              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsNack")}</span>
                <span className="metrics-card-value">{metrics.nack_total.toLocaleString()}</span>
              </div>

              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsBytesIn")}</span>
                <span className="metrics-card-value">{formatBytes(metrics.bytes_in)}</span>
                <span className="metrics-card-sub">
                  {t("platformMetricsPacketsIn")}: {metrics.packets_in.toLocaleString()}
                </span>
              </div>

              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsBytesOut")}</span>
                <span className="metrics-card-value">{formatBytes(metrics.bytes_out)}</span>
                <span className="metrics-card-sub">
                  {t("platformMetricsPacketsOut")}: {metrics.packets_out.toLocaleString()}
                </span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Capacity History Section */}
      <div className="dz-separator" />
      <div className="metrics-section">
        <div className="metrics-header">
          <h2 className="settings-section-title">{t("platformMetricsHistory")}</h2>
          <div className="metrics-period-toggle">
            {(["24h", "7d", "30d"] as const).map((period) => (
              <button
                key={period}
                className={`metrics-period-btn${selectedPeriod === period ? " active" : ""}`}
                onClick={() => handlePeriodChange(period)}
                disabled={isHistoryLoading}
              >
                {t(`platformMetricsPeriod${period}`)}
              </button>
            ))}
          </div>
        </div>

        {/* Time-Series Charts */}
        <MetricsChart
          data={timeSeries}
          period={selectedPeriod}
          isLoading={isChartLoading}
        />

        {isHistoryLoading && !historySummary && (
          <p className="metrics-timestamp">{t("platformMetricsRefreshing")}</p>
        )}

        {historySummary && historySummary.sample_count === 0 && (
          <p className="metrics-unavailable">
            {t("platformMetricsHistoryNoData")}
          </p>
        )}

        {historySummary && historySummary.sample_count > 0 && (
          <div className="metrics-grid">
            <div className="metrics-card">
              <span className="metrics-card-label">{t("platformMetricsPeakParticipants")}</span>
              <span className="metrics-card-value">{historySummary.peak_participants}</span>
            </div>

            <div className="metrics-card">
              <span className="metrics-card-label">{t("platformMetricsAvgParticipants")}</span>
              <span className="metrics-card-value">{historySummary.avg_participants.toFixed(1)}</span>
            </div>

            <div className="metrics-card">
              <span className="metrics-card-label">{t("platformMetricsPeakRooms")}</span>
              <span className="metrics-card-value">{historySummary.peak_rooms}</span>
            </div>

            <div className="metrics-card">
              <span className="metrics-card-label">{t("platformMetricsPeakCPU")}</span>
              <span className="metrics-card-value">{historySummary.peak_cpu_pct.toFixed(1)}%</span>
            </div>

            <div className="metrics-card">
              <span className="metrics-card-label">{t("platformMetricsAvgCPU")}</span>
              <span className="metrics-card-value">{historySummary.avg_cpu_pct.toFixed(1)}%</span>
            </div>

            <div className="metrics-card">
              <span className="metrics-card-label">{t("platformMetricsPeakMemory")}</span>
              <span className="metrics-card-value">{formatBytes(historySummary.peak_memory_bytes)}</span>
            </div>

            <div className="metrics-card">
              <span className="metrics-card-label">{t("platformMetricsAvgBandwidthIn")}</span>
              <span className="metrics-card-value">{formatBps(historySummary.avg_bandwidth_in_bps)}</span>
            </div>

            <div className="metrics-card">
              <span className="metrics-card-label">{t("platformMetricsAvgBandwidthOut")}</span>
              <span className="metrics-card-value">{formatBps(historySummary.avg_bandwidth_out_bps)}</span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}


type MetricsChartProps = {
  data: MetricsTimeSeriesPoint[];
  period: "24h" | "7d" | "30d";
  isLoading: boolean;
};

function MetricsChart({ data, period, isLoading }: MetricsChartProps) {
  const { t } = useTranslation("settings");

  if (isLoading && data.length === 0) {
    return (
      <div className="metrics-chart-loading">
        <div className="metrics-chart-skeleton" />
        <div className="metrics-chart-skeleton" />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <p className="metrics-unavailable">{t("platformMetricsChartNoData")}</p>
    );
  }

  return (
    <div className="metrics-chart-container">
      {/* CPU Chart */}
      <div className="metrics-chart-block">
        <span className="metrics-chart-title">{t("platformMetricsChartCPU")}</span>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--red)" stopOpacity={0.25} />
                <stop offset="95%" stopColor="var(--red)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--b1)" strokeDasharray="3 3" />
            <XAxis
              dataKey="ts"
              tickFormatter={(v: string) => formatXAxis(v, period)}
              tick={{ fill: "var(--t2)", fontSize: 13 }}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              tickFormatter={(v: number) => `${v.toFixed(0)}%`}
              tick={{ fill: "var(--t2)", fontSize: 13 }}
              axisLine={false}
              tickLine={false}
              width={45}
              domain={[0, "auto"]}
            />
            <Tooltip content={<ChartTooltip period={period} valueFormatter={(v) => `${v.toFixed(1)}%`} />} />
            <Area
              type="monotone"
              dataKey="cpu_pct"
              stroke="var(--red)"
              fill="url(#cpuGrad)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3, fill: "var(--red)" }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Bandwidth Chart */}
      <div className="metrics-chart-block">
        <span className="metrics-chart-title">{t("platformMetricsChartBandwidth")}</span>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="bwInGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--yellow)" stopOpacity={0.25} />
                <stop offset="95%" stopColor="var(--yellow)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="bwOutGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--red)" stopOpacity={0.15} />
                <stop offset="95%" stopColor="var(--red)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--b1)" strokeDasharray="3 3" />
            <XAxis
              dataKey="ts"
              tickFormatter={(v: string) => formatXAxis(v, period)}
              tick={{ fill: "var(--t2)", fontSize: 13 }}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              tickFormatter={(v: number) => formatBps(v)}
              tick={{ fill: "var(--t2)", fontSize: 13 }}
              axisLine={false}
              tickLine={false}
              width={55}
              domain={[0, "auto"]}
            />
            <Tooltip
              content={
                <ChartTooltip
                  period={period}
                  valueFormatter={(v) => formatBps(v)}
                  labelMap={{ bw_in: "In", bw_out: "Out" }}
                />
              }
            />
            <Area
              type="monotone"
              dataKey="bw_in"
              stroke="var(--yellow)"
              fill="url(#bwInGrad)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3, fill: "var(--yellow)" }}
            />
            <Area
              type="monotone"
              dataKey="bw_out"
              stroke="var(--red)"
              fill="url(#bwOutGrad)"
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: "var(--red)" }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}


type ChartTooltipProps = {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number; color: string }>;
  label?: string;
  period: "24h" | "7d" | "30d";
  valueFormatter: (v: number) => string;
  labelMap?: Record<string, string>;
};

function ChartTooltip({ active, payload, label, period, valueFormatter, labelMap }: ChartTooltipProps) {
  if (!active || !payload || !label) return null;

  return (
    <div className="metrics-chart-tooltip">
      <span className="metrics-chart-tooltip-time">{formatXAxis(label, period)}</span>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="metrics-chart-tooltip-row">
          <span className="metrics-chart-tooltip-dot" style={{ background: entry.color }} />
          <span>{labelMap?.[entry.dataKey] ?? entry.dataKey}: {valueFormatter(entry.value)}</span>
        </div>
      ))}
    </div>
  );
}


function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatBps(bytesPerSec: number): string {
  const bps = bytesPerSec * 8;
  if (bps === 0) return "0 bps";
  const units = ["bps", "Kbps", "Mbps", "Gbps"];
  const i = Math.floor(Math.log(bps) / Math.log(1000));
  const val = bps / Math.pow(1000, i);
  return `${val.toFixed(1)} ${units[Math.min(i, units.length - 1)]}`;
}

function formatXAxis(ts: string, period: "24h" | "7d" | "30d"): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  if (period === "24h") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return (
    d.toLocaleDateString([], { month: "2-digit", day: "2-digit" }) +
    " " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
}

export default MetricsPanel;
