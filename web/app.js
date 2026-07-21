const $ = (id) => document.getElementById(id);
const campusName = (v) => ({ lxd: "留仙洞", xlh: "西丽湖", auto: "自动", none: "关闭" }[v] || v || "—");

function fillTimes() {
  const values = [];
  for (let m = 480; m <= 1320; m += 30) values.push(String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"));
  for (const id of ["startTime", "endTime"]) $(id).innerHTML = values.map((v) => '<option value="' + v + '">' + v + "</option>").join("");
}
function setField(id, value) { if (value !== undefined && value !== null && String(value) !== "") $(id).value = String(value); }
function applyDefaults(c = {}) {
  setField("formPrimary", c.primaryCampus || "lxd"); setField("formFallback", c.fallbackCampus || "xlh");
  setField("startTime", c.desiredStartTime || "19:30"); setField("endTime", c.desiredEndTime || "21:00");
  setField("maxMinutes", c.maxBookingMinutes || 120); setField("maxAmount", c.maxBookingAmount || 200); setField("partialMinutes", c.partialMinMinutes || 60);
}
function formBody() { return { targetDate: $("targetDate").value, primaryCampus: $("formPrimary").value, fallbackCampus: $("formFallback").value, desiredStartTime: $("startTime").value, desiredEndTime: $("endTime").value, maxBookingMinutes: Number($("maxMinutes").value), maxBookingAmount: Number($("maxAmount").value), partialMinMinutes: Number($("partialMinutes").value) }; }
function validate() { const b = formBody(); if (!b.targetDate) throw new Error("请选择预约日期。"); if (b.primaryCampus === b.fallbackCampus) throw new Error("主校区和候补校区不能相同。"); if (b.desiredEndTime <= b.desiredStartTime) throw new Error("结束时间必须晚于开始时间。"); return b; }
function setBusy(busy, text, cls) { $("healthPill").textContent = text || (busy ? "执行中" : "已连接"); $("healthPill").className = "pill " + (cls || (busy ? "warn" : "ok")); for (const id of ["refreshButton", "planButton", "installButton", "selfCheckButton"]) $(id).disabled = busy; }
function dl(el, rows) { el.innerHTML = rows.map((r) => "<div><dt>" + r[0] + "</dt><dd>" + (r[1] ?? "—") + "</dd></div>").join(""); }
function safeOutput(r) { const value = r && r.json ? JSON.stringify(r.json, null, 2) : String(r?.stdout || r?.error || r?.stderr || "操作完成"); return value.replace(/[A-Za-z]:\\[^\r\n]+/g, "[本地路径]"); }
function render(data) {
  const c = data.effectiveConfig || data.config || {};
  $("configSource").textContent = data.installedConfig ? "已安装任务" : "本地配置"; $("generatedAt").textContent = new Date(data.generatedAt).toLocaleString("zh-CN", { hour12: false });
  $("primaryCampus").textContent = campusName(c.primaryCampus); $("fallbackCampus").textContent = "候补 " + campusName(c.fallbackCampus);
  $("desiredTime").textContent = (c.desiredStartTime || "—") + "–" + (c.desiredEndTime || "—"); $("bookingLimits").textContent = "最长 " + (c.maxBookingMinutes || "—") + " 分钟 · ¥" + (c.maxBookingAmount || "—");
  $("mailState").textContent = c.mailOnCompletion ? "已开启" : "已关闭"; $("paymentState").textContent = c.paymentAutoConfirm ? "已显式开启" : "已关闭";
  dl($("configList"), [["轮询窗口", (c.pollStartTime || "—") + "–" + (c.pollUntilTime || "—")], ["轮询间隔", (c.pollIntervalMs || "—") + " ms"], ["浏览器链路", c.browserMode || "—"], ["VPN 预连接", c.openVpn ? "开启" : "关闭"], ["部分时段兜底", c.partialMinMinutes ? "至少 " + c.partialMinMinutes + " 分钟" : "开启"]]); applyDefaults(c);
  const tasks = data.tasks?.rows || []; $("taskCount").textContent = tasks.length + " 项"; $("taskList").className = "timeline" + (tasks.length ? "" : " empty");
  $("taskList").innerHTML = tasks.length ? tasks.map((t) => '<div class="task"><span class="task-dot"></span><div><strong>' + (t.taskName || "项目任务") + "</strong><small>下次：" + (t.nextRunTime || "—") + " · 上次结果：" + (t.lastTaskResult ?? "—") + '</small></div><span class="pill neutral">' + (t.state || "未知") + "</span></div>").join("") : "尚未安装项目任务。";
  const r = data.latestResult; $("resultPill").textContent = !r ? "暂无" : (r.success ? "成功" : "失败"); $("resultPill").className = "pill " + (!r ? "neutral" : (r.success ? "ok" : "fail"));
  dl($("resultList"), r ? [["目标日期", r.slot?.targetDate || "—"], ["校区", campusName(r.slot?.campus)], ["场地", r.slot?.court || "—"], ["时段", r.slot?.start && r.slot?.end ? r.slot.start + "–" + r.slot.end : "—"], ["结果", r.success ? "预约成功" : (r.failureReason || "未成功")]] : [["状态", "暂无运行记录"]]);
  const check = data.latestSelfCheck; $("selfCheckSummary").textContent = check ? "最近自检：" + (check.passed || 0) + " 通过，" + (check.failed || 0) + " 失败" : "尚未运行自检。";
}
async function api(path, options = {}) { const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options, body: options.body ? JSON.stringify(options.body) : undefined }); const data = await response.json(); if (!response.ok || data.ok === false) throw new Error(data.error || data.stderr || data.stdout || "请求失败：" + response.status); return data; }
async function refresh(preserve = false) { setBusy(true, "刷新中"); try { render(await api("/api/dashboard")); if (!preserve) $("actionOutput").textContent = "状态已刷新。"; setBusy(false); } catch (e) { $("actionOutput").textContent = e.message; setBusy(false, "连接失败", "fail"); } }
async function action(label, path, body, confirmation) { try { if (confirmation && !window.confirm(confirmation)) return; setBusy(true, label); const result = await api(path, { method: "POST", body }); $("actionOutput").textContent = safeOutput(result); await refresh(true); } catch (e) { $("actionOutput").textContent = e.message; setBusy(false, "操作失败", "fail"); } }
fillTimes(); const date = new Date(); date.setDate(date.getDate() + 2); $("targetDate").value = date.toISOString().slice(0, 10); applyDefaults();
$("refreshButton").addEventListener("click", () => refresh()); $("planButton").addEventListener("click", () => action("预览中", "/api/plan-next", validate()));
$("installButton").addEventListener("click", () => action("安装中", "/api/install-next", validate(), "将替换本项目创建的 BadmintonBookingAssistant_* 任务。其他计划任务不会被修改。确认继续？"));
$("selfCheckButton").addEventListener("click", () => action("自检中", "/api/self-check")); refresh();
