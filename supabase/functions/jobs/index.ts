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
  description: string; posted_at: string | null; pay: string | null; closes_at?: string | null;
};

// ---------- helpers ----------
const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
function strip(html: string): string {
  let s = (html || "").replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENT[m] ?? m); // greenhouse double-encodes
  s = s.replace(/<(br|\/p|\/li|\/h\d|\/div)[^>]*>/gi, "\n").replace(/<li[^>]*>/gi, "\n- ").replace(/<[^>]+>/g, " ");
  s = s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENT[m] ?? m).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  return s.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, 20000);
}
async function getJSON(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers } });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.json();
}
// API keys live in Supabase Vault, never in code.
async function secret(name: string): Promise<string> {
  const { data, error } = await sb.rpc("get_feed_secret", { n: name });
  if (error || !data) throw new Error(`missing secret ${name} — add it to the vault`);
  return data as string;
}
// Pay: find a real range (or a single rate with a unit) and normalize it to "$X–$Y/hr" or "$XK–$YK/yr".
const NUM = String.raw`\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*([kK])?`;
const RANGE_RE = new RegExp(`${NUM}\\s*(?:-|–|—|to)\\s*${NUM}(?:\\s*(?:USD|usd))?(?:\\s*(?:\\/|per|an?)?\\s*(hr|hour|hourly|annually|annual|year|yr|annum|per-hour-wage|per-year-salary))?`, "g");
const toNum = (int: string, dec?: string, k?: string) => (parseFloat(int.replace(/,/g, "") + (dec ? "." + dec : "")) * (k ? 1000 : 1));
function fmtPay(min: number, max: number, unitHint = ""): string | null {
  if (!(min > 0) || !(max >= min)) return null;
  const hourly = /h(ou)?r/i.test(unitHint) || max < 250;
  if (hourly) { if (max > 250 || min < 7) return null; const f = (n: number) => `$${n % 1 ? n.toFixed(2) : n}`; return `${f(min)}–${f(max)}/hr`; }
  if (min < 20000 || max > 600000) return null;
  const f = (n: number) => `$${Math.round(n / 1000)}K`; return `${f(min)}–${f(max)}/yr`;
}
// Annualized numbers for filtering/sorting: hourly x 2080 (full-time year).
function payYears(pay: string | null): { pay_min_yr: number | null; pay_max_yr: number | null } {
  const m = (pay || "").match(/\$([\d.]+)(K)?–\$([\d.]+)(K)?\/(hr|yr)/);
  if (!m) return { pay_min_yr: null, pay_max_yr: null };
  const k = (v: string, K?: string) => parseFloat(v) * (K ? 1000 : 1) * (m[5] === "hr" ? 2080 : 1);
  return { pay_min_yr: Math.round(k(m[1], m[2])), pay_max_yr: Math.round(k(m[3], m[4])) };
}
function findPay(text: string): string | null {
  if (!text) return null;
  // Prefer ranges that sit near pay words; otherwise take the first plausible range.
  const cands: { pay: string; near: boolean }[] = [];
  for (const m of text.matchAll(RANGE_RE)) {
    const raw = m[0]; if (!/\$|usd/i.test(raw) && !/(hourly|annually)/i.test(raw)) continue;
    const pay = fmtPay(toNum(m[1], m[2], m[3]), toNum(m[4], m[5], m[6]), m[7] || "");
    if (!pay) continue;
    const ctx = text.slice(Math.max(0, (m.index ?? 0) - 160), (m.index ?? 0)).toLowerCase();
    cands.push({ pay, near: /(pay|salary|compensation|wage|base|range|rate)/.test(ctx) });
  }
  return (cands.find((c) => c.near) || cands[0])?.pay ?? null;
}
const cleanPay = (p: string | null | undefined) => (p ? (findPay(p) ?? null) : null);

