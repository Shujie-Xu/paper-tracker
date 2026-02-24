#!/usr/bin/env node
/**
 * paper-tracker · fetch.js
 * 1. Fetch NBER RSS (+ optional SSRN)
 * 2. Score relevance to Shujie's research interests via LLM
 * 3. For high-relevance papers (≥7): download PDF + deep analysis
 * 4. Append new papers to papers-db.json
 *
 * Usage: node fetch.js [--dry-run]
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

const DB_FILE   = path.join(__dirname, 'papers-db.json');
const SEEN_FILE = path.join(__dirname, 'seen-ids.json');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Research profile (used in LLM prompt) ─────────────────────
const RESEARCH_PROFILE = `
Shujie Xu is a researcher in Applied Microeconomics, Corporate Finance, and Urban Economics.
Research interests:
1. Information economics — information frictions, disclosure, asymmetric information, strategic communication
2. Corporate political engagement — political connections, lobbying, policy attention, partisan alignment, government-firm relations
3. Housing and real estate markets — listing prices, bargaining, seller behavior, housing market frictions
4. Text-based empirical methods — NLP/ML applied to economics, Word2Vec, text mining, earnings calls, political speech analysis
5. Causal inference — DiD, IV, RD, natural experiments, panel data methods

Current projects:
- Housing market: effects of listing price format on bargaining outcomes (NLP measure of seller impatience, HMDA matching)
- Corporate political: how political attention and partisan alignment affect corporate performance (text-based measures from earnings calls)
- Supply chain networks: firm centrality and risk exposure from annual report text mining

Strong interest in: computational economics, large datasets (80M+ observations), working paper methodology, replication materials.
`;

// ── NBER API endpoint ─────────────────────────────────────────
// Returns latest working papers; newthisweek=true for current week
const NBER_API = 'https://www.nber.org/api/v1/working_page_asset/contentType/working_paper/_/_/search?sortBy=public_date&perPage=100&page=';

// SSRN is scraped by the cron agent via web_search (not here)

// ── HTTP helpers ───────────────────────────────────────────────
function fetchUrl(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (research-paper-tracker/1.0)' },
      timeout: 15000
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        resolve(fetchUrl(res.headers.location, maxRedirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// ── XML parsing (no deps) ──────────────────────────────────────
function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim() : '';
}

function parseItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const raw = m[1];
    const title   = extractTag(raw, 'title');
    const link    = extractTag(raw, 'link');
    const desc    = extractTag(raw, 'description');
    const pubDate = extractTag(raw, 'pubDate');
    const guid    = extractTag(raw, 'guid') || link;
    // NBER-specific: dc:creator or author
    const author  = extractTag(raw, 'dc:creator') || extractTag(raw, 'author');
    // JEL codes sometimes in description or category
    const jelRe = /([A-Z]\d{2,3})/g;
    const jel = [];
    let jm;
    while ((jm = jelRe.exec(desc)) !== null) jel.push(jm[1]);

    items.push({ title, link, desc, pubDate, guid, author, jel: [...new Set(jel)] });
  }
  return items;
}

function parseEntries(xml) {
  // Atom feed (SSRN)
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const raw = m[1];
    const title   = extractTag(raw, 'title');
    const linkM   = raw.match(/<link[^>]+href="([^"]+)"/);
    const link    = linkM ? linkM[1] : '';
    const summary = extractTag(raw, 'summary') || extractTag(raw, 'content');
    const updated = extractTag(raw, 'updated') || extractTag(raw, 'published');
    const id      = extractTag(raw, 'id') || link;
    const author  = extractTag(raw, 'name');
    entries.push({ title, link, desc: summary, pubDate: updated, guid: id, author, jel: [] });
  }
  return entries;
}

// ── NBER paper number extraction ──────────────────────────────
function extractNberNum(link) {
  const m = link.match(/\/papers\/w(\d+)/);
  return m ? `nber-w${m[1]}` : null;
}

// ── Date parsing ───────────────────────────────────────────────
function parseDate(str) {
  if (!str) return new Date().toISOString().slice(0, 10);
  const d = new Date(str);
  return isNaN(d) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

function getISOWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const weekStart = new Date(jan4.getTime() - (dayOfWeek - 1) * 86400000);
  const diff = d.getTime() - weekStart.getTime();
  const weekNum = 1 + Math.floor(diff / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// ── OpenClaw LLM helper (uses openclaw agent context) ─────────
// We emit a structured prompt to stdout for the cron agent to process
// In standalone mode, we use a simple keyword heuristic fallback

const TOPIC_KEYWORDS = {
  'information':          ['information friction', 'information asymmetry', 'disclosure', 'opacity', 'transparency', 'signal', 'uncertainty', 'belief', 'strategic communication', 'private information'],
  'corporate-political':  ['political connection', 'lobbying', 'political attention', 'partisan', 'government relation', 'policy attention', 'political uncertainty', 'corporate political', 'regulatory capture', 'political risk'],
  'housing':              ['housing market', 'real estate', 'listing price', 'bargaining', 'property', 'mortgage', 'homebuyer', 'seller', 'house price', 'rental'],
  'text-methods':         ['natural language processing', 'nlp', 'text analysis', 'word embedding', 'word2vec', 'text mining', 'machine learning', 'earnings call', 'textual', 'sentiment analysis', 'large language model', 'bert', 'tf-idf'],
  'causal-inference':     ['difference-in-differences', 'did', 'instrumental variable', 'regression discontinuity', 'natural experiment', 'causal', 'identification strategy', 'plausibly exogenous', 'treatment effect'],
  'corporate-finance':    ['corporate finance', 'firm behavior', 'ceo', 'board', 'governance', 'capital structure', 'investment', 'earnings', 'stock market', 'firm performance'],
};

function keywordScore(title, abstract) {
  const text = ((title || '') + ' ' + (abstract || '')).toLowerCase();
  const scores = {};
  let total = 0;
  Object.entries(TOPIC_KEYWORDS).forEach(([topic, kws]) => {
    let hits = kws.filter(kw => text.includes(kw.toLowerCase())).length;
    if (hits > 0) scores[topic] = Math.min(5, hits);
    total += hits;
  });
  // Weighted relevance score: 0-10
  const maxPossible = 10;
  const raw = Math.min(10, total * 1.5);
  const topics = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);
  return { relevance_score: parseFloat(raw.toFixed(1)), topics, breakdown: scores };
}

// ── Main orchestration prompt (for AI agent) ──────────────────
function buildScoringPrompt(paper) {
  return `You are scoring a working paper for relevance to a researcher's interests.

RESEARCHER PROFILE:
${RESEARCH_PROFILE}

PAPER:
Title: ${paper.title}
Authors: ${(paper.authors || []).join(', ')}
Abstract: ${paper.abstract || 'N/A'}
JEL Codes: ${(paper.jel_codes || []).join(', ')}

TASK: Score relevance (0–10) and identify matching topics. Output JSON only:
{
  "relevance_score": <0-10 float>,
  "relevance_reason": "<2 sentences why>",
  "topics": ["information","corporate-political","housing","text-methods","causal-inference","corporate-finance"],
  "relevance_breakdown": {
    "information_economics": <0-5>,
    "corporate_political": <0-5>,
    "housing_markets": <0-5>,
    "text_methods": <0-5>,
    "causal_inference": <0-5>
  }
}`;
}

function buildAnalysisPrompt(paper, pdfText) {
  return `You are reading a working paper for a researcher. Extract key information.

RESEARCHER PROFILE:
${RESEARCH_PROFILE}

PAPER TITLE: ${paper.title}
AUTHORS: ${(paper.authors || []).join(', ')}

FULL TEXT (may be truncated):
${pdfText.slice(0, 12000)}

TASK: Provide structured analysis. Output JSON only:
{
  "research_question": "<what question does this paper ask>",
  "data": "<what data/dataset is used>",
  "identification": "<identification strategy: DiD/IV/RD/etc and key assumptions>",
  "main_findings": "<main results with numbers where available>",
  "limitations": "<acknowledged limitations>",
  "connection_to_my_work": "<how this connects to the researcher's projects above — be specific>",
  "my_takeaway": "<what the researcher should take away: cite-worthy finding, methodology to borrow, or gap to address>"
}`;
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : [];
  const seenIds = new Set(fs.existsSync(SEEN_FILE) ? JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')) : []);
  const existingIds = new Set(db.map(p => p.id));
  const newPapers = [];

  console.log('🔍 Fetching NBER API (new this week)...');

  // ── Fetch NBER API (paginate until non-new papers appear) ─────
  let page = 1;
  let found = true;
  while (found && page <= 5) {
    try {
      const json = await fetchUrl(NBER_API + page);
      const data = JSON.parse(json);
      const results = data.results || [];
      found = results.some(r => r.newthisweek);
      console.log(`  Page ${page}: ${results.length} papers, ${results.filter(r=>r.newthisweek).length} new`);

      for (const item of results) {
        if (!item.newthisweek && page > 1) continue; // stop at non-new on later pages

        const paperNum = (item.url || '').match(/w(\d+)/)?.[1];
        const id = paperNum ? `nber-w${paperNum}` : `nber-${item.nid}`;
        if (existingIds.has(id) || seenIds.has(id)) continue;
        seenIds.add(id);

        // Clean authors (strip HTML)
        const authors = (item.authors || []).map(a => a.replace(/<[^>]+>/g, '').trim());
        const abstract = (item.abstract || '').trim();
        const date = new Date().toISOString().slice(0, 10); // NBER API doesn't give exact date
        const week = getISOWeek(date);
        const fullUrl = `https://www.nber.org${item.url || ''}`;
        const pNum = (item.url || '').match(/(w\d+)$/)?.[1];
        const pdfUrl = pNum
          ? `https://www.nber.org/system/files/working_papers/${pNum}/${pNum}.pdf`
          : null;

        const { relevance_score, topics, breakdown } = keywordScore(item.title, abstract);

        newPapers.push({
          id,
          title: item.title,
          authors,
          date,
          week,
          source: 'NBER',
          url: fullUrl,
          pdf_url: pdfUrl,
          abstract,
          jel_codes: [],          // filled by cron agent if needed
          nber_program: [],        // filled by cron agent if needed
          topics,
          relevance_score,
          relevance_breakdown_raw: breakdown,
          status: 'abstract_only',
          added_date: date,
          _needs_scoring:  true,
          _needs_analysis: relevance_score >= 6,
          _scoring_prompt: buildScoringPrompt({ title: item.title, authors, abstract, jel_codes: [] }),
        });
      }
      page++;
    } catch (e) {
      console.warn(`  ⚠️ NBER API page ${page} failed:`, e.message);
      break;
    }
  }

  console.log(`\n📊 Fetched ${newPapers.length} new NBER papers this week`);
  if (newPapers.length === 0) {
    console.log('  (all already seen, or no new papers this week)');
    return { newPapers: 0, highRelevance: 0, papers: [] };
  }

  // Filter: keep relevance ≥ 4 for DB
  const toSave = newPapers.filter(p => p.relevance_score >= 4.0);
  const highRel = newPapers.filter(p => p.relevance_score >= 6.0);
  const allNew  = newPapers; // cron agent can re-score everything

  console.log(`  All new: ${allNew.length} | DB-worthy (≥4): ${toSave.length} | Needs analysis (≥6): ${highRel.length}`);

  if (!DRY_RUN) {
    const updatedDb = [...newPapers, ...db]; // store all for agent re-scoring
    updatedDb.splice(600);
    fs.writeFileSync(DB_FILE, JSON.stringify(updatedDb, null, 2), 'utf8');
    fs.writeFileSync(SEEN_FILE, JSON.stringify([...seenIds].slice(-3000), null, 2), 'utf8');
    console.log(`💾 Saved ${newPapers.length} papers to DB`);
  } else {
    console.log('[DRY RUN] Sample:');
    console.log(JSON.stringify(newPapers.slice(0, 2), null, 2));
  }

  return {
    newPapers: newPapers.length,
    highRelevance: highRel.length,
    papers: newPapers,
    topForAnalysis: highRel.map(p => ({
      id: p.id, title: p.title, abstract: p.abstract,
      url: p.url, pdf_url: p.pdf_url, score: p.relevance_score,
      topics: p.topics,
    })),
  };
}

main().then(result => {
  // Write result for cron agent to pick up
  const outFile = path.join(__dirname, 'fetch-result.json');
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n✅ Done. Result written to ${outFile}`);
}).catch(err => {
  console.error('❌ fetch.js failed:', err);
  process.exit(1);
});
