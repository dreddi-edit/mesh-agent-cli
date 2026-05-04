import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Brain,
  CheckCircle2,
  Cpu,
  FileCode2,
  GitBranch,
  Play,
  Radio,
  RefreshCw,
  Search,
  ShieldAlert,
  Wifi,
  WifiOff
} from "lucide-react";
import { useDashboardSocket } from "./useDashboardSocket";
import type { DashboardActionName, DashboardState, FileGroup, GraphLink, GraphNode, HotFile } from "./types";

const GROUP_LABEL: Record<FileGroup, string> = {
  source: "Source",
  tests: "Tests",
  docs: "Docs",
  config: "Config",
  other: "Other"
};

const GROUP_COLOR: Record<FileGroup, string> = {
  source: "#25d0b5",
  tests: "#b3d45b",
  docs: "#8aa3ff",
  config: "#f0a942",
  other: "#b0b8c0"
};

function compact(value: number | null | undefined): string {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function basename(file: string): string {
  return file.split("/").pop() || file;
}

function formatTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString();
}

function firstFile(state: DashboardState | null): string | null {
  if (!state) return null;
  return state.hotFiles[0]?.file
    || state.groupedFiles.source[0]
    || state.groupedFiles.tests[0]
    || state.groupedFiles.config[0]
    || null;
}

