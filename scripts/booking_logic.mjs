export const VENUES = {
  lxd: {
    label: "liuxiandong",
    shopNum: "1002",
    url: "https://ydsz.szpu.edu.cn/easyserp/index.html#/siteList?shortname=lxdymq&name=%E7%95%99%E4%BB%99%E6%B4%9E%E7%BE%BD%E6%AF%9B%E7%90%83&shopNum=1002&id=11&stid=11",
  },
  xlh: {
    label: "xilihu",
    shopNum: "1001",
    url: "https://ydsz.szpu.edu.cn/easyserp/index.html#/siteList?shortname=xlhymq&name=%E8%A5%BF%E4%B8%BD%E6%B9%96%E7%BE%BD%E6%AF%9B%E7%90%83&shopNum=1001&id=13&stid=13",
  },
};

export const LOGIN_URL =
  "https://authserver.szpu.edu.cn/authserver/login?service=https%3A%2F%2Fydsz.szpu.edu.cn%3A443%2Fcas%2F%2Flogin";

export function toMinutes(time) {
  const match = String(time || "").match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function toTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function desiredStarts(start, end) {
  const startMin = toMinutes(start);
  const endMin = toMinutes(end);
  if (startMin === null || endMin === null || endMin <= startMin) {
    throw new Error(`Invalid desired time range: ${start}-${end}`);
  }
  const result = [];
  for (let cursor = startMin; cursor < endMin; cursor += 30) result.push(toTime(cursor));
  return result;
}

export function courtPriority(config, campus) {
  const key = campus === "lxd" ? "lxdCourtPriority" : "xlhCourtPriority";
  return String(config[key] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function resolveFallbackCampus(primary, fallback) {
  if (!fallback || fallback === "none") return null;
  if (fallback === "auto") return primary === "xlh" ? "lxd" : "xlh";
  return fallback;
}

export function campusOrder(config) {
  const order = [String(config.primaryCampus || "lxd")];
  const fallback = resolveFallbackCampus(order[0], String(config.fallbackCampus || "none"));
  if (fallback && fallback !== order[0]) order.push(fallback);
  return order;
}

export function buildRunKey({ runDate, targetDate, config }) {
  const start = String(config.desiredStartTime).replaceAll(":", "");
  const end = String(config.desiredEndTime).replaceAll(":", "");
  return `booking_${runDate.replaceAll("-", "")}_0745_for_${targetDate.replaceAll("-", "")}_${String(config.primaryCampus).toLowerCase()}_${start}_${end}`;
}

export function validateConfig(config) {
  const required = [
    "username",
    "primaryCampus",
    "desiredStartTime",
    "desiredEndTime",
    "pollStartTime",
    "pollUntilTime",
    "pollIntervalMs",
  ];
  const missing = required.filter((key) => config[key] === undefined || config[key] === null || config[key] === "");
  if (missing.length) throw new Error(`Missing config field(s): ${missing.join(", ")}`);
  if (!VENUES[config.primaryCampus]) throw new Error(`Unknown primaryCampus: ${config.primaryCampus}`);
  desiredStarts(config.desiredStartTime, config.desiredEndTime);
  return true;
}

export function selectSlotPageFunction(input) {
  return `
(async () => {
  const input = ${JSON.stringify(input)};
  const courtPriority = input.courtPriority || [];
  const targetDate = input.targetDate;
  const desiredStart = input.desiredStartTime;
  const desiredEnd = input.desiredEndTime;
  const selectionMode = input.selectionMode || "full";
  const partialMinMinutes = Number(input.partialMinMinutes || 60);
  const maxSlotsInput = Number(input.maxSlots || 0);
  const maxAmount = Number(input.maxAmount || 0);
  const refreshDelayMs = Math.max(0, Number(input.refreshDelayMs ?? 60));
  const refreshTimeoutMs = Math.max(200, Number(input.refreshTimeoutMs ?? 900));
  const selectDelayMs = Math.max(0, Number(input.selectDelayMs ?? 25));
  const toMinutes = (time) => {
    const m = String(time || "").match(/^(\\d{1,2}):(\\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const toTime = (minutes) => String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0");
  const desiredStarts = [];
  const startMin = toMinutes(desiredStart);
  const endMin = toMinutes(desiredEnd);
  if (startMin === null || endMin === null || endMin <= startMin) {
    return { ok:false, reason:"invalid desired time range", targetDate, desiredStart, desiredEnd };
  }
  for (let t = startMin; t < endMin; t += 30) desiredStarts.push(toTime(t));
  const minPartialSlots = Math.max(1, Math.ceil(partialMinMinutes / 30));
  const maxSlots = maxSlotsInput > 0 ? Math.max(minPartialSlots, Math.floor(maxSlotsInput)) : desiredStarts.length;
  const configuredSlotCount = Math.min(desiredStarts.length, maxSlots);
  const configuredWindows = [];
  if (configuredSlotCount > 0) {
    for (let i = 0; i <= desiredStarts.length - configuredSlotCount; i += 1) {
      configuredWindows.push(desiredStarts.slice(i, i + configuredSlotCount));
    }
  }

  const dateLi = [...document.querySelectorAll(".date_top li")].find((el) =>
    (el.innerText || el.textContent || "").includes(targetDate)
  );
  if (!dateLi) return { ok:false, reason:"target date not found", targetDate };

  let vm = null;
  const seen = new Set();
  function walk(x) {
    if (!x || seen.has(x)) return;
    seen.add(x);
    if (x._data && Object.prototype.hasOwnProperty.call(x._data, "siteList")) vm = x;
    (x.$children || []).forEach(walk);
  }
  walk(document.querySelector("#app") && document.querySelector("#app").__vue__);

  const clickElement = (el) => {
    if (!el) return false;
    if (typeof el.click === "function") {
      try {
        el.click();
        return true;
      } catch {}
    }
    if (typeof Event === "function") {
      for (const type of ["mousedown", "mouseup", "click"]) {
        try {
          el.dispatchEvent(new Event(type, { bubbles:true, cancelable:true }));
        } catch {}
      }
    }
    return true;
  };
  const norm = (el) => (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ");
  const cellState = (el) => {
    const cls = String(el?.className || "");
    if (/colorThree|selected|active/.test(cls)) return 3;
    if (/colorTwo/.test(cls)) return 1;
    return 0;
  };
  const buildDomSites = async () => {
    clickElement(dateLi);
    await sleep(refreshDelayMs);
    const labels = [...document.querySelectorAll("li")]
      .map((el) => ({ el, text:norm(el), minutes:toMinutes(norm(el)) }))
      .filter((item) => item.minutes !== null && /^\\d{2}:\\d{2}$/.test(item.text))
      .sort((a, b) => a.minutes - b.minutes);
    if (labels.length < 2) return { sites:[], reason:"dom time labels not found" };
    const slotTimes = labels.slice(0, -1).map((item) => item.text);
    const headers = [...document.querySelectorAll(".sitename_top li")]
      .map((el, index) => ({ text:norm(el), index }))
      .filter((item) => item.text);
    const cells = [...document.querySelectorAll(".sitecontentWrap li, .sitecontent li")]
      .filter((el) => /豆/.test(norm(el)));
    if (!cells.length) return { sites:[], reason:"dom slot cells not found" };
    const slotsPerCourt = slotTimes.length;
    const courtCount = headers.length || Math.max(1, Math.floor(cells.length / slotsPerCourt));
    const sites = [];
    if (cells.length >= courtCount * slotsPerCourt) {
      for (let courtIndex = 0; courtIndex < courtCount; courtIndex += 1) {
        const courtCells = cells.slice(courtIndex * slotsPerCourt, (courtIndex + 1) * slotsPerCourt);
        if (courtCells.length < slotsPerCourt) continue;
        const courtName = headers[courtIndex]?.text || ((input.campus || "court") + "-" + (courtIndex + 1));
        sites.push({
          projectName:{ name:courtName },
          projectInfo:slotTimes.map((starttime, slotIndex) => ({
            starttime,
            endtime:labels[slotIndex + 1]?.text || toTime(toMinutes(starttime) + 30),
            state:cellState(courtCells[slotIndex]),
            money:Number((norm(courtCells[slotIndex]).match(/\\d+(?:\\.\\d+)?/) || [0])[0]),
            element:courtCells[slotIndex],
            domCellIndex:cells.indexOf(courtCells[slotIndex]),
          })),
        });
      }
    }
    return { sites, reason:sites.length ? "" : "dom grid did not map to courts" };
  };

  const dateItems = [...document.querySelectorAll(".date_top li")];
  const dateIndex = Math.max(0, dateItems.indexOf(dateLi));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const compactError = (e) => e && e.message ? e.message : String(e);
  const withTimeout = (promise, label) => Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + " timeout after " + refreshTimeoutMs + "ms")), refreshTimeoutMs)),
  ]);
  const refreshDetails = [];
  async function recordRefresh(label, fn) {
    try {
      const result = fn();
      if (result && typeof result.then === "function") await withTimeout(result, label);
      if (vm.$nextTick) await new Promise((resolve) => vm.$nextTick(resolve));
      await sleep(refreshDelayMs);
      refreshDetails.push({ label, ok:true, siteCount:Array.isArray(vm.siteList) ? vm.siteList.length : -1 });
    } catch (e) {
      refreshDetails.push({ label, ok:false, error:compactError(e) });
    }
  }

  let sourceSites = [];
  let sourceMode = "vue";
  let domReason = "";
  if (vm) {
    await recordRefresh("date-click", () => clickElement(dateLi));
    for (const name of ["discountGetSiteList", "getSiteList"]) {
      const refresh = vm[name];
      if (typeof refresh !== "function") continue;
      await recordRefresh(name + "(targetDate,dateIndex)", () => refresh.call(vm, targetDate, dateIndex));
      if (Array.isArray(vm.siteList) && vm.siteList.length > 0) break;
      await recordRefresh(name + "(dateIndex)", () => refresh.call(vm, dateIndex));
      if (Array.isArray(vm.siteList) && vm.siteList.length > 0) break;
    }
    sourceSites = Array.isArray(vm.siteList) ? vm.siteList : [];
  } else {
    sourceMode = "dom";
    const dom = await buildDomSites();
    sourceSites = dom.sites;
    domReason = dom.reason;
    refreshDetails.push({ label:"dom-grid", ok:sourceSites.length > 0, siteCount:sourceSites.length, reason:domReason });
  }

  const candidates = [];
  const targetSummary = [];
  let singleAvailable = 0;
  function pushCandidate(selectedSlots, courtNo, priorityIndex, mode) {
    const money = selectedSlots.reduce((sum, item) => sum + Number(item.slot.money || 0), 0);
    if (maxAmount > 0 && money > maxAmount + 0.01) return false;
    candidates.push({
      selected: selectedSlots,
      courtNo,
      priorityRank: priorityIndex >= 0 ? priorityIndex : 999,
      start: selectedSlots[0].slot.starttime || "",
      durationSlots: selectedSlots.length,
      hourAlignedRank: toMinutes(selectedSlots[0].slot.starttime) % 60 === 0 ? 0 : 1,
      money,
      mode,
    });
    return true;
  }
  for (let siteIndex = 0; siteIndex < sourceSites.length; siteIndex += 1) {
    const site = sourceSites[siteIndex];
    const court = site.projectName || {};
    const courtNo = String((court.name || "").match(/\\d+/)?.[0] || "");
    const slots = site.projectInfo || [];
    const targetStates = desiredStarts.map((start) => {
      const slot = slots.find((item) => item.starttime === start);
      const state = slot ? Number(slot.state) : null;
      if (state === 1) singleAvailable += 1;
      return start + ":" + (slot ? String(slot.state) : "missing");
    });
    targetSummary.push({ court: court.name || "", courtNo, states: targetStates.join("|") });
    if (courtPriority.length && !courtPriority.includes(courtNo)) continue;
    if (selectionMode === "full") {
      for (const windowStarts of configuredWindows) {
        const selectedSlots = [];
        for (const start of windowStarts) {
          const slotIndex = slots.findIndex((item) => item.starttime === start && Number(item.state) === 1);
          if (slotIndex < 0) { selectedSlots.length = 0; break; }
          selectedSlots.push({ siteIndex, slotIndex, court, slot: slots[slotIndex] });
        }
        if (selectedSlots.length === windowStarts.length) {
          pushCandidate(selectedSlots, courtNo, courtPriority.indexOf(courtNo), "full");
        }
      }
    } else {
      let run = [];
      const flushRun = () => {
        if (run.length >= minPartialSlots && run.length < desiredStarts.length) {
          const longest = Math.min(run.length, maxSlots);
          for (let size = longest; size >= minPartialSlots; size -= 1) {
            for (let startIndex = 0; startIndex <= run.length - size; startIndex += 1) {
              pushCandidate(run.slice(startIndex, startIndex + size), courtNo, courtPriority.indexOf(courtNo), "partial");
            }
          }
        }
        run = [];
      };
      for (const start of desiredStarts) {
        const slotIndex = slots.findIndex((item) => item.starttime === start && Number(item.state) === 1);
        if (slotIndex >= 0) run.push({ siteIndex, slotIndex, court, slot: slots[slotIndex] });
        else flushRun();
      }
      flushRun();
    }
  }

  if (!candidates.length) return {
    ok:false,
    campus:input.campus,
    reason:"no available slot",
    targetDate,
    siteCount:sourceSites.length,
    sourceMode,
    domReason,
    desiredStarts,
    singleAvailable,
    targetSummary,
    refreshDetails,
  };

  candidates.sort((a, b) => {
    if (selectionMode === "partial") {
      return (b.durationSlots || 0) - (a.durationSlots || 0) ||
        (a.hourAlignedRank || 0) - (b.hourAlignedRank || 0) ||
        a.start.localeCompare(b.start) ||
        a.priorityRank - b.priorityRank ||
        a.courtNo.localeCompare(b.courtNo);
    }
    return a.priorityRank - b.priorityRank || a.start.localeCompare(b.start) || a.courtNo.localeCompare(b.courtNo);
  });

  const chosen = candidates[0];
  if (vm) {
    vm.selectList.splice(0, vm.selectList.length);
    vm.changeItems.splice(0, vm.changeItems.length);
    for (const site of sourceSites) {
      for (const slot of site.projectInfo || []) {
        if (Number(slot.state) === 3) slot.state = 1;
      }
    }
    vm.$forceUpdate();
    await sleep(selectDelayMs);
  }
  for (const item of chosen.selected) {
    if (vm && typeof vm.select === "function") {
      await vm.select(item.slot, item.siteIndex, item.slotIndex);
    } else if (item.slot.element) {
      clickElement(item.slot.element);
    }
    await sleep(selectDelayMs);
  }
  const firstMeta = chosen.selected[0];
  const lastMeta = chosen.selected[chosen.selected.length - 1];
  const money = chosen.selected.reduce((sum, item) => sum + Number(item.slot.money || 0), 0);
  const candidate = {
    campus:input.campus,
    sourceMode,
    selectionMode,
    fallbackMode:chosen.mode || selectionMode,
    partialFallback:chosen.mode === "partial",
    targetDate,
    court:firstMeta.court.name,
    start:firstMeta.slot.starttime,
    end:lastMeta.slot.endtime,
    slotCount:chosen.selected.length,
    durationMinutes:chosen.selected.length * 30,
    times:chosen.selected.map((item) => item.slot.starttime + "-" + item.slot.endtime),
    money,
  };
  const selectedText = (document.querySelector(".selected")?.innerText || "").replace(/\\s+/g, " ").trim();
  const totalText = [...document.querySelectorAll("p,div,span")]
    .map((el) => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim())
    .find((text) => /共计/.test(text)) || "";
  const selectedCount = vm ? Math.max(
    Array.isArray(vm.selectList) ? vm.selectList.length : 0,
    Array.isArray(vm.changeItems) ? vm.changeItems.length : 0
  ) : chosen.selected.filter((item) => item.slot.element && cellState(item.slot.element) === 3).length;
  const pageTotal = String((vm && (vm.money || vm.totalMoney)) || totalText || "");
  const actualTotal = Number(pageTotal.match(/\\d+(?:\\.\\d+)?/)?.[0] || 0);
  const amountMismatch = money > 0 && actualTotal > 0 && Math.abs(actualTotal - money) > 0.01;
  const actualSelected = [];
  for (let siteIndex = 0; siteIndex < sourceSites.length; siteIndex += 1) {
    const site = sourceSites[siteIndex];
    const court = site.projectName || {};
    for (let slotIndex = 0; slotIndex < (site.projectInfo || []).length; slotIndex += 1) {
      const slot = site.projectInfo[slotIndex];
      if (Number(slot.state) === 3 || (slot.element && cellState(slot.element) === 3)) {
        actualSelected.push({ siteIndex, slotIndex, court, slot });
      }
    }
  }
  actualSelected.sort((a, b) => a.siteIndex - b.siteIndex || toMinutes(a.slot.starttime) - toMinutes(b.slot.starttime));
  const selectedCountStrict = actualSelected.length || selectedCount;
  const acceptedByVm = !!(vm && (
    (Array.isArray(vm.selectList) && vm.selectList.length >= chosen.selected.length) ||
    (Array.isArray(vm.changeItems) && vm.changeItems.length >= chosen.selected.length)
  ));
  const acceptedByDom = chosen.selected.every((item) => {
    if (!item.slot.element) return false;
    return cellState(item.slot.element) === 3;
  });
  const acceptedByTotal = /共计[:：]\\s*(?!0(?:\\.00)?\\s*豆)/.test(totalText);
  if (selectedCountStrict < chosen.selected.length || amountMismatch || (!acceptedByVm && !acceptedByDom && !acceptedByTotal)) {
    const minPartialSlots = Math.max(1, Math.ceil(partialMinMinutes / 30));
    let bestPartial = [];
    let run = [];
    const flushActualRun = () => {
      if (run.length >= minPartialSlots && run.length > bestPartial.length) bestPartial = run.slice();
      run = [];
    };
    for (const item of actualSelected) {
      const start = toMinutes(item.slot.starttime);
      const end = toMinutes(item.slot.endtime);
      const prev = run[run.length - 1];
      const prevEnd = prev ? toMinutes(prev.slot.endtime) : null;
      const sameCourt = !prev || prev.siteIndex === item.siteIndex;
      const contiguous = !prev || prevEnd === start;
      const withinDesiredWindow = start !== null && end !== null &&
        (startMin === null || start >= startMin) &&
        (endMin === null || end <= endMin);
      if (!withinDesiredWindow || !sameCourt || !contiguous) flushActualRun();
      if (withinDesiredWindow) run.push(item);
    }
    flushActualRun();
    if (bestPartial.length >= minPartialSlots) {
      const partialMoney = bestPartial.reduce((sum, item) => sum + Number(item.slot.money || 0), 0);
      const partialAmountMismatch = partialMoney > 0 && actualTotal > 0 && Math.abs(actualTotal - partialMoney) > 0.01;
      if (!partialAmountMismatch) {
        const partialFirst = bestPartial[0];
        const partialLast = bestPartial[bestPartial.length - 1];
        return {
          ok:true,
          campus:input.campus,
          sourceMode,
          selectionMode,
          fallbackMode:"degraded-partial",
          partialFallback:true,
          degradedFromFull:true,
          targetDate,
          court:partialFirst.court.name,
          start:partialFirst.slot.starttime,
          end:partialLast.slot.endtime,
          slotCount:bestPartial.length,
          durationMinutes:bestPartial.length * 30,
          times:bestPartial.map((item) => item.slot.starttime + "-" + item.slot.endtime),
          money:partialMoney,
          selectedCount:selectedCountStrict,
          pageTotal,
          refreshDetails,
        };
      }
    }
    return {
      ok:false,
      campus:input.campus,
      sourceMode,
      domClickFallback:sourceMode === "dom",
      domSelector:".sitecontentWrap li, .sitecontent li",
      domCellIndices:chosen.selected.map((item) => item.slot.domCellIndex).filter((idx) => Number.isInteger(idx) && idx >= 0),
      candidate,
      reason:"selection click rejected",
      selectedCount:selectedCountStrict,
      expectedCount:chosen.selected.length,
      pageTotal,
      expectedMoney:money,
      amountMismatch,
      targetDate,
      selectedText,
      totalText,
      toast:(document.body.innerText || "").split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean).slice(-8).join(" | "),
      refreshDetails,
    };
  }
  return {
    ok:true,
    ...candidate,
    selectedCount:selectedCountStrict,
    pageTotal,
    refreshDetails,
  };
})()
`;
}

export const venueStatePageFunction = `
(() => {
  let siteVm = null;
  const seen = new Set();
  function walk(x) {
    if (!x || seen.has(x)) return;
    seen.add(x);
    if (x._data && Object.prototype.hasOwnProperty.call(x._data, "siteList")) siteVm = x;
    (x.$children || []).forEach(walk);
  }
  const app = document.querySelector("#app");
  if (app && app.__vue__) walk(app.__vue__);
  const dates = [...document.querySelectorAll(".date_top li")].map((el) => (el.innerText || el.textContent || "").trim()).filter(Boolean);
  const storageGet = (key) => {
    try {
      return typeof sessionStorage !== "undefined" ? sessionStorage.getItem(key) || "" : "";
    } catch {
      return "";
    }
  };
  return {
    url: location.href,
    token: storageGet("token"),
    shopNum: storageGet("shopNum"),
    hasDateTop: !!document.querySelector(".date_top"),
    dateCount: dates.length,
    firstDates: dates.slice(0, 3),
    hasVenueVm: !!siteVm,
    siteCount: siteVm && Array.isArray(siteVm.siteList) ? siteVm.siteList.length : -1,
    text: (document.body && document.body.innerText || "").slice(0, 500),
  };
})()
`;

export const submitBookingPageFunction = `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (el) => {
    if (!el) return "";
    return [
      el.innerText || el.textContent || "",
      el.getAttribute && el.getAttribute("aria-label") || "",
      el.getAttribute && el.getAttribute("title") || "",
      el.value || "",
    ].join("").replace(/\\s+/g, "");
  };
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 &&
      rect.width > 0 && rect.height > 0;
  };
  const click = (el) => {
    if (!el) return false;
    if (el.scrollIntoView) el.scrollIntoView({ block:"center" });
    if (typeof el.click === "function") {
      try {
        el.click();
        return true;
      } catch {}
    }
    if (typeof Event === "function") {
      try { el.dispatchEvent(new Event("click", { bubbles:true, cancelable:true })); } catch {}
    }
    return true;
  };
  let siteVm = null;
  const seen = new Set();
  function walk(x) {
    if (!x || seen.has(x)) return;
    seen.add(x);
    if (x._data && Object.prototype.hasOwnProperty.call(x._data, "siteList") && typeof x.submit === "function") siteVm = x;
    (x.$children || []).forEach(walk);
  }
  walk(document.querySelector("#app") && document.querySelector("#app").__vue__);
  let clickedSubmit = false;
  if (siteVm) {
    siteVm.submit();
    clickedSubmit = true;
  } else {
    const button = [...document.querySelectorAll("button,a,[role=button]")].reverse()
      .find((el) => visible(el) && norm(el).includes("\\u9884\\u7ea6\\u573a\\u5730"));
    if (!button) return { clicked:false, reason:"submit not found" };
    clickedSubmit = click(button);
  }
  await sleep(120);
  let clickedNoCompanion = false;
  for (let i = 0; i < 16 && !location.href.includes("confirmPayment"); i += 1) {
    const noCompanion = [...document.querySelectorAll(".van-dialog__cancel,button,a,[role=button]")]
      .find((el) => visible(el) && norm(el) === "\\u5426");
    if (noCompanion) {
      clickedNoCompanion = click(noCompanion);
      break;
    }
    await sleep(80);
  }
  if (clickedNoCompanion) await sleep(180);
  let clickedConfirm = false;
  for (let i = 0; i < 20 && !location.href.includes("confirmPayment"); i += 1) {
    const confirm = [...document.querySelectorAll("button,a,[role=button],.van-dialog__confirm")]
      .find((el) => visible(el) && norm(el).includes("\\u786e\\u8ba4\\u9884\\u7ea6"));
    if (confirm) {
      clickedConfirm = click(confirm);
      break;
    }
    await sleep(100);
  }
  await sleep(500);
  return { clickedSubmit, clickedNoCompanion, clickedConfirm, url:location.href, text:(document.body.innerText || "").slice(0, 800) };
})()
`;

export function confirmPaymentPageFunction({ noConfirmPayment, campus }) {
  return `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const noConfirmPayment = ${noConfirmPayment ? "true" : "false"};
  const campus = ${JSON.stringify(campus || "")};
  const expectedShopNum = campus === "lxd" ? "1002" : (campus === "xlh" ? "1001" : "");
  const norm = (el) => (el.innerText || el.textContent || "").replace(/\\s+/g, "");
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 &&
      rect.width > 0 && rect.height > 0;
  };
  const click = (el) => {
    if (!el) return false;
    if (el.scrollIntoView) el.scrollIntoView({ block:"center" });
    if (typeof el.click === "function") {
      try {
        el.click();
        return true;
      } catch {}
    }
    if (typeof Event === "function") {
      try { el.dispatchEvent(new Event("click", { bubbles:true, cancelable:true })); } catch {}
    }
    return true;
  };
  const matchExact = (text, match) => typeof match === "string" ? text === match : match.test(text);
  const matchLoose = (text, match) => typeof match === "string" ? text.includes(match) : match.test(text);
  const findClickable = (matches, selector = ".yd-btn-block,.van-button,.mint-button,button,a,[role=button]") =>
    [...document.querySelectorAll(selector)].reverse().find((el) => {
      if (!visible(el)) return false;
      const text = norm(el);
      return matches.some((match) => matchExact(text, match));
    });
  const findClickableLoose = (matches, selector = ".yd-btn-block,.van-button,.mint-button,button,a,[role=button]") =>
    [...document.querySelectorAll(selector)].reverse().find((el) => {
      if (!visible(el)) return false;
      const text = norm(el);
      return matches.some((match) => matchLoose(text, match));
    });
  let vm = null;
  const seen = new Set();
  function walk(x) {
    if (!x || seen.has(x)) return;
    seen.add(x);
    if (x._data && Object.prototype.hasOwnProperty.call(x._data, "MembershipCardPaymentArr")) vm = x;
    (x.$children || []).forEach(walk);
  }
  const pageText = () => document.body?.innerText || "";
  const shopNum = () => {
    try { return sessionStorage.getItem("shopNum") || ""; } catch { return ""; }
  };
  if (expectedShopNum && shopNum() !== expectedShopNum) {
    try {
      sessionStorage.setItem("shopNum", expectedShopNum);
      if ((campus === "lxd" && pageText().includes("留仙洞")) || (campus === "xlh" && pageText().includes("西丽湖"))) {
        location.reload();
        await sleep(2500);
      }
    } catch {}
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    walk(document.querySelector("#app") && document.querySelector("#app").__vue__);
    const cards = vm && Array.isArray(vm.MembershipCardPaymentArr) ? vm.MembershipCardPaymentArr : [];
    if (cards.length > 0) break;
    await sleep(2000);
  }
  const card = vm && vm.MembershipCardPaymentArr && vm.MembershipCardPaymentArr[0];
  if (!card) {
    return {
      url:location.href,
      text:(document.body.innerText || "").slice(0, 1600),
      clickedPay:false,
      clickedConfirmPayment:false,
      reason:"campus card payment array not available",
      cardCount: vm && Array.isArray(vm.MembershipCardPaymentArr) ? vm.MembershipCardPaymentArr.length : 0,
      patmentModel: vm && vm.PatmentModel,
      selectedCardIndex: vm && vm.selectCardindexHyk,
      sessionShopNum: shopNum(),
    };
  }
  const applyCardToVm = () => {
    if (!vm || !card) return;
    if (typeof vm.PatmentChange === "function") vm.PatmentChange({ target:{ checked:false, value:card.cardindex } }, card);
    vm.PatmentModel = "hyk";
    vm.cardTime = 0;
    vm.NewcardIndex = card.cardindex;
    vm.selectCardindexHyk = card.cardindex;
    vm.cardcash = card.cardcash;
    vm.zengSongE = card.zengSongE || 0;
  };
  applyCardToVm();
  const findCampusCardRadio = () => [...document.querySelectorAll("input[type=radio]")].find((el) => {
    const cellText = norm(el.closest(".yd-cell-item,.van-cell,.mint-cell,label,li") || el.parentElement || el);
    return cellText.includes("\\u6821\\u56ed\\u5361") || (card && el.value === String(card.cardindex));
  }) || document.querySelector("input[type=radio]");
  const clickCampusCardChoice = () => {
    let clicked = false;
    const radio = findCampusCardRadio();
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event("input", { bubbles:true }));
      radio.dispatchEvent(new Event("change", { bubbles:true }));
      clicked = click(radio) || clicked;
      const row = radio.closest(".yd-cell-item,.van-cell,.mint-cell,label,li");
      if (row) clicked = click(row) || clicked;
    }
    const rowByText = [...document.querySelectorAll(".yd-cell-item,.van-cell,.mint-cell,label,li")].find((el) =>
      visible(el) && norm(el).includes("\\u6821\\u56ed\\u5361")
    );
    if (rowByText) clicked = click(rowByText) || clicked;
    return clicked;
  };
  let clickedRadio = clickCampusCardChoice();
  await sleep(500);
  if (noConfirmPayment) {
    return {
      url:location.href,
      text:(document.body.innerText || "").slice(0, 1600),
      selectedOnly:true,
      cardCount: vm && Array.isArray(vm.MembershipCardPaymentArr) ? vm.MembershipCardPaymentArr.length : 0,
      clickedRadio,
      patmentModel: vm && vm.PatmentModel,
      newCardIndex: vm && vm.NewcardIndex,
      selectedCardIndex: vm && vm.selectCardindexHyk,
      sessionShopNum: shopNum(),
    };
  }
  let clickedPay = false;
  let clickedConfirmPayment = false;
  let payClickCount = 0;
  let confirmClickCount = 0;
  let lastAction = "";
  const payTexts = [
    "\\u786e\\u5b9a\\u652f\\u4ed8",
    "\\u786e\\u8ba4\\u652f\\u4ed8",
    "\\u7acb\\u5373\\u652f\\u4ed8",
    "\\u53bb\\u652f\\u4ed8",
    "\\u652f\\u4ed8",
    /\\u652f\\u4ed8$/
  ];
  const confirmTexts = [
    "\\u786e\\u8ba4",
    "\\u786e\\u5b9a",
    "\\u7ee7\\u7eed",
    "\\u6211\\u77e5\\u9053\\u4e86",
    /^(\\u786e\\u8ba4|\\u786e\\u5b9a|\\u7ee7\\u7eed|\\u6211\\u77e5\\u9053\\u4e86)$/
  ];
  const successText = /\\u652f\\u4ed8\\u6210\\u529f|\\u9884\\u7ea6\\u6210\\u529f|\\u5df2\\u652f\\u4ed8|\\u8ba2\\u5355\\u6210\\u529f/;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (location.href.includes("myOrderSite") || successText.test(pageText())) break;
    walk(document.querySelector("#app") && document.querySelector("#app").__vue__);
    applyCardToVm();
    if (attempt % 3 === 0) clickedRadio = clickCampusCardChoice() || clickedRadio;
    const confirmPayment = findClickable(confirmTexts, ".van-dialog .van-dialog__confirm,.van-dialog .van-button,.mint-msgbox .mint-msgbox-confirm,.mint-msgbox .mint-button,[role=dialog] button,[role=dialog] a");
    if (confirmPayment) {
      clickedConfirmPayment = click(confirmPayment) || clickedConfirmPayment;
      confirmClickCount += 1;
      lastAction = "confirm";
      await sleep(900);
      continue;
    }
    const pay = document.querySelector("button.yd-btn-block:not([disabled])") ||
      findClickableLoose(payTexts, ".yd-btn-block,.van-button,.mint-button,button,a,[role=button]");
    if (pay) {
      clickedPay = click(pay) || clickedPay;
      payClickCount += 1;
      lastAction = "pay";
      await sleep(900);
      continue;
    }
    lastAction = "wait";
    await sleep(700);
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const text = document.body.innerText || "";
    if (location.href.includes("myOrderSite") || successText.test(text)) break;
    await sleep(500);
  }
  return {
    url:location.href,
    text:(document.body.innerText || "").slice(0, 1600),
    clickedPay,
    clickedConfirmPayment,
    payClickCount,
    confirmClickCount,
    lastAction,
    cardCount: vm && Array.isArray(vm.MembershipCardPaymentArr) ? vm.MembershipCardPaymentArr.length : 0,
    patmentModel: vm && vm.PatmentModel,
    newCardIndex: vm && vm.NewcardIndex,
    selectedCardIndex: vm && vm.selectCardindexHyk,
    sessionShopNum: shopNum(),
  };
})()
`;
}

export function paymentOutcome(payment, { noConfirmPayment }) {
  const text = String(payment?.text || "");
  const url = String(payment?.url || "");
  const paymentStepReached = url.includes("confirmPayment");
  const success = url.includes("myOrderSite") || /支付成功|预约成功|已支付|订单成功|\\u652f\\u4ed8\\u6210\\u529f|\\u9884\\u7ea6\\u6210\\u529f|\\u5df2\\u652f\\u4ed8/.test(text) ||
    (noConfirmPayment && paymentStepReached);
  const quotaExhausted = /0\\.0/.test(text) && paymentStepReached;
  let reason = "";
  if (noConfirmPayment && paymentStepReached) {
    reason = `NoConfirmPayment: reached payment page and selected payment method. cardCount=${payment.cardCount || 0} selectedCardIndex=${payment.selectedCardIndex || ""}`;
  } else if (!success) {
    reason = payment?.reason || text.split(/\\r?\\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 6).join(" | ");
    if (payment && !payment.clickedPay) reason = `Payment button not clicked. ${reason}`;
    if (payment && payment.clickedPay && !payment.clickedConfirmPayment && paymentStepReached) reason = `Payment still pending after pay loop. payClicks=${payment.payClickCount || 0} confirmClicks=${payment.confirmClickCount || 0} lastAction=${payment.lastAction || ""}. ${reason}`;
    if (payment && payment.cardCount === 0) reason = `Campus card unavailable. ${reason}`;
    if (quotaExhausted) reason += " | Daily reservation quota is already exhausted; stop retrying.";
  }
  return { success, quotaExhausted, reason, url, text };
}
