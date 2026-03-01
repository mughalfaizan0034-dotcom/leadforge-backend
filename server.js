// ── Enrich leads with social profiles (LinkedIn, Instagram, Facebook) ──
app.post("/enrich/social", async (req, res) => {
  try {
    const { leads, token } = req.body;
    const enriched = await Promise.all(leads.map(async (lead) => {
      const name = encodeURIComponent(lead.name || "");
      const results = { linkedin: "", instagram: "", facebook: "" };
      try {
        // LinkedIn search via Apify
        const li = await axios.post(
          `${BASE}/acts/2SyF0bVxmgGr8IVCZ/runs?token=${token}`,
          { searchUrl: `https://www.linkedin.com/search/results/companies/?keywords=${name}`, maxResults: 1 }
        );
        const liRunId = li.data?.data?.id;
        if (liRunId) {
          // poll max 3 times (9s) for quick results
          for (let i = 0; i < 3; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const s = await axios.get(`${BASE}/actor-runs/${liRunId}?token=${token}`);
            if (s.data?.data?.status === "SUCCEEDED") {
              const did = s.data.data.defaultDatasetId;
              const items = await axios.get(`${BASE}/datasets/${did}/items?token=${token}&limit=1`);
              if (items.data?.[0]) results.linkedin = items.data[0].linkedInUrl || items.data[0].url || "";
              break;
            }
          }
        }
      } catch {}

      try {
        // Instagram search via Apify
        const ig = await axios.post(
          `${BASE}/acts/reGe1ST3OBgYZSsZJ/runs?token=${token}`,
          { hashtags: [lead.name.replace(/\s+/g, "").toLowerCase()], resultsLimit: 1 }
        );
        const igRunId = ig.data?.data?.id;
        if (igRunId) {
          for (let i = 0; i < 3; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const s = await axios.get(`${BASE}/actor-runs/${igRunId}?token=${token}`);
            if (s.data?.data?.status === "SUCCEEDED") {
              const did = s.data.data.defaultDatasetId;
              const items = await axios.get(`${BASE}/datasets/${did}/items?token=${token}&limit=1`);
              if (items.data?.[0]) results.instagram = `instagram.com/${items.data[0].ownerUsername || ""}`;
              break;
            }
          }
        }
      } catch {}

      try {
        // Facebook search via Apify
        const fb = await axios.post(
          `${BASE}/acts/KoJrdxJCTtpon81KY/runs?token=${token}`,
          { startUrls: [{ url: `https://www.facebook.com/search/pages/?q=${name}` }], maxResults: 1 }
        );
        const fbRunId = fb.data?.data?.id;
        if (fbRunId) {
          for (let i = 0; i < 3; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const s = await axios.get(`${BASE}/actor-runs/${fbRunId}?token=${token}`);
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
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
