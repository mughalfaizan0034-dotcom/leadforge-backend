const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const BASE = "https://api.apify.com/v2";

// ── Serve frontend HTML ──
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.json({ status: "LeadForge backend running ✅" }));

// ── Poll until actor finishes ──
async function waitForRun(runId, token) {
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const { data } = await axios.get(`${BASE}/actor-runs/${runId}?token=${token}`);
    const status = data.data.status;
    if (status === "SUCCEEDED") return data.data.defaultDatasetId;
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(status)) throw new Error("Actor " + status);
  }
  throw new Error("Actor timed out");
}

async function getItems(datasetId, token, limit) {
  const { data } = await axios.get(`${BASE}/datasets/${datasetId}/items?token=${token}&limit=${limit}`);
  return data;
}

function score(w, e, p) {
  let s = 5;
  if (w) s += 2;
  if (e) s += 2;
  if (p) s += 1;
  return Math.min(s, 10);
}

// ── Google Maps ──
app.post("/scrape/google-maps", async (req, res) => {
  try {
    const { keyword, location, limit, token } = req.body;
    const { data } = await axios.post(`${BASE}/acts/nwua9Gu5YrADL7ZDj/runs?token=${token}`, {
      searchStringsArray: [`${keyword} ${location}`],
      maxCrawledPlacesPerSearch: parseInt(limit) || 10
    });
    const did = await waitForRun(data.data.id, token);
    const items = await getItems(did, token, limit);
    res.json({ success: true, leads: items.map(i => ({ name: i.title || i.name || "", website: i.website || "", email: i.email || "", phone: i.phone || i.phoneNumber || "", location: i.address || i.city || "", platform: "Google Maps", score: score(i.website, i.email, i.phone) })) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── LinkedIn ──
app.post("/scrape/linkedin", async (req, res) => {
  try {
    const { keyword, limit, token } = req.body;
    const { data } = await axios.post(`${BASE}/acts/2SyF0bVxmgGr8IVCZ/runs?token=${token}`, {
      searchUrl: `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(keyword)}`,
      maxResults: parseInt(limit) || 10
    });
    const did = await waitForRun(data.data.id, token);
    const items = await getItems(did, token, limit);
    res.json({ success: true, leads: items.map(i => ({ name: i.name || i.companyName || "", website: i.website || i.linkedInUrl || "", email: i.email || "", phone: i.phone || "", location: i.location || i.headquarter || "", platform: "LinkedIn", score: score(i.website, i.email, i.phone) })) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Instagram ──
app.post("/scrape/instagram", async (req, res) => {
  try {
    const { keyword, limit, token } = req.body;
    const { data } = await axios.post(`${BASE}/acts/reGe1ST3OBgYZSsZJ/runs?token=${token}`, {
      hashtags: [keyword.replace(/ /g, "")],
      resultsLimit: parseInt(limit) || 10
    });
    const did = await waitForRun(data.data.id, token);
    const items = await getItems(did, token, limit);
    res.json({ success: true, leads: items.map(i => ({ name: i.ownerUsername || i.name || "", website: i.externalUrl || "", email: i.businessEmail || "", phone: i.businessPhoneNumber || "", location: i.city || "", platform: "Instagram", score: score(i.externalUrl, i.businessEmail, i.businessPhoneNumber) })) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Facebook ──
app.post("/scrape/facebook", async (req, res) => {
  try {
    const { keyword, limit, token } = req.body;
    const { data } = await axios.post(`${BASE}/acts/KoJrdxJCTtpon81KY/runs?token=${token}`, {
      startUrls: [{ url: `https://www.facebook.com/search/pages/?q=${encodeURIComponent(keyword)}` }],
      maxResults: parseInt(limit) || 10
    });
    const did = await waitForRun(data.data.id, token);
    const items = await getItems(did, token, limit);
    res.json({ success: true, leads: items.map(i => ({ name: i.pageName || i.name || "", website: i.website || "", email: i.email || "", phone: i.phone || "", location: i.location || "", platform: "Facebook", score: score(i.website, i.email, i.phone) })) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Hunter.io single domain (kept for compatibility) ──
app.post("/enrich/hunter", async (req, res) => {
  try {
    const { domain, hunterApiKey } = req.body;
    const { data } = await axios.get(`https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${hunterApiKey}&limit=1`);
    const emails = data?.data?.emails || [];
    const best = emails.filter(e => isValidEmail(e.value)).sort((a,b) => (b.confidence||0)-(a.confidence||0))[0];
    res.json({ success: true, email: best?.value || "" });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Blocked email prefixes (support/system roles — not decision makers) ──
const BLOCKED_PREFIXES = [
  "noreply","no-reply","donotreply","do-not-reply","support","help","helpdesk",
  "contact","newsletter","subscribe","unsubscribe","mailer","daemon","bounce",
  "postmaster","webmaster","hostmaster","abuse","spam","robot","bot","auto",
  "notification","notifications","alerts","system","admin@admin","test@","fake@",
  "example@","privacy","legal","compliance","billing@billing","accounts@accounts"
];

const BLOCKED_DOMAINS = [
  "example.com","test.com","fake.com","mailinator.com","tempmail.com",
  "guerrillamail.com","yopmail.com","trashmail.com","sharklasers.com",
  "none.com","noreply.com","no-reply.com","domain.com"
];

// ── Validate email is real and from a decision maker ──
function isDecisionMakerEmail(email) {
  if (!email || typeof email !== "string") return false;
  const clean = email.trim().toLowerCase();
  const re = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  if (!re.test(clean)) return false;
  const [prefix, domain] = clean.split("@");
  if (BLOCKED_DOMAINS.includes(domain)) return false;
  if (BLOCKED_PREFIXES.some(b => prefix.startsWith(b))) return false;
  return true;
}

// ── Enrich a single business with multiple verified emails ──
async function enrichEmails(lead, hunterApiKey) {
  if (!lead.website) return lead;
  try {
    const domain = lead.website.replace(/https?:\/\//, "").split("/")[0].replace(/^www\./, "");
    if (!domain || domain.length < 4) return lead;
    const { data } = await axios.get(
      `https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${hunterApiKey}&limit=10`
    );
    const emails = (data?.data?.emails || [])
      .filter(e => e.value && isDecisionMakerEmail(e.value))
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .map(e => e.value.trim().toLowerCase());
    // deduplicate
    lead.emails = [...new Set(emails)];
  } catch {}
  return lead;
}

// ── Bulk enrich emails ──
app.post("/enrich/emails", async (req, res) => {
  try {
    const { leads, hunterApiKey } = req.body;
    if (!hunterApiKey) return res.json({ success: true, leads });
    const enriched = [];
    for (let i = 0; i < leads.length; i += 5) {
      const batch = leads.slice(i, i + 5);
      const results = await Promise.all(batch.map(l => enrichEmails(l, hunterApiKey)));
      enriched.push(...results);
      if (i + 5 < leads.length) await new Promise(r => setTimeout(r, 1200));
    }
    res.json({ success: true, leads: enriched });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Push to Google Sheets ──
app.post("/push/sheets", async (req, res) => {
  try {
    const { webhookUrl, leads } = req.body;
    // each lead: join multiple emails as comma-separated, only decision-maker emails
    const cleaned = leads.map(l => ({
      ...l,
      emails: (l.emails || []).filter(isDecisionMakerEmail).join(", ")
    }));
    await axios.post(webhookUrl, { leads: cleaned });
    const withEmail = cleaned.filter(l => l.emails).length;
    res.json({ success: true, count: cleaned.length, withEmail });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ LeadForge running on port ${PORT}`));
