const state = {
  dashboard: null,
  busy: false,
  formInitialized: false,
};

const $ = (id) => document.getElementById(id);

function timeOptions(startHour = 8, endHour = 22) {
  const result = [];
  for (let minutes = startHour * 60; minutes <= endHour * 60; minutes += 30) {
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    result.push(`${hh}:${mm}`);
  }
  return result;
}

function fillTimeSelects() {
  const options = timeOptions();
  for (const id of ["desiredStartTime", "desiredEndTime"]) {
    const select = $(id);
    select.innerHTML = "";
    for (const value of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
  }
}

function setField(id, value) {
  const el = $(id);
  if (!el || value === undefined || value === null || value === "") return;
  if (el.type === "checkbox") el.checked = !!value;
  else el.value = String(value);
}

function getFormValues() {
  return {
    runDate: $("runDate").value,
    targetDate: $("targetDate").value,
    primaryCampus: $("primaryCampus").value,
    fallbackCampus: $("fallbackCampus").value,
    desiredStartTime: $("desiredStartTime").value,
    desiredEndTime: $("desiredEndTime").value,
    maxBookingMinutes: Number($("maxBookingMinutes").value),
    maxBookingAmount: Number($("maxBookingAmount").value),
    partialMinMinutes: Number($("partialMinMinutes").value),
    autoPay: $("autoPay").checked,
  };
}

function applyConfigDefaults(config) {
  setField("primaryCampus", config.primaryCampus);
  setField("fallbackCampus", config.fallbackCampus);
  setField("desiredStartTime", config.desiredStartTime);
  setField("desiredEndTime", config.desiredEndTime);
  setField("maxBookingMinutes", config.maxBookingMinutes);
  setField("maxBookingAmount", config.maxBookingAmount);
  setField("partialMinMinutes", config.partialMinMinutes);
  setField("autoPay", true);
}

function applyPlanDefaults(plan) {
  if (!plan) return;
  setField("runDate", plan.runDate);
  setField("targetDate", plan.targetDate);
}

function validateForm() {
  const value = getFormValues();
  if (value.primaryCampus === value.fallbackCampus) {
    throw new Error("候补校区不能和优先校区一样。");
  }
  if (value.desiredEndTime <= value.desiredStartTime) {
    throw new Error("结束时间必须晚于开始时间。");
  }
  if (value.partialMinMinutes > value.maxBookingMinutes) {
    throw new Error("候补最短时长不能大于最长时长。");
  }
  if (!value.autoPay) {
    const ok = window.confirm("已关闭自动付款。这样只会提交到付款前或跳过确认，确定继续吗？");
    if (!ok) throw new Error("已取消。");
  }
  return value;
}

function setBusy(busy, text = busy ? "执行中" : "空闲", cls = busy ? "warn" : "ok") {
  state.busy = busy;
  $("busyPill").textContent = text;
  $("busyPill").className = `pill ${cls}`;
  for (const id of ["refreshBtn", "selfCheckBtn", "planBtn", "installBtn"]) {
    $(id).disabled = busy;
  }
}

function setOutput(value) {
  $("output").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function formatSelfCheckOutput(result) {
  if (Array.isArray(result?.checks)) {
    const failed = result.checks.filter((check) => !check.ok);
    const mailText = result.mail?.sent
      ? `邮件：已发送到 ${result.mail.to || "-"}`
      : `邮件：未发送${result.mail?.error ? ` - ${result.mail.error}` : ""}`;
    return [
      `自检${result.ok ? "通过" : "失败"}：${result.passed}/${result.total} 项通过，${result.failed} 项失败。`,
      mailText,
      `报告：${result.resultPath || "-"}`,
      failed.length ? `\n失败项：\n${failed.map((check) => `FAIL ${check.name} ${check.detail || ""}`.trim()).join("\n")}` : "",
      `\n明细：\n${result.checks.map((check) => `${check.status} ${check.name} ${check.detail || ""}`.trim()).join("\n")}`,
      result.stderr ? `\n错误输出：\n${result.stderr}` : "",
    ].join("\n").trim();
  }

  const stdout = String(result?.stdout || "").trim();
  const stderr = String(result?.stderr || "").trim();
  const lines = stdout ? stdout.split(/\r?\n/).filter(Boolean) : [];
  const failed = lines.filter((line) => line.startsWith("FAIL "));
  const status = result?.ok && failed.length === 0 ? "通过" : "失败";
  const summary = `自检${status}：${lines.length} 项检查，${failed.length} 项失败。`;
  return [
    summary,
    failed.length ? `\n失败项：\n${failed.join("\n")}` : "",
    stdout ? `\n明细：\n${stdout}` : "",
    stderr ? `\n错误输出：\n${stderr}` : "",
  ].join("").trim();
}

function formatPlanOutput(result) {
  const plan = result?.json || result;
  if (!plan || !plan.runDate) return result;
  return [
    "下一次任务预览",
    `安装来源：${plan.installSource || "-"}`,
    `运行日期：${plan.runDate}`,
    `预约日期：${plan.targetDate}`,
    `执行链路：${plan.webBridgePrestart} WebBridge，${plan.vpnPreconnect} VPN，${plan.preflight} 预检，${plan.bookingStart} 正式抢场，${plan.postcheck} 事后检查`,
    `目标：${plan.primaryCampus} 优先，${plan.fallbackCampus} 候补，${plan.desired}`,
    `上限：${plan.maxBookingMinutes} 分钟 / ${plan.maxBookingAmount} 元，候补最短 ${plan.partialMinMinutes} 分钟`,
    `配置文件：${plan.configPath}`,
    `预览是否写入配置：${plan.configWritten ? "是" : "否"}`,
  ].join("\n");
}

function formatInstallOutput(result) {
  const data = result?.json || result;
  if (!data?.plan) return result?.stdout || result;
  const rows = (data.tasks || []).map((task) => (
    `${task.taskName} | ${task.nextRunTime || "-"} | last=${task.lastTaskResult} | ${runnerKind(task.action)}`
  ));
  return [
    "正式任务已安装并校验",
    `安装来源：${data.plan.installSource || "-"}`,
    `运行日期：${data.plan.runDate}`,
    `预约日期：${data.plan.targetDate}`,
    `目标：${data.plan.primaryCampus} -> ${data.plan.fallbackCampus}，${data.plan.desired}`,
    `配置文件：${data.plan.configPath}`,
    `校验日志：${data.verificationLog || "-"}`,
    "",
    "Windows 任务：",
    rows.join("\n"),
  ].join("\n");
}

function pill(el, text, cls = "") {
  el.textContent = text;
  el.className = `pill ${cls}`.trim();
}

function formatMoney(value) {
  if (value === "" || value === undefined || value === null) return "";
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : String(value);
}

function setDefinitionList(el, rows) {
  el.innerHTML = "";
  for (const [key, value] of rows) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dd.title = value === undefined || value === null ? "" : String(value);
    dt.textContent = key;
    dd.textContent = value === undefined || value === null || value === "" ? "-" : String(value);
    el.append(dt, dd);
  }
}

function runnerKind(action = "") {
  if (action.includes("run-booking.ps1")) return "wrapper";
  if (action.includes("webbridge_runner.mjs")) return "旧直连 Node";
  if (action.includes("postcheck.ps1")) return "postcheck";
  if (action.includes("start-webbridge.ps1")) return "WebBridge";
  if (action.includes("open-vpn.ps1")) return "VPN";
  return "-";
}

function renderConfig(config, installed = false) {
  $("configTitle").textContent = installed ? "当前安装配置" : "基准配置";
  setDefinitionList($("configList"), [
    ["校区", `${config.primaryCampus} -> ${config.fallbackCampus}`],
    ["时段", `${config.desiredStartTime}-${config.desiredEndTime}`],
    ["上限", `${config.maxBookingMinutes} 分钟 / ${config.maxBookingAmount} 元`],
    ["候补", `${config.partialMinMinutes}+ 分钟`],
    ["轮询", `${config.pollStartTime}-${config.pollUntilTime} / ${config.pollIntervalMs}ms`],
    ["浏览器", config.browserMode],
    ["VPN", config.openVpn ? "自动启动" : "不启动"],
    ["邮件", config.mailOnCompletion ? "开启" : "关闭"],
  ]);
  $("targetSummary").textContent = `${config.primaryCampus} 优先，${config.desiredStartTime}-${config.desiredEndTime}`;
}

function renderLatestResult(result) {
  if (!result) {
    pill($("resultPill"), "无结果", "warn");
    $("lastResult").textContent = "无结果";
    setDefinitionList($("resultList"), []);
    return;
  }
  const slot = result.slot || {};
  pill($("resultPill"), result.success ? "成功" : "失败", result.success ? "ok" : "bad");
  $("lastResult").textContent = result.success
    ? `${slot.targetDate || result.run?.targetDate || ""} ${slot.start || ""}-${slot.end || ""}`
    : "失败";
  setDefinitionList($("resultList"), [
    ["日期", slot.targetDate || result.run?.targetDate],
    ["校区", slot.campus || result.run?.primaryCampus],
    ["场地", slot.court],
    ["时段", slot.start && slot.end ? `${slot.start}-${slot.end}` : (slot.times || []).join(", ")],
    ["金额", formatMoney(slot.money)],
    ["模式", slot.fallbackMode],
    ["邮件", result.mail?.sent ? "已发送" : "未确认"],
    ["原因", result.success ? "" : result.failureReason],
    ["文件", result.name],
  ]);
}

function renderTasks(tasks) {
  const rows = tasks?.rows || [];
  const tbody = $("taskRows");
  tbody.innerHTML = "";
  for (const task of rows) {
    const tr = document.createElement("tr");
    for (const value of [task.taskName, task.state, task.nextRunTime || "-", task.lastTaskResult, runnerKind(task.action)]) {
      const td = document.createElement("td");
      td.textContent = String(value ?? "");
      if (value === "旧直连 Node") td.className = "status-bad";
      if (value === "wrapper") td.className = "status-ok";
      tr.append(td);
    }
    tbody.append(tr);
  }
  const booking = rows.find((row) => row.taskName === "CodexBadminton_LXD_1900_2100");
  const kind = booking ? runnerKind(booking.action) : "-";
  $("taskSummary").textContent = booking?.nextRunTime
    ? `下次 ${booking.nextRunTime} / ${kind}`
    : `${rows.length} 个任务 / ${kind}`;
  pill($("tasksPill"), tasks?.ok ? `${rows.length} 个任务` : "读取失败", tasks?.ok ? "ok" : "bad");
}

function renderSelfCheck(check) {
  const summary = $("selfCheckSummary");
  const mail = $("selfCheckMail");
  if (!check) {
    summary.textContent = "未运行";
    summary.className = "status-warn";
    mail.textContent = "";
    return;
  }
  summary.textContent = `${check.ok ? "通过" : "失败"} ${check.passed || 0}/${check.total || 0} 项`;
  summary.className = check.ok ? "status-ok" : "status-bad";
  if (check.mail?.sent) {
    mail.textContent = `邮件已发 ${check.mail.to || ""}`.trim();
  } else if (check.mail) {
    mail.textContent = `邮件未发${check.mail.error ? `：${check.mail.error}` : ""}`;
  } else {
    mail.textContent = "邮件未确认";
  }
}

function renderDashboard(data) {
  state.dashboard = data;
  $("repoLine").textContent = data.repoUrl || data.projectRoot || "";
  const displayConfig = data.effectiveConfig || data.installedConfig || data.config || {};
  const hasInstalledConfig = !!data.installedConfig;
  renderConfig(displayConfig, hasInstalledConfig);
  renderLatestResult(data.latestResult);
  renderTasks(data.tasks);
  renderSelfCheck(data.latestSelfCheck);
  pill($("profilePill"), hasInstalledConfig ? "已安装任务" : "未安装任务", hasInstalledConfig ? "ok" : "warn");
  if (!state.formInitialized) {
    applyConfigDefaults(displayConfig);
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, stdout: text };
  }
  if (!res.ok) {
    const error = new Error(json.stderr || json.error || `HTTP ${res.status}`);
    error.payload = json;
    throw error;
  }
  return json;
}