// ---------- source adapters ----------
async function fromGreenhouse(slug: string, company: string): Promise<Raw[]> {
  const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  return (d.jobs || []).filter((j: any) => laneOf(j.title || "")).map((j: any) => {
    const desc = strip(j.content || "");
    return { external_id: String(j.id), company, title: j.title, location: j.location?.name || "", url: j.absolute_url,
      description: desc, posted_at: j.first_published || j.updated_at || null, pay: findPay(desc) };
  });
}
async function fromLever(slug: string, company: string): Promise<Raw[]> {
  const d = await getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json&limit=500`);
  return (Array.isArray(d) ? d : []).filter((j: any) => laneOf(j.text || "")).map((j: any) => {
    const lists = (j.lists || []).map((l: any) => `${l.text}\n${strip(l.content)}`).join("\n");
    const desc = [j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).join("\n").slice(0, 20000);
    const sr = j.salaryRange ? fmtPay(+j.salaryRange.min, +j.salaryRange.max, j.salaryRange.interval || "") : null;
    return { external_id: j.id, company, title: j.text, location: j.categories?.location || j.categories?.allLocations?.join("; ") || "",
      url: j.hostedUrl, description: desc, posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null, pay: sr || findPay(desc) };
  });
}
async function fromAshby(slug: string, company: string): Promise<Raw[]> {
  const d = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
  return (d.jobs || []).filter((j: any) => j.isListed !== false && laneOf(j.title || "")).map((j: any) => {
    const desc = (j.descriptionPlain || strip(j.descriptionHtml || "")).slice(0, 20000);
    const loc = [j.location, ...(j.secondaryLocations || []).map((s: any) => s.location)].filter(Boolean).join("; ");
    return { external_id: j.id, company, title: j.title, location: loc + (j.isRemote ? " (Remote)" : ""), url: j.jobUrl,
      description: desc, posted_at: j.publishedAt || null, pay: cleanPay(j.compensation?.compensationTierSummary) || findPay(desc) };
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
        posted_at: j.posted_date ? new Date(j.posted_date).toISOString() : null,
        pay: findPay(JSON.stringify([j.description, j.basic_qualifications, j.preferred_qualifications, j.description_short]).replace(/\\n/g, " ")) });
    }
    if (jobs.length < 100) break;
  }
  return out;
}
// Workday: slug = "tenant|wdN|site|query1;query2". Search is keyword-based, so liveness is checked per URL in verify().
async function postJSON(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { ...UA, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.json();
}
// Skip postings that are clearly outside the US (Workday search is global).
const FOREIGN = /^(?!.*\b(United States|USA|US)\b).*\b(India|China|Taiwan|Japan|Korea|Singapore|Israel|Germany|Ireland|Netherlands|UK|United Kingdom|Canada|Mexico|Poland|France|Australia|Brazil)\b/i;
const WD_QUERIES = "data center;datacenter technician;servicenow;IT support;hardware technician;NPI engineer;manufacturing engineer;rack integration";
async function fromWorkday(slug: string, company: string): Promise<Raw[]> {
  const [tenant, wd, site, q] = slug.split("|");
  const host = `https://${tenant}.${wd}.myworkdayjobs.com`, api = `${host}/wday/cxs/${tenant}/${site}`;
  const hits = new Map<string, any>();
  for (const query of (q || WD_QUERIES).split(";")) {
    for (let offset = 0; offset < 100; offset += 20) {
      const d = await postJSON(`${api}/jobs`, { appliedFacets: {}, limit: 20, offset, searchText: query });
      for (const j of d.jobPostings || []) if (j.externalPath && laneOf(j.title || "") && !FOREIGN.test(j.locationsText || "")) hits.set(j.externalPath, j);
      if (!d.jobPostings || d.jobPostings.length < 20) break;
    }
  }
  const out: Raw[] = [];
  for (const [path, j] of hits) {
    try {
      const d = await getJSON(`${api}${path}`);
      const info = d.jobPostingInfo || {};
      const desc = strip(info.jobDescription || "");
      const loc = [info.location, ...(info.additionalLocations || [])].filter(Boolean).join("; ") || j.locationsText || "";
      out.push({ external_id: path, company, title: info.title || j.title, location: loc, url: info.externalUrl || `${host}/${site}${path}`,
        description: desc, posted_at: info.startDate ? new Date(info.startDate).toISOString() : null, pay: findPay(desc) });
    } catch (_) { /* skip one bad detail */ }
  }
  return out;
}
// Oracle Recruiting Cloud: slug = "host|siteNumber|query1;query2"
async function fromOracle(slug: string, company: string): Promise<Raw[]> {
  const [host, site, q] = slug.split("|");
  const base = `https://${host}/hcmRestApi/resources/latest`;
  const hits = new Map<string, any>();
  for (const query of (q || "data center technician;data center").split(";")) {
    const d = await getJSON(`${base}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=${site},keyword=${encodeURIComponent('"' + query + '"')},limit=100,sortBy=POSTING_DATES_DESC`);
    for (const r of d.items?.[0]?.requisitionList || []) if (laneOf(r.Title || "")) hits.set(String(r.Id), r);
  }
  const out: Raw[] = [];
  for (const [id, r] of hits) {
    try {
      const d = await getJSON(`${base}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${id}%22,siteNumber=${site}`);
      const it = d.items?.[0] || {};
      const desc = strip([it.ExternalDescriptionStr, it.ExternalQualificationsStr, it.ExternalResponsibilitiesStr].filter(Boolean).join("\n"));
      out.push({ external_id: id, company, title: r.Title, location: r.PrimaryLocation || "", url: `https://careers.oracle.com/jobs/#en/sites/jobsearch/job/${id}`,
        description: desc, posted_at: r.PostedDate ? new Date(r.PostedDate).toISOString() : null, pay: findPay(desc) });
    } catch (_) { /* skip */ }
  }
  return out;
}
// Microsoft (Eightfold PCS): slug = "query1;query2"
async function fromMicrosoft(slug: string, company: string): Promise<Raw[]> {
  const base = "https://apply.careers.microsoft.com/api/pcsx";
  const hits = new Map<string, any>();
  for (const query of (slug || "datacenter technician").split(";")) {
    for (let start = 0; start < 100; start += 10) {
      await new Promise((r) => setTimeout(r, 1500)); // Microsoft rate-limits fast clients
      const d = await getJSON(`${base}/search?domain=microsoft.com&query=${encodeURIComponent(query)}&location=United%20States&start=${start}&sort_by=timestamp`);
      const pos = d.data?.positions || [];
      for (const p of pos) if (laneOf(p.name || "")) hits.set(String(p.id), p);
      if (pos.length < 10) break;
    }
  }
  const out: Raw[] = [];
  for (const [id, p] of hits) {
    try {
      await new Promise((r) => setTimeout(r, 800));
      const d = await getJSON(`${base}/position_details?position_id=${id}&domain=microsoft.com&hl=en`);
      const desc = strip(d.data?.jobDescription || "");
      out.push({ external_id: id, company, title: p.name, location: (p.locations || p.standardizedLocations || []).join("; "),
        url: p.positionUrl ? `https://apply.careers.microsoft.com${p.positionUrl}` : `https://apply.careers.microsoft.com/careers/job/${id}`,
        description: desc, posted_at: p.postedTs ? new Date(p.postedTs * 1000).toISOString() : null, pay: findPay(desc) });
    } catch (_) { /* skip */ }
  }
  return out;
}
// USAJobs (federal): slug = location, e.g. "Anchorage, Alaska". Needs vault secrets usajobs_key + usajobs_email.
async function fromUSAJobs(slug: string, _company: string): Promise<Raw[]> {
  const headers = { "Host": "data.usajobs.gov", "User-Agent": await secret("usajobs_email"), "Authorization-Key": await secret("usajobs_key") };
  const out: Raw[] = [];
  for (let page = 1; page <= 10; page++) {
    const q = slug.startsWith("remote:") ? `RemoteIndicator=True&JobCategoryCode=${slug.slice(7)}` : `LocationName=${encodeURIComponent(slug)}&Radius=40`;
    const d = await getJSON(`https://data.usajobs.gov/api/search?${q}&ResultsPerPage=250&Page=${page}`, headers);
    const items = d.SearchResult?.SearchResultItems || [];
    for (const it of items) {
      const m = it.MatchedObjectDescriptor || {}; const det = m.UserArea?.Details || {};
      const rem = (m.PositionRemuneration || [])[0] || {};
      const per = /hour/i.test(rem.RateIntervalCode || rem.Description || "") ? "hr" : "yr";
      const pay = rem.MinimumRange ? fmtPay(+rem.MinimumRange, +rem.MaximumRange || +rem.MinimumRange, per) : null;
      const desc = [det.JobSummary, m.QualificationSummary, (det.MajorDuties || []).join("\n"), det.Requirements, det.Education,
        det.SecurityClearance && det.SecurityClearance !== "Not Required" ? `Security clearance: ${det.SecurityClearance} clearance required` : ""]
        .filter(Boolean).join("\n").slice(0, 20000);
      out.push({ external_id: String(m.PositionID || it.MatchedObjectId), company: m.OrganizationName || m.DepartmentName || "US Government",
        title: m.PositionTitle, location: (m.PositionLocationDisplay || slug) + (det.RemoteIndicator === true || det.RemoteIndicator === "True" ? " (Remote)" : ""), url: m.PositionURI || (m.ApplyURI || [])[0],
        description: desc, posted_at: m.PublicationStartDate || null, pay, closes_at: m.ApplicationCloseDate || null });
    }
    if (items.length < 250) break;
  }
  return out;
}
// Adzuna (aggregator, every employer): slug = "where|salary_min|what|what_or" (where optional). Needs vault secrets adzuna_app_id + adzuna_app_key.
async function fromAdzuna(slug: string, _company: string): Promise<Raw[]> {
  const [where, salaryMin, what, whatOr] = slug.split("|");
  const geo = where ? `&where=${encodeURIComponent(where)}&distance=40` : "";
  const kw = (what ? `&what=${encodeURIComponent(what)}` : "") + (whatOr ? `&what_or=${encodeURIComponent(whatOr)}` : "");
  const id = await secret("adzuna_app_id"), key = await secret("adzuna_app_key");
  const out: Raw[] = [];
  for (let page = 1; page <= 10; page++) {
    if (page > 1) await new Promise((r) => setTimeout(r, 2500)); // Adzuna free tier rate limit
    const d = await getJSON(`https://api.adzuna.com/v1/api/jobs/us/search/${page}?app_id=${id}&app_key=${key}&results_per_page=50${geo}${kw}&max_days_old=30&salary_min=${salaryMin || 0}&salary_include_unknown=1&content-type=application/json`);
    const res = d.results || [];
    for (const j of res) {
      let pay = j.salary_min ? fmtPay(+j.salary_min, +(j.salary_max || j.salary_min), +(j.salary_max || 0) < 250 ? "hr" : "") : null;
      if (pay && String(j.salary_is_predicted) === "1") pay += " (est.)";
      out.push({ external_id: String(j.id), company: j.company?.display_name || "Unknown employer", title: (j.title || "").replace(/<[^>]+>/g, ""),
        location: [j.location?.display_name, ...(j.location?.area || []).slice(0, 2)].filter(Boolean).join(", ") || where || "US", url: j.redirect_url, description: strip(j.description || ""),
        posted_at: j.created || null, pay });
    }
    if (res.length < 50) break;
  }
  return out;
}
// ---- Remote job boards (public APIs, no keys). Pre-filtered to tech titles.
async function fromRemotive(_slug: string): Promise<Raw[]> {
  const d = await getJSON("https://remotive.com/api/remote-jobs"); // Remotive asks for <= 4 calls/day: source runs daily
  return (d.jobs || []).filter((j: any) => laneOf(j.title || "")).map((j: any) => {
    const desc = strip(j.description || "");
    return { external_id: String(j.id), company: j.company_name || "Unknown", title: j.title, location: `Remote (${j.candidate_required_location || "Anywhere"})`,
      url: j.url, description: desc, posted_at: j.publication_date ? new Date(j.publication_date).toISOString() : null, pay: findPay(j.salary || "") || findPay(desc) };
  });
}
async function fromHimalayas(slug: string): Promise<Raw[]> {
  const out = new Map<string, Raw>();
  for (const q of slug.split(";")) {
    const d = await getJSON(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(q)}&country=US`);
    for (const j of d.jobs || []) {
      if (!laneOf(j.title || "")) continue;
      const desc = strip(j.description || j.excerpt || "");
      const pay = j.minSalary && (j.currency || "USD") === "USD" ? fmtPay(+j.minSalary, +(j.maxSalary || j.minSalary), "") : findPay(desc);
      const loc = (j.locationRestrictions || []).map((l: any) => (typeof l === "string" ? l : l?.name)).filter(Boolean).join("; ");
      const id = String(j.guid || j.applicationLink);
      out.set(id, { external_id: id, company: j.companyName || "Unknown", title: j.title, location: `Remote (${loc || "Anywhere"})`,
        url: j.applicationLink || j.guid, description: desc, posted_at: j.pubDate ? new Date(+j.pubDate > 1e12 ? +j.pubDate : +j.pubDate * 1000).toISOString() : null,
        pay, closes_at: j.expiryDate ? new Date(+j.expiryDate > 1e12 ? +j.expiryDate : +j.expiryDate * 1000).toISOString() : null });
    }
  }
  return [...out.values()];
}
async function fromJobicy(slug: string): Promise<Raw[]> {
  const d = await getJSON(`https://jobicy.com/api/v2/remote-jobs?count=100&geo=${encodeURIComponent(slug || "usa")}`);
  return (d.jobs || []).filter((j: any) => laneOf(j.jobTitle || "")).map((j: any) => {
    const desc = strip(j.jobDescription || j.jobExcerpt || "");
    const pay = j.annualSalaryMin && (j.salaryCurrency || "USD") === "USD" ? fmtPay(+j.annualSalaryMin, +(j.annualSalaryMax || j.annualSalaryMin), "yr") : findPay(desc);
    return { external_id: String(j.id), company: j.companyName || "Unknown", title: strip(j.jobTitle), location: `Remote (${j.jobGeo || "USA"})`,
      url: j.url, description: desc, posted_at: j.pubDate ? new Date(j.pubDate).toISOString() : null, pay };
  });
}
async function fromRemoteOK(_slug: string): Promise<Raw[]> {
  const d = await getJSON("https://remoteok.com/api");
  return (Array.isArray(d) ? d : []).filter((j: any) => j.id && j.position && laneOf(j.position)).map((j: any) => {
    const desc = strip(j.description || "");
    return { external_id: String(j.id), company: j.company || "Unknown", title: j.position, location: `Remote (${j.location || "Anywhere"})`,
      url: j.url || j.apply_url, description: desc, posted_at: j.date || null,
      pay: j.salary_min ? fmtPay(+j.salary_min, +(j.salary_max || j.salary_min), "yr") : findPay(desc) };
  });
}
const ADAPTERS: Record<string, (slug: string, company: string) => Promise<Raw[]>> = {
  greenhouse: fromGreenhouse, lever: fromLever, ashby: fromAshby, amazon: fromAmazon,
  workday: fromWorkday, oracle: fromOracle, microsoft: fromMicrosoft, usajobs: fromUSAJobs, adzuna: fromAdzuna,
  remotive: fromRemotive, himalayas: fromHimalayas, jobicy: fromJobicy, remoteok: fromRemoteOK,
};
// Keyword-search sources can't prove a job closed by its absence; verify() checks those by URL.
const PARTIAL = new Set(["amazon", "workday", "oracle", "microsoft", "adzuna", "himalayas", "jobicy"]);
const REMOTE_BOARDS = new Set(["remotive", "himalayas", "jobicy", "remoteok"]);
const AK_RE = /(anchorage|eagle river|chugiak|girdwood|\bjber\b|elmendorf|fort richardson|wasilla|palmer|\balaska\b|,\s*AK\b|north slope|prudhoe|deadhorse|kuparuk|kenai|nikiski|soldotna|valdez)/i;
// Anchorage: only practical work Sultan can do — tech (laneOf), oil & gas / field, and skilled labor / operations.
const AK_OIL = /(\boil\b|\bgas\b|pipeline|petroleum|refiner|\blng\b|north slope|prudhoe|roustabout|roughneck|floorhand|derrick|driller|drilling|well ?(test|service|site)|wellhead|\bfrac\b|production (operator|technician)|process (operator|technician)|plant operator|field (technician|tech|operator|service|specialist|engineer)|instrument(ation)? (tech|technician)|\bi&e\b|compressor)/i;
const AK_LABOR = /(operator|equipment|crane|forklift|warehouse|material(s)? (handler|coordinator|specialist)|logistics|inventory|supply (tech|technician|specialist)|maintenance|mechanic|diesel|laborer|general labor|technician|\btech\b|telecom|inspector|safety (tech|technician|specialist|coordinator|officer|advisor)|\bhse\b|\behs\b|security (officer|guard|specialist)|corrections? officer|correctional|detention|dispatcher|utility (worker|tech|technician|operator)|facilities|production (worker|associate)|quality (tech|technician|inspector))/i;
const AK_SKIP = /(\bsenior\b|\bsr\.?\s|\blead\b|manager|supervisor|superintendent|licensed|cardio|electrophysiolog|\bpart?ner\b|\bai\b)/i;
const akLane = (t: string) => AK_SKIP.test(t) ? null : AK_OIL.test(t) ? "Oil & Gas / Field" : AK_LABOR.test(t) ? "Skilled labor / Ops" : null;
// Obvious work-from-home scams / junk.
const SCAM = /(data entry|commission[- ]only|\bmlm\b|be your own boss|unlimited (earning|income)|mystery shopper|reship|package (handler|forward)|crypto trading|forex|paid (surveys|daily)|no experience.{0,30}\$\d{3,})/i;
const REMOTE_T = /\b(remote|work from home|wfh|telework|teleworking|virtual)\b/i;
function workMode(r: Raw, src: any): string {
  const head = `${r.title} ${r.location}`, desc = (r.description || "").slice(0, 4000);
  if (/remote hands/i.test(head)) return "onsite";
  if (/hybrid/i.test(head)) return "hybrid";
  if (REMOTE_T.test(head) || REMOTE_BOARDS.has(src.kind)) return /\bhybrid\b/i.test(desc) && !REMOTE_BOARDS.has(src.kind) ? "hybrid" : "remote";
  if (/(hybrid (work|schedule|role|position|model|environment)|\d days? (a|per) week (in|on)[- ](the )?(office|site)|this (role|position) is hybrid)/i.test(desc)) return "hybrid";
  if (/((fully|100%) remote|remote[- ](first|position|role|job|opportunity|eligible)|work (from|at) home)/i.test(desc)) return "remote";
  return "onsite";
}
const US_OK = /\b(US|USA|U\.S\.|United States|Americas|North America|worldwide|anywhere)\b/i;
const EXEC = /\b(director|vice president|\bvp\b|chief|president|head of|principal|partner|supervisory)\b/i;
const LICENSED = /(physician|surgeon|surgical|dentist|dental|hygien|pharmac|nurs(e|ing)\b|\brn\b|\blpn\b|\bcna\b|attorney|lawyer|counsel|psycholog|therap|social worker|teacher|professor|\bpilot\b|first officer|captain|veterinar|optometr|audiolog|rehab|radiolog|sonograph|technologist|\bmri\b|\bct\b|cath lab|x-?ray|paramedic|\bemt\b|anesthes|midwife|physician assistant|\bnp\b|pa-c|behavioral health|mental health|clinical|clinician|phlebotom|respiratory|dietitian|speech|hospitalist|(civil|structural|geotechnical|hydraulic|environmental|electrical|mechanical) engineer|\(hydraulics\)|accountant|\bcpa\b|actuar|surg tech|cvor|allied health|medical|patient|clinic|hospital|laborator|ophthalm|electrician|plumber|line ?(man|worker)|\ba&p\b|airframe|avionics|aircraft (mechanic|technician|maintenance)|\bcdl\b|truck driver|chef|cook\b|teller|rad tech|\bep (tech|lab)|\beeg\b|\bekg\b|\becg\b|echo tech|\bcvt\b|allied|social work|dietic|sterile|\bspd\b|lab tech|pharm tech|ultrasound|mammo|dialysis|per week|travel .{0,25}tech|caregiver|\bdsp\b|direct support|home health|veterinary|groomer)/i;
// Healthcare employers: only their IT/tech-lane roles count.
const HEALTH_CO = /(medical|health|hospital|clinic|staffing|healthcare|providence|nursing|care (center|services))/i;
// Non-English postings (Latin America boards).
const FOREIGN_T = /(atendente|analista|soporte|suporte|t[eé]cnico|desarroll|vaga|empleo)/i;

// ---------- relevance + fit scoring (Sultan's verified profile) ----------
const SENIOR = /\b(senior|sr\.?|mgr|staff|principal|lead|manager|director|head|chief|architect|vp|president|iii|iv|v\b|intern|internship|counsel|recruiter|sales|account|construction|project|program|security|electrical|mechanical|controls|commissioning|facilit(y|ies)|civil|design|planner|procurement|logistics|finance|legal|marketing|quality|software|developer|sde|early access|forward[- ]deployed|supervisor|scientist|researcher|machine learning|ml)\b/i;
function laneOf(title: string): string | null {
  if (SENIOR.test(title)) return null;
  if (/servicenow/i.test(title)) return "ServiceNow";
  if (/(data ?cent(er|re)|datacenter|\bdco\b|critical (facilit|environment)|server (tech|operations)|hardware (tech|operations|deployment)|fleet (tech|operations)|deployment (tech|engineer)|rack (integration|tech)|infrastructure tech|(hardware|server|systems?|network) (integration|deployment) (engineer|tech)|site (reliability|operations) tech)/i.test(title)
      && /(tech|operations|specialist|associate|engineer|deployment|integrat)/i.test(title)) return "Data Center";
  if (/(\bnpi\b|new product introduction|manufacturing engineer|process engineer|product engineer|production engineer|test engineer|rack integration|(system|systems|hardware|server|rack) (integration|validation|test|operations|reliability|bring[- ]?up) engineer|hardware engineering technician|failure analysis)/i.test(title)
      && !/(chemical|petroleum|refin|pipeline|drilling|subsea|reservoir|pharma|biolog|food|civil|structural|\btpm\b|motors?|actuators?|propulsion|aerospace|space|thermo|mechatronic|dynamics|robotic|battery|vehicle|wafer|\bai\b)/i.test(title)) return "Hardware / NPI";
  if (/(it support|help ?desk|service desk|desktop support|end[- ]user support|it technician|it specialist|it operations (tech|specialist|analyst)|technical support (specialist|analyst|technician|engineer)|support technician|it analyst|\bnoc (technician|analyst|engineer|specialist)|network operations center|application support (analyst|specialist|engineer)|product support (specialist|engineer)|it helpdesk)/i.test(title)) return "IT Support";
  if (/(systems? administrator|sysadmin|linux administrator|infrastructure administrator|systems? technician|network (administrator|technician|specialist)|it administrator|telecom(munications)? technician)/i.test(title)) return "Sysadmin";
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
  ["NPI / process validation", /(\bnpi\b|new product introduction|process validation|pilot build|bring[- ]?up)/i],
  ["Production metrics / yield", /(yield|throughput|production metrics|corrective action|\bcapa\b|\b8d\b)/i],
  ["Manufacturing / assembly floor", /(manufacturing|assembly|production line|factory|contract manufactur|\bodm\b|\bcm\b)/i],
  ["Cross-functional (mfg/quality/eng)", /(cross[- ]functional|quality team|engineering teams?)/i],
  ["Corrections / public safety", /(correction|detention|law enforcement|public safety|security officer|inmate|jail|tcole|peace officer)/i],
  ["Shift work / physical", /(shift work|rotational|rotation|on-?call|outdoor|physically demanding)/i],
];
const LACK: [string, RegExp][] = [
  ["Bash", /\bbash\b/i], ["Juniper/JunOS", /(juniper|junos)/i], ["ITIL", /\bitil\b/i],
  ["ServiceNow CSA cert", /(\bcsa\b|certified system administrator)/i], ["ServiceNow CAD cert", /(\bcad\b|certified application developer)/i],
  ["JavaScript", /javascript|glide ?script/i], ["Git", /\bgit(hub|lab)?\b/i], ["Kubernetes", /kubernetes|\bk8s\b/i],
  ["Ansible/Terraform", /(ansible|terraform|puppet|chef)/i], ["Active Directory / Entra", /(active directory|entra|azure ad)/i],
  ["M365 / Google Workspace admin", /(m365|microsoft 365|office 365|google workspace|intune|jamf|\bmdm\b)/i],
  ["CompTIA A+/Network+", /(comptia|\ba\+|network\+|security\+)/i], ["CCNA", /\bccna\b/i],
  ["Electrical/HVAC/mechanical", /(electrical (systems|work)|hvac|mechanical systems|generator|ups systems|switchgear|fire suppression)/i],
  ["Six Sigma / SPC / DFM", /(six sigma|lean six|\bspc\b|statistical process control|\bdfm\b|\bdfx\b|\bfmea\b)/i],
  ["CAD (SolidWorks/AutoCAD)", /(solidworks|autocad|\bcreo\b|\bcatia\b|\bnx cad\b)/i],
  ["ME/EE/IE degree", /(degree|bachelor'?s|bs|b\.s\.)[^.\n]{0,40}(mechanical|electrical|industrial|manufacturing) engineering/i],
  ["PLC / automation", /(\bplc\b|ladder logic|robotics programming)/i],
  ["CDL license", /(\bcdl\b|commercial driver)/i],
  ["Trade license (journeyman)", /(journeyman|licensed (electrician|plumber|welder)|apprenticeship completion)/i],
];
const CLEARANCE = /(active (secret|ts|top secret)|(secret|ts\/sci|top secret|public trust) clearance|clearance (is )?required|must (hold|possess) .{0,20}clearance)/i;
const MY_YEARS: Record<string, number> = { "Data Center": 4, "Hardware / NPI": 1, "IT Support": 4, "Sysadmin": 1, "ServiceNow": 0, "Oil & Gas / Field": 2, "Skilled labor / Ops": 4 };

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
  // Hardware/NPI roles only count when the work is on computer/server hardware.
  if (lane === "Hardware / NPI" && !/(server|\brack|data ?cent|pcba?\b|electronic|computer hardware|\bgpu|network(ing)? (equipment|hardware)|\bsmt\b|system integration)/i.test(text)) return null;
  const snow = /servicenow/i.test(text);
  const gaps = LACK.filter(([k, re]) => (snow || !/^ServiceNow/.test(k)) && re.test(text)).map(([k]) => k);
  const yrs = yearsRequired(r.description);
  let s = ({ "Data Center": 58, "Hardware / NPI": 54, "IT Support": 48, "Sysadmin": 38, "ServiceNow": 32, "Oil & Gas / Field": 50, "Skilled labor / Ops": 50 } as Record<string, number>)[lane] ?? 46;
  if (lane === "ServiceNow" && /(junior|jr\.?|associate|entry|early career|graduate|trainee|apprentice)/i.test(r.title + " " + r.description.slice(0, 600))) s += 22;
  if (/\btechnician\b/i.test(r.title) && lane === "Data Center") s += 4;
  s += Math.min(matched.length * 4, 32);
  s -= Math.min(gaps.length * 6, 30);
  if (gaps.includes("Electrical/HVAC/mechanical")) s -= 16; // facilities-engineering roles, not his background
  if (yrs != null && Number.isFinite(yrs) && yrs > MY_YEARS[lane]) { s -= (yrs - MY_YEARS[lane]) * 9; gaps.unshift(`${yrs}+ yrs required`); }
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
        let lane = laneOf(r.title);
        const mode = workMode(r, src);
        if (src.region) {
          if (SCAM.test(`${r.title}\n${(r.description || "").slice(0, 2000)}`) || EXEC.test(r.title) || /clearance/i.test(r.title) || !/[a-z]{3}/i.test(r.title)) continue;
          if (r.closes_at && new Date(r.closes_at) < new Date()) continue;
        }
        if (src.region === "anchorage") {
          if (!AK_RE.test(r.location) || LICENSED.test(r.title)) continue;
          lane = lane || (HEALTH_CO.test(r.company) ? null : akLane(r.title));
        } else if (src.region === "remote") {
          if (mode === "onsite" || FOREIGN_T.test(r.title)) continue;
          if (mode === "remote" && (NON_US.test(r.location) || /(europe|emea|latam|latin america|apac|asia|africa|philippines|pakistan|nigeria|argentina|colombia)/i.test(r.location)) && !US_OK.test(r.location)) continue;
          if (mode === "hybrid" && !isUS(r.location)) continue;
        } else if (!isUS(r.location)) continue;
        if (!lane || !r.url) continue;
        const sc = score(r, lane); if (!sc) continue;
        if (seen.has(r.external_id)) continue;
        seen.add(r.external_id);
        const row: any = { source_id: src.id, external_id: r.external_id, company: r.company, title: r.title, location: r.location,
          url: r.url, lane, pay: r.pay, description: r.description, posted_at: r.posted_at, last_seen_at: new Date().toISOString(),
          is_open: true, closed_at: null, close_reason: null, work_mode: mode, ...sc, ...payYears(r.pay) };
        if (!known.has(r.external_id)) newCount++;
        rows.push(row);
      }
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await sb.from("postings").upsert(rows.slice(i, i + 200), { onConflict: "source_id,external_id" });
        if (error) throw new Error(error.message);
      }
      // Gone from a full company board = closed (boards are pre-filtered to relevant titles). Keyword-search sources are verified by URL instead.
      if (!PARTIAL.has(src.kind) && raws.length > 0) {
        const gone = (existing || []).filter((e: any) => e.is_open && !seen.has(e.external_id)).map((e: any) => e.id);
        if (gone.length) {
          await sb.from("postings").update({ is_open: false, closed_at: new Date().toISOString(), close_reason: "Removed from company job board" }).in("id", gone);
          closedCount += gone.length;
        }
      }
      // Aggregator listings that haven't appeared for 3 days are treated as closed.
      if ((src.kind === "adzuna" || src.kind === "himalayas" || src.kind === "jobicy") && raws.length > 0) {
        const stale = new Date(Date.now() - 72 * 3600e3).toISOString();
        const { data: old } = await sb.from("postings").update({ is_open: false, closed_at: new Date().toISOString(), close_reason: "No longer listed" })
          .eq("source_id", src.id).eq("is_open", true).lt("last_seen_at", stale).select("id");
        closedCount += old?.length || 0;
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
      let target = p.url;
      const wd = p.url.match(/^https:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)(\/job\/.+)$/);
      if (wd) target = `https://${wd[1]}.${wd[2]}.myworkdayjobs.com/wday/cxs/${wd[1]}/${wd[3]}${wd[4]}`;
      const r = await fetch(target, { headers: UA, redirect: "follow" });
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

async function probe(candidates?: any[]) {
  const { data: saved } = candidates ? { data: null } : await sb.from("sources").select("*").neq("kind", "manual");
  const sources = candidates || saved;
  const out: any[] = [];
  await Promise.all((sources || []).map(async (s: any) => {
    try {
      const raws = await ADAPTERS[s.kind](s.slug, s.company);
      const relevant = raws.filter((r) => laneOf(r.title) && isUS(r.location)).length;
      out.push({ id: s.id, company: s.company, kind: s.kind, total: raws.length, relevant,
        sample: s.region || s.sample ? raws.slice(0, 8).map((r) => `${r.title} | ${r.location} | ${r.pay}`) : undefined });
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
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const result = mode === "verify" ? await verify() : mode === "probe" ? await probe(body.candidates)
      : await ingest(url.searchParams.get("source") ? +url.searchParams.get("source")! : undefined);
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
