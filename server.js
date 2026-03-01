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

// ── Validate email format ──
function isValidEmail(email) {
  if (!email || typeof email !== "string") return false;
  const clean = email.trim().toLowerCase();
  // must match standard email pattern
  const re = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  if (!re.test(clean)) return false;
  // reject disposable / fake domains
  const blocked = ["example.com","test.com","fake.com","mailinator.com","tempmail.com","guerrillamail.com","yopmail.com","trashmail.com","sharklasers.com","none.com","noreply.com","no-reply.com"];
  const domain = clean.split("@")[1];
  if (blocked.includes(domain)) return false;
  // reject placeholder patterns
  if (/^(test|fake|noreply|no-reply|admin@admin|info@info|example)/.test(clean)) return false;
  return true;
}

// ── Enrich single lead email via Hunter.io ──
async function enrichEmail(lead, hunterApiKey) {
  if (isValidEmail(lead.email)) return lead; // already has valid email
  if (!lead.website) return lead;
  try {
    const domain = lead.website.replace(/https?:\/\//, "").split("/")[0].replace(/^www\./, "");
    if (!domain || domain.length < 4) return lead;
    const { data } = await axios.get(`https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${hunterApiKey}&limit=1`);
    const emails = data?.data?.emails || [];
    // pick highest confidence verified email
    const best = emails
      .filter(e => e.value && isValidEmail(e.value))
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    if (best) {
      lead.email = best.value;
      lead.score = Math.min(lead.score + 2, 10);
    }
  } catch {}
  return lead;
}

// ── Bulk enrich emails ──
app.post("/enrich/emails", async (req, res) => {
  try {
    const { leads, hunterApiKey } = req.body;
    if (!hunterApiKey) return res.json({ success: true, leads });
    // process in batches of 5 to avoid rate limiting
    const enriched = [];
    for (let i = 0; i < leads.length; i += 5) {
      const batch = leads.slice(i, i + 5);
      const results = await Promise.all(batch.map(l => enrichEmail(l, hunterApiKey)));
      enriched.push(...results);
      if (i + 5 < leads.length) await new Promise(r => setTimeout(r, 1000)); // 1s pause between batches
    }
    res.json({ success: true, leads: enriched });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Push to Google Sheets (only valid emails) ──
app.post("/push/sheets", async (req, res) => {
  try {
    const { webhookUrl, leads } = req.body;
    // sanitize: clean and validate emails before pushing
    const cleaned = leads.map(l => ({
      ...l,
      email: isValidEmail(l.email) ? l.email.trim().toLowerCase() : ""
    }));
    await axios.post(webhookUrl, { leads: cleaned });
    const withEmail = cleaned.filter(l => l.email).length;
    res.json({ success: true, count: cleaned.length, withEmail });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ LeadForge running on port ${PORT}`));