async function refresh({ preserveOutput = false } = {}) {
  setBusy(true, "刷新中");
  try {
    const data = await api("/api/dashboard");
    renderDashboard(data);
    if (!state.formInitialized) {
      const plan = await api("/api/plan-next", { method: "POST", body: getFormValues() });
      applyPlanDefaults(plan.json || plan);
      state.formInitialized = true;
    }
    if (!preserveOutput) setOutput(data);
  } catch (error) {
    if (!preserveOutput) setOutput(error.payload || error.message);
  } finally {
    setBusy(false);
  }
}

async function runAction(label, path, useForm = false, formatter = null) {
  setBusy(true, label);
  let idleText = "空闲";
  let idleClass = "ok";
  try {
    const body = useForm ? validateForm() : undefined;
    const result = await api(path, { method: "POST", body });
    setOutput(formatter ? formatter(result) : (result.json || result.stdout || result));
    idleText = result.ok === false ? "执行失败" : "执行完成";
    idleClass = result.ok === false ? "bad" : "ok";
    await refresh({ preserveOutput: true });
  } catch (error) {
    setOutput(formatter && error.payload ? formatter(error.payload) : (error.payload || error.message));
    idleText = "执行失败";
    idleClass = "bad";
  } finally {
    setBusy(false, idleText, idleClass);
  }
}

$("refreshBtn").addEventListener("click", refresh);
$("selfCheckBtn").addEventListener("click", () => runAction("自检中", "/api/self-check", false, formatSelfCheckOutput));
$("planBtn").addEventListener("click", () => runAction("预览中", "/api/plan-next", true, formatPlanOutput));
$("installBtn").addEventListener("click", () => {
  let value = null;
  try {
    value = validateForm();
  } catch (error) {
    setOutput(error.message);
    return;
  }
  const summary = [
    `${value.runDate} 早上执行，抢 ${value.targetDate}`,
    `${value.primaryCampus} 优先，${value.fallbackCampus} 候补`,
    `${value.desiredStartTime}-${value.desiredEndTime}`,
    `最长 ${value.maxBookingMinutes} 分钟，金额上限 ${value.maxBookingAmount}`,
    `自动付款：${value.autoPay ? "开" : "关"}`,
  ].join("\n");
  const ok = window.confirm(`安装下一次正式任务会覆盖现有 CodexBadminton_* 任务。\n\n${summary}`);
  if (ok) runAction("安装中", "/api/install-next", true, formatInstallOutput);
});

fillTimeSelects();
refresh();
