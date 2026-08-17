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
  Copy,
  Download,
  ExternalLink,
  FileText,
  Filter,
  Globe2,
  KeyRound,
  ListPlus,
  LoaderCircle,
  LogIn,
  Mail,
  MailCheck,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
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
const SMS_PROVIDER_SETTINGS_KEY = "chatgpt-onboarding.sms-provider-settings-v1";
const SUB2API_UPLOAD_SETTINGS_KEY = "chatgpt-onboarding.sub2api-upload-settings-v1";
const ACCOUNT_PROXY_STORAGE_KEY = "chatgpt-onboarding.account-proxy-v1";
const SMS_PROVIDER_EXTERNAL_LINKS = {
  luban: {
    href: "https://lubansms.com/",
    label: "点击获取 API 密钥",
  },
  smsbower: {
    href: "https://smsbower.app/cabinet/profile",
    label: "点击获取 API 密钥",
  },
};
const REGION_NAMES = typeof Intl.DisplayNames === "function"
  ? new Intl.DisplayNames(["zh-CN"], { type: "region" })
  : null;

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
  const [smsSettings, setSmsSettings] = useState(readSmsProviderSettings);
  const [smsSettingsOpen, setSmsSettingsOpen] = useState(false);
  const [smsSettingsDraft, setSmsSettingsDraft] = useState(readSmsProviderSettings);
  const [smsSettingsError, setSmsSettingsError] = useState("");
  const [smsNumberOptions, setSmsNumberOptions] = useState([]);
  const [smsOptionsLoading, setSmsOptionsLoading] = useState(false);
  const [sub2apiSettings, setSub2apiSettings] = useState(readSub2ApiSettings);
  const [sub2apiSettingsDraft, setSub2apiSettingsDraft] = useState(readSub2ApiSettings);
  const [sub2apiGroups, setSub2apiGroups] = useState([]);
  const [sub2apiProxies, setSub2apiProxies] = useState([]);
  const [sub2apiSettingsOpen, setSub2apiSettingsOpen] = useState(false);
  const [sub2apiSettingsError, setSub2apiSettingsError] = useState("");
  const [sub2apiGroupsLoading, setSub2apiGroupsLoading] = useState(false);
  const [sub2apiSettingsSaving, setSub2apiSettingsSaving] = useState(false);
  const [sub2apiMonitorChecking, setSub2apiMonitorChecking] = useState(false);
  const [sub2apiMonitorStatus, setSub2apiMonitorStatus] = useState({
    configured: false,
    enabled: false,
    running: false,
    lastCheckAt: null,
    nextCheckAt: null,
    lastError: null,
    lastResult: null,
    intervalMinutes: 5,
  });
  const [uploadNotice, setUploadNotice] = useState("");
  const [accountProxyUrl, setAccountProxyUrl] = useState(() => readLocalTextSetting(ACCOUNT_PROXY_STORAGE_KEY));

  useEffect(() => writeLocalJson(SMS_PROVIDER_SETTINGS_KEY, smsSettings), [smsSettings]);
  useEffect(() => writeLocalJson(SUB2API_UPLOAD_SETTINGS_KEY, sub2apiSettings), [sub2apiSettings]);
  useEffect(() => writeLocalTextSetting(ACCOUNT_PROXY_STORAGE_KEY, accountProxyUrl.trim()), [accountProxyUrl]);

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

  useEffect(() => {
    if (!token || !features.sub2apiMonitor) return undefined;
    let stopped = false;
    const load = async () => {
      try {
        const data = await apiFetch(token, "/api/sub2api/monitor");
        if (!stopped) {
          setSub2apiMonitorStatus(data);
          setSub2apiSettings((current) => ({ ...current, monitorEnabled: Boolean(data.enabled) }));
        }
      } catch {}
    };
    void load();
    const timer = window.setInterval(load, 5_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [token, features.sub2apiMonitor]);

  const pageJobIds = useMemo(() => jobs.map((job) => job.id), [jobs]);
  const smsProviderDefinitions = Array.isArray(features.smsProviders) ? features.smsProviders : [];
  const activeSmsProvider = useMemo(
    () => resolveSmsProvider(smsProviderDefinitions, smsSettings),
    [smsProviderDefinitions, smsSettings],
  );
  const draftSmsProvider = useMemo(
    () => resolveSmsProvider(smsProviderDefinitions, smsSettingsDraft),
    [smsProviderDefinitions, smsSettingsDraft],
  );
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
  const forceReloginSelectedCount = selectedJobs.filter((job) => job.canForceRelogin).length;
  const canForceReloginSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && forceReloginSelectedCount > 0;
  const canUploadSelected = selectedJobs.length > 0 && downloadableSelectedCount > 0;
  const totpSetupSelectedCount = selectedJobs.filter((job) => job.canSetupTotp).length;
  const canSetupTotpSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && totpSetupSelectedCount > 0;
  const passwordAddSelectedCount = selectedJobs.filter((job) => job.canAddPassword).length;
  const canAddPasswordSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && passwordAddSelectedCount > 0;

  function openSmsSettings() {
    const draft = withSmsProviderDefaults(smsProviderDefinitions, smsSettings);
    setSmsSettingsDraft(draft);
    setSmsSettingsError("");
    setSmsSettingsOpen(true);
  }

  function openSub2ApiSettings() {
    setSub2apiSettingsDraft({ ...sub2apiSettings, monitorEnabled: Boolean(sub2apiMonitorStatus.enabled) });
    setSub2apiSettingsError("");
    setSub2apiSettingsOpen(true);
  }

  async function loadSub2ApiOptions(settings = sub2apiSettingsDraft) {
    setSub2apiGroupsLoading(true);
    setSub2apiSettingsError("");
    try {
      const data = await apiFetch(token, "/api/sub2api/options", {
        method: "POST",
        body: JSON.stringify({ config: settings }),
      });
      setSub2apiGroups(Array.isArray(data.groups) ? data.groups : []);
      setSub2apiProxies(Array.isArray(data.proxies) ? data.proxies : []);
    } catch (requestError) {
      setSub2apiGroups([]);
      setSub2apiProxies([]);
      setSub2apiSettingsError(requestError.message);
    } finally {
      setSub2apiGroupsLoading(false);
    }
  }

  async function saveSub2ApiSettings(event) {
    event.preventDefault();
    const baseUrl = String(sub2apiSettingsDraft.baseUrl || "").trim();
    const adminApiKey = String(sub2apiSettingsDraft.adminApiKey || "").trim();
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      setSub2apiSettingsError("请输入 http:// 或 https:// 开头的 Sub2API 后端地址");
      return;
    }
    if (!adminApiKey) {
      setSub2apiSettingsError("请输入 Sub2API 管理员 API Key");
      return;
    }
    const nextSettings = {
      ...readSub2ApiSettings(sub2apiSettingsDraft),
      baseUrl: baseUrl.replace(/\/+$/, ""),
      adminApiKey,
    };
    setSub2apiSettingsSaving(true);
    try {
      const monitor = await apiFetch(token, "/api/sub2api/monitor", {
        method: "POST",
        body: JSON.stringify({ enabled: nextSettings.monitorEnabled, config: nextSettings }),
      });
      setSub2apiSettings(nextSettings);
      setSub2apiMonitorStatus(monitor);
      setSub2apiSettingsOpen(false);
      setSub2apiSettingsError("");
    } catch (requestError) {
      setSub2apiSettingsError(requestError.message);
    } finally {
      setSub2apiSettingsSaving(false);
    }
  }

  async function checkSub2ApiMonitorNow() {
    if (!sub2apiMonitorStatus.enabled || sub2apiMonitorChecking) return;
    setSub2apiMonitorChecking(true);
    setSub2apiSettingsError("");
    try {
      const data = await apiFetch(token, "/api/sub2api/monitor/check", { method: "POST" });
      setSub2apiMonitorStatus(data);
      setUploadNotice(formatMonitorResult(data.result));
      setError("");
    } catch (requestError) {
      if (sub2apiSettingsOpen) setSub2apiSettingsError(requestError.message);
      else setError(requestError.message);
    } finally {
      setSub2apiMonitorChecking(false);
    }
  }

  function setSub2ApiGroupChecked(groupId, checked) {
    setSub2apiSettingsDraft((current) => {
      const selected = new Set(current.groupIds);
      if (checked) selected.add(String(groupId));
      else selected.delete(String(groupId));
      return { ...current, groupIds: [...selected] };
    });
  }

  async function uploadSelected(ids) {
    if (!sub2apiSettings.baseUrl || !sub2apiSettings.adminApiKey) {
      openSub2ApiSettings();
      setUploadNotice("请先配置 Sub2API 后端地址、管理员 API Key 和目标号池");
      return;
    }
    if (batchAction) return;
    setBatchAction("upload");
    setUploadNotice("");
    try {
      const data = await apiFetch(token, "/api/sub2api/upload", {
        method: "POST",
        body: JSON.stringify({ ids, config: sub2apiSettings }),
      });
      const result = data.result || {};
      const created = result.account_created ?? result.success ?? data.uploaded;
      const failed = result.account_failed ?? result.failed ?? 0;
      setUploadNotice(`已上传 ${created} 条${failed ? `，失败 ${failed} 条` : ""}${data.skipped ? `，跳过未完成任务 ${data.skipped} 条` : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function loadSmsNumberOptions(settings = smsSettingsDraft) {
    const resolved = resolveSmsProvider(smsProviderDefinitions, settings);
    if (!resolved.definition?.optionsEndpoint) return;
    if (!String(resolved.config.apiKey || "").trim()) {
      setSmsSettingsError("请先填写 API Key");
      return;
    }
    setSmsOptionsLoading(true);
    setSmsSettingsError("");
    try {
      const data = await apiFetch(token, resolved.definition.optionsEndpoint, {
        method: "POST",
        body: JSON.stringify({ config: resolved.config }),
      });
      const options = Array.isArray(data.options) ? data.options : [];
      setSmsNumberOptions(options);
      const current = resolved.config.maxPrice
        ? options.find((option) => option.country === resolved.config.country) || options[0]
        : options[0];
      if (!current) throw new Error("当前没有可购买的国家号码");
      updateSmsProviderConfig(resolved.id, {
        country: current.country,
        maxPrice: String(current.price),
        countryLabel: formatSmsCountryName(current),
      });
    } catch (requestError) {
      setSmsNumberOptions([]);
      setSmsSettingsError(requestError.message);
    } finally {
      setSmsOptionsLoading(false);
    }
  }

  function updateSmsProviderConfig(providerId, values) {
    setSmsSettingsDraft((current) => ({
      ...current,
      configs: {
        ...(current.configs || {}),
        [providerId]: {
          ...(current.configs?.[providerId] || {}),
          ...values,
        },
      },
    }));
  }

  function saveSmsSettings(event) {
    event.preventDefault();
    const resolved = resolveSmsProvider(smsProviderDefinitions, smsSettingsDraft);
    if (!resolved.definition) {
      setSmsSettingsError("请选择接码平台");
      return;
    }
    const missing = resolved.definition.fields.find((field) => (
      field.required !== false && !String(resolved.config[field.key] || "").trim()
    ));
    if (missing) {
      setSmsSettingsError(`请填写${missing.label}`);
      return;
    }
    if (resolved.id === "custom") {
      const customEntries = inspectCustomSmsEntries(resolved.config.entries);
      if (customEntries.error) {
        setSmsSettingsError(customEntries.error);
        return;
      }
    }
    setSmsSettings(withSmsProviderDefaults(smsProviderDefinitions, smsSettingsDraft));
    setSmsSettingsOpen(false);
    setSmsSettingsError("");
  }

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
        body: JSON.stringify({ email: email.trim(), proxyUrl: accountProxyUrl.trim() }),
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
        body: JSON.stringify({ text: batchText, proxyUrl: accountProxyUrl.trim() }),
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
        body: JSON.stringify({ ids: [...selectedJobIds], proxyUrl: accountProxyUrl.trim() }),
      });
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function setupTotpSelected() {
    if (!canSetupTotpSelected || batchAction) return;
    const skipped = selectedJobIds.size - totpSetupSelectedCount;
    const message = `确定为选中的 ${totpSetupSelectedCount} 个账号设置 2FA 吗？${skipped ? `另有 ${skipped} 个账号不符合条件，将自动跳过。` : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("setup-2fa");
    try {
      const data = await apiFetch(token, "/api/jobs/setup-2fa-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], proxyUrl: accountProxyUrl.trim() }),
      });
      setUploadNotice(`已开始为 ${data.started} 个账号设置 2FA${data.skipped ? `，跳过 ${data.skipped} 个` : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function addPasswordSelected() {
    if (!canAddPasswordSelected || batchAction) return;
    const skipped = selectedJobIds.size - passwordAddSelectedCount;
    const message = `确定为选中的 ${passwordAddSelectedCount} 个无密码账号生成并添加随机强密码吗？${skipped ? `另有 ${skipped} 个账号已有密码或不符合条件，将自动跳过。` : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("add-password");
    try {
      const data = await apiFetch(token, "/api/jobs/add-password-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], proxyUrl: accountProxyUrl.trim() }),
      });
      setUploadNotice(`已开始为 ${data.started} 个账号添加密码${data.skipped ? `，跳过 ${data.skipped} 个` : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function forceReloginSelected() {
    if (!canForceReloginSelected || batchAction) return;
    const skipped = selectedJobIds.size - forceReloginSelectedCount;
    const message = `确定让选中的 ${forceReloginSelectedCount} 个账号跳过刷新令牌，重新登录并授权吗？${skipped ? `另有 ${skipped} 个进行中账号将自动跳过。` : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("relogin");
    try {
      const data = await apiFetch(token, "/api/jobs/relogin-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], proxyUrl: accountProxyUrl.trim() }),
      });
      setUploadNotice(`已开始重新登录并授权 ${data.started} 个账号${data.skipped ? `，跳过 ${data.skipped} 个` : ""}`);
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

        <div className="provider-toolbar sms-provider-toolbar" aria-label="接码平台配置">
          <div className="provider-heading"><PhoneIncoming size={17} /><strong>接码平台</strong></div>
          <span className="provider-name">{activeSmsProvider.name || "未选择"}</span>
          <span className={`provider-ready ${activeSmsProvider.ready ? "" : "incomplete"}`}>
            {activeSmsProvider.ready ? <Check size={14} /> : <CircleAlert size={14} />}
            {activeSmsProvider.ready
              ? (activeSmsProvider.summary ? `已配置 · ${activeSmsProvider.summary}` : "已配置")
              : "未完成配置"}
          </span>
          <button type="button" className="secondary-button provider-settings-button" onClick={openSmsSettings} disabled={!smsProviderDefinitions.length}>
            <Settings2 size={16} />配置
          </button>
        </div>

        <div className="provider-toolbar sub2api-toolbar" aria-label="Sub2API 配置与号池监控">
          <div className="provider-heading"><Send size={17} /><strong>Sub2API</strong></div>
          <span className="provider-name">{sub2apiSettings.baseUrl || "未配置后端"}</span>
          <span className={`provider-ready ${sub2apiSettings.adminApiKey ? "" : "incomplete"}`}>
            {sub2apiSettings.adminApiKey ? <Check size={14} /> : <CircleAlert size={14} />}
            {sub2apiSettings.adminApiKey
              ? `${sub2apiSettings.groupIds.length ? `已配置 · ${sub2apiSettings.groupIds.length} 个号池` : "已配置 · 默认号池"}${sub2apiSettings.proxyId ? " · 已指定代理" : ""}`
              : "未完成配置"}
          </span>
          {features.sub2apiMonitor && (
            <span className={`provider-ready monitor-ready ${sub2apiMonitorStatus.enabled ? "" : "incomplete"}`}>
              {sub2apiMonitorStatus.running
                ? <LoaderCircle className="spin" size={14} />
                : sub2apiMonitorStatus.enabled ? <ShieldCheck size={14} /> : <CircleAlert size={14} />}
              {sub2apiMonitorStatus.running
                ? "正在巡检"
                : sub2apiMonitorStatus.enabled
                  ? `号池监控已启用${sub2apiMonitorStatus.lastCheckAt ? ` · ${formatRelativeMonitorTime(sub2apiMonitorStatus.lastCheckAt)}` : ""}`
                  : "号池监控未启用"}
            </span>
          )}
          {features.sub2apiMonitor && sub2apiMonitorStatus.enabled && (
            <button
              type="button"
              className="icon-button monitor-check-button"
              onClick={checkSub2ApiMonitorNow}
              disabled={sub2apiMonitorChecking || sub2apiMonitorStatus.running}
              title="立即检查 Sub2API 异常账号"
            >
              <RefreshCw className={sub2apiMonitorChecking || sub2apiMonitorStatus.running ? "spin" : ""} size={16} />
            </button>
          )}
          <button type="button" className="secondary-button provider-settings-button" onClick={openSub2ApiSettings} disabled={!token}>
            <Settings2 size={16} />配置
          </button>
        </div>

        <div className="provider-toolbar account-proxy-toolbar" aria-label="代理 IP 配置">
          <div className="provider-heading"><Globe2 size={17} /><strong>代理 IP</strong></div>
          <div className="account-proxy-input">
            <label className="provider-field account-proxy-field" title="支持 http://、https://、socks5:// 和 socks5h://；用户名中包含 -sid- 时会自动轮换会话编号">
              <Globe2 size={15} aria-hidden="true" />
              <input
                value={accountProxyUrl}
                onChange={(event) => setAccountProxyUrl(event.target.value)}
                placeholder="socks5h://用户名:密码@主机:端口"
                spellCheck="false"
                aria-label="代理 IP 地址"
              />
            </label>
          </div>
          <span className={`provider-ready ${accountProxyUrl.trim() ? "" : "incomplete"}`}>
            {accountProxyUrl.trim() ? <Check size={14} /> : <CircleAlert size={14} />}
            {accountProxyUrl.trim() ? "已配置，按账号检测出口" : "未配置，使用本地 IP"}
          </span>
          <a
            className="provider-external-link"
            href="https://invite.zooproxy.com/share/ez2v2jdb7"
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={13} aria-hidden="true" />
            点击获取代理 IP
          </a>
        </div>

        {error && (
          <div className="global-error" role="alert">
            <CircleAlert size={17} />
            <span>{error}</span>
            <button type="button" onClick={() => setError("")} title="关闭"><X size={16} /></button>
          </div>
        )}
        {uploadNotice && (
          <div className="global-success" role="status">
            <Check size={17} />
            <span>{uploadNotice}</span>
            <button type="button" onClick={() => setUploadNotice("")} title="关闭"><X size={16} /></button>
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
              {features.sub2apiUpload && (
                <button type="button" className="secondary-button bulk-button" onClick={() => uploadSelected([...selectedJobIds])} disabled={!canUploadSelected || Boolean(batchAction)}>
                  {batchAction === "upload" ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
                  上传到 Sub2API
                </button>
              )}
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
              {features.forceRelogin && (
                <button type="button" className="relogin-button bulk-button" onClick={forceReloginSelected} disabled={!canForceReloginSelected || Boolean(batchAction)}>
                  {batchAction === "relogin" ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}
                  批量重新登录并授权
                </button>
              )}
              {features.totpSetup && (
                <button type="button" className="secondary-button bulk-button" onClick={setupTotpSelected} disabled={!canSetupTotpSelected || Boolean(batchAction)}>
                  {batchAction === "setup-2fa" ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
                  批量设置 2FA
                </button>
              )}
              {features.passwordAdd && (
                <button type="button" className="secondary-button bulk-button" onClick={addPasswordSelected} disabled={!canAddPasswordSelected || Boolean(batchAction)}>
                  {batchAction === "add-password" ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
                  批量添加密码
                </button>
              )}
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
                <th>最近操作时间</th>
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
                    smsProviderAvailable={smsProviderDefinitions.length > 0}
                    smsProvider={activeSmsProvider}
                    onUpload={() => uploadSelected([job.id])}
                    sub2apiUploadAvailable={Boolean(features.sub2apiUpload && sub2apiSettings.baseUrl && sub2apiSettings.adminApiKey)}
                    totpSetupAvailable={Boolean(features.totpSetup)}
                    passwordAddAvailable={Boolean(features.passwordAdd)}
                    forceReloginAvailable={Boolean(features.forceRelogin)}
                    accountProxyUrl={accountProxyUrl}
                  />
                  {expandedJobId === job.id && (
                    <tr className="log-row">
                      <td colSpan="7"><JobLogs token={token} jobId={job.id} /></td>
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
      {smsSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSmsSettingsOpen(false);
        }}>
          <form className="batch-dialog sms-settings-dialog" onSubmit={saveSmsSettings} role="dialog" aria-modal="true" aria-labelledby="sms-settings-title">
            <div className="dialog-header">
              <div>
                <h2 id="sms-settings-title">接码平台配置</h2>
                <span>配置保存在当前浏览器</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setSmsSettingsOpen(false)} title="关闭">
                <X size={18} />
              </button>
            </div>

            <div className="provider-tabs" role="tablist" aria-label="选择接码平台">
              {smsProviderDefinitions.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  role="tab"
                  aria-selected={draftSmsProvider.id === provider.id}
                  className={draftSmsProvider.id === provider.id ? "active" : ""}
                  onClick={() => {
                    setSmsSettingsDraft((current) => withSmsProviderDefaults(smsProviderDefinitions, {
                      ...current,
                      selectedProviderId: provider.id,
                    }));
                    setSmsSettingsError("");
                  }}
                >
                  {provider.name}
                </button>
              ))}
            </div>

            {draftSmsProvider.definition && (
              <div className="provider-config-section">
                <div className="provider-description-row">
                  <div className="provider-description">{draftSmsProvider.definition.description}</div>
                  {SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id] && (
                    <a
                      className="provider-external-link"
                      href={SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id].href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={13} aria-hidden="true" />
                      {SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id].label}
                    </a>
                  )}
                </div>
                <div className="provider-config-grid">
                  {draftSmsProvider.definition.fields.filter((field) => field.type !== "hidden").map((field) => (
                    <label key={field.key} className={`settings-field ${["price-select", "textarea"].includes(field.type) ? "wide-settings-field" : ""}`}>
                      <span>{field.label}</span>
                      {field.type === "price-select" ? (
                        <div className="price-select-row">
                          <div className="price-select-box">
                            <Settings2 size={15} />
                            <select
                              value={draftSmsProvider.config.country || ""}
                              onChange={(event) => {
                                const selected = smsNumberOptions.find((option) => option.country === event.target.value);
                                if (!selected) return;
                                updateSmsProviderConfig(draftSmsProvider.id, {
                                  country: selected.country,
                                  maxPrice: String(selected.price),
                                  countryLabel: formatSmsCountryName(selected),
                                });
                              }}
                              disabled={!smsNumberOptions.length || smsOptionsLoading}
                              aria-label="SMSBower 国家与价格"
                            >
                              {!smsNumberOptions.length && (
                                <option value={draftSmsProvider.config.country || ""}>
                                  {smsOptionsLoading ? "正在查询实时价格..." : "请先查询实时价格"}
                                </option>
                              )}
                              {smsNumberOptions.map((option) => (
                                <option key={option.country} value={option.country}>{formatSmsPriceOption(option)}</option>
                              ))}
                            </select>
                          </div>
                          <button
                            type="button"
                            className="price-refresh-button"
                            onClick={() => loadSmsNumberOptions()}
                            disabled={smsOptionsLoading || !draftSmsProvider.config.apiKey}
                          >
                            {smsOptionsLoading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                            {smsOptionsLoading ? "查询中" : "查询价格"}
                          </button>
                        </div>
                      ) : field.type === "textarea" ? (
                        <textarea
                          className="settings-textarea"
                          value={draftSmsProvider.config[field.key] || ""}
                          onChange={(event) => updateSmsProviderConfig(draftSmsProvider.id, { [field.key]: event.target.value })}
                          placeholder={field.placeholder}
                          rows="8"
                          autoComplete="off"
                          spellCheck="false"
                        />
                      ) : (
                        <div>
                          {field.type === "password" ? <KeyRound size={15} /> : <Settings2 size={15} />}
                          <input
                            type={field.type || "text"}
                            value={draftSmsProvider.config[field.key] || ""}
                            onChange={(event) => updateSmsProviderConfig(draftSmsProvider.id, { [field.key]: event.target.value })}
                            placeholder={field.placeholder}
                            autoComplete="off"
                            spellCheck="false"
                          />
                        </div>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {smsSettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{smsSettingsError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setSmsSettingsOpen(false)}>取消</button>
              <button type="submit" className="primary-button" disabled={!draftSmsProvider.definition}>
                <Check size={17} />保存配置
              </button>
            </div>
          </form>
        </div>
      )}
      {sub2apiSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSub2apiSettingsOpen(false);
        }}>
          <form className="batch-dialog sub2api-settings-dialog" onSubmit={saveSub2ApiSettings} role="dialog" aria-modal="true" aria-labelledby="sub2api-settings-title">
            <div className="dialog-header">
              <div>
                <h2 id="sub2api-settings-title">Sub2API 配置</h2>
                <span>管理员 Key 不写入任务文件或日志；启用监控后由本机服务保存</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setSub2apiSettingsOpen(false)} title="关闭"><X size={18} /></button>
            </div>
            <div className="provider-config-grid sub2api-config-grid">
              <label className="settings-field wide-settings-field">
                <span>Sub2API 后端地址</span>
                <input
                  type="url"
                  value={sub2apiSettingsDraft.baseUrl}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                  placeholder="例如 http://127.0.0.1:8080"
                  autoComplete="url"
                />
              </label>
              {features.sub2apiMonitor && (
                <label className="settings-field wide-settings-field sub2api-monitor-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(sub2apiSettingsDraft.monitorEnabled)}
                    onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, monitorEnabled: event.target.checked }))}
                  />
                  <span>
                    <strong>每 5 分钟监控异常账号</strong>
                    <small>只自动处理上次完整登录未人工输入密码、邮箱码或登录 2FA 的任务</small>
                  </span>
                </label>
              )}
              <label className="settings-field wide-settings-field">
                <span>管理员 API Key</span>
                <input
                  type="password"
                  value={sub2apiSettingsDraft.adminApiKey}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, adminApiKey: event.target.value }))}
                  placeholder="输入 sub2api 管理员 API Key"
                  autoComplete="off"
                />
              </label>
              <fieldset className="settings-field wide-settings-field sub2api-group-field">
                <legend>目标号池（可多选）</legend>
                <section className="sub2api-group-picker" aria-label="目标号池">
                  {sub2apiGroups.length ? sub2apiGroups.map((group) => {
                    const groupId = String(group.id);
                    return (
                      <label key={group.id} className="sub2api-group-option">
                        <input
                          type="checkbox"
                          checked={sub2apiSettingsDraft.groupIds.includes(groupId)}
                          onChange={(event) => setSub2ApiGroupChecked(groupId, event.target.checked)}
                        />
                        <span>{group.name}</span>
                        <small>ID: {group.id}</small>
                      </label>
                    );
                  }) : <div className="sub2api-group-empty">暂无可选号池</div>}
                </section>
                <section className="sub2api-group-selection" aria-label="号池选择操作">
                  <span>已选 {sub2apiSettingsDraft.groupIds.length} 个</span>
                  <button
                    type="button"
                    onClick={() => setSub2apiSettingsDraft((current) => ({ ...current, groupIds: sub2apiGroups.map((group) => String(group.id)) }))}
                    disabled={!sub2apiGroups.length || sub2apiGroups.every((group) => sub2apiSettingsDraft.groupIds.includes(String(group.id)))}
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    onClick={() => setSub2apiSettingsDraft((current) => ({ ...current, groupIds: [] }))}
                    disabled={!sub2apiSettingsDraft.groupIds.length}
                  >
                    清空
                  </button>
                </section>
              </fieldset>
              <label className="settings-field wide-settings-field">
                <span>代理 IP</span>
                <select
                  value={sub2apiSettingsDraft.proxyId}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, proxyId: event.target.value }))}
                >
                  <option value="">使用账号原配置</option>
                  {sub2apiProxies.map((proxy) => <option key={proxy.id} value={String(proxy.id)}>{formatSub2ApiProxy(proxy)}</option>)}
                </select>
              </label>
              <label className="settings-field">
                <span>并发数</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  value={sub2apiSettingsDraft.concurrency}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, concurrency: event.target.value }))}
                  placeholder="留空使用账号原值"
                />
              </label>
              <label className="settings-field">
                <span>负载因子</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  value={sub2apiSettingsDraft.loadFactor}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, loadFactor: event.target.value }))}
                  placeholder="留空使用账号原值"
                />
              </label>
              <label className="settings-field">
                <span>优先级</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  value={sub2apiSettingsDraft.priority}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, priority: event.target.value }))}
                  placeholder="留空使用账号原值"
                />
              </label>
              <label className="settings-field wide-settings-field">
                <span>允许使用的模型</span>
                <textarea
                  className="sub2api-model-textarea"
                  value={sub2apiSettingsDraft.modelWhitelist}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, modelWhitelist: event.target.value }))}
                  placeholder={"每行一个模型，也支持逗号分隔，例如：\ngpt-5\ngpt-5-mini\ngpt-4.1"}
                  rows="5"
                  spellCheck="false"
                />
              </label>
            </div>
            <div className="dialog-hint">分组为空时，上传使用 Sub2API 默认号池，监控检查全部 OpenAI 账号；选择分组后只监控这些号池。</div>
            {features.sub2apiMonitor && sub2apiMonitorStatus.configured && (
              <div className={`sub2api-monitor-status ${sub2apiMonitorStatus.lastError ? "error" : ""}`}>
                <ShieldCheck size={15} />
                <span>{sub2apiMonitorStatus.lastError
                  ? `上次巡检失败：${sub2apiMonitorStatus.lastError}`
                  : sub2apiMonitorStatus.lastCheckAt
                    ? formatMonitorResult(sub2apiMonitorStatus.lastResult)
                    : "尚未执行号池巡检"}</span>
              </div>
            )}
            {sub2apiSettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{sub2apiSettingsError}</div>}
            <div className="dialog-actions sub2api-dialog-actions">
              <button type="button" className="secondary-button" onClick={() => loadSub2ApiOptions()} disabled={sub2apiGroupsLoading || !token}>
                {sub2apiGroupsLoading ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}读取配置
              </button>
              {features.sub2apiMonitor && sub2apiMonitorStatus.enabled && (
                <button type="button" className="secondary-button" onClick={checkSub2ApiMonitorNow} disabled={sub2apiMonitorChecking || sub2apiMonitorStatus.running}>
                  {sub2apiMonitorChecking || sub2apiMonitorStatus.running ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}立即检查
                </button>
              )}
              <span className="dialog-actions-spacer" />
              <button type="button" className="cancel-button" onClick={() => setSub2apiSettingsOpen(false)} disabled={sub2apiSettingsSaving}>取消</button>
              <button type="submit" className="primary-button" disabled={sub2apiSettingsSaving}>
                {sub2apiSettingsSaving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存配置
              </button>
            </div>
          </form>
        </div>
      )}
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
            <label className="batch-label" htmlFor="batch-input">每行一个账号：自动识别邮箱、密码、邮件 API 和 2FA，字段顺序不限</label>
            <textarea
              id="batch-input"
              value={batchText}
              onChange={(event) => setBatchText(event.target.value)}
              placeholder={"name@icloud.com----https://mail.example/messages/name\nhttps://mail.example/messages/name2|账号密码|name2@example.co.uk|BASE32二步验证密钥\nBASE32二步验证密钥::name3@example.dev::账号密码"}
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
      <td colSpan="7">
        <div className="empty-state">
          <div><Mail size={24} /></div>
          <h3>{filtered ? "没有匹配账号" : "暂无授权任务"}</h3>
          <p>{filtered ? "当前筛选邮箱不在任务列表中。" : "在右上方输入邮箱地址开始登录。"}</p>
        </div>
      </td>
    </tr>
  );
}

