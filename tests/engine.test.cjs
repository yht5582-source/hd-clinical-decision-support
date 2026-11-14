// node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const E = require("../engine.js");

const DEF = {
  sex: "M", age: 60, height: 168, dw: 62, preW: 64.2, qb: 280, qd: 500, hours: 4, koa: 950,
  intake: 200, urine: 100, freq: 3, access: "av",
  alb: 3.9, ca: 9.1, phos: 4.8, ipth: 260, pthUln: 65, hb: 10.6, ferritin: 320, tsat: 26, k: 4.7
};
const SAMPLE = {
  ...DEF, sex: "F", age: 68, height: 156, dw: 52, preW: 55.2, qb: 220, hours: 3, koa: 700,
  intake: 300, urine: 0, access: "cvc",
  alb: 3.4, ca: 9.4, phos: 6.4, ipth: 780, hb: 9.1, ferritin: 140, tsat: 16, k: 5.8
};
const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b} (±${tol})`);

test("Watson V", () => {
  close(E.watsonV("M", 60, 168, 62), 35.63, 0.01);
  close(E.watsonV("F", 40, 156, 52), 27.40, 0.01);
});

test("Michaels K: bounded by blood water flow, rises with Qb/Qd/KoA", () => {
  const K = E.michaelsK(280, 500, 950);
  close(K, 223.6, 0.5);
  assert.ok(K < 280 * 0.86);
  assert.ok(E.michaelsK(350, 500, 950) > K);
  assert.ok(E.michaelsK(280, 800, 950) > K);
  assert.ok(E.michaelsK(280, 500, 1400) > K);
  assert.ok(isFinite(E.michaelsK(500 / 0.86, 500, 950)));  // Qbw == Qd 特例
});

test("spKt/V ≈ K·t / V_post (variable-volume model + Daugirdas II consistency)", () => {
  const k = E.kinetics(DEF);
  close(k.spKtv, (k.K * k.tMin) / (k.V * 1000), 0.08);
  assert.ok(k.eKtv < k.spKtv);
  assert.ok(k.stdKtv > 2 && k.stdKtv < 3);
  assert.ok(k.urr > 60 && k.urr < 80);
});

test("no UF still works", () => {
  const k = E.kinetics({ ...DEF, preW: 62, intake: 0 });
  assert.ok(isFinite(k.spKtv) && k.ufr === 0);
});

test("default case: adequate, no alerts", () => {
  const r = E.compute(DEF);
  assert.ok(r.hdOk);
  assert.ok(r.kin.spKtv >= 1.4);
  assert.ok(r.kin.ufr <= 10);
  const all = [...r.notes.hd, ...r.notes.lab, ...r.notes.nutr];
  assert.equal(all.filter(n => n.type === "alert").length, 0);
});

test("sample case: flags every intended abnormality", () => {
  const r = E.compute(SAMPLE);
  const txt = [...r.notes.hd, ...r.notes.lab, ...r.notes.nutr].map(n => n.text).join("\n");
  assert.ok(r.kin.spKtv < 1.2);
  for (const s of ["透析劑量不足", "超濾率過高", "高血磷合併", "次發性副甲狀腺", "腎性貧血合併鐵質", "高血鉀", "PEW"]) {
    assert.ok(txt.includes(s), s);
  }
  assert.equal(r.lab.iron.key, "absolute");
  // CVC 不建議 Qb 超過 350
  const m = txt.match(/Qb 由 \d+ 調至 (\d+)/);
  if (m) assert.ok(Number(m[1]) <= 350);
});

test("suggested Qb / hours actually reach target", () => {
  const p = { ...DEF, qb: 230, hours: 3.5, koa: 700 };
  const h = E.hoursFor(p, 1.4);
  assert.ok(h && E.kinetics({ ...p, hours: h }).spKtv >= 1.4);
  assert.ok(E.kinetics({ ...p, hours: h - 0.25 }).spKtv < 1.4);
  const qb = E.qbFor(p, 1.4);
  if (qb) assert.ok(E.kinetics({ ...p, qb }).spKtv >= 1.4);
});

test("does not suggest a bigger dialyzer when already on the largest", () => {
  const r = E.compute({ ...SAMPLE, koa: 1400 });
  assert.ok(!r.notes.hd[0].text.includes("改用 KoA"));
});

test("UFR advice never recommends > 6 h", () => {
  const r = E.compute(SAMPLE);
  const t = r.notes.hd.find(n => n.text.includes("超濾率")).text;
  assert.ok(!/延長透析時間至 ≥ ([7-9]|\d\d)/.test(t), t);
});

test("twice-weekly uses stdKt/V and warns about residual function", () => {
  const r = E.compute({ ...DEF, freq: 2 });
  assert.equal(r.metric.name, "stdKt/V");
  assert.ok(r.notes.hd.some(n => n.text.includes("每週兩次")));
});

test("blank labs are skipped, not treated as 0", () => {
  const r = E.compute({ ...DEF, hb: null, k: null, phos: null, ipth: null, ferritin: null, tsat: null });
  const txt = r.notes.lab.map(n => n.text).join("");
  assert.ok(!txt.includes("貧血") && !txt.includes("血鉀") && !txt.includes("血磷"));
  assert.equal(r.lab.iron, null);
  assert.ok(!/NaN|undefined/.test(r.soap));
});

test("incomplete HD inputs degrade gracefully", () => {
  const r = E.compute({ ...DEF, dw: null });
  assert.equal(r.hdOk, false);
  assert.equal(r.kin, null);
  assert.ok(!/NaN|undefined/.test(r.soap));
});

test("iron classification", () => {
  assert.equal(E.ironStatus(150, 15).key, "absolute");
  assert.equal(E.ironStatus(600, 15).key, "functional");
  assert.equal(E.ironStatus(150, 25).key, "lowStore");
  assert.equal(E.ironStatus(900, 30).key, "overload");
  assert.equal(E.ironStatus(300, 30).key, "ok");
});

test("iPTH target scales with lab ULN (2–9×)", () => {
  const r = E.labs({ ...DEF, pthUln: 70 });
  assert.equal(r.pthLow, 140);
  assert.equal(r.pthHigh, 630);
});

test("severe hyperkalemia escalates", () => {
  const r = E.compute({ ...DEF, k: 6.8 });
  assert.ok(r.notes.lab.some(n => n.text.includes("嚴重高血鉀")));
});

test("nutrition reference weight", () => {
  const obese = E.nutrition({ ...DEF, dw: 95 }, 4);
  assert.ok(obese.basis.startsWith("調整體重"));
  const thin = E.nutrition({ ...DEF, dw: 45 }, 4);
  assert.ok(thin.basis.startsWith("理想體重"));
});

test("SOAP plan strips leading emoji and has real newlines", () => {
  const r = E.compute(SAMPLE);
  assert.ok(r.soap.split("\n").length > 15);
  assert.ok(!/^- [^\p{L}\p{N}]/mu.test(r.soap.split("[P] Plan:")[1]));
});

test("inline page script parses (regression: raw newline in string)", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length >= 1);
  for (const s of scripts) new Function(s);
});
