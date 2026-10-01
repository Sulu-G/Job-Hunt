// Job Hunt feed: pulls company job boards, scores fit, and closes dead postings.
// Modes: ?mode=ingest (every 3h) | ?mode=verify (every 4h) | ?mode=probe (test sources)
// Auth: custom x-cron-secret header checked against Supabase Vault (verify_jwt disabled on purpose).
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const UA = { "User-Agent": "Mozilla/5.0 (job-hunt personal tracker)", "Accept": "application/json,text/html" };

type Raw = {
  external_id: string; company: string; title: string; location: string; url: string;
  description: string; posted_at: string | null; pay: string | null;
};

// ---------- helpers ----------
const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
function strip(html: string): string {
  let s = (html || "").replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENT[m] ?? m); // greenhouse double-encodes
  s = s.replace(/<(br|\/p|\/li|\/h\d|\/div)[^>]*>/gi, "\n").replace(/<li[^>]*>/gi, "\n- ").replace(/<[^>]+>/g, " ");
  s = s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENT[m] ?? m).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  return s.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, 20000);
}
async function getJSON(url: string) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.json();
}
const PAY_RE = /\$\s?\d[\d,]*(?:\.\d+)?\s*[kK]?(?:\s*(?:-|–|—|to)\s*\$?\s?\d[\d,]*(?:\.\d+)?\s*[kK]?)?(?:\s*(?:\/|per)\s*(?:hr|hour|year|yr|annum))?/;
const findPay = (t: string) => (t.match(PAY_RE)?.[0] ?? null);

// ---------- source adapters ----------
async function fromGreenhouse(slug: string, company: string): Promise<Raw[]> {
  const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  return (d.jobs || []).map((j: any) => {
    const desc = strip(j.content || "");
    return { external_id: String(j.id), company, title: j.title, location: j.location?.name || "", url: j.absolute_url,
      description: desc, posted_at: j.first_published || j.updated_at || null, pay: findPay(desc) };
  });
}
async function fromLever(slug: string, company: string): Promise<Raw[]> {
  const d = await getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json&limit=500`);
  return (Array.isArray(d) ? d : []).map((j: any) => {
    const lists = (j.lists || []).map((l: any) => `${l.text}\n${strip(l.content)}`).join("\n");
    const desc = [j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).join("\n").slice(0, 20000);
    const sr = j.salaryRange ? `$${j.salaryRange.min}–$${j.salaryRange.max}/${j.salaryRange.interval || "yr"}` : null;
    return { external_id: j.id, company, title: j.text, location: j.categories?.location || j.categories?.allLocations?.join("; ") || "",
      url: j.hostedUrl, description: desc, posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null, pay: sr || findPay(desc) };
  });
}
async function fromAshby(slug: string, company: string): Promise<Raw[]> {
  const d = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
  return (d.jobs || []).filter((j: any) => j.isListed !== false).map((j: any) => {
    const desc = (j.descriptionPlain || strip(j.descriptionHtml || "")).slice(0, 20000);
    const loc = [j.location, ...(j.secondaryLocations || []).map((s: any) => s.location)].filter(Boolean).join("; ");
    return { external_id: j.id, company, title: j.title, location: loc + (j.isRemote ? " (Remote)" : ""), url: j.jobUrl,
      description: desc, posted_at: j.publishedAt || null, pay: j.compensation?.compensationTierSummary || findPay(desc) };
  });
}
async function fromAmazon(queries: string, company: string): Promise<Raw[]> {
  const out: Raw[] = []; const ids = new Set<string>();
  for (const query of queries.split("|")) for (let offset = 0; offset < 300; offset += 100) {
    const d = await getJSON(`https://www.amazon.jobs/en/search.json?base_query=${encodeURIComponent(query)}&country=USA&result_limit=100&offset=${offset}&sort=recent`);
    const jobs = d.jobs || [];
    for (const j of jobs) {
      const desc = [j.description, "Basic qualifications:\n" + (j.basic_qualifications || ""), "Preferred qualifications:\n" + (j.preferred_qualifications || "")]
        .map(strip).join("\n");
      const eid = String(j.id_icims || j.id); if (ids.has(eid)) continue; ids.add(eid);
      out.push({ external_id: eid, company, title: j.title, location: j.normalized_location || j.location || "",
        url: "https://www.amazon.jobs" + j.job_path, description: desc,
        posted_at: j.posted_date ? new Date(j.posted_date).toISOString() : null, pay: findPay(desc) });
    }
    if (jobs.length < 100) break;
  }
  return out;
}
const ADAPTERS: Record<string, (slug: string, company: string) => Promise<Raw[]>> = {
  greenhouse: fromGreenhouse, lever: fromLever, ashby: fromAshby, amazon: fromAmazon,
};