function JobRow({ job, token, expanded, onToggleLogs, onError, selected, onToggleSelected, selectionSupported, smsProviderAvailable, smsProvider, onUpload, sub2apiUploadAvailable, totpSetupAvailable, passwordAddAvailable, forceReloginAvailable, accountProxyUrl }) {
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
      await apiFetch(token, `/api/jobs/${job.id}/retry`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
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
      await apiFetch(token, `/api/jobs/${job.id}/regenerate`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function forceRelogin() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/relogin`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function setupTotp() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/setup-2fa`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function addPassword() {
    if (!window.confirm("确定为该账号生成并添加随机强密码吗？成功后会自动更新账号原始信息。")) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/add-password`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function copyTotpSecret() {
    try {
      await navigator.clipboard.writeText(job.totpSetupSecret || "");
      onError("");
    } catch {
      onError("无法自动复制，请手动选择 2FA 密钥");
    }
  }

  async function requestSmsNumber() {
    if (!smsProvider.ready) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/sms-number`, {
        method: "POST",
        body: JSON.stringify({ providerId: smsProvider.id, config: smsProvider.config }),
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
        {job.autoRepairBlocked && (
          <div className="row-error">号池监控已永久跳过：{extractResponseMessage(job.autoRepairBlockedReason || "账号已不可用")}</div>
        )}
        {job.totpSetupError && <div className="row-error">2FA：{extractResponseMessage(job.totpSetupError)}</div>}
        {job.passwordAddError && <div className="row-error">添加密码：{extractResponseMessage(job.passwordAddError)}</div>}
        {job.mailApiError && job.status === "email_otp" && <div className="mail-error">{job.mailApiError}</div>}
        {job.currentPhone && ["working", "phone", "phone_otp"].includes(job.status) && (
          <div className="phone-target"><Smartphone size={13} />当前手机号：<strong>{job.currentPhone}</strong></div>
        )}
        {job.phoneError && <div className="phone-error"><CircleAlert size={13} />{job.phoneError}</div>}
        {job.smsStatus && !["idle", "unavailable"].includes(job.smsStatus) && (
          <div className={`sms-status ${job.smsStatus === "error" ? "error" : ""}`}>
            {job.smsStatus === "error" ? <CircleAlert size={13} /> : <PhoneIncoming size={13} />}
            <span>{smsStatusText(job)}</span>
          </div>
        )}
        {job.status === "totp_setup_otp" && job.totpSetupSecret && (
          <div className="totp-setup-secret">
            <span>2FA 密钥</span>
            <code>{job.totpSetupSecret}</code>
            <button type="button" className="icon-button" onClick={copyTotpSecret} title="复制 2FA 密钥">
              <Copy size={15} />
            </button>
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
            {job.status === "phone" && smsProviderAvailable && (
              <>
                <span className="input-separator" aria-hidden="true" />
                <button
                  type="button"
                  className="platform-number-button"
                  onClick={requestSmsNumber}
                  disabled={!smsProvider.ready || submitting || job.smsStatus === "requesting"}
                  title={smsProvider.ready ? `使用 ${smsProvider.name} 取号` : "请先完成接码平台配置"}
                >
                  {submitting || job.smsStatus === "requesting" ? <LoaderCircle className="spin" size={15} /> : <PhoneIncoming size={15} />}
                  {smsProvider.name || "平台"}取号
                </button>
              </>
            )}
          </div>
        )}
      </td>
      <td className="time-cell"><time dateTime={job.createdAt}>{formatDateTime(job.createdAt)}</time></td>
      <td className="operation-time-cell">
        <time dateTime={job.lastOperationAt || job.createdAt}>{formatDateTime(job.lastOperationAt || job.createdAt)}</time>
        <span>{operationLabel(job.lastOperationType)}</span>
      </td>
      <td>
        <div className="row-actions">
          {job.canDownload && (
            <button type="button" className="download-button" onClick={download}>
              <Download size={16} />下载
            </button>
          )}
          {job.canDownload && sub2apiUploadAvailable && (
            <button type="button" className="secondary-button" onClick={onUpload} disabled={submitting} title="上传到已配置的 Sub2API 号池">
              <Send size={16} />上传
            </button>
          )}
          {job.canRegenerate && (
            <button type="button" className="regenerate-button" onClick={regenerate} disabled={submitting} title="重新授权：优先使用刷新令牌，失效后自动重新登录">
              {submitting ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
              重新授权
            </button>
          )}
          {forceReloginAvailable && job.canForceRelogin && (
            <button type="button" className="relogin-button" onClick={forceRelogin} disabled={submitting} title="跳过刷新令牌和旧检查点，完整重新登录后自动授权">
              {submitting ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}
              重新登录并授权
            </button>
          )}
          {totpSetupAvailable && job.canSetupTotp && (
            <button type="button" className="icon-button" onClick={setupTotp} disabled={submitting} title="设置 2FA">
              {submitting ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
            </button>
          )}
          {passwordAddAvailable && job.canAddPassword && (
            <button type="button" className="icon-button" onClick={addPassword} disabled={submitting} title="添加密码">
              {submitting ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
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
    totp_starting: ["准备 2FA", <LoaderCircle className="spin" size={14} />],
    password_add_starting: ["准备密码", <LoaderCircle className="spin" size={14} />],
    totp_setup_otp: ["激活 2FA", <ShieldCheck size={14} />],
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
    const methods = ["密码", job.autoEmailOtp ? "自动收码" : "", job.hasTotpKey ? "2FA" : ""].filter(Boolean);
    return (
      <span className="mail-mode password-mode">
        {job.hasTotpKey ? <ShieldCheck size={12} /> : <KeyRound size={12} />}
        {methods.join(" + ")}
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
  if (status === "totp_setup_otp") {
    return { action: "totp_setup_otp", placeholder: "新 2FA 的 6 位验证码", submitLabel: "激活新的 2FA", inputMode: "numeric", icon: <ShieldCheck size={15} /> };
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

function smsStatusText(job) {
  const providerName = job.smsProviderName || "接码平台";
  if (job.smsError) return `${providerName}：${job.smsError}`;
  return {
    requesting: `${providerName}：正在获取手机号`,
    number_acquired: `${providerName}：已获取手机号，正在发送验证码`,
    waiting_sms: `${providerName}：验证码已发送，正在等待短信`,
    submitting: `${providerName}：已收到验证码，正在自动提交`,
    submitted: `${providerName}：验证码已自动提交`,
    manual_submitted: `${providerName}：已停止自动读取，正在验证手动输入的验证码`,
    completed: `${providerName}：手机验证已通过，订单已完成`,
  }[job.smsStatus] || `${providerName}：处理中`;
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

function formatMonitorResult(result) {
  if (!result || typeof result !== "object") return "号池巡检已完成";
  const parts = [`检查 ${Number(result.checked || 0)} 条异常记录`];
  if (result.started) parts.push(`已启动自动修复 ${result.started} 条`);
  if (result.updated) parts.push(`已更新 ${result.updated} 条`);
  if (result.blocked) parts.push(`永久跳过 ${result.blocked} 条`);
  if (result.ineligible) parts.push(`需人工 ${result.ineligible} 条`);
  if (result.missingTask) parts.push(`本地无任务 ${result.missingTask} 条`);
  if (result.busy) parts.push(`正在运行 ${result.busy} 条`);
  if (result.cooldown) parts.push(`冷却中 ${result.cooldown} 条`);
  return parts.join("，");
}

function formatRelativeMonitorTime(value) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "刚刚检查";
  if (elapsed < 60_000) return "刚刚检查";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前检查`;
  return `${Math.floor(elapsed / (60 * 60_000))} 小时前检查`;
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

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const now = new Date();
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat("zh-CN", {
    ...(isToday ? {} : { month: "2-digit", day: "2-digit" }),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function operationLabel(type) {
  return ({
    initial_authorization: "首次授权",
    reauthorize: "重新授权",
    relogin: "重新登录并授权",
    automatic_relogin: "号池自动重登并授权",
    resume: "继续中断流程",
    setup_2fa: "设置 2FA",
    add_password: "添加密码",
    account_update: "更新账号资料",
    proxy_update: "更新代理 IP",
  })[type] || "账号操作";
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

function readLocalTextSetting(key) {
  let value = readLocalSetting(key).trim();
  for (let attempt = 0; attempt < 4 && value; attempt += 1) {
    if (!(value.startsWith('"') && value.endsWith('"'))) return value;
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded !== "string") return value;
      value = decoded.trim();
    } catch {
      return value;
    }
  }
  return value;
}

function readSmsProviderSettings() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SMS_PROVIDER_SETTINGS_KEY) || "null");
    if (stored && typeof stored === "object" && stored.configs && typeof stored.configs === "object") {
      return stored;
    }
  } catch {}
  return {
    selectedProviderId: "luban",
    configs: {
      luban: {
        apiKey: readLocalSetting(LUBAN_API_KEY_STORAGE_KEY),
        serviceId: readLocalSetting(LUBAN_SERVICE_ID_STORAGE_KEY),
      },
    },
  };
}

function normalizeSub2ApiSettings(value) {
  const stored = value && typeof value === "object" ? value : {};
  const rawGroupIds = Array.isArray(stored.groupIds)
    ? stored.groupIds
    : String(stored.groupId || "").trim()
      ? [stored.groupId]
      : [];
  return {
    baseUrl: String(stored.baseUrl || ""),
    adminApiKey: String(stored.adminApiKey || ""),
    groupIds: [...new Set(rawGroupIds.map((id) => String(id).trim()).filter(Boolean))],
    proxyId: String(stored.proxyId || ""),
    concurrency: String(stored.concurrency ?? ""),
    loadFactor: String(stored.loadFactor ?? ""),
    priority: String(stored.priority ?? ""),
    modelWhitelist: String(stored.modelWhitelist || ""),
    monitorEnabled: stored.monitorEnabled === true,
  };
}

function readSub2ApiSettings(value) {
  try {
    const stored = value || JSON.parse(window.localStorage.getItem(SUB2API_UPLOAD_SETTINGS_KEY) || "null");
    if (stored && typeof stored === "object") return normalizeSub2ApiSettings(stored);
  } catch {}
  return normalizeSub2ApiSettings({});
}

function formatSub2ApiProxy(proxy) {
  const protocol = String(proxy.protocol || "http").replace(/:\/\/$/, "");
  const host = String(proxy.host || "");
  const port = proxy.port ? `:${proxy.port}` : "";
  const endpoint = host ? `${protocol}://${host}${port}` : "地址未知";
  const ip = String(proxy.ipAddress || "").trim();
  return `${proxy.name || `代理 ${proxy.id}`} | ${endpoint}${ip ? ` | 出口 IP：${ip}` : ""}`;
}

function withSmsProviderDefaults(definitions, settings) {
  const configs = { ...(settings?.configs || {}) };
  definitions.forEach((provider) => {
    const current = { ...(configs[provider.id] || {}) };
    provider.fields.forEach((field) => {
      if (!String(current[field.key] || "").trim() && field.defaultValue) current[field.key] = field.defaultValue;
    });
    configs[provider.id] = current;
  });
  const selectedProviderId = definitions.some((provider) => provider.id === settings?.selectedProviderId)
    ? settings.selectedProviderId
    : definitions[0]?.id || settings?.selectedProviderId || "luban";
  return { selectedProviderId, configs };
}

function resolveSmsProvider(definitions, settings) {
  const normalized = withSmsProviderDefaults(definitions, settings || {});
  const definition = definitions.find((provider) => provider.id === normalized.selectedProviderId) || null;
  const config = definition ? normalized.configs[definition.id] || {} : {};
  const requiredFieldsReady = Boolean(definition) && definition.fields.every((field) => (
    field.required === false || String(config[field.key] || "").trim()
  ));
  const customEntries = definition?.id === "custom" ? inspectCustomSmsEntries(config.entries) : null;
  const ready = requiredFieldsReady && !customEntries?.error;
  const summary = definition?.id === "custom"
    ? (customEntries?.count ? `${customEntries.count} 个号码` : "")
    : definition
    ? definition.fields
      .filter((field) => field.summary || field.summaryKey)
      .map((field) => config[field.summaryKey || field.key])
      .filter(Boolean)
      .join(" / ")
    : "";
  return {
    id: definition?.id || "",
    name: definition?.name || "",
    definition,
    config,
    ready,
    summary,
  };
}

function inspectCustomSmsEntries(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { count: 0, error: "请粘贴至少一条手机号和接码 API" };
  if (lines.length > 500) return { count: 0, error: "自定义接码一次最多导入 500 条" };
  const phones = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const delimiterAt = lines[index].indexOf("----");
    if (delimiterAt < 0) return { count: 0, error: `第 ${index + 1} 行格式错误，请使用 手机号----接码API` };
    const phone = lines[index].slice(0, delimiterAt).trim();
    const apiUrl = lines[index].slice(delimiterAt + 4).trim();
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
      return { count: 0, error: `第 ${index + 1} 行手机号必须使用 +861871291167 这种国际格式` };
    }
    try {
      const parsed = new URL(apiUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid protocol");
    } catch {
      return { count: 0, error: `第 ${index + 1} 行接码 API 必须是有效的 HTTP 或 HTTPS 地址` };
    }
    phones.add(phone);
  }
  return { count: phones.size, error: "" };
}

function formatSmsCountryName(option) {
  if (option.iso && REGION_NAMES) {
    try {
      return REGION_NAMES.of(option.iso) || option.title;
    } catch {}
  }
  return option.title || `国家 ${option.country}`;
}

function formatSmsPriceOption(option) {
  const name = formatSmsCountryName(option);
  return `${name} | 价格 ${option.price} | 库存 ${option.count}`;
}

function writeLocalJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing modes may disable localStorage; the current tab still works.
  }
}

function writeLocalTextSetting(key, value) {
  try {
    window.localStorage.setItem(key, String(value || ""));
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
