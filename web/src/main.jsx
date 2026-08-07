import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Download,
  FileText,
  Filter,
  Hash,
  KeyRound,
  ListPlus,
  LoaderCircle,
  Mail,
  MailCheck,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Smartphone,
  PhoneIncoming,
  Trash2,
  X,
} from "lucide-react";
import "./styles.css";

const POLL_INTERVAL_MS = 900;
const LUBAN_API_KEY_STORAGE_KEY = "chatgpt-onboarding.luban-api-key";
const LUBAN_SERVICE_ID_STORAGE_KEY = "chatgpt-onboarding.luban-service-id";

function App() {
  const [token, setToken] = useState("");
  const [features, setFeatures] = useState({});
  const [jobs, setJobs] = useState([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [filterError, setFilterError] = useState("");
  const [emailFilter, setEmailFilter] = useState([]);
  const [error, setError] = useState("");
  const [expandedJobId, setExpandedJobId] = useState(null);
  const [selectedJobIds, setSelectedJobIds] = useState(() => new Set());
  const [jobSelectionIndex, setJobSelectionIndex] = useState([]);
  const [batchAction, setBatchAction] = useState("");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  const [stats, setStats] = useState({ active: 0, queued: 0, completed: 0 });
  const [lubanApiKey, setLubanApiKey] = useState(() => readLocalSetting(LUBAN_API_KEY_STORAGE_KEY));
  const [lubanServiceId, setLubanServiceId] = useState(() => readLocalSetting(LUBAN_SERVICE_ID_STORAGE_KEY));

  useEffect(() => writeLocalSetting(LUBAN_API_KEY_STORAGE_KEY, lubanApiKey), [lubanApiKey]);
  useEffect(() => writeLocalSetting(LUBAN_SERVICE_ID_STORAGE_KEY, lubanServiceId), [lubanServiceId]);

  useEffect(() => {
    let stopped = false;
    fetch("/api/bootstrap")
      .then(readResponse)
      .then((data) => {
        if (!stopped) {
          setToken(data.token);
          setFeatures(data.features || {});
        }
      })
      .catch((requestError) => setError(requestError.message));
    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    if (!token) return undefined;
    let stopped = false;
    let timer;
    const poll = async () => {
      try {
        const data = emailFilter.length
          ? await apiFetch(token, "/api/jobs/query", {
              method: "POST",
              body: JSON.stringify({ page, emails: emailFilter }),
            })
          : await apiFetch(token, `/api/jobs?page=${page}`);
        if (!stopped) {
          setJobs(data.jobs);
          setJobSelectionIndex(data.selection || data.jobs);
          setPagination(data.pagination || { page, pageSize: 20, total: data.jobs.length, totalPages: 1 });
          setStats(data.stats || { active: 0, queued: 0, completed: 0 });
          if (data.pagination?.page && data.pagination.page !== page) setPage(data.pagination.page);
          setError("");
        }
      } catch (requestError) {
        if (!stopped) setError(requestError.message);
      } finally {
        if (!stopped) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [token, page, emailFilter]);

  const pageJobIds = useMemo(() => jobs.map((job) => job.id), [jobs]);
  const selectedJobs = useMemo(
    () => jobSelectionIndex.filter((job) => selectedJobIds.has(job.id)),
    [jobSelectionIndex, selectedJobIds],
  );
  const downloadableSelectedCount = selectedJobs.filter((job) => job.canDownload).length;
  const allPageSelected = pageJobIds.length > 0 && pageJobIds.every((id) => selectedJobIds.has(id));
  const canDownloadSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && downloadableSelectedCount > 0;
  const canReauthorizeSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && selectedJobs.every((job) => job.canRegenerate || job.canRetry);

  useEffect(() => {
    const valid = new Set(jobSelectionIndex.map((job) => job.id));
    setSelectedJobIds((current) => {
      const next = new Set([...current].filter((id) => valid.has(id)));
      if (next.size === current.size && [...next].every((id) => current.has(id))) return current;
      return next;
    });
  }, [jobSelectionIndex]);

  useEffect(() => {
    setExpandedJobId(null);
  }, [page]);

  async function createJob(event) {
    event.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    try {
      const data = await apiFetch(token, "/api/jobs", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      });
      setPage(1);
      if (page === 1) setJobs((current) => mergeJobs([data.job], current).slice(0, 20));
      setEmail("");
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function createBatch(event) {
    event.preventDefault();
    if (!batchText.trim() || batchBusy) return;
    setBatchBusy(true);
    try {
      const data = await apiFetch(token, "/api/jobs/batch", {
        method: "POST",
        body: JSON.stringify({ text: batchText }),
      });
      setPage(1);
      if (page === 1) setJobs((current) => mergeJobs(data.jobs, current).slice(0, 20));
      setBatchText("");
      setBatchError("");
      setBatchOpen(false);
      setError("");
    } catch (requestError) {
      setBatchError(requestError.message);
    } finally {
      setBatchBusy(false);
    }
  }

  function applyEmailFilter(event) {
    event.preventDefault();
    try {
      const emails = parseEmailFilter(filterText);
      setEmailFilter(emails);
      setSelectedJobIds(new Set());
      setExpandedJobId(null);
      setPage(1);
      setFilterError("");
      setFilterOpen(false);
    } catch (filterParseError) {
      setFilterError(filterParseError.message);
    }
  }

  function clearEmailFilter() {
    setEmailFilter([]);
    setFilterText("");
    setSelectedJobIds(new Set());
    setExpandedJobId(null);
    setPage(1);
    setFilterError("");
  }

  function toggleJobSelection(jobId) {
    setSelectedJobIds((current) => {
      const next = new Set(current);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  function toggleAllOnPage() {
    setSelectedJobIds((current) => {
      const next = new Set(current);
      pageJobIds.forEach((id) => {
        if (allPageSelected) next.delete(id);
        else next.add(id);
      });
      return next;
    });
  }

  async function downloadSelected() {
    if (!canDownloadSelected || batchAction) return;
    setBatchAction("download");
    try {
      const response = await fetch("/api/jobs/download-batch", {
        method: "POST",
        headers: { "content-type": "application/json", "x-console-token": token },
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "批量下载失败");
      await saveDownloadResponse(response, `sub2api-import-oauth-${downloadableSelectedCount}-accounts-${localTimestamp()}.json`);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function reauthorizeSelected() {
    if (!canReauthorizeSelected || batchAction) return;
    setBatchAction("reauthorize");
    try {
      await apiFetch(token, "/api/jobs/reauthorize-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function exportSelectedSource() {
    if (!selectedJobIds.size || batchAction) return;
    setBatchAction("source");
    try {
      const response = await fetch("/api/jobs/export-source", {
        method: "POST",
        headers: { "content-type": "application/json", "x-console-token": token },
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "原始信息导出失败");
      await saveDownloadResponse(response, `chatgpt-account-source-${selectedJobIds.size}-accounts-${localTimestamp()}.txt`);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function deleteSelected() {
    if (!selectedJobIds.size || batchAction) return;
    if (!window.confirm(`确定删除选中的 ${selectedJobIds.size} 条任务吗？对应的本地授权文件也会被删除。`)) return;
    setBatchAction("delete");
    try {
      await apiFetch(token, "/api/jobs/delete-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      setJobs((current) => current.filter((job) => !selectedJobIds.has(job.id)));
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function cancelAllRunningJobs() {
    const runningCount = (stats.active || 0) + (stats.queued || 0);
    if (!runningCount || batchAction) return;
    if (!window.confirm(`确定停止全部 ${runningCount} 条进行中和排队任务吗？`)) return;
    setBatchAction("cancel-all");
    try {
      await apiFetch(token, "/api/jobs/cancel-all", { method: "POST" });
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark"><ShieldCheck size={21} strokeWidth={2.2} /></div>
          <div>
            <h1>ChatGPT 账号授权控制台</h1>
            <p>本地多任务协议登录</p>
          </div>
        </div>
        <div className="summary" aria-label="任务统计">
          <span><i className="status-dot active" />进行中 <strong>{stats.active}</strong></span>
          <span><i className="status-dot queued" />排队中 <strong>{stats.queued || 0}</strong></span>
          <span><i className="status-dot complete" />已完成 <strong>{stats.completed}</strong></span>
        </div>
      </header>

      <section className="workspace">
        <div className="section-heading">
          <div>
            <h2>授权任务</h2>
            <p>{emailFilter.length
              ? `匹配 ${pagination.total} 条，共 ${pagination.totalAll ?? pagination.total} 条任务`
              : (pagination.total ? `共 ${pagination.total} 条任务` : "添加邮箱后开始第一条任务")}</p>
          </div>
          <form className="add-form" onSubmit={createJob}>
            <div className="email-field">
              <Mail size={17} aria-hidden="true" />
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="输入邮箱地址"
                autoComplete="email"
                aria-label="邮箱地址"
                required
              />
            </div>
            <button className="primary-button" type="submit" disabled={!token || busy}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}
              添加任务
            </button>
            <button className="secondary-button" type="button" onClick={() => { setBatchError(""); setBatchOpen(true); }} disabled={!token}>
              <ListPlus size={17} />
              批量添加
            </button>
            <button
              className={`secondary-button ${emailFilter.length ? "filter-active" : ""}`}
              type="button"
              onClick={() => { setFilterError(""); setFilterText(emailFilter.join("\n")); setFilterOpen(true); }}
              disabled={!token}
            >
              <Filter size={17} />
              {emailFilter.length ? `筛选 ${emailFilter.length}` : "筛选账号"}
            </button>
            {emailFilter.length > 0 && (
              <button className="selection-text-button clear-filter-button" type="button" onClick={clearEmailFilter}>
                清除筛选
              </button>
            )}
          </form>
        </div>

        <div className="provider-toolbar" aria-label="LubanSMS 接码配置">
          <div className="provider-heading"><PhoneIncoming size={17} /><strong>LubanSMS 接码</strong><span>配置会保存在当前浏览器</span></div>
          <label className="provider-field">
            <KeyRound size={15} />
            <input
              type="password"
              value={lubanApiKey}
              onChange={(event) => setLubanApiKey(event.target.value)}
              placeholder="API Key"
              aria-label="LubanSMS API Key"
              autoComplete="off"
            />
          </label>
          <label className="provider-field service-field">
            <Hash size={15} />
            <input
              value={lubanServiceId}
              onChange={(event) => setLubanServiceId(event.target.value)}
              placeholder="供应商编号"
              aria-label="LubanSMS 供应商编号"
              autoComplete="off"
            />
          </label>
          {lubanApiKey && lubanServiceId && <span className="provider-ready"><Check size={14} />已就绪</span>}
        </div>

        {error && (
          <div className="global-error" role="alert">
            <CircleAlert size={17} />
            <span>{error}</span>
            <button type="button" onClick={() => setError("")} title="关闭"><X size={16} /></button>
          </div>
        )}

        {features.bulkActions && jobs.length > 0 && (
          <div className="selection-toolbar">
            <div className="selection-summary">
              <span>当前页 {jobs.length} 条，跨页已选 {selectedJobIds.size} 条，可下载 {downloadableSelectedCount} 条</span>
              <button type="button" className="selection-text-button" onClick={toggleAllOnPage} disabled={allPageSelected || !pageJobIds.length}>
                本页全选
              </button>
              <button type="button" className="selection-text-button" onClick={() => setSelectedJobIds(new Set())} disabled={!selectedJobIds.size}>
                清除选择
              </button>
            </div>
            <div className="bulk-actions">
              {features.cancelAll && (
                <button
                  type="button"
                  className="stop-all-button"
                  onClick={cancelAllRunningJobs}
                  disabled={!(stats.active || stats.queued) || Boolean(batchAction)}
                >
                  {batchAction === "cancel-all" ? <LoaderCircle className="spin" size={16} /> : <Ban size={16} />}
                  停止全部
                </button>
              )}
              <button type="button" className="download-button" onClick={downloadSelected} disabled={!canDownloadSelected || Boolean(batchAction)}>
                {batchAction === "download" ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
                批量下载
              </button>
              {features.sourceExport && (
                <button type="button" className="secondary-button bulk-button" onClick={exportSelectedSource} disabled={!selectedJobIds.size || Boolean(batchAction)}>
                  {batchAction === "source" ? <LoaderCircle className="spin" size={16} /> : <FileText size={16} />}
                  导出原始信息
                </button>
              )}
              <button type="button" className="regenerate-button bulk-button" onClick={reauthorizeSelected} disabled={!canReauthorizeSelected || Boolean(batchAction)}>
                {batchAction === "reauthorize" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                批量重新授权
              </button>
              <button type="button" className="delete-button" onClick={deleteSelected} disabled={!selectedJobIds.size || Boolean(batchAction)}>
                {batchAction === "delete" ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
                批量删除
              </button>
            </div>
          </div>
        )}

        <div className="table-frame">
          <table>
            <thead>
              <tr>
                <th className="select-heading">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={toggleAllOnPage}
                    disabled={!features.bulkActions || !pageJobIds.length}
                    aria-label="选择当前页全部任务"
                  />
                </th>
                <th>账号</th>
                <th>状态</th>
                <th>当前操作</th>
                <th>开始时间</th>
                <th className="actions-heading">操作</th>
              </tr>
            </thead>
            <tbody>
              {!jobs.length && <EmptyState filtered={emailFilter.length > 0} />}
              {jobs.map((job) => (
                <React.Fragment key={job.id}>
                  <JobRow
                    job={job}
                    token={token}
                    expanded={expandedJobId === job.id}
                    onToggleLogs={() => setExpandedJobId((current) => current === job.id ? null : job.id)}
                    onError={setError}
                    selected={selectedJobIds.has(job.id)}
                    onToggleSelected={() => toggleJobSelection(job.id)}
                    selectionSupported={Boolean(features.bulkActions)}
                    lubanSmsAvailable={Boolean(features.lubanSms)}
                    lubanConfig={{ apiKey: lubanApiKey, serviceId: lubanServiceId }}
                  />
                  {expandedJobId === job.id && (
                    <tr className="log-row">
                      <td colSpan="6"><JobLogs token={token} jobId={job.id} /></td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {features.pagination && pagination.totalPages > 1 && (
          <nav className="pagination" aria-label="任务分页">
            <button type="button" className="icon-button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1} title="上一页">
              <ChevronLeft size={17} />
            </button>
            <span>第 <strong>{pagination.page}</strong> / {pagination.totalPages} 页</span>
            <button type="button" className="icon-button" onClick={() => setPage((current) => Math.min(pagination.totalPages, current + 1))} disabled={page >= pagination.totalPages} title="下一页">
              <ChevronRight size={17} />
            </button>
          </nav>
        )}
      </section>
      {batchOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !batchBusy) setBatchOpen(false);
        }}>
          <form className="batch-dialog" onSubmit={createBatch} role="dialog" aria-modal="true" aria-labelledby="batch-title">
            <div className="dialog-header">
              <div>
                <h2 id="batch-title">批量添加账号</h2>
                <span>{countBatchLines(batchText)} 条，超出并发上限后自动排队</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setBatchOpen(false)} disabled={batchBusy} title="关闭">
                <X size={18} />
              </button>
            </div>
            <label className="batch-label" htmlFor="batch-input">每行一条：邮箱 + 收码接口，或邮箱 + 密码/收码接口 + 2FA 密钥</label>
            <textarea
              id="batch-input"
              value={batchText}
              onChange={(event) => setBatchText(event.target.value)}
              placeholder={"name@icloud.com----https://mail.example/messages/token/name%40icloud.com\nname2@example.com----账号密码----BASE32二步验证密钥\nname3@example.com----https://mail.example/messages/token/name3----BASE32二步验证密钥"}
              spellCheck="false"
              autoFocus
            />
            {batchError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{batchError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setBatchOpen(false)} disabled={batchBusy}>取消</button>
              <button type="submit" className="primary-button" disabled={!batchText.trim() || batchBusy || countBatchLines(batchText) > 500}>
                {batchBusy ? <LoaderCircle className="spin" size={17} /> : <ListPlus size={17} />}
                创建 {countBatchLines(batchText) || ""} 条任务
              </button>
            </div>
          </form>
        </div>
      )}
      {filterOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setFilterOpen(false);
        }}>
          <form className="batch-dialog filter-dialog" onSubmit={applyEmailFilter} role="dialog" aria-modal="true" aria-labelledby="filter-title">
            <div className="dialog-header">
              <div>
                <h2 id="filter-title">筛选账号</h2>
                <span>{countBatchLines(filterText)} 个邮箱</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setFilterOpen(false)} title="关闭">
                <X size={18} />
              </button>
            </div>
            <label className="batch-label" htmlFor="filter-input">每行输入一个完整邮箱地址</label>
            <textarea
              id="filter-input"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              placeholder={"name1@icloud.com\nname2@icloud.com"}
              spellCheck="false"
              autoFocus
            />
            {filterError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{filterError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setFilterOpen(false)}>取消</button>
              <button type="submit" className="primary-button" disabled={!filterText.trim() || countBatchLines(filterText) > 500}>
                <Filter size={17} />应用筛选
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

function EmptyState({ filtered = false }) {
  return (
    <tr>
      <td colSpan="6">
        <div className="empty-state">
          <div><Mail size={24} /></div>
          <h3>{filtered ? "没有匹配账号" : "暂无授权任务"}</h3>
          <p>{filtered ? "当前筛选邮箱不在任务列表中。" : "在右上方输入邮箱地址开始登录。"}</p>
        </div>
      </td>
    </tr>
  );
}

function JobRow({ job, token, expanded, onToggleLogs, onError, selected, onToggleSelected, selectionSupported, lubanSmsAvailable, lubanConfig }) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setValue(""), [job.status]);

  async function sendInput(action, submittedValue = value) {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/input`, {
        method: "POST",
        body: JSON.stringify({ action, value: submittedValue }),
      });
      setValue("");
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/cancel`, { method: "POST" });
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function retry() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/retry`, { method: "POST" });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function regenerate() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/regenerate`, { method: "POST" });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function requestLubanNumber() {
    if (!lubanConfig.apiKey.trim() || !lubanConfig.serviceId.trim()) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/luban-number`, {
        method: "POST",
        body: JSON.stringify({ apiKey: lubanConfig.apiKey.trim(), serviceId: lubanConfig.serviceId.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function download() {
    try {
      const response = await fetch(`/api/jobs/${job.id}/download`, {
        headers: { "x-console-token": token },
      });
      if (!response.ok) throw new Error((await response.json()).error || "下载失败");
      await saveDownloadResponse(response, `${job.email}-sub2api-import-oauth-${localTimestamp()}.json`);
    } catch (requestError) {
      onError(requestError.message);
    }
  }

  const inputConfig = getInputConfig(job.status, job.currentPhone);
  const terminal = ["completed", "failed", "canceled", "reauth_required", "resume_available"].includes(job.status);

  return (
    <tr className={`job-row status-${job.status}`}>
      <td className="select-cell">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          disabled={!selectionSupported}
          aria-label={`选择 ${job.email}`}
        />
      </td>
      <td>
        <div className="account-cell">
          <div className="account-avatar">{job.email.slice(0, 1).toUpperCase()}</div>
          <div className="account-details"><strong>{job.email}</strong><span>{shortId(job.id)}</span></div>
          <LoginMethodBadge job={job} />
        </div>
      </td>
      <td><StatusBadge status={job.status} /></td>
      <td className="step-cell">
        <div className="prompt-line">{job.prompt}</div>
        {job.lastError && <div className="row-error">{extractResponseMessage(job.lastError)}</div>}
        {job.mailApiError && job.status === "email_otp" && <div className="mail-error">{job.mailApiError}</div>}
        {job.currentPhone && ["working", "phone", "phone_otp"].includes(job.status) && (
          <div className="phone-target"><Smartphone size={13} />当前手机号：<strong>{job.currentPhone}</strong></div>
        )}
        {job.phoneError && <div className="phone-error"><CircleAlert size={13} />{job.phoneError}</div>}
        {job.lubanStatus && !["idle", "unavailable"].includes(job.lubanStatus) && (
          <div className={`luban-status ${job.lubanStatus === "error" ? "error" : ""}`}>
            {job.lubanStatus === "error" ? <CircleAlert size={13} /> : <PhoneIncoming size={13} />}
            <span>{lubanStatusText(job)}</span>
          </div>
        )}
        {inputConfig && (
          <div className="inline-entry">
            <div className="compact-input">
              {inputConfig.icon}
              <input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && value && !submitting) sendInput(inputConfig.action);
                }}
                inputMode={inputConfig.inputMode}
                type={inputConfig.type || "text"}
                placeholder={inputConfig.placeholder}
                aria-label={inputConfig.placeholder}
                autoComplete={inputConfig.autoComplete || "one-time-code"}
              />
            </div>
            <button
              type="button"
              className="icon-button submit"
              onClick={() => sendInput(inputConfig.action)}
              disabled={!value || submitting}
              title={inputConfig.submitLabel}
            >
              {submitting ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
            </button>
            {job.status === "email_otp" && (
              <button type="button" className="text-action" onClick={() => sendInput("resend_email", "")} disabled={submitting}>
                <RefreshCw size={14} />重发
              </button>
            )}
            {job.status === "phone_otp" && (
              <>
                <button type="button" className="text-action" onClick={() => sendInput("resend_phone", "")} disabled={submitting}>
                  <RefreshCw size={14} />重发
                </button>
                <button type="button" className="text-action" onClick={() => sendInput("change_phone", "")} disabled={submitting}>
                  <RotateCcw size={14} />换号
                </button>
              </>
            )}
            {job.status === "phone" && lubanSmsAvailable && (
              <>
                <span className="input-separator" aria-hidden="true" />
                <button
                  type="button"
                  className="platform-number-button"
                  onClick={requestLubanNumber}
                  disabled={!lubanConfig.apiKey.trim() || !lubanConfig.serviceId.trim() || submitting || job.lubanStatus === "requesting"}
                  title={lubanConfig.apiKey.trim() && lubanConfig.serviceId.trim() ? "使用上方统一配置取号" : "请先填写上方的 API Key 和供应商编号"}
                >
                  {submitting || job.lubanStatus === "requesting" ? <LoaderCircle className="spin" size={15} /> : <PhoneIncoming size={15} />}
                  平台取号
                </button>
              </>
            )}
          </div>
        )}
      </td>
      <td className="time-cell">{formatTime(job.createdAt)}</td>
      <td>
        <div className="row-actions">
          {job.canDownload && (
            <button type="button" className="download-button" onClick={download}>
              <Download size={16} />下载
            </button>
          )}
          {job.canRegenerate && (
            <button type="button" className="regenerate-button" onClick={regenerate} disabled={submitting} title="优先使用刷新令牌直接生成新授权">
              {submitting ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
              重新生成
            </button>
          )}
          {job.canRetry && (
            <button type="button" className="retry-button" onClick={retry} disabled={submitting}>
              {submitting ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
              {job.securityCheckRequired ? "手动重试" : job.canResume ? "继续流程" : "重新授权"}
            </button>
          )}
          <button type="button" className="icon-button" onClick={onToggleLogs} title={expanded ? "收起日志" : "查看日志"}>
            <FileText size={17} />
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          {!terminal && (
            <button type="button" className="icon-button danger" onClick={cancel} disabled={submitting} title="取消任务">
              <Ban size={17} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function JobLogs({ token, jobId }) {
  const [logs, setLogs] = useState("正在读取日志...");

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const data = await apiFetch(token, `/api/jobs/${jobId}/logs`);
        if (!stopped) setLogs(data.logs || "暂无日志");
      } catch (error) {
        if (!stopped) setLogs(`日志读取失败：${error.message}`);
      }
    };
    load();
    const timer = window.setInterval(load, 1_200);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [jobId, token]);

  return (
    <div className="log-panel">
      <div className="log-title"><FileText size={15} />协议日志</div>
      <pre>{logs}</pre>
    </div>
  );
}

function StatusBadge({ status }) {
  const config = {
    queued: ["排队中", <LoaderCircle size={14} />],
    starting: ["启动中", <LoaderCircle className="spin" size={14} />],
    working: ["处理中", <LoaderCircle className="spin" size={14} />],
    password: ["待密码", <KeyRound size={14} />],
    mfa_otp: ["待 2FA", <ShieldCheck size={14} />],
    email_otp: ["待邮箱码", <Mail size={14} />],
    phone: ["待手机号", <Smartphone size={14} />],
    phone_otp: ["待手机码", <Smartphone size={14} />],
    finalizing: ["生成中", <LoaderCircle className="spin" size={14} />],
    refreshing: ["刷新授权", <RefreshCw className="spin" size={14} />],
    completed: ["已完成", <Check size={14} />],
    failed: ["失败", <CircleAlert size={14} />],
    canceled: ["已取消", <Ban size={14} />],
    reauth_required: ["待重新授权", <RefreshCw size={14} />],
    resume_available: ["可继续", <RotateCcw size={14} />],
  }[status] || [status, null];
  return <span className={`status-badge ${status}`}>{config[1]}{config[0]}</span>;
}

function LoginMethodBadge({ job }) {
  if (job.loginMode === "password") {
    return (
      <span className="mail-mode password-mode">
        {job.hasTotpKey ? <ShieldCheck size={12} /> : <KeyRound size={12} />}
        {job.hasTotpKey ? "密码 + 2FA" : "密码登录"}
      </span>
    );
  }
  if (job.autoEmailOtp) {
    return (
      <span className={`mail-mode ${["error", "timeout"].includes(job.mailStatus) ? "error" : ""}`}>
        {job.hasTotpKey ? <ShieldCheck size={12} /> : <MailCheck size={12} />}
        {job.hasTotpKey ? "自动收码 + 2FA" : "自动收码"}
      </span>
    );
  }
  if (job.loginMode === "manual") {
    return (
      <span className="mail-mode unknown-mode">
        <CircleAlert size={12} />旧任务资料未记录
      </span>
    );
  }
  if (!job.hasTotpKey) return null;
  return (
    <span className="mail-mode">
      <ShieldCheck size={12} />邮箱码 + 2FA
    </span>
  );
}

function getInputConfig(status, currentPhone) {
  if (status === "password") {
    return { action: "password", placeholder: "输入账号密码", submitLabel: "提交密码", inputMode: "text", type: "password", autoComplete: "current-password", icon: <KeyRound size={15} /> };
  }
  if (status === "mfa_otp") {
    return { action: "mfa_otp", placeholder: "6 位 2FA 验证码", submitLabel: "提交 2FA 验证码", inputMode: "numeric", icon: <ShieldCheck size={15} /> };
  }
  if (status === "email_otp") {
    return { action: "email_otp", placeholder: "6 位邮箱验证码", submitLabel: "提交邮箱验证码", inputMode: "numeric", icon: <Mail size={15} /> };
  }
  if (status === "phone") {
    return { action: "phone", placeholder: "+60123456789", submitLabel: "发送手机验证码", inputMode: "tel", icon: <Smartphone size={15} /> };
  }
  if (status === "phone_otp") {
    return { action: "phone_otp", placeholder: currentPhone ? `${currentPhone} 的验证码` : "手机验证码", submitLabel: "提交手机验证码", inputMode: "numeric", icon: <Smartphone size={15} /> };
  }
  return null;
}

function lubanStatusText(job) {
  if (job.lubanError) return `LubanSMS：${job.lubanError}`;
  return {
    requesting: "LubanSMS：正在获取手机号",
    number_acquired: "LubanSMS：已获取手机号，正在发送验证码",
    waiting_sms: "LubanSMS：验证码已发送，正在等待短信",
    submitting: "LubanSMS：已收到验证码，正在自动提交",
    submitted: "LubanSMS：验证码已自动提交",
    manual_submitted: "LubanSMS：已停止自动读取，正在验证手动输入的验证码",
  }[job.lubanStatus] || "LubanSMS：处理中";
}

async function saveDownloadResponse(response, fallbackName) {
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = downloadFilename(response.headers.get("content-disposition")) || fallbackName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

function downloadFilename(contentDisposition) {
  if (!contentDisposition) return "";
  const encodedMatch = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(contentDisposition);
  const plainMatch = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(contentDisposition);
  const rawName = encodedMatch?.[1] || plainMatch?.[1] || plainMatch?.[2] || "";
  try {
    return decodeURIComponent(rawName.trim().replace(/^"|"$/g, "")).replace(/[\\/]/g, "_");
  } catch {
    return rawName.trim().replace(/^"|"$/g, "").replace(/[\\/]/g, "_");
  }
}

function localTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function apiFetch(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-console-token": token,
      ...(options.headers || {}),
    },
  });
  return readResponse(response);
}

async function readResponse(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败：HTTP ${response.status}`);
  return data;
}

function shortId(id) {
  return `任务 ${id.slice(0, 8)}`;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function countBatchLines(value) {
  return String(value || "").split(/\r?\n/).filter((line) => line.trim()).length;
}

function parseEmailFilter(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  if (!lines.length) throw new Error("请至少输入一个筛选邮箱");
  if (lines.length > 500) throw new Error("一次最多筛选 500 个邮箱");
  lines.forEach((email, index) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new Error(`第 ${index + 1} 行邮箱格式错误`);
    }
  });
  return [...new Set(lines)];
}

function extractResponseMessage(value) {
  const text = String(value || "").trim();
  const jsonAt = text.indexOf("{");
  if (jsonAt >= 0) {
    try {
      const payload = JSON.parse(text.slice(jsonAt));
      const message = payload?.error?.message || payload?.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    } catch {}
  }
  const match = text.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (match) {
    try {
      return JSON.parse(`"${match[1]}"`).trim();
    } catch {
      return match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").trim();
    }
  }
  return text;
}

function readLocalSetting(key) {
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeLocalSetting(key, value) {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Private browsing modes may disable localStorage; the current tab still works.
  }
}

function mergeJobs(...groups) {
  const unique = new Map();
  groups.flat().forEach((job) => {
    if (!unique.has(job.id)) unique.set(job.id, job);
  });
  return [...unique.values()];
}

const appRoot = globalThis.__chatgptOnboardingRoot || createRoot(document.getElementById("root"));
globalThis.__chatgptOnboardingRoot = appRoot;
appRoot.render(<App />);