export default function App() {
  const { state, status, lastError, serverVersion, runAction, requestState } = useDashboardSocket();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState<FileGroup | "all">("all");
  const [graphMode, setGraphMode] = useState<"focus" | "atlas">("focus");

  useEffect(() => {
    if (!selectedFile) setSelectedFile(firstFile(state));
  }, [selectedFile, state]);

  const visibleFiles = useMemo(() => {
    if (!state) return [];
    const query = fileFilter.trim().toLowerCase();
    return (Object.entries(state.groupedFiles) as Array<[FileGroup, string[]]>)
      .flatMap(([group, files]) => files.map(file => ({ group, file })))
      .filter(item => (groupFilter === "all" || item.group === groupFilter) && (!query || item.file.toLowerCase().includes(query)))
      .slice(0, 300);
  }, [fileFilter, groupFilter, state]);

  if (!state) {
    return (
      <main className="boot-shell">
        <div className="boot-panel">
          <Radio className="boot-icon" size={22} />
          <h1>Mesh Dashboard</h1>
          <p>{lastError || "Connecting to the local live socket..."}</p>
          <span className={`socket-pill ${status}`}>{status}</span>
        </div>
      </main>
    );
  }

  const selectedDetails = selectedFile ? state.dependencyGraph.details[selectedFile] : null;
  const selectedHotFile = selectedFile ? state.hotFiles.find(item => item.file === selectedFile) : null;
  const runningActions = new Set(state.actionQueue.filter(action => action.status === "running").map(action => action.action));

  return (
    <main className="dashboard-shell">
      <TopBar
        state={state}
        status={status}
        version={serverVersion}
        lastError={lastError}
        requestState={requestState}
      />

      <section className="metric-strip" aria-label="Repository metrics">
        <HealthTile state={state} />
        <MetricTile icon={<FileCode2 size={18} />} label="Files understood" value={compact(state.summary.fileCount)} detail={`${state.summary.sourceCount} src / ${state.summary.testCount} tests`} />
        <MetricTile icon={<ShieldAlert size={18} />} label="Risk hotspots" value={compact(state.summary.riskHotspots)} detail={`${state.summary.repairs} repair candidates`} tone={state.summary.riskHotspots > 0 ? "warn" : "ok"} />
        <MetricTile icon={<Brain size={18} />} label="Repo memory" value={compact(state.summary.rules)} detail={`${state.summary.insights} causal insights`} />
        <ContextTile state={state} />
      </section>

      <section className="work-grid">
        <aside className="left-rail">
          <Panel title="File Mix" note={`${state.summary.fileCount} files`}>
            <FileMix state={state} />
          </Panel>
          <Panel title="Risk Radar" note={state.hotFiles.length ? `${state.hotFiles.length} flagged` : "clear"} fill>
            <RiskList hotFiles={state.hotFiles} selectedFile={selectedFile} onSelect={setSelectedFile} />
          </Panel>
          <Panel title="Command Dock" note="local">
            <CommandDock
              state={state}
              runningActions={runningActions}
              runAction={runAction}
            />
          </Panel>
        </aside>

        <section className="graph-stage">
          <div className="stage-toolbar">
            <div>
              <strong>Dependency Field</strong>
              <span>{state.dependencyGraph.nodes.length} files / {state.dependencyGraph.links.length} links / {formatTime(state.liveUpdatedAt)}</span>
            </div>
            <div className="segmented" role="tablist" aria-label="Graph mode">
              <button className={graphMode === "focus" ? "active" : ""} onClick={() => setGraphMode("focus")}>Focus</button>
              <button className={graphMode === "atlas" ? "active" : ""} onClick={() => setGraphMode("atlas")}>Atlas</button>
            </div>
          </div>
          <DependencyCanvas
            state={state}
            selectedFile={selectedFile}
            mode={graphMode}
            onSelect={setSelectedFile}
          />
          <PackageRow state={state} />
        </section>

        <aside className="file-rail">
          <section className="file-hero">
            <p className="eyebrow">File Intelligence</p>
            <h2>{selectedFile ? basename(selectedFile) : "No file selected"}</h2>
            <p title={selectedFile || ""}>{selectedFile || "Select a node or file."}</p>
            <div className="file-kpis">
              <MiniKpi label="imports" value={selectedDetails?.dependencies.length || 0} />
              <MiniKpi label="used by" value={selectedDetails?.dependents.length || 0} />
              <MiniKpi label="pkgs" value={selectedDetails?.externalImports.length || 0} />
              <MiniKpi label="risk" value={selectedHotFile?.score ?? selectedHotFile?.risks.length ?? 0} />
            </div>
          </section>
          <section className="file-tools">
            <label>
              <Search size={14} />
              <input value={fileFilter} onChange={event => setFileFilter(event.target.value)} placeholder="Search files" />
            </label>
            <select value={groupFilter} onChange={event => setGroupFilter(event.target.value as FileGroup | "all")}>
              <option value="all">All</option>
              {(Object.keys(GROUP_LABEL) as FileGroup[]).map(group => <option key={group} value={group}>{GROUP_LABEL[group]}</option>)}
            </select>
          </section>
          <FileList
            files={visibleFiles}
            hotFiles={state.hotFiles}
            selectedFile={selectedFile}
            onSelect={setSelectedFile}
          />
          <FileDetail
            file={selectedFile}
            details={selectedDetails}
            hotFile={selectedHotFile || undefined}
            state={state}
          />
        </aside>
      </section>
    </main>
  );
}

function TopBar(props: {
  state: DashboardState;
  status: string;
  version: string | null;
  lastError: string | null;
  requestState: () => void;
}) {
  const live = props.status === "live";
  return (
    <header className="topbar">
      <div className="brand-block">
        <span>Mesh</span>
        <strong>Repository Intelligence</strong>
      </div>
      <div className="workspace-path" title={props.state.workspaceRoot}>{props.state.workspaceRoot}</div>
      <div className="top-actions">
        <span className={`socket-pill ${props.status}`} title={props.lastError || props.version || props.status}>
          {live ? <Wifi size={15} /> : <WifiOff size={15} />}
          {props.status}
        </span>
        <button className="icon-button" onClick={props.requestState} aria-label="Refresh dashboard state">
          <RefreshCw size={16} />
        </button>
      </div>
    </header>
  );
}