// ---------- relevance + fit scoring (Sultan's verified profile) ----------
const SENIOR = /\b(senior|sr\.?|staff|principal|lead|manager|director|head|chief|architect|vp|president|iii|iv|v\b|intern|internship|counsel|recruiter|sales|account|construction|project|program|security|electrical|mechanical|controls|commissioning|facilit(y|ies)|civil|design|planner|procurement|logistics|finance|legal|marketing|quality)\b/i;
function laneOf(title: string): string | null {
  if (SENIOR.test(title)) return null;
  if (/servicenow/i.test(title)) return "ServiceNow";
  if (/(data ?cent(er|re)|datacenter|\bdco\b|critical (facilit|environment)|server (tech|operations)|hardware (tech|operations|deployment)|fleet (tech|operations)|deployment tech|rack (integration|tech)|infrastructure tech)/i.test(title)
      && /(tech|operations|specialist|associate|engineer|deployment|integrat)/i.test(title)) return "Data Center";
  if (/(it support|help ?desk|service desk|desktop support|end[- ]user support|it technician|it specialist|it operations (tech|specialist|analyst)|technical support (specialist|analyst|technician)|support technician|it analyst)/i.test(title)) return "IT Support";
  if (/(systems? administrator|sysadmin|linux administrator|infrastructure administrator|systems? technician)/i.test(title)) return "Sysadmin";
  return null;
}
const US_STATES = "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";
const US_RE = new RegExp(`(\\b(${US_STATES})\\b|united states|\\busa?\\b|u\\.s\\.|texas|virginia|georgia|ohio|oregon|arizona|iowa|nevada|washington|north dakota|remote)`, "i");
const NON_US = /(canada|ontario|quebec|\bON\b|\bQC\b|\bBC\b|united kingdom|\buk\b|london|ireland|germany|india|netherlands|singapore|japan|australia|mexico|brazil|poland|spain|france|israel|sweden|norway|finland)/i;
const isUS = (loc: string) => !loc || (US_RE.test(loc) && !(NON_US.test(loc) && !/\b(US|USA|United States)\b/.test(loc)));

