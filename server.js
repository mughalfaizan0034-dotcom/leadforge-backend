const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const BASE = "https://api.apify.com/v2";

// ── Serve frontend ──
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.json({ status: "LeadForge backend running ✅" }));

// ── Poll until actor run finishes ──
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

// ── Fetch dataset items ──
async function getItems(datasetId, token, limit) {
  const { data } = await axios.get(`${BASE}/datasets/${datasetId}/items?token=${token}&limit=${limit}`);
  return data;
}

// ── Lead score calculator ──
function calcScore(website, email, phone, linkedin, instagram, facebook) {
  let s = 4;
  if (website)  s += 1;
  if (email)    s += 2;
  if (phone)    s += 1;
  if (linkedin || instagram || facebook) s += 2;
  return Math.min(s, 10);
}

// ── Email validators ──
const BLOCKED_PREFIXES = ["noreply","no-reply","donotreply","do-not-reply","unsubscribe"];
const BLOCKED_DOMAINS  = ["example.com","test.com","fake.com","mailinator.com","tempmail.com","guerrillamail.com","yopmail.com","trashmail.com","sharklasers.com","none.com"];

function isValidEmail(email) {
  if (!email || typeof email !== "string") return false;
  const clean = email.trim().toLowerCase();
  if (!/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(clean)) return false;
  const [prefix, domain] = clean.split("@");
  if (BLOCKED_DOMAINS.includes(domain)) return false;
  if (BLOCKED_PREFIXES.some(b => prefix === b || prefix.startsWith(b))) return false;
  return true;
}

// ── Extract best email from Apify Google Maps result ──
function extractEmail(item) {
  const candidates = [
    item.email,
    item.emails,
    item.additionalInfo?.email,
    item.website && item.website.includes("@") ? item.website : null,
  ].flat().filter(Boolean);

  // regex scan entire raw JSON for any email
  const rawStr = JSON.stringify(item);
  const emailMatches = rawStr.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
  candidates.push(...emailMatches);

  const seen = new Set();
  for (const e of candidates) {
    const clean = typeof e === "string" ? e.trim().toLowerCase() : "";
    if (clean && !seen.has(clean) && isValidEmail(clean)) {
      seen.add(clean);
      return clean;
    }
  }
  return "";
}

// ── GOOGLE MAPS ──
app.post("/scrape/google-maps", async (req, res) => {
  try {
    const { keyword, location, limit, token } = req.body;
    const searchQuery = [keyword, location].filter(Boolean).join(" ");
    const { data } = await axios.post(`${BASE}/acts/nwua9Gu5YrADL7ZDj/runs?token=${token}`, {
      searchStringsArray: [searchQuery],
      maxCrawledPlacesPerSearch: parseInt(limit) || 10,
      scrapeContacts: true,
      includeHistogram: false,
      includeOpeningHours: false,
      includePeopleAlsoSearch: false,
    });
    const did = await waitForRun(data.data.id, token);
    const items = await getItems(did, token, limit);
    const leads = items.map(i => {
      const email = extractEmail(i);
      return {
        name:      i.title || i.name || "",
        website:   i.website || "",
        email,
        phone:     i.phone || i.phoneNumber || "",
        location:  i.address || i.city || "",
        linkedin:  "",
        instagram: "",
        facebook:  "",
        score:     calcScore(i.website, email, i.phone, "", "", "")
      };
    });
    const withEmail = leads.filter(l => l.email).length;
    res.json({ success: true, leads, withEmail });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── SOCIAL PROFILE ENRICHMENT ──
app.post("/enrich/social", async (req, res) => {
  try {
    const { leads, token } = req.body;

    const enriched = await Promise.all(leads.map(async (lead) => {
      const name = encodeURIComponent(lead.name || "");
      const results = { linkedin: "", instagram: "", facebook: "" };

      // LinkedIn
      try {
        const li = await axios.post(`${BASE}/acts/2SyF0bVxmgGr8IVCZ/runs?token=${token}`, {
          searchUrl: `https://www.linkedin.com/search/results/companies/?keywords=${name}`,
          maxResults: 1
        });
        const runId = li.data?.data?.id;
        if (runId) {
          for (let i = 0; i < 3; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const s = await axios.get(`${BASE}/actor-runs/${runId}?token=${token}`);
            if (s.data?.data?.status === "SUCCEEDED") {
              const did = s.data.data.defaultDatasetId;
              const items = await axios.get(`${BASE}/datasets/${did}/items?token=${token}&limit=1`);
              if (items.data?.[0]) results.linkedin = items.data[0].linkedInUrl || items.data[0].url || "";
              break;
            }
          }
        }
      } catch {}

      // Instagram
      try {
        const ig = await axios.post(`${BASE}/acts/reGe1ST3OBgYZSsZJ/runs?token=${token}`, {
          hashtags: [lead.name.replace(/\s+/g, "").toLowerCase()],
          resultsLimit: 1
        });
        const runId = ig.data?.data?.id;
        if (runId) {
          for (let i = 0; i < 3; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const s = await axios.get(`${BASE}/actor-runs/${runId}?token=${token}`);
            if (s.data?.data?.status === "SUCCEEDED") {
              const did = s.data.data.defaultDatasetId;
              const items = await axios.get(`${BASE}/datasets/${did}/items?token=${token}&limit=1`);
              if (items.data?.[0]) results.instagram = `instagram.com/${items.data[0].ownerUsername || ""}`;
              break;
            }
          }
        }
      } catch {}

      // Facebook
      try {
        const fb = await axios.post(`${BASE}/acts/KoJrdxJCTtpon81KY/runs?token=${token}`, {
          startUrls: [{ url: `https://www.facebook.com/search/pages/?q=${name}` }],
          maxResults: 1
        });
        const runId = fb.data?.data?.id;
        if (runId) {
          for (let i = 0; i < 3; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const s = await axios.get(`${BASE}/actor-runs/${runId}?token=${token}`);
            if (s.data?.data?.status === "SUCCEEDED") {
              const did = s.data.data.defaultDatasetId;
              const items = await axios.get(`${BASE}/datasets/${did}/items?token=${token}&limit=1`);
              if (items.data?.[0]) results.facebook = items.data[0].url || items.data[0].pageUrl || "";
              break;
            }
          }
        }
      } catch {}

      const updatedLead = { ...lead, ...results };
      updatedLead.score = calcScore(updatedLead.website, updatedLead.email, updatedLead.phone, results.linkedin, results.instagram, results.facebook);
      return updatedLead;
    }));

    res.json({ success: true, leads: enriched });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── PUSH TO GOOGLE SHEETS ──
app.post("/push/sheets", async (req, res) => {
  try {
    const { webhookUrl, leads } = req.body;
    const cleaned = leads.map(l => ({
      name:      l.name      || "",
      website:   l.website   || "",
      phone:     l.phone     || "",
      location:  l.location  || "",
      linkedin:  l.linkedin  || "",
      instagram: l.instagram || "",
      facebook:  l.facebook  || "",
      email:     isValidEmail(l.email) ? l.email.trim().toLowerCase() : "",
      score:     l.score     || 0,
      date:      new Date().toLocaleString()
    }));
    await axios.post(webhookUrl, { leads: cleaned });
    const withEmail = cleaned.filter(l => l.email).length;
    res.json({ success: true, count: cleaned.length, withEmail });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── START ──
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ LeadForge running on port ${PORT}`));