function MetricTile(props: { icon: React.ReactNode; label: string; value: string; detail: string; tone?: "ok" | "warn" }) {
  return (
    <article className={`metric-card ${props.tone || ""}`}>
      <div className="metric-label">{props.icon}<span>{props.label}</span></div>
      <strong>{props.value}</strong>
      <p>{props.detail}</p>
    </article>
  );
}

function HealthTile({ state }: { state: DashboardState }) {
  const tone = state.health.status === "healthy" ? "ok" : state.health.status === "watch" ? "warn" : "danger";
  return (
    <article className={`health-card ${tone}`}>
      <div className="dial" style={{ "--score": state.health.score } as React.CSSProperties}>
        <span>{state.health.score}</span>
      </div>
      <div>
        <p>System Health</p>
        <strong>{state.health.status}</strong>
        <span>{state.summary.repairs} repairs / {state.summary.riskHotspots} hotspots</span>
      </div>
    </article>
  );
}

function ContextTile({ state }: { state: DashboardState }) {
  const report = state.contextMetrics?.report;
  const used = Number(report?.totalTokens || 0);
  const max = Number(report?.maxInputTokens || 0);
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return (
    <article className="context-card">
      <div className="metric-label"><Cpu size={18} /><span>Context budget</span></div>
      <strong>{pct ? `${pct}%` : "idle"}</strong>
      <div className="budget-track"><span style={{ width: `${pct}%` }} /></div>
      <p>{compact(state.contextMetrics?.rawTokensSavedEstimate)} tokens saved</p>
    </article>
  );
}

function Panel(props: { title: string; note?: string; children: React.ReactNode; fill?: boolean }) {
  return (
    <section className={`panel ${props.fill ? "fill" : ""}`}>
      <div className="panel-head">
        <h3>{props.title}</h3>
        {props.note && <span>{props.note}</span>}
      </div>
      {props.children}
    </section>
  );
}

function FileMix({ state }: { state: DashboardState }) {
  const rows = (Object.keys(GROUP_LABEL) as FileGroup[]).map(group => ({
    group,
    count: state.groupedFiles[group]?.length || 0
  }));
  const total = Math.max(1, rows.reduce((sum, row) => sum + row.count, 0));
  return (
    <div className="mix-list">
      {rows.map(row => (
        <div className="mix-row" key={row.group}>
          <span>{GROUP_LABEL[row.group]}</span>
          <div><i style={{ width: `${(row.count / total) * 100}%`, background: GROUP_COLOR[row.group] }} /></div>
          <b>{compact(row.count)}</b>
        </div>
      ))}
    </div>
  );
}

function RiskList(props: { hotFiles: HotFile[]; selectedFile: string | null; onSelect: (file: string) => void }) {
  if (props.hotFiles.length === 0) {
    return <p className="empty">No risk hotspots in the current twin.</p>;
  }
  return (
    <div className="risk-list">
      {props.hotFiles.map(item => (
        <button
          key={item.file}
          className={props.selectedFile === item.file ? "active" : ""}
          onClick={() => props.onSelect(item.file)}
        >
          <span>{item.file}</span>
          <small>{item.risks.join(", ") || "risk hotspot"}</small>
          <b>{item.score ?? "risk"}</b>
        </button>
      ))}
    </div>
  );
}

