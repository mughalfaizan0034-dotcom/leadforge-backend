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
function score(w, e, p, li, ig, fb) {
  let s = 4;
  if (w) s += 1;
  if (e) s += 2;
  if (p) s += 1;
  if (li || ig || fb) s += 2;
  return Math.min(s, 10);
}

// ── Email validators ──
const BLOCKED_PREFIXES = ["info","contact","hello","support","help","admin","sales","team","office","general","enquiries","enquiry","noreply","no-reply","mail","webmaster","marketing","accounts","billing","hr","careers","jobs","press","media","feedback"];
const BLOCKED_DOMAINS  = ["example.com","test.com","fake.com","mailinator.com","tempmail.com","guerrillamail.com","yopmail.com","trashmail.com","sharklasers.com","none.com","noreply.com","no-reply.com"];
const DM_TITLES        = ["ceo","founder","co-founder","owner","director","head","vp","vice president","president","chief","manager","partner","principal","cto","coo","cmo"];

function isValidEmail(email) {
  if (!email || typeof email !== "string") return false;
  const clean = email.trim().toLowerCase();
  if (!/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(clean)) return false;
  const domain = clean.split("@")[1];
  if (BLOCKED_DOMAINS.includes(domain)) return false;
  return true;
}

function isDecisionMaker(emailObj) {
  if (!emailObj || !isValidEmail(emailObj.value)) return false;
  const prefix = emailObj.value.split("@")[0].toLowerCase();
  if (BLOCKED_PREFIXES.some(b => prefix === b || prefix.startsWith(b + "."))) return false;
  const hasName = /^[a-z]+[\.\-_][a-z]+/.test(prefix) || /^[a-z]{3,}$/.test(prefix);
  const pos = (emailObj.position || emailObj.type || "").toLowerCase();
  const isDM = DM_TITLES.some(t => pos.includes(t));
  return (hasName && (emailObj.confidence || 0) >= 50) || isDM;
}

// ── Clean email before pushing ──
function cleanEmail(email) {
  if (!isValidEmail(email)) return "";
  return email.trim().toLowerCase();
}

// ── GOOGLE MAPS ──
app.post("/scrape/google-maps", async (req, res) => {
  try {
    const { keyword, location, limit, token } = req.body;
    const { data } = await axios.post(`${BASE}/acts/nwua9Gu5YrADL7ZDj/runs?token=${token}`, {
      searchStringsArray: [`${keyword} ${location}`],
      maxCrawledPlacesPerSearch: parseInt(limit) || 10
    });
    const did = await waitForRun(data.data.id, token);
    const items = await getItems(did, token, limit);
    const leads = items.map(i => ({
      name:     i.title || i.name || "",
      website:  i.website || "",
      email:    "",
      phone:    i.phone || i.phoneNumber || "",
      location: i.address || i.city || "",
      linkedin: "",
      instagram:"",
      facebook: "",
      score:    score(i.website, "", i.phone, "", "", "")
    }));
    res.json({ success: true, leads });
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

      return { ...lead, ...results };
    }));

    res.json({ success: true, leads: enriched });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── HUNTER.IO BULK EMAIL ENRICHMENT (decision-makers only) ──
app.post("/enrich/emails", async (req, res) => {
  try {
    const { leads, hunterApiKey } = req.body;
    if (!hunterApiKey) return res.json({ success: true, leads });

    const enriched = [];
    for (let i = 0; i < leads.length; i += 5) {
      const batch = leads.slice(i, i + 5);
      const results = await Promise.all(batch.map(async (lead) => {
        if (!lead.website) return lead;
        try {
          const domain = lead.website.replace(/https?:\/\//, "").split("/")[0].replace(/^www\./, "");
          if (!domain || domain.length < 4) return lead;
          const { data } = await axios.get(`https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${hunterApiKey}&limit=10`);
          const emails = (data?.data?.emails || []);
          const dmEmails = emails.filter(e => isDecisionMaker(e)).sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
          if (dmEmails.length) {
            lead.email      = dmEmails[0].value.trim().toLowerCase();
            lead.emailName  = `${dmEmails[0].first_name || ""} ${dmEmails[0].last_name || ""}`.trim();
            lead.emailTitle = dmEmails[0].position || "";
          }
        } catch {}
        return lead;
      }));
      enriched.push(...results);
      if (i + 5 < leads.length) await new Promise(r => setTimeout(r, 1000));
    }
    res.json({ success: true, leads: enriched });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── PUSH TO GOOGLE SHEETS ──
app.post("/push/sheets", async (req, res) => {
  try {
    const { webhookUrl, leads } = req.body;
    // sanitize emails — only push verified decision-maker emails
    const cleaned = leads.map(l => ({
      name:       l.name       || "",
      website:    l.website    || "",
      phone:      l.phone      || "",
      location:   l.location   || "",
      linkedin:   l.linkedin   || "",
      instagram:  l.instagram  || "",
      facebook:   l.facebook   || "",
      email:      cleanEmail(l.email),
      emailName:  l.emailName  || "",
      emailTitle: l.emailTitle || "",
      score:      l.score      || 0,
      date:       new Date().toLocaleString()
    }));
    await axios.post(webhookUrl, { leads: cleaned });
    const withEmail = cleaned.filter(l => l.email).length;
    res.json({ success: true, count: cleaned.length, withEmail });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── START ──
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ LeadForge running on port ${PORT}`));
