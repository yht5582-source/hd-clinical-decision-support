/*
 * HD 臨床決策引擎（純函式，無 DOM 依賴）
 * 瀏覽器：window.HDEngine；Node：require("./engine.js")
 *
 * 動力學模型
 *   K      ：Michaels 方程式（血中尿素水流量 Qbw = 0.86 × Qb）
 *   V      ：Watson 總體水公式（以乾體重 ≈ 透析後體重計算）
 *   R      ：單池變動容積模型（透析中脫水使分布容積由 V+UF 縮至 V）
 *   spKt/V ：Daugirdas 第二代公式 −ln(R − 0.008t) + (4 − 3.5R) × UF/W
 *   eKt/V  ：Daugirdas rate equation（AV 通路 / 中心靜脈導管）
 *   stdKt/V：Leypoldt / FHN 簡化公式（含脫水校正）
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HDEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VERSION = "1.1.0";

  const T = {
    spKtvMin: 1.2,      // KDOQI 2015：每週三次，單次最低
    spKtvTarget: 1.4,   // KDOQI 2015：建議目標
    stdKtvMin: 2.1,     // KDOQI 2015：每週最低
    stdKtvTarget: 2.3,  // KDOQI 2015：每週建議目標
    ufrCaution: 10,     // mL/kg/hr
    ufrHigh: 13,        // KDOQI 2015
    idwgPct: 5,         // % 乾體重
    corrCaLow: 8.4,
    corrCaHigh: 9.5,
    phosLow: 3.5,
    phosHigh: 5.5,
    caxp: 55,
    hbLow: 10.0,
    hbHigh: 11.5,
    hbHold: 13.0,
    kHigh: 5.5,
    kUrgent: 6.5,
    kLow: 3.5,
    albPew: 3.8,
    maxHours: 6,
    maxQbAv: 450,
    maxQbCvc: 350
  };

  const KOA_OPTIONS = [700, 950, 1150, 1400];

  function isNum(x) { return typeof x === "number" && isFinite(x); }
  function fmt(x, d) { return isNum(x) ? x.toFixed(d) : "--"; }
  function roundUp(x, step) { return Math.ceil(x / step - 1e-9) * step; }

  /* ---------- 動力學 ---------- */

  function watsonV(sex, age, heightCm, weightKg) {
    return sex === "F"
      ? -2.097 + 0.1069 * heightCm + 0.2466 * weightKg
      : 2.447 - 0.09516 * age + 0.1074 * heightCm + 0.3362 * weightKg;
  }

  function michaelsK(qb, qd, koa) {
    const qbw = qb * 0.86;
    const ratio = qbw / qd;
    if (Math.abs(1 - ratio) < 1e-6) return (qbw * koa) / (koa + qbw);
    const ez = Math.exp((koa / qbw) * (1 - ratio));
    return qbw * (ez - 1) / (ez - ratio);
  }

  function kinetics(p) {
    const tMin = p.hours * 60;
    const V = watsonV(p.sex, p.age, p.height, p.dw);          // L，透析後
    const K = michaelsK(p.qb, p.qd, p.koa);                    // mL/min
    const idwg = Math.max(0, p.preW - p.dw);
    const ufL = idwg + Math.max(0, p.intake) / 1000;
    const qf = (ufL * 1000) / tMin;                            // mL/min
    const V0 = V + ufL;

    const R = qf < 1e-6
      ? Math.exp(-(K * tMin) / (V0 * 1000))
      : Math.pow(V / V0, (K - qf) / qf);
    const Rg = Math.min(0.99, R + 0.008 * p.hours);            // 含尿素生成之預估透析後/前 BUN 比
    const spKtv = -Math.log(Rg - 0.008 * p.hours) + (4 - 3.5 * Rg) * (ufL / p.dw);
    const urr = (1 - Rg) * 100;

    const eKtv = p.access === "cvc"
      ? spKtv - 0.47 * spKtv / p.hours + 0.02
      : spKtv - 0.6 * spKtv / p.hours + 0.03;

    const N = p.freq;
    const ex = 1 - Math.exp(-eKtv);
    const stdBase = (10080 * ex / tMin) / (ex / eKtv + 10080 / (N * tMin) - 1);
    const ufCorr = 1 - (0.74 / N) * (ufL * N / V);
    const stdKtv = ufCorr > 0.3 ? stdBase / ufCorr : stdBase;

    return {
      K, V, tMin, idwg, idwgPct: (idwg / p.dw) * 100, ufL, ufMl: ufL * 1000,
      ufr: (ufL * 1000) / p.hours / p.dw, R: Rg, spKtv, urr, eKtv, stdKtv
    };
  }

  function adequacyMetric(p, kin) {
    return p.freq === 3
      ? { name: "spKt/V", value: kin.spKtv, min: T.spKtvMin, target: T.spKtvTarget }
      : { name: "stdKt/V", value: kin.stdKtv, min: T.stdKtvMin, target: T.stdKtvTarget };
  }

  function metricWith(p, patch) {
    const q = Object.assign({}, p, patch);
    return adequacyMetric(q, kinetics(q)).value;
  }

  /** 延長時間（每 0.25 h）至達標所需最短時數；超過上限回傳 null */
  function hoursFor(p, target) {
    for (let h = roundUp(p.hours + 0.25, 0.25); h <= T.maxHours + 1e-9; h += 0.25) {
      if (metricWith(p, { hours: h }) >= target) return h;
    }
    return null;
  }

  /** 提高 Qb（每 10 mL/min）至達標所需最低值；超過通路上限回傳 null */
  function qbFor(p, target) {
    const cap = p.access === "cvc" ? T.maxQbCvc : T.maxQbAv;
    for (let qb = roundUp(p.qb + 10, 10); qb <= cap; qb += 10) {
      if (metricWith(p, { qb }) >= target) return qb;
    }
    return null;
  }

  /* ---------- 處方建議 ---------- */

  function hdNotes(p, kin) {
    const notes = [];
    const m = adequacyMetric(p, kin);
    const label = `${m.name} = ${fmt(m.value, 2)}`;

    if (m.value < m.target) {
      const opts = [];
      if (p.access === "cvc") opts.push("檢查導管功能與再循環（必要時正反接評估）");
      else opts.push("先排除血管通路狹窄與再循環、確認實際 Qb 與透析時間足量");
      const qbNeed = qbFor(p, m.target);
      if (qbNeed) opts.push(`Qb 由 ${p.qb} 調至 ${qbNeed} mL/min`);
      const nextKoa = KOA_OPTIONS.find(k => k > p.koa);
      if (nextKoa) opts.push(`改用 KoA ≈ ${nextKoa} 人工腎臟（預估 ${m.name} ${fmt(metricWith(p, { koa: nextKoa }), 2)}）`);
      if (p.qd < 700) opts.push(`Qd 調至 700–800 mL/min（預估 ${m.name} ${fmt(metricWith(p, { qd: 800 }), 2)}，效益有限）`);
      const hNeed = hoursFor(p, m.target);
      if (hNeed) opts.push(`透析時間延長至 ${hNeed} 小時`);
      else opts.push(`單靠延長時間（≤ ${T.maxHours} h）仍無法達標，需合併上述調整或增加透析次數`);

      const below = m.value < m.min;
      notes.push({
        type: below ? "alert" : "caution",
        text: below
          ? `⚠️ 透析劑量不足（${label} < 最低標準 ${m.min}）：建議${opts.join("；")}。`
          : `🟡 透析劑量達最低標準但未達建議目標（${label}，目標 ≥ ${m.target}）：可考慮${opts.join("；")}。`
      });
    } else {
      notes.push({
        type: "good",
        text: `✅ 透析廓清率達標（${label} ≥ ${m.target}，URR ${fmt(kin.urr, 1)}%）：維持現行 Qb ${p.qb} / Qd ${p.qd}、${p.hours} 小時處方。`
      });
    }

    if (p.freq === 2) {
      notes.push({
        type: "caution",
        text: "🟡 每週兩次透析：KDOQI 僅建議用於殘餘腎功能足夠（Kru 約 > 3 mL/min/1.73m²）者，需每 1–3 個月追蹤殘餘尿量與尿素廓清率；本試算之 stdKt/V 未納入殘餘腎功能。"
      });
    }

    const hUfr = roundUp(kin.ufMl / (T.ufrCaution * p.dw), 0.25);
    if (kin.ufr > T.ufrHigh) {
      notes.push({
        type: "alert",
        text: `🚨 超濾率過高（UFR ${fmt(kin.ufr, 1)} mL/kg/hr > ${T.ufrHigh}）：透析中低血壓與心肌頓抑風險高。${hUfr <= T.maxHours ? `建議延長透析時間至 ≥ ${hUfr} 小時（使 UFR ≤ 10）或加做一次透析` : `即使延長至 ${T.maxHours} 小時 UFR 仍 > 10，需加做一次透析或分次達成乾體重`}、啟動階梯式脫水曲線、透析液溫度 35.5–36.0°C、減少透析中進食，並重新評估乾體重。`
      });
    } else if (kin.ufr > T.ufrCaution || kin.idwgPct > T.idwgPct) {
      const extra = kin.ufr > T.ufrCaution && hUfr <= T.maxHours ? `若維持 UFR ≤ 10 需透析 ≥ ${hUfr} 小時；` : "";
      notes.push({
        type: "caution",
        text: `🟡 脫水負荷偏高（IDWG ${fmt(kin.idwgPct, 1)}%，UFR ${fmt(kin.ufr, 1)} mL/kg/hr）：${extra}密切監測後段血壓，並衛教限鹽限水（每日鈉 < 2 g）。`
      });
    } else {
      notes.push({
        type: "good",
        text: `✅ 脫水速率安全（UFR ${fmt(kin.ufr, 1)} mL/kg/hr ≤ 10，IDWG ${fmt(kin.idwgPct, 1)}%）：依標準曲線脫水。`
      });
    }

    if (p.preW < p.dw) {
      notes.push({
        type: "caution",
        text: `🟡 上機前體重（${p.preW} kg）低於乾體重（${p.dw} kg）：請確認秤重，並評估乾體重是否需下修（營養不良、肌肉流失）。`
      });
    }
    return notes;
  }

  /* ---------- 生化判讀 ---------- */

  function ironStatus(ferritin, tsat) {
    if (!isNum(ferritin) || !isNum(tsat)) return null;
    if (ferritin > 800 || tsat > 50) return { label: "鐵過量風險", cls: "warn", key: "overload" };
    if (tsat < 20 && ferritin < 200) return { label: "絕對缺鐵", cls: "warn", key: "absolute" };
    if (tsat < 20) return { label: "功能性缺鐵", cls: "warn", key: "functional" };
    if (ferritin < 200) return { label: "儲鐵偏低", cls: "warn", key: "lowStore" };
    return { label: "儲備充足", cls: "ok", key: "ok" };
  }

  function labs(l) {
    const corrCa = isNum(l.ca) && isNum(l.alb)
      ? (l.alb < 4.0 ? l.ca + 0.8 * (4.0 - l.alb) : l.ca)
      : (isNum(l.ca) ? l.ca : null);
    const caxp = isNum(corrCa) && isNum(l.phos) ? corrCa * l.phos : null;
    const iron = ironStatus(l.ferritin, l.tsat);
    const uln = isNum(l.pthUln) && l.pthUln > 0 ? l.pthUln : 65;
    return { corrCa, caxp, iron, pthLow: 2 * uln, pthHigh: 9 * uln };
  }

  function labNotes(l, r) {
    const notes = [];
    const { corrCa, caxp } = r;
    const highCa = isNum(corrCa) && corrCa > T.corrCaHigh;
    const highP = isNum(l.phos) && l.phos > T.phosHigh;

    // 鈣
    if (isNum(corrCa) && corrCa < T.corrCaLow) {
      notes.push({
        type: "alert",
        text: `🦴 低血鈣（矯正鈣 ${fmt(corrCa, 2)} mg/dL < ${T.corrCaLow}）：檢視擬鈣劑劑量（Cinacalcet / Etelcalcetide 常見副作用），可考慮含鈣磷結合劑、活性維生素 D 或提高透析液鈣濃度；有症狀者補充鈣劑並追蹤心電圖 QTc。`
      });
    }

    // 磷
    if (isNum(l.phos)) {
      if (highP) {
        notes.push(highCa || (isNum(caxp) && caxp >= T.caxp)
          ? { type: "alert", text: `🦴 高血磷合併高血鈣／高鈣磷乘積（P ${l.phos}、矯正鈣 ${fmt(corrCa, 2)}、Ca×P ${fmt(caxp, 1)}）：減量或停用含鈣磷結合劑，改用非鈣系（Sevelamer、Lanthanum、Ferric citrate、Sucroferric oxyhydroxide），可考慮透析液鈣 2.5 mEq/L；磷結合劑須「隨餐」服用（Lanthanum 需嚼碎），並檢視透析劑量與高磷加工食品。` }
          : { type: "alert", text: `🦴 高血磷（P ${l.phos} > ${T.phosHigh} mg/dL，矯正鈣 ${fmt(corrCa, 2)}）：調升磷結合劑（血鈣正常偏低時可用鈣系或非鈣系），檢視服藥順從性、透析劑量，以及加工食品添加磷與食物磷／蛋白比。` });
      } else if (l.phos < T.phosLow) {
        notes.push({ type: "caution", text: `🟡 低血磷（P ${l.phos} < ${T.phosLow} mg/dL）：警覺蛋白質熱量耗損（PEW）或進食不足，建議減量或暫停磷結合劑並加強高生物價蛋白質攝取。` });
      } else {
        notes.push({ type: "good", text: `✅ 血磷控制達標（P ${l.phos} mg/dL${isNum(caxp) ? `，Ca×P ${fmt(caxp, 1)}` : ""}）：維持現行磷結合劑與飲食衛教。` });
      }
    }

    // iPTH（KDIGO 2017：正常上限 2–9 倍）
    if (isNum(l.ipth)) {
      const range = `${Math.round(r.pthLow)}–${Math.round(r.pthHigh)}`;
      if (l.ipth > r.pthHigh) {
        const rx = highCa || highP
          ? "血鈣或血磷偏高，優先使用擬鈣劑（Cinacalcet / Etelcalcetide），暫緩或減量活性維生素 D。"
          : "血鈣、血磷不高，可啟動或調升活性維生素 D（Calcitriol / Paricalcitol），或合併擬鈣劑。";
        const ptx = l.ipth > 2 * r.pthHigh ? "若藥物治療無效或合併高血鈣，評估副甲狀腺切除術。" : "";
        notes.push({ type: "alert", text: `🦴 次發性副甲狀腺機能亢進（iPTH ${l.ipth} pg/mL > 目標 ${range}）：${rx}${ptx}` });
      } else if (l.ipth < r.pthLow) {
        notes.push({ type: "caution", text: `🟡 iPTH 偏低（${l.ipth} pg/mL < ${Math.round(r.pthLow)}）：低週轉骨病變風險，建議減量或暫停活性維生素 D、擬鈣劑與含鈣磷結合劑，避免血管鈣化。` });
      } else {
        notes.push({ type: "good", text: `✅ iPTH 位於目標範圍（${l.ipth} pg/mL，目標 ${range}）：觀察趨勢，避免單次數值即調藥。` });
      }
    }

    // 貧血
    const iron = r.iron;
    const ironRoom = isNum(l.tsat) && isNum(l.ferritin) && l.tsat <= 30 && l.ferritin <= 500;
    if (isNum(l.hb)) {
      if (l.hb < T.hbLow) {
        notes.push(ironRoom
          ? { type: "alert", text: `🩸 腎性貧血合併鐵質可補充（Hb ${l.hb} g/dL、TSAT ${l.tsat}%、Ferritin ${l.ferritin}）：先給予靜脈鐵劑（例：Iron sucrose 100 mg 每次透析 × 10 次，總量約 1 g），排除感染活動期；若 4 週 Hb 上升 < 1 g/dL，ESA 調升約 25%。` }
          : { type: "alert", text: `🩸 腎性貧血（Hb ${l.hb} g/dL < ${T.hbLow}${iron ? `，${iron.label}` : ""}）：ESA 調升約 25%，並排查出血、感染／發炎（CRP）、透析不足、副甲狀腺機能亢進與 B12／葉酸缺乏等 ESA 低反應原因。` });
      } else if (l.hb > T.hbHold) {
        notes.push({ type: "alert", text: `🩸 血紅素過高（Hb ${l.hb} g/dL > ${T.hbHold}）：暫停 ESA，待 Hb 降至目標範圍後以較低劑量（約減 25%）恢復。` });
      } else if (l.hb > T.hbHigh) {
        notes.push({ type: "caution", text: `🟡 血紅素偏高（Hb ${l.hb} g/dL > ${T.hbHigh}）：為降低中風、血栓與心血管風險，ESA 調降約 25%。` });
      } else {
        notes.push({ type: "good", text: `✅ 血紅素控制理想（Hb ${l.hb} g/dL，目標 ${T.hbLow}–${T.hbHigh}）：維持現行 ESA 與鐵劑劑量。` });
      }
    }
    if (iron) {
      if (iron.key === "overload") {
        notes.push({ type: "caution", text: `🟡 鐵過量風險（Ferritin ${l.ferritin}、TSAT ${l.tsat}%）：暫停靜脈鐵劑，下次檢驗再評估。` });
      } else if (iron.key !== "ok" && !(isNum(l.hb) && l.hb < T.hbLow)) {
        notes.push({ type: "caution", text: `🟡 ${iron.label}（Ferritin ${l.ferritin}、TSAT ${l.tsat}%）：${iron.key === "functional" ? "常見於發炎或 ESA 劑量偏高，可在排除感染後給予小劑量維持性靜脈鐵劑並追蹤 CRP" : "建議維持性靜脈鐵劑（例：每 1–2 週 100 mg）並追蹤"}。` });
      }
    }

    // 血鉀
    if (isNum(l.k)) {
      if (l.k >= T.kUrgent) {
        notes.push({ type: "alert", text: `🚨 嚴重高血鉀（K ${l.k} mEq/L ≥ ${T.kUrgent}）：立即 12 導程心電圖與心臟監測；有 ECG 變化時給予靜脈鈣劑，並以胰島素＋葡萄糖暫時轉移鉀，儘速安排透析（避免使用 0–1 K 透析液造成鉀驟降）。` });
      } else if (l.k >= T.kHigh) {
        notes.push({ type: "alert", text: `⚡ 高血鉀（K ${l.k} mEq/L ≥ ${T.kHigh}）：檢視心電圖、RAASi 與其他升鉀藥物、便祕與透析劑量；可用 2.0 K 透析液（心律不整高風險者避免 < 2 K），考慮新型排鉀劑（Sodium zirconium cyclosilicate / Patiromer），並加強低鉀飲食衛教（生菜、菜湯、肉湯、低鈉鹽）。` });
      } else if (l.k < T.kLow) {
        notes.push({ type: "alert", text: `⚡ 低血鉀（K ${l.k} mEq/L < ${T.kLow}）：評估進食不足、腹瀉或嘔吐，改用 3.0 K 透析液並適度放寬飲食攝鉀；服用毛地黃者風險更高。` });
      }
    }
    return notes;
  }

  /* ---------- 營養 ---------- */

  function nutrition(p, alb) {
    const ibw = p.sex === "M" ? (p.height - 80) * 0.7 : (p.height - 70) * 0.6;
    const ratio = p.dw / ibw;
    let refWeight = p.dw;
    let basis = "乾體重";
    if (ratio > 1.2) { refWeight = ibw + 0.25 * (p.dw - ibw); basis = "調整體重（乾體重 > 120% IBW）"; }
    else if (ratio < 0.8) { refWeight = ibw; basis = "理想體重（乾體重 < 80% IBW）"; }
    const kcalPerKg = p.age >= 60 ? [30, 35] : [35, 35];
    return {
      ibw, refWeight, basis,
      kcalMin: Math.round(refWeight * kcalPerKg[0]),
      kcalMax: Math.round(refWeight * kcalPerKg[1]),
      kcalPerKg,
      proMin: refWeight * 1.0,
      proMax: refWeight * 1.2,
      fluidLimit: Math.round(Math.max(0, p.urine) + 750),
      idwgLimit: p.dw * T.idwgPct / 100,
      alb
    };
  }

  function nutrNotes(n, p) {
    const notes = [];
    if (isNum(n.alb) && n.alb < T.albPew) {
      notes.push({ type: "alert", text: `⚠️ 蛋白質熱量耗損（PEW）風險（Albumin ${n.alb} g/dL < ${T.albPew}）：營養師介入評估（SGA / MIS、飲食紀錄、nPCR），排除發炎與透析不足；攝取不足時給予透析專用口服營養補充品（高蛋白、低磷鉀）每日 1–2 份，透析中進食可提升攝取。` });
    }
    const kcal = n.kcalPerKg[0] === n.kcalPerKg[1] ? `${n.kcalPerKg[0]}` : `${n.kcalPerKg[0]}–${n.kcalPerKg[1]}`;
    const kcalRange = n.kcalMin === n.kcalMax ? `${n.kcalMin}` : `${n.kcalMin}–${n.kcalMax}`;
    notes.push({ type: "info", text: `🍽️ 每日營養目標（${n.basis} ${fmt(n.refWeight, 1)} kg）：熱量 ${kcalRange} kcal/day（${kcal} kcal/kg）；蛋白質 ${fmt(n.proMin, 0)}–${fmt(n.proMax, 0)} g/day（1.0–1.2 g/kg，≥ 50% 高生物價蛋白質）。` });
    notes.push({ type: "info", text: `💧 每日水分建議：約 ${n.fluidLimit} mL/day（殘餘尿量 ${p.urine} mL + 750 mL，含食物水分以外之飲水與湯）；兩次透析間體重增加宜 ≤ ${fmt(n.idwgLimit, 1)} kg（乾體重 5%）。` });
    return notes;
  }

  /* ---------- 整合 ---------- */

  const HD_KEYS = ["age", "height", "dw", "preW", "qb", "qd", "hours", "koa", "intake", "urine", "freq"];

  function compute(inp) {
    const missing = HD_KEYS.filter(k => !isNum(inp[k]));
    const hdOk = missing.length === 0 && inp.dw > 0 && inp.hours > 0 && inp.qb > 0 && inp.qd > 0;
    const out = { version: VERSION, hdOk, missing, kin: null, metric: null, nutr: null, notes: { hd: [], lab: [], nutr: [] } };

    if (hdOk) {
      out.kin = kinetics(inp);
      out.metric = adequacyMetric(inp, out.kin);
      out.notes.hd = hdNotes(inp, out.kin);
      out.nutr = nutrition(inp, inp.alb);
      out.notes.nutr = nutrNotes(out.nutr, inp);
    } else {
      out.notes.hd = [{ type: "caution", text: "🟡 請完整填寫透析處方欄位（年齡、身高、體重、Qb、Qd、時間、次數…）以進行動力學試算。" }];
      if (isNum(inp.alb) && inp.alb < T.albPew) out.notes.nutr = nutrNotes({ alb: inp.alb, kcalPerKg: [0, 0] }, inp).slice(0, 1);
    }

    out.lab = labs(inp);
    out.notes.lab = labNotes(inp, out.lab);
    out.soap = soap(inp, out);
    return out;
  }

  function stripEmoji(s) { return s.replace(/^[^\p{L}\p{N}]+/u, ""); }

  function soap(p, r) {
    const v = (x, d) => (isNum(x) ? (d === undefined ? String(x) : x.toFixed(d)) : "N/A");
    const k = r.kin;
    const lines = [];
    lines.push("[S] Subjective:");
    lines.push("- Maintenance hemodialysis patient; routine monthly lab & dialysis adequacy review.");
    lines.push("");
    lines.push("[O] Objective:");
    if (k) {
      lines.push(`- Fluid: DW ${p.dw} kg, Pre-HD ${p.preW} kg (IDWG ${v(k.idwg, 1)} kg / ${v(k.idwgPct, 1)}%), planned UF ${Math.round(k.ufMl)} mL, UFR ${v(k.ufr, 1)} mL/kg/hr.`);
      lines.push(`- HD Rx: ${p.freq}x/week, ${p.hours} hr, Qb ${p.qb} mL/min, Qd ${p.qd} mL/min, KoA ~${p.koa}, access ${p.access === "cvc" ? "CVC" : "AVF/AVG"}.`);
      lines.push(`- Modeled kinetics: K ${Math.round(k.K)} mL/min, V(Watson) ${v(k.V, 1)} L -> spKt/V ${v(k.spKtv, 2)}, eKt/V ${v(k.eKtv, 2)}, stdKt/V ${v(k.stdKtv, 2)}, URR ${v(k.urr, 1)}%.`);
    } else {
      lines.push("- HD prescription data incomplete.");
    }
    lines.push(`- Labs: Alb ${v(p.alb)} g/dL, Ca ${v(p.ca)} mg/dL (corr. ${v(r.lab.corrCa, 2)}), P ${v(p.phos)} mg/dL (Ca×P ${v(r.lab.caxp, 1)}), iPTH ${v(p.ipth)} pg/mL, Hb ${v(p.hb)} g/dL, Ferritin ${v(p.ferritin)} ng/mL, TSAT ${v(p.tsat)}%, pre-HD K ${v(p.k)} mEq/L.`);
    lines.push("");
    lines.push("[A] Assessment:");
    if (k && r.metric) {
      const m = r.metric;
      const ad = m.value >= m.target ? "adequate" : m.value >= m.min ? `above minimum but below target (${m.name} < ${m.target})` : `inadequate (${m.name} < ${m.min})`;
      const uf = k.ufr > T.ufrHigh ? `high (> ${T.ufrHigh} mL/kg/hr)` : k.ufr > T.ufrCaution ? "elevated (> 10 mL/kg/hr)" : "within safe range";
      lines.push(`1. ESRD on maintenance HD: dialysis dose ${ad}; UFR ${uf}.`);
    } else {
      lines.push("1. ESRD on maintenance HD: adequacy not assessed (incomplete data).");
    }
    lines.push(`2. CKD-MBD & electrolytes: corr. Ca ${v(r.lab.corrCa, 2)}, P ${v(p.phos)}, iPTH ${v(p.ipth)}, K ${v(p.k)}.`);
    lines.push(`3. Renal anemia: Hb ${v(p.hb)} g/dL${r.lab.iron ? ` (iron: ${r.lab.iron.label})` : ""}.`);
    lines.push(`4. Nutrition: Albumin ${v(p.alb)} g/dL${isNum(p.alb) ? (p.alb < T.albPew ? " (PEW risk)" : " (stable)") : ""}.`);
    lines.push("");
    lines.push("[P] Plan:");
    [...r.notes.hd, ...r.notes.lab, ...r.notes.nutr].forEach(n => lines.push(`- ${stripEmoji(n.text)}`));
    lines.push("- Follow-up: monitor intradialytic hemodynamics, reinforce diet & medication adherence, recheck monthly labs; verify modeled Kt/V with measured pre/post BUN.");
    return lines.join("\n");
  }

  return { VERSION, T, KOA_OPTIONS, watsonV, michaelsK, kinetics, hoursFor, qbFor, ironStatus, labs, nutrition, compute };
});