function CommandDock(props: {
  state: DashboardState;
  runningActions: Set<DashboardActionName | undefined>;
  runAction: (action: DashboardActionName) => void;
}) {
  const latestByAction = new Map(props.state.actionQueue.map(record => [record.action, record]));
  return (
    <div className="command-list">
      {props.state.actions.map(action => {
        const latest = latestByAction.get(action.action);
        const running = props.runningActions.has(action.action);
        return (
          <div className="command-item" key={action.action}>
            <div>
              <strong>{action.label}</strong>
              <span>{action.detail}</span>
              {latest?.summary && <em>{latest.summary}</em>}
              {latest?.error && <em className="error-text">{latest.error}</em>}
            </div>
            <button disabled={running} onClick={() => props.runAction(action.action)} aria-label={`Run ${action.label}`}>
              {running ? <Activity size={15} /> : <Play size={15} />}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function DependencyCanvas(props: {
  state: DashboardState;
  selectedFile: string | null;
  mode: "focus" | "atlas";
  onSelect: (file: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hitMapRef = useRef<Array<{ id: string; x: number; y: number; r: number }>>([]);

  const layout = useMemo(() => {
    const graph = props.state.dependencyGraph;
    const byId = new Map(graph.nodes.map(node => [node.id, node]));
    if (props.mode === "focus" && props.selectedFile) {
      const details = graph.details[props.selectedFile] || { dependencies: [], dependents: [], externalImports: [] };
      const ids = [
        ...details.dependents.slice(0, 10),
        props.selectedFile,
        ...details.dependencies.slice(0, 10)
      ].filter((id, index, list) => byId.has(id) && list.indexOf(id) === index);
      const nodeSet = new Set(ids);
      return {
        nodes: ids.map(id => byId.get(id)).filter(Boolean) as GraphNode[],
        links: graph.links.filter(link => nodeSet.has(link.source) && nodeSet.has(link.target))
      };
    }
    return {
      nodes: graph.nodes.slice(0, 70),
      links: graph.links.slice(0, 160)
    };
  }, [props.mode, props.selectedFile, props.state.dependencyGraph]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    drawDependencyField(ctx, rect.width, rect.height, layout.nodes, layout.links, props.selectedFile, hitMapRef.current);
  }, [layout, props.selectedFile]);

  return (
    <canvas
      ref={canvasRef}
      className="dependency-canvas"
      role="img"
      aria-label="Dependency graph"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const hit = hitMapRef.current.find(item => Math.hypot(item.x - x, item.y - y) <= item.r);
        if (hit) props.onSelect(hit.id);
      }}
    />
  );
}

function drawDependencyField(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  nodes: GraphNode[],
  links: GraphLink[],
  selectedFile: string | null,
  hitMap: Array<{ id: string; x: number; y: number; r: number }>
) {
  hitMap.length = 0;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#090d11";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(255,255,255,.045)";
  for (let x = 20; x < width; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 20; y < height; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const byId = new Map<string, GraphNode & { x: number; y: number; r: number }>();
  nodes.forEach((node, index) => {
    const angle = index * 2.399963;
    const radius = Math.min(width, height) * (0.18 + (index % 9) * 0.028);
    const selectedBoost = node.id === selectedFile ? 0 : 1;
    const x = selectedFile && node.id === selectedFile ? width / 2 : width / 2 + Math.cos(angle) * radius * selectedBoost;
    const y = selectedFile && node.id === selectedFile ? height / 2 : height / 2 + Math.sin(angle) * radius * selectedBoost;
    byId.set(node.id, {
      ...node,
      x: Math.max(34, Math.min(width - 34, x)),
      y: Math.max(34, Math.min(height - 34, y)),
      r: Math.max(6, Math.min(16, 7 + node.dependents + node.dependencies * 0.5))
    });
  });

  links.forEach(link => {
    const source = byId.get(link.source);
    const target = byId.get(link.target);
    if (!source || !target) return;
    const active = link.source === selectedFile || link.target === selectedFile;
    ctx.strokeStyle = active ? "rgba(37,208,181,.85)" : "rgba(130,148,160,.24)";
    ctx.lineWidth = active ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
  });

  byId.forEach(node => {
    const active = node.id === selectedFile;
    const color = GROUP_COLOR[node.group] || GROUP_COLOR.other;
    ctx.shadowColor = active ? color : "transparent";
    ctx.shadowBlur = active ? 24 : 0;
    ctx.fillStyle = active ? color : "#101820";
    ctx.strokeStyle = color;
    ctx.lineWidth = active ? 3 : 2;
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = active ? "#f7fffc" : "rgba(235,244,242,.78)";
    ctx.font = active ? "700 12px Fira Sans" : "600 11px Fira Sans";
    ctx.fillText(basename(node.id).slice(0, 24), node.x + node.r + 7, node.y + 4);
    hitMap.push({ id: node.id, x: node.x, y: node.y, r: node.r + 12 });
  });
}

function PackageRow({ state }: { state: DashboardState }) {
  const packages = state.dependencyGraph.externalPackages.slice(0, 16);
  return (
    <div className="package-row">
      {packages.length ? packages.map(pkg => (
        <span key={pkg.name}>{pkg.name}<b>{pkg.count}</b></span>
      )) : <p className="empty">No external packages detected.</p>}
    </div>
  );
}

function MiniKpi(props: { label: string; value: number | string }) {
  return (
    <div className="mini-kpi">
      <span>{props.label}</span>
      <b>{props.value}</b>
    </div>
  );
}

function FileList(props: {
  files: Array<{ group: FileGroup; file: string }>;
  hotFiles: HotFile[];
  selectedFile: string | null;
  onSelect: (file: string) => void;
}) {
  const hotSet = new Set(props.hotFiles.map(item => item.file));
  return (
    <section className="file-list">
      <p>{props.files.length} visible files</p>
      <div>
        {props.files.map(item => (
          <button
            key={`${item.group}:${item.file}`}
            className={`${props.selectedFile === item.file ? "active" : ""} ${hotSet.has(item.file) ? "hot" : ""}`}
            onClick={() => props.onSelect(item.file)}
          >
            <span>{item.file}</span>
            <small>{item.group}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function FileDetail(props: {
  file: string | null;
  details: DashboardState["dependencyGraph"]["details"][string] | null;
  hotFile?: HotFile;
  state: DashboardState;
}) {
  if (!props.file || !props.details) {
    return <section className="file-detail"><p className="empty">No file selected.</p></section>;
  }
  const file = props.file;
  const event = props.state.events.find(item => item.path === file || item.path?.endsWith(file));
  return (
    <section className="file-detail">
      <DetailSection title="Dependency Balance">
        <BalanceBar label="imports" value={props.details.dependencies.length} max={Math.max(1, props.details.dependencies.length, props.details.dependents.length, props.details.externalImports.length)} />
        <BalanceBar label="used by" value={props.details.dependents.length} max={Math.max(1, props.details.dependencies.length, props.details.dependents.length, props.details.externalImports.length)} />
        <BalanceBar label="packages" value={props.details.externalImports.length} max={Math.max(1, props.details.dependencies.length, props.details.dependents.length, props.details.externalImports.length)} />
      </DetailSection>
      <PillSection title="Imports" items={props.details.dependencies.map(basename)} />
      <PillSection title="Used By" items={props.details.dependents.map(basename)} />
      <PillSection title="Packages" items={props.details.externalImports} tone="pkg" />
      {props.hotFile && <PillSection title="Risk Signals" items={props.hotFile.risks.length ? props.hotFile.risks : ["flagged"]} tone="risk" />}
      <DetailSection title="Last Activity">
        <p className="quiet">{event ? `${event.msg || event.type} / ${formatTime(event.at)}` : "No recent activity for this file."}</p>
      </DetailSection>
    </section>
  );
}

function DetailSection(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="detail-section">
      <h4>{props.title}</h4>
      {props.children}
    </div>
  );
}

function PillSection(props: { title: string; items: string[]; tone?: "pkg" | "risk" }) {
  if (props.items.length === 0) return null;
  return (
    <DetailSection title={props.title}>
      <div className="pill-wrap">
        {props.items.slice(0, 14).map(item => <span className={props.tone || ""} key={item}>{item}</span>)}
      </div>
    </DetailSection>
  );
}

function BalanceBar(props: { label: string; value: number; max: number }) {
  return (
    <div className="balance-row">
      <span>{props.label}</span>
      <div><i style={{ width: `${(props.value / props.max) * 100}%` }} /></div>
      <b>{props.value}</b>
    </div>
  );
}
