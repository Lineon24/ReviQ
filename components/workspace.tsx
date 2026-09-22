"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { get, set } from "idb-keyval";
import { ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, BarChart3, Check, ChevronDown, ChevronRight, CircleHelp, Copy, FileSpreadsheet, FileText, Folder, FolderOpen, Layers3, LoaderCircle, Menu, MessageSquare, MoreHorizontal, Paperclip, Plus, Search, ShieldCheck, Sparkles, Square, Trash2, TrendingUp, UploadCloud, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MAX_DATA_CHARS, MAX_FILES, Message, Project, ReviewFile } from "@/lib/types";
import { summarize, statisticalReport } from "@/lib/analysis";
import { REPORT_PROMPT_VERSION, CHAT_ENGINE, clearReport, hasCurrentReport } from "@/lib/report";
import { parseFile } from "@/lib/parse";
import { sampleFiles, templateCSV } from "@/lib/sample";
import { ReviQMark } from "./reviq-mark";
import { ANALYSIS_ENGINE, AnalysisProgress, initialStages, StageStatus } from "./analysis-progress";

type Session = { configured: boolean; authenticated: boolean; passwordRequired: boolean; deploymentBlocked: boolean };
type Modal = "new" | "help" | "files" | "report" | "login" | "rename" | null;
const uid = () => crypto.randomUUID();
const newProject = (name: string): Project => ({ id: uid(), name, createdAt: new Date().toISOString(), files: [], messages: [] });
function download(content: string, name: string, type = "text/markdown;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Markdown({ children }: { children: string }) { return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown></div>; }

export function Workspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState("");
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"upload" | "chat" | "report" | "login" | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sourceId, setSourceId] = useState("all");
  const [reportDraft, setReportDraft] = useState("");
  const [stages, setStages] = useState<StageStatus[]>(initialStages);
  const [copied, setCopied] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const reportInFlight = useRef(false);
  const saveQueue = useRef(Promise.resolve());
  const dialog = useRef<HTMLElement>(null);
  const project = projects.find(p => p.id === activeId);
  const files = project?.files ?? [];
  const selectedFiles = sourceId === "all" ? files : files.filter(f => f.id === sourceId);
  const stats = useMemo(() => summarize(files), [files]);
  const reportReady = hasCurrentReport(project);

  useEffect(() => {
    get<{ projects: Project[]; activeId: string }>("review-studio-v1").then(saved => {
      if (saved?.projects?.length) { setProjects(saved.projects); setActiveId(saved.projects.some(p => p.id === saved.activeId) ? saved.activeId : saved.projects[0].id); }
      else { const p = newProject("첫 번째 프로젝트"); setProjects([p]); setActiveId(p.id); }
    }).catch(() => {
      const p = newProject("첫 번째 프로젝트"); setProjects([p]); setActiveId(p.id);
      setError("브라우저 저장소를 열 수 없습니다. 현재 작업은 새로고침하면 사라질 수 있습니다.");
    }).finally(() => setReady(true));
    fetch("/api/session").then(r => r.json()).then(setSession).catch(() => setError("서버 연결을 확인해주세요."));
    return () => abort.current?.abort();
  }, []);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      saveQueue.current = saveQueue.current.then(() => set("review-studio-v1", { projects, activeId })).catch(() => setError("저장 공간이 부족합니다. 보고서를 다운로드하고 불필요한 프로젝트를 삭제해주세요."));
    }, 300);
    return () => clearTimeout(timer);
  }, [projects, activeId, ready]);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(""), 4500); return () => clearTimeout(timer); } }, [notice]);
  useEffect(() => {
    if (!project?.messages.length) return;
    const el = scroll.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 250) el.scrollTop = el.scrollHeight;
  }, [project?.messages]);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") { setModal(null); setSidebar(false); } };
    window.addEventListener("keydown", fn); return () => window.removeEventListener("keydown", fn);
  }, []);
  useEffect(() => {
    if (!modal || !dialog.current) return;
    const previous = document.activeElement as HTMLElement | null;
    const el = dialog.current;
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, a[href], [tabindex="0"]'));
    if (!el.contains(document.activeElement)) focusables()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const nodes = focusables(); const first = nodes[0]; const last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    el.addEventListener("keydown", trap);
    return () => { el.removeEventListener("keydown", trap); previous?.focus(); };
  }, [modal]);

  useEffect(() => {
    if (!ready || !project?.files.length || !session?.configured || !session.authenticated || session.deploymentBlocked || busy || reportInFlight.current || hasCurrentReport(project)) return;
    if (project.reportState === "failed" || project.reportState === "stopped") return;
    void generateReport(project);
  }, [ready, project, session, busy]);

  function update(id: string, fn: (p: Project) => Project) { setProjects(prev => prev.map(p => p.id === id ? fn(p) : p)); }
  function activate(id: string) { if (busy) return; setActiveId(id); setSourceId("all"); setQuery(""); setError(""); setSidebar(false); }
  function createProject() {
    if (!name.trim()) return;
    if (modal === "rename" && project) update(project.id, p => ({ ...p, name: name.trim() }));
    else { const p = newProject(name.trim()); setProjects(prev => [...prev, p]); setActiveId(p.id); setSourceId("all"); }
    setName(""); setModal(null); setSidebar(false);
  }
  async function upload(incoming: FileList | File[]) {
    if (!project || busy) return;
    const target = project.id;
    setBusy("upload"); setError("");
    const added: ReviewFile[] = []; const issues: string[] = [];
    for (const f of Array.from(incoming)) {
      if (files.length + added.length >= MAX_FILES) { issues.push(`프로젝트당 최대 ${MAX_FILES}개 파일을 올릴 수 있습니다.`); break; }
      if ([...files, ...added].some(existing => existing.name === f.name)) { issues.push(`${f.name}: 같은 이름의 파일이 이미 있습니다.`); continue; }
      try {
        const parsed = await parseFile(f);
        if (JSON.stringify([...files, ...added, parsed].flatMap(f => f.reviews)).length > MAX_DATA_CHARS) throw new Error("프로젝트 분석 용량을 초과했습니다. 새 프로젝트로 나눠주세요.");
        added.push(parsed);
      } catch (e) { issues.push(`${f.name}: ${(e as Error).message}`); }
    }
    if (added.length) {
      update(target, p => clearReport({ ...p, files: [...p.files, ...added] }));
      setNotice(`${added.length}개 파일을 추가했습니다. 분석 보고서를 준비합니다.`);
    }
    setError(issues.join("\n")); setBusy(null);
    if (input.current) input.current.value = "";
  }
  function loadSample() {
    if (busy) return;
    const p = newProject("샘플 · 식품 리뷰 분석"); p.files = sampleFiles();
    setProjects(prev => [...prev, p]); setActiveId(p.id); setSourceId("all"); setNotice("기능 체험용 가상 리뷰 48건을 불러왔습니다.");
  }
  function removeFile(id: string) {
    if (!project || busy) return;
    update(project.id, p => clearReport({ ...p, files: p.files.filter(f => f.id !== id) }));
    if (sourceId === id) setSourceId("all");
  }
  async function requestAI(mode: "chat" | "report", messages: Message[], onText: (text: string) => void, targetProject: Project, inputFiles: ReviewFile[]) {
    setStages(initialStages());
    abort.current = new AbortController();
    const response = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: abort.current.signal,
      body: JSON.stringify({ files: inputFiles, messages: messages.filter(m => !m.preview && m.reportId === targetProject.reportId && m.sourceIds?.slice().sort().join(",") === inputFiles.map(f => f.id).sort().join(",")).slice(-20).map(({ role, content }) => ({ role, content })), mode, title: targetProject.name,
        ...(mode === "chat" ? { report: { id: targetProject.reportId, content: targetProject.report, engine: targetProject.reportEngine, sources: targetProject.reportSources, promptVersion: targetProject.reportPromptVersion } } : {}),
      }),
    });
    if (!response.ok) { if (response.status === 401) setModal("login"); const data = await response.json().catch(() => ({})); throw Object.assign(new Error(data.error || "분석 서버에 연결할 수 없습니다. 서버 실행 상태를 확인해주세요."), { code: data.code }); }
    if (!response.body) throw new Error("서버 응답이 비어 있습니다.");
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    let buffer = ""; let text = ""; let doneEvent = false;
    let reportMetadata: { id: string; sources: Record<string, string>; promptVersion: string } | undefined;
    try { while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.error) throw new Error(event.error);
        if (event.progress && Number.isInteger(event.progress.stage) && event.progress.stage >= 0 && event.progress.stage < 3 && ["running", "completed"].includes(event.progress.status)) {
          setStages(prev => prev.map((status, index) => index === event.progress.stage ? event.progress.status : status));
        }
        if (event.delta) { text += event.delta; onText(text); }
        if (event.done) {
          if (mode === "report") {
            const metadata = event.report;
            doneEvent = event.engine === ANALYSIS_ENGINE && event.completedStages === 3 && metadata?.promptVersion === REPORT_PROMPT_VERSION && typeof metadata?.id === "string" && metadata.id.length > 0 && metadata.sources && Object.keys(metadata.sources).length === inputFiles.length && inputFiles.every(file => typeof metadata.sources[file.id] === "string" && /^[a-f0-9]{64}$/.test(metadata.sources[file.id]));
            if (doneEvent) reportMetadata = metadata;
          } else doneEvent = event.engine === CHAT_ENGINE && event.reportId === targetProject.reportId;
        }
      }
      if (done) break;
    } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!doneEvent || !text.trim()) throw new Error("답변이 완성되지 않았습니다. 다시 시도해주세요.");
    return { text, reportMetadata };
  }
  async function send(prompt = query) {
    if (!project || !prompt.trim() || busy) return;
    if (!selectedFiles.length) { setError("먼저 분석할 리뷰 파일을 올려주세요."); input.current?.click(); return; }
    if (session?.passwordRequired && !session.authenticated) { setModal("login"); return; }
    if (!session?.configured) { setError("AI 대화는 OPENAI_API_KEY 설정 후 사용할 수 있습니다. 지금은 데이터 요약과 통계 보고서를 확인할 수 있어요."); return; }
    if (!hasCurrentReport(project)) { setError("분석 보고서가 준비된 뒤 질문할 수 있어요. 보고서 생성을 완료해주세요."); return; }
    const target = project.id; const aid = uid();
    const user: Message = { id: uid(), role: "user", content: prompt.trim(), sources: selectedFiles.map(f => f.name), sourceIds: selectedFiles.map(f => f.id), reportId: project.reportId };
    const history = [...project.messages, user];
    update(target, p => ({ ...p, messages: [...history, { id: aid, role: "assistant", content: "", sources: selectedFiles.map(f => f.name), sourceIds: selectedFiles.map(f => f.id), reportId: project.reportId }] }));
    setQuery(""); setBusy("chat"); setError("");
    setTimeout(() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }), 100);
    try {
      await requestAI("chat", history, text => update(target, p => ({ ...p, messages: p.messages.map(m => m.id === aid ? { ...m, content: text } : m) })), project, selectedFiles);
      update(target, p => ({ ...p, messages: p.messages.map(m => m.id === aid ? { ...m, engine: CHAT_ENGINE } : m) }));
    } catch (e) {
      const stopped = (e as Error).name === "AbortError";
      update(target, p => ({ ...p, messages: p.messages.map(m => m.id === aid ? { ...m, content: (m.content ? m.content + "\n\n---\n" : "") + (stopped ? "답변 생성을 중지했습니다." : "답변을 완성하지 못했습니다. 다시 질문해주세요."), preview: true } : m) }));
      if ((e as Error & { code?: string }).code === "report_stale") update(target, clearReport);
      if (!stopped) setError((e as Error).message);
      setQuery(prompt);
    } finally { setBusy(null); abort.current = null; }
  }
  async function generateReport(targetProject: Project) {
    if (reportInFlight.current || !targetProject.files.length) return;
    reportInFlight.current = true;
    setBusy("report"); setReportDraft(""); setStages(initialStages());
    update(targetProject.id, p => ({ ...clearReport(p), reportState: "building" }));
    try {
      const result = await requestAI("report", [], setReportDraft, targetProject, targetProject.files);
      if (!result.reportMetadata) throw new Error("보고서의 자료 정보를 확인할 수 없습니다. 다시 생성해주세요.");
      update(targetProject.id, p => ({ ...p, report: result.text, reportKind: "ai", reportEngine: ANALYSIS_ENGINE,
        reportId: result.reportMetadata!.id, reportSources: result.reportMetadata!.sources, reportPromptVersion: result.reportMetadata!.promptVersion, reportState: "ready", reportError: undefined }));
      setNotice("분석 보고서가 준비되었습니다. 이제 보고서와 원문으로 대화할 수 있어요.");
    } catch (e) {
      const stopped = (e as Error).name === "AbortError";
      const message = stopped ? "보고서 생성을 중지했습니다." : (e as Error).message;
      update(targetProject.id, p => ({ ...clearReport(p), reportState: stopped ? "stopped" : "failed", reportError: message }));
      if (!stopped) setError(message);
    } finally { reportInFlight.current = false; setBusy(null); setReportDraft(""); abort.current = null; }
  }
  async function makeReport() {
    if (!project || !files.length || (busy && busy !== "report")) return;
    setModal("report");
    if (busy === "report" || hasCurrentReport(project)) return;
    if (!session?.configured) {
      update(project.id, p => ({ ...clearReport(p), report: statisticalReport(files, p.name), reportKind: "preview" })); return;
    }
    if (!session.authenticated) { setModal("login"); return; }
    if (project.reportState === "failed" || project.reportState === "stopped") return;
    await generateReport(project);
  }
  function retryReport() {
    if (!project || busy) return;
    if (!session?.authenticated) { setModal("login"); return; }
    setError("");
    void generateReport(project);
  }
  async function login() {
    setBusy("login"); setError("");
    try {
      const response = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setSession(prev => prev ? { ...prev, authenticated: true } : prev); setPassword(""); setModal(null); setNotice("워크스페이스에 연결되었습니다.");
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }
  function localSummary() {
    if (!project || !files.length || busy) return;
    update(project.id, p => ({ ...p, messages: [...p.messages, { id: uid(), role: "assistant", content: statisticalReport(selectedFiles, p.name), preview: true, sources: selectedFiles.map(f => f.name) }] }));
  }

  if (!ready) return <div className="loading-screen"><ReviQMark size={36} /><span>ReviQ</span><LoaderCircle className="spin" size={18} /></div>;
  return <div className="app-shell">
    {sidebar && <button className="sidebar-backdrop" aria-label="메뉴 닫기" onClick={() => setSidebar(false)} />}
    <aside className={`sidebar ${sidebar ? "open" : ""}`}>
      <a className="brand" href="/" aria-label="ReviQ 홈"><ReviQMark size={34} /><span>ReviQ</span><span className="brand-label">리뷰 AI</span></a>
      <button className="new-project" disabled={!!busy} onClick={() => { setName(""); setModal("new"); }}><Plus size={17} />새 프로젝트</button>
      <label className="search"><Search size={16} /><input placeholder="프로젝트 검색" aria-label="프로젝트 검색" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div className="sidebar-heading">워크스페이스<span>{projects.length}</span></div>
      <nav className="project-list" aria-label="프로젝트">
        {projects.filter(p => p.name.toLowerCase().includes(search.toLowerCase())).map(p => <button key={p.id} disabled={!!busy} onClick={() => activate(p.id)} className={`project-item ${p.id === activeId ? "active" : ""}`}>
          {p.id === activeId ? <FolderOpen size={17} /> : <Folder size={17} />}<span>{p.name}</span>{p.id === activeId && <ChevronRight size={14} />}
        </button>)}
        {search && !projects.some(p => p.name.toLowerCase().includes(search.toLowerCase())) && <p className="muted search-empty">검색 결과가 없습니다.</p>}
      </nav>
      <div className="sidebar-files">
        <div className="sidebar-heading">프로젝트 파일<span>{files.length} / {MAX_FILES}</span></div>
        {files.map(f => <div className="side-file" key={f.id}><FileSpreadsheet size={17} /><button title={f.name} onClick={() => { setSourceId(f.id); setModal("files"); }}><span>{f.name}</span><small>{f.reviews.length.toLocaleString()}개 리뷰</small></button><button className="icon-button remove-file" disabled={!!busy} onClick={() => removeFile(f.id)} aria-label={`${f.name} 삭제`}><X size={13} /></button></div>)}
        {(reportReady || busy === "report") && <div className="side-file generated-report"><FileText size={17} /><button disabled={!!busy && busy !== "report"} onClick={makeReport}><span>분석 보고서.md</span><small>{busy === "report" ? "자동 생성 중" : "원문과 함께 채팅에 사용"}</small></button></div>}
        <button className="add-file" disabled={!!busy} onClick={() => input.current?.click()}><Plus size={15} />파일 추가</button>
        {!files.length && <p className="file-hint">분석할 파일을 모아두세요.<br />프로젝트 안에서 함께 분석합니다.</p>}
      </div>
      <div className="sidebar-bottom">
        <div className="storage-note"><ShieldCheck size={17} /><span>나만의 리뷰 워크스페이스<small>이 브라우저에 자동 저장됩니다</small></span></div>
        <button className="help-button" onClick={() => setModal("help")}><CircleHelp size={17} />사용 가이드<ArrowRight size={14} /></button>
        <div className="profile"><span className="avatar">나</span><span>내 워크스페이스<small>Personal workspace</small></span><button className="icon-button" aria-label="프로젝트 관리" onClick={() => { setName(project?.name ?? ""); setModal("rename"); }}><MoreHorizontal size={19} /></button></div>
      </div>
    </aside>

    <main className="main" onDragOver={e => { e.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDrop={e => { e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files); }}>
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" onClick={() => setSidebar(true)} aria-label="메뉴 열기"><Menu size={20} /></button><FolderOpen size={17} /><button disabled={!!busy} onClick={() => { setName(project?.name ?? ""); setModal("rename"); }}>{project?.name}</button><ChevronDown size={14} /><span className="private-badge">개인 프로젝트</span></div>
        <button className="report-button" disabled={!files.length || (!!busy && busy !== "report")} onClick={makeReport}><ArrowDownToLine size={16} /><span>보고서 다운로드</span></button>
      </header>
      <div className="context-bar"><div><span className={`status-dot ${session?.configured ? "connected" : ""}`} />{session?.configured ? "보고서 기반 대화" : "통계 미리보기"}<span className="context-divider" />파일 {files.length}개 연결됨</div><button onClick={() => setModal("files")}>분석 자료 보기<ChevronRight size={13} /></button></div>

      {files.length > 0 && session?.configured && <div className="report-status" role="status" aria-label="분석 보고서 상태">
        {busy === "report" ? <><LoaderCircle size={15} className="spin" /><span>보고서를 만들고 있어요 · {stages[1] === "running" ? "원인 추적" : stages[2] === "running" ? "보고서 작성" : "정량 분석"}</span><button onClick={() => setModal("report")}>진행 보기</button></> : reportReady ? <><FileText size={15} /><span>보고서 준비 완료 · 보고서와 원문을 함께 참고합니다</span><button onClick={makeReport}>보고서 보기</button></> : <><FileText size={15} /><span>{project?.reportState === "failed" ? "보고서 생성에 실패했습니다" : project?.reportState === "stopped" ? "보고서 생성이 중지되었습니다" : "대화 전에 분석 보고서를 준비해주세요"}</span><button disabled={!!busy} onClick={retryReport}>{!session.authenticated ? "로그인" : "보고서 생성"}</button></>}
      </div>}

      <div className="conversation-scroll" ref={scroll}>
        {project?.messages.length ? <div className="messages"><div className="conversation-date">{new Date().toLocaleDateString("ko-KR", { month: "long", day: "numeric" })} · {project.name}</div>{project.messages.map(message => <article className={`message ${message.role}`} key={message.id}>
          {message.role === "assistant" && <div className="assistant-heading"><ReviQMark size={28} />ReviQ{message.preview ? <small>통계 · 시스템 안내</small> : message.engine === CHAT_ENGINE ? <small>보고서 + 원문 기반</small> : message.engine === ANALYSIS_ENGINE && <small>3개 에이전트 분석</small>}</div>}
          <div className="message-content">{message.content ? <Markdown>{message.content}</Markdown> : busy === "chat" && message.id === project.messages.at(-1)?.id ? <div className="thinking"><span /><span /><span />보고서와 원문을 확인하고 있어요</div> : <p>분석이 중단되었습니다. 다시 질문해주세요.</p>}</div>
          {message.role === "assistant" && message.content && <div className="message-meta"><span><FileSpreadsheet size={12} />{message.sources?.length ?? 0}개 파일 기반</span><button className="icon-button" aria-label="답변 복사" onClick={async () => { try { await navigator.clipboard.writeText(message.content); setCopied(message.id); setTimeout(() => setCopied(""), 2000); } catch { setError("클립보드에 접근할 수 없습니다."); } }}>{copied === message.id ? <Check size={14} /> : <Copy size={14} />}</button></div>}
        </article>)}</div> : <div className="welcome">
          <div className="welcome-logo"><ReviQMark size={44} /><span>ReviQ</span></div>
          <h1>리뷰에 <span>질문하세요.</span></h1>
          <p className="welcome-description">흩어진 고객의 목소리, 명확한 인사이트로.<br />리뷰 파일을 올리면 ReviQ와 대화할 준비가 끝나요.</p>
          <div className={`upload-card ${files.length ? "has-files" : ""}`}>
            <div className="upload-icon">{files.length ? <Check size={23} /> : <UploadCloud size={25} strokeWidth={1.6} />}</div>
            <div className="upload-copy"><h2>{files.length ? `${files.length}개 파일, 분석 준비 완료` : "어떤 리뷰를 살펴볼까요?"}</h2><p>{files.length ? `${stats.count.toLocaleString()}건의 고객 목소리에서 인사이트를 발견하세요.` : "리뷰 파일을 여기에 끌어놓거나 직접 선택하세요."}</p></div>
            <button className="primary-button" disabled={!!busy} onClick={() => input.current?.click()}>{busy === "upload" ? <LoaderCircle className="spin" size={15} /> : <Plus size={16} />}{files.length ? "파일 추가" : "파일 선택"}</button>
            <div className="upload-foot"><span><FileSpreadsheet size={13} />XLSX, CSV · 파일당 최대 10MB</span><button onClick={() => download(templateCSV(), "리뷰_업로드_양식.csv", "text/csv;charset=utf-8")}>업로드 양식<ArrowDown size={12} /></button></div>
          </div>
          {files.length > 0 && <div className="stats-strip"><div><span>전체 리뷰</span><strong>{stats.count.toLocaleString()}<small>건</small></strong></div><div><span>평균 별점</span><strong>{stats.average.toFixed(2)}<small>/ 5</small></strong></div><div><span>긍정 리뷰</span><strong className="metric-positive">{stats.positiveRate}<small>%</small></strong></div><div><span>분석 상품</span><strong>{stats.products.length}<small>개</small></strong></div></div>}
          <div className="suggestion-heading"><Sparkles size={14} /><span>이렇게 시작해보세요</span><span className="suggestion-line" /></div>
          <div className="suggestions">{[
            { icon: BarChart3, title: "핵심 인사이트 요약", text: "전체 리뷰의 주요 특징을 정리해줘" },
            { icon: MessageSquare, title: "고객의 진짜 목소리", text: "고객이 가장 아쉬워하는 점은 뭐야?" },
            { icon: TrendingUp, title: "상품별 비교 분석", text: "상품별 평점과 개선점을 비교해줘" },
          ].map(item => <button key={item.title} className="suggestion" disabled={!!busy} onClick={() => { setQuery(item.text); textarea.current?.focus(); }}><span className="suggestion-icon"><item.icon size={18} /></span><strong>{item.title}</strong><span>{item.text}</span><ArrowRight className="suggestion-arrow" size={15} /></button>)}</div>
          <div className="sample-prompt">{files.length ? <><span>숫자로 먼저 확인하고 싶다면</span><button onClick={localSummary}>데이터 요약 보기<ArrowRight size={13} /></button></> : <><span>먼저 둘러보고 싶으신가요?</span><button disabled={!!busy} onClick={loadSample}>샘플 데이터로 체험하기<ArrowRight size={13} /></button></>}</div>
        </div>}
      </div>

      <div className="composer-area">
        {session?.deploymentBlocked && <div className="inline-notice">Vercel 환경 변수에 APP_PASSWORD를 설정하면 AI 기능이 활성화됩니다.</div>}
        {error && <div role="alert" className="error-notice"><span>{error}</span><button className="icon-button" aria-label="오류 닫기" onClick={() => setError("")}><X size={15} /></button></div>}
        <form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}>
          <textarea ref={textarea} aria-label="리뷰 데이터에 질문하기" placeholder={busy === "report" ? "보고서를 준비하고 있어요. 질문을 미리 입력해두세요." : files.length ? "ReviQ에게 리뷰에 대해 무엇이든 물어보세요" : "ReviQ에게 물어보세요. 파일 첨부로 시작할 수 있어요."} value={query} maxLength={8000} rows={2} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
          <div className="composer-bottom"><div><button type="button" className="icon-button attach-button" disabled={!!busy} onClick={() => input.current?.click()} aria-label="파일 첨부"><Paperclip size={19} /></button><span className="composer-separator" /><div className="source-select"><Layers3 size={14} /><select aria-label="분석할 파일 선택" value={sourceId} onChange={e => setSourceId(e.target.value)} disabled={!!busy}><option value="all">전체 파일</option>{files.map(f => <option value={f.id} key={f.id}>{f.name}</option>)}</select><ChevronDown size={12} /></div></div><div><span className="enter-hint">Enter로 전송</span>{busy === "chat" || busy === "report" ? <button className="send-button" type="button" aria-label="생성 중지" onClick={() => abort.current?.abort()}><Square size={15} fill="currentColor" /></button> : <button type="submit" className="send-button" aria-label="질문 보내기" disabled={!query.trim() || !!busy || (!!session?.configured && !reportReady)}><ArrowUp size={20} /></button>}</div></div>
        </form>
        <p className="composer-disclaimer"><ShieldCheck size={12} />업로드한 자료를 기반으로 답변합니다. 중요한 내용은 원본 데이터와 함께 확인하세요.</p>
      </div>
      {dragging && <div className="drop-overlay"><UploadCloud size={48} /><h2>파일을 놓아 프로젝트에 추가하세요</h2><p>Excel · CSV 리뷰 데이터</p></div>}
    </main>
    <input ref={input} type="file" accept=".xlsx,.csv" multiple hidden onChange={e => { if (e.target.files) void upload(e.target.files); }} />
    {notice && <div className="toast" role="status"><Check size={17} />{notice}</div>}

    {modal && <div className="modal-overlay" onClick={() => setModal(null)}><section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="modal-title" className={`modal ${modal === "report" || modal === "files" ? "wide" : ""}`} onClick={e => e.stopPropagation()}>
      <div className="modal-header"><h2 id="modal-title">{{ new: "새 프로젝트", rename: "프로젝트 관리", help: "ReviQ 사용 가이드", files: "프로젝트 분석 자료", report: "분석 보고서", login: "워크스페이스 연결" }[modal]}</h2><button className="icon-button" aria-label="닫기" onClick={() => setModal(null)}><X size={20} /></button></div>
      {(modal === "new" || modal === "rename") && <form onSubmit={e => { e.preventDefault(); createProject(); }}><p className="modal-description">함께 분석할 파일과 대화를 하나의 프로젝트에 모으세요.</p><label className="field-label" htmlFor="project-name">프로젝트 이름</label><input id="project-name" className="text-input" value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="예: 9월 식품 리뷰 분석" autoFocus required /><div className="modal-actions">{modal === "rename" && <button type="button" className="danger-button" disabled={!!busy} onClick={() => { if (!project || !window.confirm(`'${project.name}'의 파일과 대화를 모두 삭제할까요?`)) return; const remaining = projects.filter(p => p.id !== activeId); if (!remaining.length) remaining.push(newProject("첫 번째 프로젝트")); setProjects(remaining); setActiveId(remaining[0].id); setSourceId("all"); setModal(null); }}><Trash2 size={14} />프로젝트 삭제</button>}<button type="submit" className="primary-button" disabled={!name.trim() || !!busy}>{modal === "new" ? "프로젝트 만들기" : "이름 저장"}<ArrowRight size={15} /></button></div></form>}
      {modal === "help" && <div className="guide"><div><span>01</span><section><h3>프로젝트를 만들고 파일을 추가하세요</h3><p>.xlsx와 .csv 파일을 최대 10개까지 올릴 수 있습니다. 모든 시트에 필수 열이 있어야 하며, 파일당 최대 5,000개 리뷰를 지원합니다.</p></section></div><div><span>02</span><section><h3>자료를 선택하고 대화하세요</h3><p>전체 파일을 함께 분석하거나 입력창에서 파일 하나를 선택할 수 있습니다. 파일을 올리면 정량 분석·원인 추적·최종 작성 에이전트가 보고서를 만듭니다. 이후 질문에는 저장된 보고서와 선택한 원문을 함께 참고해 빠르게 답합니다. 긍정은 4~5점, 중립은 3점, 부정은 1~2점으로 집계합니다.</p></section></div><div><span>03</span><section><h3>분석 결과를 보고서로 저장하세요</h3><p>오른쪽 위에서 전체 프로젝트 보고서를 생성하고 Markdown으로 다운로드하세요. PDF는 보고서의 인쇄 버튼에서 저장할 수 있습니다.</p></section></div><div className="guide-note"><strong>데이터와 AI 연결</strong><p>프로젝트와 대화는 현재 브라우저에 저장됩니다. 기기 간 동기화는 지원하지 않습니다. AI 연결 상태에서 파일을 올리면 보고서 생성을 위해 프로젝트 리뷰가 서버와 OpenAI로 전송됩니다. 채팅에는 저장된 보고서와 선택한 리뷰가 함께 전송됩니다.</p><p>AI 기능은 서버의 OPENAI_API_KEY가 필요합니다. 연결 전에도 업로드, 통계 요약, 통계 보고서 다운로드를 사용할 수 있습니다. 프로젝트 분석 데이터는 160,000자까지 지원하며 초과 시 안내합니다.</p></div><button className="secondary-button" onClick={() => download(templateCSV(), "리뷰_업로드_양식.csv", "text/csv;charset=utf-8")}><ArrowDownToLine size={15} />업로드 양식 다운로드</button></div>}
      {modal === "login" && <form onSubmit={e => { e.preventDefault(); void login(); }}><p className="modal-description">AI 기능을 사용하려면 워크스페이스 비밀번호를 입력해주세요.</p><input className="text-input" type="password" autoComplete="current-password" aria-label="워크스페이스 비밀번호" placeholder="비밀번호" value={password} onChange={e => setPassword(e.target.value)} autoFocus required />{error && <p className="login-error">{error}</p>}<div className="modal-actions"><button className="primary-button" disabled={!!busy}>{busy === "login" && <LoaderCircle size={15} className="spin" />}연결하기</button></div></form>}
      {modal === "files" && <div className="file-details"><p className="modal-description">{files.length}개 파일 · 총 {stats.count.toLocaleString()}개 리뷰 · {stats.startDate} ~ {stats.endDate}</p>{!files.length ? <div className="empty-files"><FileSpreadsheet size={35} /><p>아직 추가한 파일이 없어요.</p><button className="primary-button" onClick={() => input.current?.click()}>파일 선택</button></div> : files.map(f => <div className="detail-file" key={f.id}><div><FileSpreadsheet size={22} /><span><strong>{f.name}</strong><small>{f.reviews.length}개 리뷰 · {(f.size / 1024).toFixed(1)} KB · {new Set(f.reviews.map(r => r.sheet)).size}개 시트</small></span><button className="icon-button" disabled={!!busy} aria-label={`${f.name} 삭제`} onClick={() => removeFile(f.id)}><Trash2 size={16} /></button></div><div className="table-scroll"><table><thead><tr><th>상품</th><th>날짜</th><th>별점</th><th>리뷰 원문</th></tr></thead><tbody>{f.reviews.slice(0, 5).map((r, i) => <tr key={i}><td>{r.product}</td><td>{r.date}</td><td>{r.rating}</td><td>{r.text}</td></tr>)}</tbody></table></div><small className="muted">미리보기: 처음 {Math.min(5, f.reviews.length)}개 행 · 분석에는 모든 행을 사용합니다.</small></div>)}</div>}
      {modal === "report" && <><div className="report-toolbar"><span><FileText size={15} />{busy === "report" ? "보고서를 작성하고 있어요…" : project?.reportKind === "ai" ? "멀티에이전트 종합 분석 보고서" : "전체 데이터 통계 보고서"}</span><div>{busy === "report" ? <button className="secondary-button" onClick={() => abort.current?.abort()}>생성 중지</button> : <><button className="secondary-button" disabled={!project?.report} onClick={() => window.print()}>인쇄 / PDF</button><button className="primary-button" disabled={!project?.report} onClick={() => download(project!.report!, `${project!.name.replace(/[\\/:*?"<>|]/g, "_")}_보고서.md`)}><ArrowDownToLine size={14} />다운로드 .md</button></>}</div></div><div className="report-body">{busy === "report" && <AnalysisProgress statuses={stages} />}{project?.report || reportDraft ? <Markdown>{project?.report || reportDraft}</Markdown> : busy === "report" ? null : <div className="report-loading"><p>{project?.reportError || error || "보고서를 생성할 수 없습니다."}</p><button className="primary-button" onClick={retryReport}>다시 시도</button></div>}</div></>}
    </section></div>}
  </div>;
}