const HAVE: [string, RegExp][] = [
  ["Python", /\bpython\b/i], ["Cisco / switch config", /\b(cisco|nx-?os|ios-?xe|network switch(es|ing)?|switch(es)? config)/i], ["Linux", /\blinux\b/i],
  ["Networking (TCP/IP, DNS, DHCP)", /(tcp\/ip|\bdns\b|\bdhcp\b|layer ?[12]|networking|network troubleshooting)/i],
  ["Hardware troubleshooting", /(hardware (troubleshoot|diagnos|repair|break[- ]?fix)|component[- ]level|server hardware|break[- ]?fix)/i],
  ["Rack integration / install", /\b(rack(ing|s)?|rack[- ]and[- ]stack|server install)/i], ["Fiber/copper cabling", /(cabling|fiber|copper|cable management)/i],
  ["Liquid/air cooling", /(liquid cool|cooling)/i], ["Ticketing / escalation", /(ticket|incident|escalat)/i],
  ["SOPs / documentation", /(\bsops?\b|\bmops?\b|documentation|work instructions|procedures)/i], ["Root cause analysis", /(root cause|\brca\b|troubleshoot)/i],
  ["Inventory", /\binventory\b/i], ["Windows", /\bwindows\b/i], ["SSH", /\bssh\b/i], ["Virtualization", /(virtualiz|vmware|hypervisor)/i],
  ["Customer support / training", /(customer service|end users?|train(ing)? (users|staff|others))/i],
  ["CS degree", /(bachelor|associate'?s|degree|computer science)/i], ["Google IT Support cert", /google it support/i],
  ["24/7 shifts", /(24\/7|nights|weekends|rotating shift|on-?call)/i], ["GPU / AI hardware", /\b(gpu|nvidia|ai infrastructure|hpc)\b/i],
  ["Physical work (lift 50 lb)", /lift.{0,20}(40|50|60) ?(lb|pound)/i], ["ServiceNow (training)", /servicenow/i],
];
const LACK: [string, RegExp][] = [
  ["Bash", /\bbash\b/i], ["Juniper/JunOS", /(juniper|junos)/i], ["ITIL", /\bitil\b/i],
  ["ServiceNow CSA cert", /(\bcsa\b|certified system administrator)/i], ["ServiceNow CAD cert", /(\bcad\b|certified application developer)/i],
  ["JavaScript", /javascript|glide ?script/i], ["Git", /\bgit(hub|lab)?\b/i], ["Kubernetes", /kubernetes|\bk8s\b/i],
  ["Ansible/Terraform", /(ansible|terraform|puppet|chef)/i], ["Active Directory / Entra", /(active directory|entra|azure ad)/i],
  ["M365 / Google Workspace admin", /(m365|microsoft 365|office 365|google workspace|intune|jamf|\bmdm\b)/i],
  ["CompTIA A+/Network+", /(comptia|\ba\+|network\+|security\+)/i], ["CCNA", /\bccna\b/i],
  ["Electrical/HVAC/mechanical", /(electrical (systems|work)|hvac|mechanical systems|generator|ups systems|switchgear|fire suppression)/i],
];
const CLEARANCE = /(active (secret|ts|top secret)|(secret|ts\/sci|top secret|public trust) clearance|clearance (is )?required|must (hold|possess) .{0,20}clearance)/i;
const MY_YEARS: Record<string, number> = { "Data Center": 4, "IT Support": 4, "Sysadmin": 1, "ServiceNow": 0 };

function yearsRequired(desc: string): number | null {
  const req = desc.match(/(minimum|basic|required|requirements|qualifications|what you'll need|you have|must have)[\s\S]{0,2500}/i)?.[0] || desc;
  const RE = /(\d{1,2})\s*\+?\s*(?:-|–|to)?\s*(?:\d{1,2})?\s*\+?\s*years?(?: of)?(?:[^.\n]{0,60})(experience|exp\b)/gi;
  let m = [...req.matchAll(RE)];
  if (!m.length) m = [...desc.matchAll(RE)];
  if (!m.length) return null;
  return Math.min(...m.map((x) => +x[1]).filter((n) => n > 0 && n < 20));
}
function score(r: Raw, lane: string) {
  const text = `${r.title}\n${r.description}`;
  if (CLEARANCE.test(text)) return null;
  const matched = HAVE.filter(([, re]) => re.test(text)).map(([k]) => k);
  const gaps = LACK.filter(([, re]) => re.test(text)).map(([k]) => k);
  const yrs = yearsRequired(r.description);
  let s = ({ "Data Center": 58, "IT Support": 48, "Sysadmin": 38, "ServiceNow": 32 } as Record<string, number>)[lane];
  if (lane === "ServiceNow" && /(junior|jr\.?|associate|entry|early career|graduate|trainee|apprentice)/i.test(r.title + " " + r.description.slice(0, 600))) s += 22;
  if (/\btechnician\b/i.test(r.title) && lane === "Data Center") s += 4;
  s += Math.min(matched.length * 4, 32);
  s -= Math.min(gaps.length * 6, 30);
  if (gaps.includes("Electrical/HVAC/mechanical")) s -= 16; // facilities-engineering roles, not his background
  if (yrs != null && Number.isFinite(yrs) && yrs > MY_YEARS[lane]) { s -= (yrs - MY_YEARS[lane]) * 9; gaps.unshift(`${yrs}+ yrs required`); }
  if (/\b(TX|Texas)\b/.test(r.location)) s += 3;
  s = Math.max(0, Math.min(100, Math.round(s)));
  const fit = s >= 75 ? "Strong" : s >= 55 ? "Good" : "Stretch";
  const why = matched.length ? `Matches your ${matched.slice(0, 6).join(", ")}.` : "Few direct keyword matches; review manually.";
  return { score: s, fit, matched, gaps, why, years_required: Number.isFinite(yrs as number) ? yrs : null };
}

// ---------- modes ----------
async function ingest(onlySource?: number) {
  const run = (await sb.from("runs").insert({ kind: "ingest" }).select().single()).data;
  let q = sb.from("sources").select("*").eq("enabled", true).neq("kind", "manual");
  if (onlySource) q = q.eq("id", onlySource);
  const { data: sources } = await q;
  let newCount = 0, closedCount = 0; const errors: string[] = [];

  await Promise.all((sources || []).map(async (src: any) => {
    try {
      const raws = await ADAPTERS[src.kind](src.slug, src.company);
      const { data: existing } = await sb.from("postings").select("id, external_id, is_open").eq("source_id", src.id);
      const known = new Map((existing || []).map((e: any) => [e.external_id, e]));
      const seen = new Set<string>(); const rows: any[] = [];
      for (const r of raws) {
        const lane = laneOf(r.title);
        if (!lane || !isUS(r.location) || !r.url) continue;
        const sc = score(r, lane); if (!sc) continue;
        if (seen.has(r.external_id)) continue;
        seen.add(r.external_id);
        const row: any = { source_id: src.id, external_id: r.external_id, company: r.company, title: r.title, location: r.location,
          url: r.url, lane, pay: r.pay, description: r.description, posted_at: r.posted_at, last_seen_at: new Date().toISOString(),
          is_open: true, closed_at: null, close_reason: null, ...sc };
        if (!known.has(r.external_id)) newCount++;
        rows.push(row);
      }
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await sb.from("postings").upsert(rows.slice(i, i + 200), { onConflict: "source_id,external_id" });
        if (error) throw new Error(error.message);
      }
      // Gone from a full company board = closed. Amazon search is partial, so it is verified by URL instead.
      if (src.kind !== "amazon" && raws.length > 0) {
        const gone = (existing || []).filter((e: any) => e.is_open && !seen.has(e.external_id)).map((e: any) => e.id);
        if (gone.length) {
          await sb.from("postings").update({ is_open: false, closed_at: new Date().toISOString(), close_reason: "Removed from company job board" }).in("id", gone);
          closedCount += gone.length;
        }
      }
      await sb.from("sources").update({ last_run_at: new Date().toISOString(), last_status: "ok", last_count: rows.length, last_error: null }).eq("id", src.id);
    } catch (e) {
      errors.push(`${src.company}: ${(e as Error).message}`);
      await sb.from("sources").update({ last_run_at: new Date().toISOString(), last_status: "error", last_error: (e as Error).message }).eq("id", src.id);
    }
  }));
  await sb.from("runs").update({ finished_at: new Date().toISOString(), new_count: newCount, closed_count: closedCount, errors }).eq("id", run.id);
  return { sources: sources?.length, newCount, closedCount, errors };
}

const DEAD = /(no longer (accepting|available|open|active)|job (has been|was|is) (removed|closed|filled|expired)|position (has been )?(filled|closed)|this (job|posting|position) (is|has) (expired|closed|been removed)|job not found|couldn'?t find (that|this) job)/i;
async function verify() {
  const run = (await sb.from("runs").insert({ kind: "verify" }).select().single()).data;
  const cutoff = new Date(Date.now() - 20 * 3600e3).toISOString();
  const { data: rows } = await sb.from("postings").select("id, url").eq("is_open", true)
    .or(`last_checked_at.is.null,last_checked_at.lt.${cutoff}`).order("last_checked_at", { ascending: true, nullsFirst: true }).limit(60);
  let closed = 0, checked = 0; const errors: string[] = [];
  await Promise.all((rows || []).map(async (p: any) => {
    try {
      const r = await fetch(p.url, { headers: UA, redirect: "follow" });
      checked++;
      let reason: string | null = null;
      if (r.status === 404 || r.status === 410) reason = `Posting page returned ${r.status}`;
      else if (r.ok) { const t = (await r.text()).slice(0, 400000); if (DEAD.test(t)) reason = "Posting page says it's closed"; }
      else await r.body?.cancel();
      const patch: any = { last_checked_at: new Date().toISOString() };
      if (reason) { Object.assign(patch, { is_open: false, closed_at: new Date().toISOString(), close_reason: reason }); closed++; }
      await sb.from("postings").update(patch).eq("id", p.id);
    } catch (e) { errors.push(`${p.url}: ${(e as Error).message}`); }
  }));
  await sb.from("runs").update({ finished_at: new Date().toISOString(), checked_count: checked, closed_count: closed, errors }).eq("id", run.id);
  return { checked, closed, errors };
}

async function probe() {
  const { data: sources } = await sb.from("sources").select("*").neq("kind", "manual");
  const out: any[] = [];
  await Promise.all((sources || []).map(async (s: any) => {
    try {
      const raws = await ADAPTERS[s.kind](s.slug, s.company);
      const relevant = raws.filter((r) => laneOf(r.title) && isUS(r.location)).length;
      out.push({ id: s.id, company: s.company, kind: s.kind, total: raws.length, relevant });
    } catch (e) { out.push({ id: s.id, company: s.company, kind: s.kind, error: (e as Error).message }); }
  }));
  return out;
}

Deno.serve(async (req) => {
  const secret = req.headers.get("x-cron-secret") || "";
  const { data: ok } = await sb.rpc("check_cron_secret", { s: secret });
  if (!ok) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "ingest";
  try {
    const result = mode === "verify" ? await verify() : mode === "probe" ? await probe()
      : await ingest(url.searchParams.get("source") ? +url.searchParams.get("source")! : undefined);
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
